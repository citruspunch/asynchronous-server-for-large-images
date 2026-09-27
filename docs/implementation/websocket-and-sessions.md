# WebSocket and session machinery

> This document describes the current Java implementation. **UTP-1.0.md is
> normative.** This document explains how the Java implementation realizes those
> semantics. Where the two differ, UTP-1.0.md wins.
>
> - Normative protocol: [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md)
> - The behavior-pinning tests, which are the fastest way to read the frozen
>   rules as executable form: `src/test/java/com/ultratile/ws/SessionTest.java`

## One socket per page, two threads per session

A viewer page opens exactly one WebSocket in `connectWs()` and reuses it for
every image and every generation. The server side of that socket is one
`SessionCoordinator`, and `SessionCoordinator.start()` creates two virtual
threads:

```text
reader VT      blocked on socket read, drives WsFrame parsing and all inbound
               UTP validation. Single writer of the reader-owned state:
               requested set, bbox, active, lastReqIdSeen, rejectedReqIds.
dispatcher VT  blocked on a Semaphore, owns the sealed work list, the sent /
               skipped counters, and every outbound frame.
```

Both share one `WsWriter` holding one `ReentrantLock`. The per-connection
virtual thread created by the accept loop returns as soon as the handshake
succeeds, so a live WebSocket session costs exactly two virtual threads and one
socket.

`ReentrantLock` rather than `synchronized` is a deliberate choice. A monitor can
pin a carrier thread in Java 21; a `ReentrantLock` cannot. The design notes for
this project treat virtual-thread pinning avoidance as a requirement, not a
nicety.

## State and its visibility

`GenerationState` is the per-generation record. Its fields split cleanly by
owner, and that split is the concurrency contract:

| Field | Owner | Visibility |
| --- | --- | --- |
| `reqId`, `imageId`, `zoom`, `lodMode` | immutable after construction | final |
| `requested` (LinkedHashSet of packed tile keys) | reader, pre-seal | plain field, reader-confined |
| `loX/hiX/loY/hiY` (union bbox) | reader, pre-seal | plain fields, reader-confined |
| `work` (immutable tile list) | reader builds, publishes at seal | `volatile` |
| `sealed`, `canceled` | reader sets, dispatcher reads | `volatile` |
| `sent`, `skipped`, `inFlight` | dispatcher | `volatile` |

Session-level state:

| Field | Type | Purpose |
| --- | --- | --- |
| `active` | `AtomicReference<GenerationState>` | the generation currently allowed to produce tiles |
| `lastReqIdSeen` | `AtomicLong` | monotonic accept watermark, only advanced on an accepted new generation |
| `rejectedReqIds` | `LinkedHashSet<Long>` | generations refused by validation, so a later COMMIT on them closes instead of resurrecting them |
| `readySlot` | `AtomicReference<GenerationState>` | the single coalesced dispatch slot |
| `readyPermit` | `Semaphore` | wakes the dispatcher |
| `closed` | `AtomicBoolean` | set by `closeSession()` and nothing else |
| `closeSent` | `AtomicBoolean` | a Close frame has been serialized, or is being attempted |
| `currentTile` | `AtomicReference<FileChannel>` | teardown-only handle so a blocked write can be unblocked |

`inFlight` is declared and checked by `WsWriter.writeEndIf()`, but nothing
increments it, because dispatch is single-threaded per session: there is exactly
one dispatcher VT and it never has two tiles in flight. The check is retained as
an invariant guard. It is not dead weight to remove carelessly if dispatch ever
becomes concurrent, but it is not load-bearing today.

## Lifecycle

```text
                  chunk (new reqId)                 COMMIT (matching reqId)
   requested ─────────────────────────▶ SEALED ──────────────────────────▶ DISPATCHING
       │  ▲                                │  ▲                                │
       │  │ chunk (same reqId)             │  │ chunk after seal -> 1002      │ END rule holds
       │  │ absorbs, extends bbox          │  │ duplicate COMMIT -> 1002       ▼
       │  │ 257th unique tile -> 1002      │  │                                  END
       │  │ post-seal  -> 1002             │  │                        else: no END (superseded /
       │  │ metadata mismatch -> 1002      │  │                              ABORT / close)
       ▼  │                                ▼  │                                
    STALE (reqId <= lastReqIdSeen)      STALE                            END, then
    ignored, connection survives        ignored                          active -> null
```

