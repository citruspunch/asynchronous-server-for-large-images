---
phase: phase-05-concurrency-sessions
goal: GOAL-005 Coalesced-slot sessions plus teardown plus stale-vs-invalid
status: 'Planned'
parent: ./overview.md
version: 1.11
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 05 — Concurrency Sessions ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: One reader VT + one dispatcher VT per WS session; one
    serialized `WsWriter` on `ReentrantLock` (reader may call `writeControl`
    under it).
    - `AtomicReference` active + `AtomicLong lastReqIdSeen` (advances ONLY
      on accepted new generation — first valid chunk OR valid newer empty
      COMMIT) + `rejectedReqIds` under the FROZEN no-evict discipline
      (reader-owned `LinkedHashSet<Long>`; purge entries ONLY when
      `id <= lastReqIdSeen`; NEVER FIFO-evict a live entry — a 65th live
      rejected ID closes the connection with 1002 instead of evicting; cap
      64 retained for the bad-100→valid-2 anti-poisoning test).
    - `volatile` sealed/canceled + `AtomicBoolean` closed + teardown-only
      atomic tile-channel ref + idempotent cleanup.
    - Frozen active-clearing: dispatcher CAS-clears iff still its state after
      END — the ONLY lifecycle that clears a sealed generation, INCLUDING
      sealed-empty ones; reader CAS-clears iff still the ABORT-matched
      state; supersede overwrites.
    - FROZEN teardown/wakeup — `closeSession()` atomically sets `closed`,
      closes the socket (wakes a reader blocked in read), AND releases the
      dispatcher permit (wakes `readyPermit.acquire()`); the dispatcher
      checks `closed` immediately after EVERY wake (permit OR spurious) and
      exits emitting nothing; a dispatcher-side fatal I/O closes the socket
      first, which wakes the reader; idle sessions terminate BOTH threads
      with no COMMIT required; coordinated Close; immediate I/O/EOF abort;
      no deadlines by design.
  - **REQ-009**: COMMIT builds the COMPLETE immutable center-first `work`
    list OFF-queue FIRST, attaches it, publishes `sealed=true` last, then
    publishes ONE coalesced ready slot (a newer COMMIT replaces a stale
    unconsumed token; at most one retained generation); supersede marks old
    canceled first; END requires `active.get()==state` +
    `nextIndex==work.size()` + `inFlight==0`.
    - Three-way COMMIT: match→seal; valid-newer-empty→ build
      `work=List.of()`, attach, seal, publish through the SAME coalesced
      slot — the dispatcher walks zero tiles and sends END 0/0 followed by
      the normal CAS-clear ("immediate" describes the absence of tile work,
      NEVER a reader-side `writeBinary` END bypassing the dispatcher).
    - FROZEN branch order per packet: safe structural parse → history
      relation (matching-active continuation first, then
      `reqId <= lastReqIdSeen` → STALE-ignore) → full image-specific /
      semantic validation for genuinely newer generations.
    - FROZEN stale-vs-invalid — STALE (ignore + WARNING, keep alive):
      below-seen non-matching traffic, unknown-ABORT, STALE COMMITs,
      superseded non-active traffic, post-clear duplicates; INVALID
      (deterministic 1002 close, connection torn down, never a hang):
      chunk/COMMIT violating the CURRENT active generation (metadata
      mismatch, post-seal chunk, duplicate COMMIT while sealed) or
      chunk/COMMIT for a reqId in `rejectedReqIds` (checked BEFORE any
      new-generation acceptance — bad-9 → valid-9 → 1002, active never
      becomes 9); invalid-newer CHUNK (fails validation, reqId > seen,
      touches no active state): ignore + WARNING + RECORD in
      `rejectedReqIds` (or 1002-close when 64 live entries are already
      retained) — the connection otherwise stays alive (anti-poisoning
      preserved; that generation's later COMMIT hits the `rejectedReqIds`
      rule and closes instead of emitting a bogus END 0/0);
      invalid-newer COMMIT: deterministic 1002 IMMEDIATELY (COMMIT is the
      terminal client message — ignoring it would leave the browser waiting
      for END/epochCancel/wsClose forever; v1.10's record-and-ignore closed
      the chunk hole but left this liveness hole).
    - 3-point checks; `transferTile` WS `24+fileSize` + looped `transferTo`
      with BOUNDED zero-progress fallback (≤3 consecutive `0` returns, then
      POSITIONAL `src.read(dst64k, transferredOffset)` advancing an explicit
      `transferred` offset + `writeFully()` — `transferTo` does NOT move the
      channel position, so a plain `src.read(dst)` would resend from the
      stale position, commonly zero); EOF before the advertised length stays
      fatal.
    - Size gate pre-frame; SKIPPED pre-frame only, post-start fatal;
      frame-boundary cancel (ABORT/supersession NEVER close the current tile
      channel — an already-started TILE finishes, then the dispatcher
      observes `canceled`; a stale complete TILE may still arrive and the
      client discards it via `classify`); `0x04` iff sealed && !canceled &&
      active && drained && inFlight==0; browser owns corrupt verdict.
  - **SEC-002**: `Config.BIND` default `127.0.0.1:8080` (`--bind` opts into
    LAN); normalized `http://` Origin vs `Host` (absent allowed, AT MOST ONE
    Origin header — duplicates →400); `/ws` bodyless-only (global body gate
    inherited).
    - WS SINGLETON headers: exactly one `Sec-WebSocket-Key`, exactly one
      `Sec-WebSocket-Version` (duplicates →400 even when values agree);
      `Sec-WebSocket-Protocol` exactly-one is an UltraTile
      handshake-profile restriction (RFC 6455 allows repeats as a combined
      list; this server requires exactly one field line with exactly the
      token `ultratile.utp.v1`, labeled as such); `Connection` aggregated
      as a comma-token list across multiple field lines, case-insensitive,
      before the `upgrade` check.
    - Subprotocol `ultratile.utp.v1` REQUIRED (server echoes
      `Sec-WebSocket-Protocol: ultratile.utp.v1` in the 101; else 400);
      1 KiB cap (1009/1002/1003); version-mismatch 400 +
      `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
    - MINIMAL-LENGTH frame encoding enforced (`126`-form header decoding to
      <126 →1002; `127`-form header decoding to <65536 →1002; non-minimal
      encoding is a protocol error, never silently accepted).
- Prior-phase deps:
  - **DEP-004**: Requires 02 (channel API, padded store) + 03 (codecs,
    LOD-0-only, u32 discipline, freeze, three-way COMMIT, dedupe-aware cap)
    + 04 (strict lexical HTTP parser/router + framing-before-method gates
    this branch extends).
- Inputs: Nio stub + sealed codec + store + strict HTTP. Outputs:
  coalesced-slot sealed sessions with deterministic teardown and no-hang
  semantics.

## Tasks

### TASK-001 — WsFrame, WsWriter, handshake branch

- Create `NEW src/main/java/com/ultratile/ws/WsFrame.java` +
  `NEW WsWriter.java` + the WS branch of `NioHttpServer`.
- Handshake: `GET` re-asserted via the method gate; HTTP/1.1 lexical head
  from phase-04 (lone-LF/token/obs-fold rejection); one valid Host;
  absolute-form authority (if present) MUST ==Host else 400.
- SINGLETONS: `Sec-WebSocket-Key` count MUST ==1 (Base64-decoding to exactly
  16B else 400); `Sec-WebSocket-Version` count MUST ==1 (value MUST ==`13`
  else 400 WITH `Sec-WebSocket-Version: 13` advertise); `Origin` count MUST
  be ≤1; `Sec-WebSocket-Protocol` count MUST ==1 with value exactly
  `ultratile.utp.v1` (case-sensitive token match; absent/wrong/duplicated
  →400 — an UltraTile handshake-profile restriction, documented in the 400
  message and the protocol doc).
- `Connection` values joined across lines, split on commas, OWS-trimmed,
  lowercased, MUST contain `upgrade` (ci) else 400; `Upgrade==websocket`
  (ci, single effective value) else 400; Origin absent→allow else
  normalized-`http://`-authority==Host else 403; global body gate inherited
  (TE present (any) / any CL≠0 / duplicated CL →400, no upgrade); leftover
  kept only after bodyless valid upgrade.
- On success →101 with `Upgrade: websocket` + `Connection: Upgrade` +
  `Sec-WebSocket-Accept` (RFC 6455 §1.3 derivation from the request key) +
  `Sec-WebSocket-Protocol: ultratile.utp.v1`.
- `WsFrame` parser: masked-required→1002; RSV≠0→1002; opcode
  ∈{0x0,0x1,0x2,0x8,0x9,0xA} else 1002; NON-MINIMAL-LENGTH→1002 (`126` form
  decoding to <126; `127` form decoding to <65536); control FIN==1&&len≤125
  else 1002.
- Reassembly: continuation w/o open→1002; second data opcode mid-frag→1002;
  cumulative frag>1KiB→1009; Close len==1→1002; bad Close code/reason→
  1002/1007; 64-bit high-bit→1002; text(valid)→1003 downstream; Ping→Pong;
  server headers exactly 2/4/10B.
- `WsWriter` (one/session, `ReentrantLock writeLock`): `writeFully(ByteBuffer)`
  primitive; `writeBinary`, `writeControl`,
  `transferTile(TileHeader,FileChannel,size)` = WS header len `24+size` +
  24B UTP + looped `transferTo(transferred, remaining)` tracking an explicit
  `transferred` offset + `zeroStreak` counting consecutive `0` returns;
  `zeroStreak>3` → switch to POSITIONAL `src.read(dst64k, transferred)` +
  `writeFully()`, advancing `transferred` by bytes written; EOF before the
  advertised length → fatal teardown (never a short TILE); writer NEVER
  touches generation state (pure byte pump under the lock).