Sealing is a single reader-side step in `onCommit()`:

```java
List<TileReq> work = buildWork(cur);   // immutable, center-first, built off-queue
cur.work = work;                        // publish
cur.sealed = true;                      // seal last
publishReady(cur);                      // one coalesced slot
```

The list is built before anything is published, so a dispatcher that wakes can
never observe a half-built list. The order `work` then `sealed` means a
`sealed == true` read is a guarantee that `work` is visible.

### Center-first ordering

`buildWork()` sorts the requested set by Manhattan distance from the center of
the union bbox of all chunks, then by `y`, then by `x`. The wire never carries a
center, so the server derives it. On a slow client this ordering means the middle
of the requested window fills in first and the edges catch up, which is the
visible behavior a viewer wants. `SessionTest.centerFirstOrder()` pins the exact
ordering.

### The coalesced ready slot

```java
void publishReady(GenerationState s) {
    GenerationState old = readySlot.getAndSet(s);
    if (old == null) readyPermit.release();      // only null -> non-null banks a permit
}
```

There is one slot and at most one outstanding permit, so a burst of COMMITs
collapses. At most the newest sealed generation survives to dispatch: a
superseded generation is replaced in the slot before the dispatcher wakes. There
is no FIFO queue, no priority queue, and no dispatch staging structure anywhere
in the code. The dispatcher walks the sealed list with a local index:

```java
GenerationState s = readySlot.getAndSet(null);
dispatchState(s);       // walks s.work with a local nextIndex, no shared cursor
```

A sealed generation that never gets dispatched produces no END. That is correct:
the client that sealed it has already been superseded or aborted, and a
superfluous END would break its accounting.

## Supersession and cancellation

Three things cancel a generation, and all three set the same `canceled` flag:

1. A newer accepted chunk or COMMIT arrives for a different reqId.
2. A matching ABORT arrives.
3. `failSession()` or `onPeerClose()` tears the session down.

Cancellation is observed at two levels. The dispatcher checks
`!(s.sealed && !s.canceled && active.get() == s)` before each tile, counting a
skipped tile and moving on. The authoritative check is inside the writer lock:
`WsWriter.transferTileIf()` re-reads `closeSent`, `closed`, `state.canceled`, and
`active` after taking the lock and before the first byte, returning
`SKIPPED` if any of them says stop.

A tile that has already started its frame is not interrupted. The lock is held
for the whole frame, so cancellation lands at a frame boundary. That is the
frame-boundary rule the tests name `noChannelCloseOnCancel` and
`peerCloseDuringTransfer`.

## Stale versus invalid

This is the distinction that the test names `historyBeforeValidation` and
`invalidNewerSplit` exist to protect.

`onViewportChunk()` and `onCommit()` run a frozen order:

1. **Parse.** A shape failure closes immediately with 1002.
2. **Rejected check.** If the reqId is in `rejectedReqIds`, close with 1002. A
   generation once refused can never be accepted later, which is what stops a
   bad reqId 9 from coming back as a valid reqId 9.
3. **History.** A reqId at or below `lastReqIdSeen` is stale and is ignored, with
   a WARNING. Connection survives.
4. **Validation.** Only now is a new generation validated against the registry.

History before validation means a delayed old packet is treated as stale even
when its image has since been removed or would no longer validate. The opposite
order would close the connection for a packet that was merely late.

The CHUNK and COMMIT sides differ on purpose:

- **Invalid-newer CHUNK** is recorded in `rejectedReqIds` and the connection
  stays alive. The client's COMMIT will then hit the rejected check and close.
- **Invalid-newer COMMIT** closes immediately. A COMMIT is terminal; ignoring it
  would leave the client's `BatchState` promise unresolved forever, hanging the
  viewer's batch loop.