- `closeSession()` (frozen): atomically set `closed`, close the socket
  (wakes a blocked reader), AND release the dispatcher permit (wakes
  `readyPermit.acquire()`); dispatcher checks `closed` after EVERY wake.
- Done when: handshake helper (TASK-005) →101.

### TASK-002 — SessionCoordinator

- Create `NEW src/main/java/com/ultratile/ws/SessionCoordinator.java` around
  `GenerationState{reqId,imageId,zoom,lodMode==0,
  requested:LinkedHashSet<String>(reader-owned, pre-seal only),
  work:List<TileReq>(immutable, attached at seal),sent,skipped,
  sealed(volatile),canceled(volatile),inFlight}` + `TileReq{state,x,y}`.
- Session: `AtomicReference<GenerationState> active` (nullable) +
  `AtomicLong lastReqIdSeen` (0) + `rejectedReqIds: LinkedHashSet<Long>`
  (insertion-ordered, reader-owned, NO-EVICT: `purgeStale()` drops only
  entries with `id <= lastReqIdSeen` after every seen-advance; a record
  required while 64 live entries are retained → deterministic 1002 close,
  never eviction) + `readySlot`/`readyPermit` + `closeSession()` (TASK-001).
- There is NO tile queue and NO `queueEmpty` anywhere: the dispatcher walks
  `work` with a DISPATCHER-LOCAL `nextIndex` (per-dispatch local int — never
  shared, never volatile).
- FROZEN seen-rule (anti-poisoning): advance `lastReqIdSeen` to `reqId` ONLY
  when (a) the first valid chunk of a strictly newer generation is ACCEPTED
  (fully validated, state installed), or (b) a valid strictly-newer empty
  COMMIT is ACCEPTED (sealed-empty installed — even when an older active
  object still exists); same-generation chunks, matching COMMITs, ABORTs
  (any `ABORT_REQ_ID`, incl. future), and ALL rejects/invalids NEVER advance
  it; `reqId≤lastReqIdSeen` with no matching active continuation →
  STALE-ignore.
- FROZEN active-clearing: after the dispatcher sends END for `s`,
  `active.compareAndSet(s,null)` — the ONLY path that clears a sealed
  generation (empty ones included); on ABORT-match,
  `active.compareAndSet(matched,null)`; supersede overwrites via `set`
  (cancel-first ordering below makes the handoff safe).
- `onViewportChunk(v)` — FROZEN order:
  1. Parse u32→`long` (`toUnsignedLong`); shape-check (lengths, MAGIC, type).
  2. `purgeStale()`; then FROZEN rejected-check FIRST —
     `rejectedReqIds.contains(reqId)` → INVALID→1002 close (BEFORE any
     acceptance logic; closes the bad-9→valid-9 resurrection hole).
  3. History relation: `reqId==active.reqId` → append-case (metadata-match
     else INVALID→1002; `!sealed` else INVALID→1002 post-seal chunk; dedupe;
     never advances seen). Else `reqId<=lastReqIdSeen` → STALE-ignore
     (WARNING, keep alive — decided BEFORE full validation so old delayed
     packets with no-longer-valid images/coords are still correctly stale).
  4. Else genuinely newer (`reqId>lastReqIdSeen`, not rejected): FULL-validate
     (incl. `lodMode==0`, `min≤max`, image bounds via registry, span in
     `long`, dedupe-aware GEN_TILE_CAP); on failure → invalid-newer:
     record in `rejectedReqIds` (or 1002 if 64 live retained), WARNING, keep
     alive. On success → validate-before-supersede (mark old canceled,
     install new state), advance seen, attach chunk.
- `onCommit(c)` — FROZEN order: parse → rejected-check (`contains(reqId)` →
  INVALID→1002) → matching-active → seal (match→attach built work; empty →
  `work=List.of()`, seal, publish through the SAME coalesced slot) →
  `reqId<=seen` non-matching → STALE-ignore (stale COMMITs never close) →
  genuinely newer: FULL-validate (image/zoom/LOD known; emptiness is legal);
  on failure → INVALID→1002 IMMEDIATELY (invalid-newer COMMIT — never
  record-and-ignore: COMMIT is terminal and the waiter has no other
  resolution); on success with empty work → install sealed-empty + advance
  seen (dispatcher sends END 0/0 + CAS-clears).
- `onAbort(a)`: `(imageId,reqId)` must match `active` else STALE-ignore
  (unknown-ABORT, never advances seen); on match → mark canceled +
  `active.compareAndSet(matched,null)`; terminal, no END; NEVER closes the
  tile channel (frame-boundary cancel).
- Dispatcher loop: `readyPermit.acquire()` → `closed`-check → take
  `readySlot` → walk `work` from local `nextIndex`: per tile 3-point checks
  (sealed && !canceled && `active.get()==state`); MISS → SKIPPED pre-frame
  only (post-start tile failure is fatal); HIT → `transferTile` (TASK-001
  semantics); after drain with `inFlight==0` → send `0x04`
  (sent,skipped) → `active.compareAndSet(state,null)`. No END on canceled.
- Done when: `SessionTest` green (TASK-004 vectors).

### TASK-003 — Read-loop wiring

- Wire `NioHttpServer` WS read-loop: reassembled binary `AA 01`→28B chunk;
  `AA 05`→8B commit; `AA 03`→8B abort; `AA` bad len→1002.
- STALE semantic →WARNING keep-alive (v1.8's blanket keep-alive is SPLIT:
  only stale stays silent); INVALID semantic (TASK-002 rules)
  →deterministic 1002 close with FINE log (no UTP ERROR packet — the close
  IS the error signal; the browser's `END-or-epochCancel-or-wsClose`
  awaiter resolves via `wsClose`, never hangs); text→1003; oversize→1009.
- FINE logs. `sameOriginHttp` normalized helper.
- Done when: TASK-005 helper →101 and TASK-004 green.

### TASK-004 — SessionTest + WsFrameTest vectors

- Create `NEW src/test/java/com/ultratile/ws/SessionTest.java` +
  `WsFrameTest.java`: v1.10 suite ADJUSTED —
  - rejected-chunk(`reqId=9`, bad coords) then COMMIT(`9`) →1002 and NEVER
    END 0/0; NEW bad-9→valid-9 resurrection: rejected-chunk(`9`) then VALID
    chunk(`9`) →1002, `active` never becomes 9, `lastReqIdSeen` never
    becomes 9.
  - Invalid-newer SPLIT: invalid-newer CHUNK(`reqId=100`) → recorded +
    WARNING, connection alive; then invalid-newer COMMIT(`reqId=101`, bad
    image) → 1002 IMMEDIATELY (liveness: no recording without close for the
    terminal message). Valid `reqId=2` after a recorded chunk → still
    accepted (anti-poisoning intact).
  - No-evict: fill 64 live rejected IDs, record a 65th → 1002 close (never
    eviction); purge-on-stale: rejected-100, accept valid 101 (seen→101),
    then chunk-100 → STALE-ignore (purged, connection alive).
  - History-before-validation: chunk for an OLD generation (below seen)
    with an image id that no longer exists → STALE-ignore, connection alive
    (never 1002 — validation must not run before the history check).
  - Duplicate COMMIT after END-sent + active-cleared → STALE (no close, no
    second END); stale COMMIT for a superseded generation → ignored.
  - Empty COMMIT dispatches through the slot (assert the DISPATCHED END 0/0
    + CAS-clear — and `rg -n "writeBinary" SessionCoordinator.java` shows
    NO reader-side END write).
  - Teardown/wakeup: `idleCloseTerminatesReaderAndDispatcher` (EOF with idle
    dispatcher in `acquire()` → both threads exit, no COMMIT needed, no
    hang); dispatcher-fatal-I/O wakes a blocked reader (socket close
    observed); NO channel-close-on-cancel (ABORT during an already-started
    TILE → TILE completes OR dispatcher stops at the NEXT frame boundary;
    connection stays open; assert channel `close()` never called on the
    cancel path).
  - Stale-vs-invalid: post-seal chunk for active →1002 (not WARNING);
    metadata-mismatch chunk for active →1002; duplicate COMMIT while sealed
    →1002; unknown-ABORT (wrong image) → ignored, connection alive.
  - Handshake singletons: duplicate `Sec-WebSocket-Key` →400; duplicate
    `Sec-WebSocket-Version` →400; duplicate `Origin` →400;
    missing/duplicated/wrong `Sec-WebSocket-Protocol` →400;
    `Connection: keep-alive` + `Connection: Upgrade` split lines →101
    (aggregation); subprotocol echoed in 101.
  - Positional fallback: stub returns `2,0,0,0,0` (2 bytes progress THEN
    persistent zeros) → fallback transmits the REMAINING bytes from offset 2
    via positional `read` (assert byte-exact full payload — the v1.9
    plain-`read` form would resend from position 0 and fail this vector);
    stub returns `0,0,0,0` persistently → fallback transmits exact bytes;
    stub returns `0,0` then progress → no fallback, exact bytes; `read()`
    EOF early → fatal teardown; `format=2` TILE never emitted by any server
    path (rg + behavior).
  - Dedupe-at-cap: 256 unique keys then duplicate existing → accepted, then
    257th unique → rejected. Minimal-length: synthetic `126`-form frame with
    length 124 →1002; synthetic `127`-form frame with length 1000 (<65536)
    →1002; minimal 126/127 forms (126 and 65536) accepted.