`lastReqIdSeen` advances only when a new generation is accepted: the first valid
chunk, or a valid empty COMMIT. Same-generation chunks, matching COMMITs, ABORTs,
stale packets, and rejects never advance it.

### The no-evict rejected set

`rejectedReqIds` is capped at `Config.REJECTED_CAP` (64). Entries purge once
`id <= lastReqIdSeen`, which `purgeStale()` does on every inbound message. A live
entry is never evicted to make room: the 65th live rejected ID closes the
connection instead. Evicting a live entry would let `bad9Valid9Resurrection`:
a reqId 9 that was refused could later be accepted as valid.
`SessionTest.noEvict64Then65thCloses()` pins the 65th-closes behavior and
`bad9Valid9Resurrection` pins the reason.

## Stale versus invalid processing on the outbound side

These are three different outcomes, and the tests keep them apart:

- **Stale TILE, structurally valid.** The server sent it before the supersession
  reached it. It is delivered and the client discards it, counting `staleTiles`.
  The socket stays open. This is the frame-boundary race, not an error.
- **Skipped tile.** The dispatcher refused to start it: the generation was
  canceled, the file was missing or unreadable, or the size gate failed. It is
  counted in END `skipped` and never appears on the wire.
- **Malformed frame.** A size-gate failure detected *before* the frame starts is a
  skip. A failure *after* the first byte is fatal, because a truncated frame
  would desynchronize the WebSocket stream. The writer declares the frame length
  as `24 + fileSize` up front, and a short read before the advertised length
  throws.

## Tile streaming

`dispatchState()` per tile: check the liveness predicate, open the tile,
`ch.size()`, re-check the size gate, build the `TileHeader`, and hand both to
`WsWriter.transferTileIf()`. Any exception from open or size is a skip, not a
failure. The channel is published to `currentTile` for teardown and cleared in a
`finally`, and it is never closed on the success path.

`transferTileIf()` is the authoritative admission point and a zero-copy pump:

1. Encode the 24-byte UTP header.
2. Take the write lock.
3. Re-check the four liveness conditions. `SHUTDOWN` means stop the whole
   dispatch; `SKIPPED` means count this tile and continue.
4. Write the WebSocket frame header declaring `24 + fileSize`.
5. Write the 24 UTP bytes.
6. Loop `FileChannel.transferTo(offset, remaining, out)` at an explicit offset.
   The offset is explicit because `transferTo` never moves the channel position,
   so a plain positional-oblivious read would resend from a stale offset.
7. If `transferTo` returns 0 three times in a row, fall back to positional reads
   into a 64 KiB buffer. `SessionTest.zeroThenProgressNoFallback()` and
   `fallbackPersistentZero()` cover both halves of that rule.

Because the payload is pumped straight from the file to the socket, a 2 MiB tile
never exists as a `byte[]`. See
[concurrency-and-memory.md](concurrency-and-memory.md).

## The END rule

`WsWriter.writeEndIf()` holds the write lock and re-checks all of:

```text
!closeSent && !closed
state.sealed && !state.canceled && active.get() == state
state.work != null && nextIndex == state.work.size()
state.inFlight == 0
```

Only then does it serialize the 16-byte END. If the write happens, `dispatchState()`
clears `active` with a compare-and-set. The whole rule is inside the lock so a
cancellation that lands mid-dispatch cannot produce an END for a dead
generation.

`sent` counts frames the writer admitted, which means `sent` is the number of
TILE frames actually on the wire, and `skipped` is everything the dispatcher
walked past. The client checks this exactly, not just the total. See
[viewer.md](viewer.md#end-accounting).

## Close discipline

Three properties, and they are not interchangeable.

**`closed` is owned by `closeSession()` alone.** `closeSession()` CAS-sets it,
closes the socket, closes any in-flight tile channel, and releases the dispatcher
permit. Setting `closed` anywhere else makes the idempotent CAS return without
closing anything, which leaks the socket and leaves the dispatcher parked.
`SessionTest.closeSentClosedSplit()` pins the split.

**`closeSent` is separate and means "a Close frame was serialized".** Both the
reader and the dispatcher check it, and both stop as soon as it is set, even if
`closeSession()` has not run yet.

**Deterministic violations serialize a real Close control frame before teardown.**
`failSession(code, reason)` cancels the active and ready generations, CAS-sets
`closeSent`, writes opcode 0x8 with the code and a reason, then calls
`closeSession()`. The reason is truncated to 123 bytes on a UTF-8 boundary, so the
whole Close payload stays within the 125-byte control limit, and the truncation
logic backs up over continuation bytes so a multi-byte character is never split.

Codes used: 1002 for a protocol violation, 1003 for a text frame, 1007 for
invalid UTF-8, 1009 for an oversize inbound message. 1009 comes from
`WsFrame.WsProtocolException`, which carries the code to emit. The only path that
skips the Close frame is fatal I/O, where the frame cannot be written.

**Peer Close is cancel-first, then a three-way echo.** Cancel the active
generation so no new TILE starts (an in-flight TILE may finish, per RFC 6455
§5.5.1), then: an empty Close echoes empty, a valid code echoes itself, an
invalid code echoes 1002. The internal 1005 never goes on the wire in either
direction. `WsFrame.isValidPeerCode()` uses explicit sets rather than an
inclusive range: 1000 to 1003, 1007 to 1014, plus 3000 to 4999 private use. A
Close with a 1-byte payload is 1002.

A peer's 4002 is a valid private-use code, so it echoes as 4002 and carries no
UTP semantics. That is the browser's channel for reporting its own protocol
violations, because a browser cannot send 1002 from script.

## Dispatcher teardown and wakeup

`closeSession()` releases `readyPermit` so a dispatcher parked in `acquire()`
wakes, and closes the socket so a reader parked in `read()` wakes. The dispatcher
checks `closed` immediately after every wake and returns without emitting
anything. Symmetrically, a dispatcher-side fatal `IOException` closes the socket
first, which is what wakes the reader out of a blocked read.
`SessionTest.dispatcherFatalWakesReader()` and `idleCloseTerminatesBoth()` cover
both directions.

There are no deadlines and no keepalive timers in the session. An idle viewer
socket stays open until the client goes away or the process ends. This is a
deliberate choice for a trusted-LAN demo scope, and it means a browser tab left
open holds two virtual threads indefinitely.

## Control frames

`handleEvent()` handles the reassembled message events. Ping gets a Pong written
through the same `WsWriter` lock. Pong is a no-op. Text is either 1003 (valid
UTF-8, unsupported content) or 1007 (invalid UTF-8). Close follows the rules
above. Anything else is caught at the frame layer.

## Inbound framing

`WsFrame.readFrameHeader()` validates the client frame shape and returns a
`Header` without consuming the payload. Client frames must be masked, RSV must
be zero, the opcode must be one of the six known ones, control frames must be
unfragmented and at most 125 bytes, and the length encoding must be minimal in
both directions: a 126-form length below 126 is 1002, and a 127-form length below
65536 is 1002, as is a 127-form with the high bit set.

The inbound application cap is `Config.WS_MSG_CAP`, currently 1024 bytes, and it
is enforced twice on purpose. `nextEvent()` checks `pendingBytes() + payloadLen`
against the cap *before* reading the payload, so an oversize payload is never
buffered, and `WsFrame.Assembler.accept()` checks again as fragments accumulate.
A well-formed oversize message is 1009. This bound is why UTP control packets fit
comfortably: a chunk is 28 bytes and a COMMIT is 8.

`WsFrame.Assembler` returns `null` to mean "need more frames", so
`readerLoop()` just continues. A data opcode in the middle of a fragment is
1002, and a continuation with no open fragment is 1002.

## What is transport-coupled here

`SessionCoordinator` is constructed from an `InputStream`, a `WritableByteChannel`,
a `Closeable`, a `TileOpener`, and an `ImageLookup`. None of those are sockets by
type. `SessionTest` drives the whole state machine, including close ordering and
the writer lock, with a `ByteArrayInputStream`, a `RecordingChannel`, and a fake
socket. That is the concrete reason the session rules would survive a transport
swap: they are already tested without one.