- Done when: `mvn -q test` green (offline validation track).

### TASK-005 — ws_handshake_check.py helper (FILE-013)

- Create `NEW scripts/ws_handshake_check.py` (stdlib, TEST-ONLY): opens a raw
  socket, sends a well-formed upgrade for `/ws` with the mandatory
  subprotocol, reads EXACTLY through `\r\n\r\n` (never `head -N` on an open
  connection — a correct 101 has fewer than 12 lines and never EOFs, so the
  v1.9 `head -12` form hangs), asserts 101 +
  `Upgrade`/`Connection`/`Accept`/`Sec-WebSocket-Protocol`, then closes.
- Flags `--expect {101,400}` + repeatable `--extra-header "Name: value"`
  cover the singleton/subprotocol negative probes deterministically
  (dup-Key→400, missing-subprotocol→400, version-12→400+advertise).
- Done when: `--expect 101` green against the TASK-003 server; each negative
  probe asserts its expected status (see Validation Commands).

## Validation Commands

Offline validation track:

```sh
mvn -q test -Dtest=SessionTest,WsFrameTest,UtpCodecTest,TileMathTest
mvn -o -q clean package -DskipTests
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$pid"; exit 1; }
python3 scripts/ws_handshake_check.py --expect 101 || { echo "handshake helper failed" >&2; kill "$pid"; exit 1; }
python3 scripts/ws_handshake_check.py --expect 400 --extra-header "Sec-WebSocket-Version: 12" | grep -qi "Sec-WebSocket-Version: 13"
python3 scripts/ws_handshake_check.py --expect 400 --extra-header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" --extra-header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" || { echo "dup-Key probe failed" >&2; kill "$pid"; exit 1; }
python3 scripts/ws_handshake_check.py --expect 400 --no-subprotocol || { echo "missing-subprotocol probe failed" >&2; kill "$pid"; exit 1; }
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Coalescing replaces FIFO: the ONLY dispatch trigger is the single permit
  for a fully-built sealed `work` list, and only the LATEST published
  generation survives to dispatch. `sealed=true` ordering still holds AND is
  now insufficient-by-itself by design (belt and suspenders, tested). Empty
  generations are NOT special-cased around the dispatcher — uniformity is
  what makes the active-clearing invariant ("only the dispatcher CAS-clears
  after END") hold without exceptions.
- Seen-rule summary: accept-new-generation advances (chunks AND
  newer-empty-COMMITs); everything else never does. ABORT is
  history-neutral. `rejectedReqIds` is the memory that makes "reject without
  poison" composable with "empty COMMIT means intentional" — and the
  no-evict discipline is what makes the memory sound: purge-on-stale keeps
  it bounded in practice (every accepted generation retires all older
  rejections), while close-on-65th-full keeps the adversarial case bounded
  without reopening the hole.
- The COMMIT-liveness split is THE v1.11 liveness fix: a recorded chunk is
  safe to ignore because its COMMIT is still coming and WILL close; a COMMIT
  is terminal, so it must close itself. Stale COMMITs (below-seen,
  non-matching, superseded) stay silent — they belong to dead generations
  whose waiters are already gone.
- History-before-validation is the matching robustness fix: with no
  deadlines anywhere, delayed duplicates of dead generations must die as
  STALE even when the world has moved on (image deleted, pyramid rebuilt).
  Validation answers "could this generation ever be real"; history answers
  "is this generation live" — history goes first.
- "No queue" is literal: `rg -in "queueEmpty|QUEUE_CAP|PriorityQueue|priority
  queue" src/main/java/` must print NOTHING after this phase. The
  dispatcher-local `nextIndex` is the drain position.
