# The browser viewer

> This document describes the viewer as it exists in `src/main/resources/web/`.
> There is no build step and no framework, so the source is the only authority
> for how it works, and the source wins where this document is stale.
>
> The UTP wire functions the viewer calls are specified normatively in
> [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md) §3 and §4. This document
> covers the browser side of that contract only.

## Module layout

Ten classic scripts, loaded with `defer` in this order, sharing one global
lexical scope. There are no imports, no bundler, and no CDN. Load order is
semantic: a top-level `let` in an earlier file is visible to every later one, so
reordering the tags would break the code.

| # | File | Owns |
| ---: | --- | --- |
| 1 | `constants.js` | Shared tunables and wire values, plus viewer-local policy |
| 2 | `structures.js` | `createReqAllocator`, `LruCache`, `DecodePipeline`. No module-state reads. |
| 3 | `state.js` | Every mutable binding in the app, and `BatchState` |
| 4 | `geometry.js` | Pyramid math, LOD selection, budgets, coverage, chunk runs |
| 5 | `codec.js` | `encodeViewport`, `encodeCommit`, `encodeAbort`, `parseTileHeader`, `parseEnd` |
| 6 | `epoch.js` | `newViewEpoch` cleanup and decode completion |
| 7 | `render.js` | Canvas compositing and the HUD |
| 8 | `net.js` | Connection, the receive pipeline, END accounting |
| 9 | `batches.js` | The network batch loop |
| 10 | `app.js` | Boot, `selectImage`, input handlers, the `globalThis.UltraTile` seam |

The module list is duplicated in three places, and this is a known trap: the
`<script>` tags in `index.html`, `VIEWER_FILES` in `scripts/test_viewer.cjs`, and
`JS_FILES` in `scripts/check_const_parity.py`. Both scripts assert the ordering
against `index.html`, and parity also fails if the old monolith
`src/main/resources/web/viewer.js` reappears.

### Constants and the parity map

`constants.js` splits into three groups, and the split is enforced:

- **Shared tunables**, each with a `Config.java` counterpart: `TILE`, `MAX_CACHE`,
  `MAX_DECODE`, `DECODE_QUEUE_MAX_JOBS`, `DECODE_QUEUE_MAX_BYTES`, `MAX_TILE_BYTES`,
  `BATCH_CAP`, `AVG_TILE_SEED`, `SCALE_MIN`, `SCALE_MAX`, `SPAN_CAP`,
  `GEN_TILE_CAP`.
- **Shared wire values**, each with a `UtpMessages.java` counterpart: `MAGIC`,
  `T_CHUNK`, `T_TILE`, `T_ABORT`, `T_END`, `T_COMMIT`, `LOD_NEAREST`,
  `FORMAT_JPEG`, `REQ_ID_MAX`.
- **Viewer-local policy**, deliberately outside the parity map and with no Java
  counterpart: `PLAN_FLOOR`, `CLOSE_UTP_ERROR`, `UNION_CAP`, `INTENT_DEBOUNCE_MS`,
  `TAU`. The parity script fails if `PLAN_FLOOR` is ever added to the map, and it
  also fails if `ws.close(1002` or a codeless `ws.close()` appears anywhere in the
  bundle.

## Bootstrap

`boot()` is the only startup flow, and it is idempotent through a cached
`bootPromise`:

1. `resizeCanvas()`.
2. `GET /api/images`.
3. Populate the picker, one option per image labelled `image-<id>`, and select
   the first. An empty list produces a single `no images` option and no network
   traffic at all.
4. `connectWs()`.
5. `selectImage(list[0].id)`.
6. `installHandlers()`.
7. `render()`.

`connectWs()` builds `ws://<location.host>/ws`, which is same-origin by
construction, offers the subprotocol `ultratile.utp.v1` as the second argument,
sets `binaryType = "arraybuffer"`, waits for `open`, and then asserts
`socket.protocol === "ultratile.utp.v1"`, rejecting the connection on a mismatch.
It also fails every outstanding batch first, so a reconnect never leaves a
half-dead `BatchState` behind.

The socket is opened before the first image is selected, so no packet can precede
`open`. The Node harness asserts that.

## The tile ownership pipeline

```text
needed                        requestableKeys(): not cached, not pending,
   │                          not queued or in flight, not terminally failed,
   │                          not skipped by the server, coordinates finite
   ▼
pending-network               pending: Map(key -> reqId), set at send time
   │                          deleted THE MOMENT the tile's header is parsed
   ▼
received / decode-owned       receivedThisEpoch.add(key), then either
   │                          decodePipeline.submit() or a terminal/retry set
   ├─ queue full ──────────▶ retryNeeded        (same epoch, retried later)
   ├─ format != 1 ─────────▶ terminalFailed     (epoch-scoped, not retried)
   └─ decode resolves ─────▶ cached             (LruCache)
                                  │
                                  └─ evicted ──▶ close(), no longer suppressed
```

`serverSkippedThisEpoch` is a fourth suppression set with no ownership
transition. When an END arrives, every expected key the batch did not receive is
added to it, and its `pending` entry is dropped. The server decided those tiles
are not coming this epoch, so the viewer does not ask again until the epoch
changes.

`requestableKeys()` is the single place that decides what may be asked for, and it
suppresses on the union of all six sets. That is what stops a rebuild loop: a key
that was just received, skipped, or terminally failed is not re-sent within the
same epoch.

### Request-id allocation

`createReqAllocator(start)` is a closure with a private counter starting at 1 and
a hard ceiling of `REQ_ID_MAX` (0xFFFFFFFE). It never wraps: on exhaustion it
returns `{ok:false}`, and `allocReqId()` in `net.js` responds by reconnecting
once and retrying the allocation against a fresh allocator starting at 1. Only a
new socket restarts the sequence, which is exactly the rule the protocol requires
for continuity across an image switch.

A switch does not reset the allocator. `selectImage()` reuses the socket and
continues the sequence, and the harness pins that
(`selectImage reuses the socket and continues reqIds`).

## Image switching

`selectImage(id)` is the sole owner of the switch transaction, and the picker
handler calls nothing else. The whole function is epoch- and switch-guarded at
every await.

```text
 1  abort the newest live generation, if any       sendAbort(latestLiveReqId())
 2  mySwitch = ++imageSwitchSeq                    the switch guard
 3  pendingSwitch = {seq, id}                      tells newViewIntent() to defer
 4  myEpoch = newViewEpoch()                       invalidates viewport work
 5  abort the previous /info fetch, start a new AbortController
 6  await GET /api/images/<id>/info
 7  if (mySwitch !== imageSwitchSeq) abandon silently
 8  currentImage = {id, w, h, levels}
 9  cache.clear()                                  closes every bitmap first
10  decodePipeline.purgeQueued(() => true)
11  resizeCanvas(); camera = initialCamera(...)
12  avgTileBytes = AVG_TILE_SEED; tileSamples = 0
13  pendingSwitch = null
14  re-check mySwitch
15  pin ONE zoom-0 generation, await it fully
16  run the effective-LOD batches
17  if a viewport intent was deferred during the fetch, run it now
18  render()
```

### viewEpoch and imageSwitchSeq

Two counters, two jobs, and the difference is the point.

`viewEpoch` is bumped on **every** viewport intent: pan, zoom, resize, and image
switch alike. It is the ownership guard. Anything carrying an epoch that is not
the current one is discarded, and `newViewEpoch()` cancels the previous epoch's
awaiters so no batch loop is left hanging.

`imageSwitchSeq` is bumped **only** by `selectImage()`. It guards the one thing an
epoch bump cannot: the `/info` fetch. A slow metadata response for image 4 can
arrive after the user has already asked for image 5, and only the switch counter
can tell that apart. `A->B race: late A abandons` and `rapid A-B-A resolves to the
latest dims once` are the tests for it.

The frozen cleanup order in `newViewEpoch()` matters and is worth reading as a
unit: bump the counter, cancel old epoch awaiters, cancel and reject old batches,
delete batches two epochs old, drop `pending` entries from other epochs, clear
`retryNeeded`, `terminalFailed`, `serverSkippedThisEpoch`, and
`receivedThisEpoch`, then purge queued decodes whose epoch is not current.
In-flight decodes are never purged, only queued ones, because a decode already
running cannot be cancelled and its result still needs an owner. It resolves
into `onDecodeResolved()`, which closes the bitmap if the epoch moved on.

### Deferred intents

`newViewIntent()` (the pan, zoom, and resize path) returns immediately with a
local render and `deferredIntent = true` if `pendingSwitch` is set. So a resize
during an in-flight metadata fetch does not touch the switch, and the switch picks
the deferred intent up at step 17. Conversely, a switch arriving mid-batch cancels
the old epoch's work through the normal epoch mechanism.

Input handlers debounce at `INTENT_DEBOUNCE_MS` (80 ms) via `scheduleIntent()`,
which coalesces a pointermove stream into one intent. The promise it returns has
a `.catch()` attached purely for hygiene: the handlers fire-and-forget, and a
protocol-fatal rejection is already surfaced through the HUD counters and
`failAllBatches`, so it must not become an unhandled rejection.

## Camera, level selection, and visible tiles

The camera is a scale plus a center in image coordinates: `camX`, `camY`, `camS`.

`initialCamera(W,H,Vw,Vh)` centers the image and fits it:
`s = clamp(min(Vw/W, Vh/H), SCALE_MIN, SCALE_MAX)`, with `SCALE_MIN = 1e-3` and
`SCALE_MAX = 32`.

Pan is a pointer drag divided by `camS`, clamped to `[0,W] x [0,H]`. Zoom is a
wheel with `factor = exp(-deltaY * 0.001)`, anchored at the cursor: the world
point under the cursor is computed before the scale change and re-solved after, so
the pixel under the pointer stays put. The new scale is clamped the same way, and
the center is re-clamped afterward.

`selectLevel(s)` chooses the level to request:

```text
N      = maxLevelFor(w, h)
zFloat = clamp(N + log2(s), 0, N)
z      = clamp(round(zFloat), 0, N)
```

`maxLevelFor` is the log form of the same ceiling-pyramid math the server uses.

`effectiveLOD(desired)` is where the request budget is enforced. It walks down
from the desired level and returns the first level whose union of visible tiles
across all levels `0..E` fits in `UNION_CAP` (36):

```text
for E = desired down to 0:
    union = all visible tile keys at levels 0..E
    if |union| <= 36: return {desired, effective: E, downgraded: E < desired}
return {desired, effective: 0, downgraded: desired > 0}
```

So a deep zoom that would need 400 tiles at the finest level is downgraded to a
level that needs 36, and the HUD shows the downgrade as `lod` versus `effZ`. The
pin of one zoom-0 generation per switch is a separate step and is not part of
this calculation.

`visibleTileRange(Z)` maps the viewport rectangle to a tile rectangle, clamps to
the image, converts with `k = 2^(Z-N)`, and clamps to the level grid. The
half-open convention matters: `tx0 = floor(ix0 * k / TILE)` and
`tx1 = ceil(ix1 * k / TILE) - 1`, so a viewport edge exactly on a tile boundary
does not pull in a neighbour.

## Batching

`splitIntoBatches(keys, budget)` groups keys by level, sorts levels descending so
the finest is served first, and within a level sorts by `y` then `x` and collapses
consecutive `x` in the same row into runs. Those runs are the wire chunks, and
`chunkRuns()` performs the same collapse for the send path. A run longer than the
budget is split across batches.

```text
budget = min(BATCH_CAP,            # 30
             freeJobs,             # 24 - (queued + in flight)
             max(1, floor(freeBytes / planTileBytes)))
planTileBytes = max(avgTileBytes, PLAN_FLOOR)   # PLAN_FLOOR = 65536
```

`avgTileBytes` is the running mean of received `payloadLen`, seeded at 131072 and
reset on every image switch. The floor matters for a specific failure: a synthetic
or very smooth pyramid produces 15 KB tiles, so without a floor the budget would
compute to 273 and exceed `BATCH_CAP`, and without `BATCH_CAP` a batch could
exceed `GEN_TILE_CAP` and be refused by the server. The clamp order is
`min(BATCH_CAP, ...)` for that reason. Two harness tests
(`tiny-tile streaks plan against the floor`, `mean governs once avgTileBytes
clears the floor`) pin both halves.

`runViewportBatches()` is the loop, and every stage is epoch-checked:

```text
for each level:
    needed = requestableKeys(visibleTileRange(z))
    for each group from splitIntoBatches(needed, budget):
        await waitHeadroom(epoch)          # never send without decode headroom
        recompute the budget, re-split
        batch = await sendGeneration(...)  # chunks, then COMMIT
        await drainBatch(batch, epoch)
then, up to 8 rounds:
    re-request whatever landed in retryNeeded
```

`waitHeadroom()` subscribes to the decode pipeline's drain event and re-checks
`headroomOk()` on each wake, so it parks instead of spinning.

`drainBatch()` awaits `batch.done` and then waits for the decode references to
reach zero, re-checking the epoch on a 20 ms poll. It never waits on coverage.
The distinction is deliberate and load-bearing: `covCov` is a pixel-level
observation, not a network state, and gating on it would deadlock whenever a level
is not being fetched.

## The receive pipeline

`onWsMessage()` dispatches on frame length: 16 bytes is an END, anything else is a
TILE. Then, for a TILE, in this exact order:

1. **Parse.** `parseTileHeader()` checks `byteLength >= 24`, that
   `byteLength === 24 + payloadLen`, the magic, the type, `tileSize === 512`, and
   the payload bounds. A failure increments `tileLenMismatch` and closes with
   4002, **before any accounting runs**.
2. **Accounting.** `rxBytes += payloadLen`, `tileSamples += 1`, and the running
   mean update. `rxBytes` counts payload bytes only, never headers or framing,
   and duplicates are counted.
3. **Classify.** `classify(reqId)` returns `"stale-unknown"` for a reqId with no
   `BatchState` (a superseded generation that has already been reclaimed, whose
   END was never awaited). That increments `droppedUnexpected` and returns.
4. **Epoch.** A batch from another epoch increments `staleTiles` and returns, with
   the socket left open. This is the frame-boundary race.
5. **Membership.** A key not in `expectedKeys`, a canceled batch, or an
   `imageId`/`zoom` mismatch increments `droppedUnexpected` and returns.
6. **Duplicate.** A key already in `receivedKeys` increments `dupTiles` and
   returns without decoding a second time.
7. **Accept.** `receivedKeys.add`, `receivedThisEpoch.add`, `pending.delete(key)`.
8. **Format.** `format !== FORMAT_JPEG` adds to `terminalFailed`. No decode, no
   retry. A stale-format tile never reaches this step, so a stale FORMAT=2 cannot
   poison the current epoch.
9. **Admission.** If the queue is over its job cap or adding this tile would
   exceed its byte cap, the key goes to `retryNeeded` instead. The payload has
   already arrived at this point, so a full in-flight set is ordinary pressure,
   not a reason to retry.
10. **Decode.** `buffer.slice(24)` copies just the JPEG out of the message and
    `decodePipeline.submit()` takes ownership.

`buffer.slice(24)` is a view, not a copy, in a real browser, so the copy is
implicitly the Blob construction inside `defaultDecode`. Either way the 24-byte
UTP header is not retained.

### END accounting

`onEndMessage()` is exact, and a mismatch is fatal:

```text
e.sent + e.skipped == b.expectedKeys.size()
e.sent             == b.receivedKeys.size()
e.skipped          == b.expectedKeys.size() - b.receivedKeys.size()
```

Checking only the first total would let a duplicate delivery mask a missing tile.
A stale or old-epoch END increments `staleEnds` and leaves the connection alone. A
current-epoch END with the wrong `imageId` or with counts that do not reconcile
increments `endCountMismatch` and calls `protocolFatal()`.

On a good END: `networkComplete = true`, every expected key not in `receivedKeys`
goes to `serverSkippedThisEpoch` and loses its `pending` entry, then `doneResolve()`.

`protocolFatal()` closes with `CLOSE_UTP_ERROR` (4002) and a reason truncated to
123 bytes, then fails every batch. 4002 is a private-use code because a browser
cannot send 1002 from script. The server's Close parser accepts and echoes it
without attaching any UTP meaning to it.

## Decode pipeline and cache

`DecodePipeline` is a bounded queue plus a bounded in-flight set, with a byte
counter on the queue only.

```text
maxInflight = 6        concurrent createImageBitmap calls
maxJobs     = 24       queue length
maxBytes    = 4 MiB    sum of queued item.len
```

`submit()` enqueues and pumps. `pump()` starts items while there is in-flight
room, shifting bytes off the queue counter as it goes, so the byte cap governs
queued work only, which is why 6 in-flight tiles at 2 MiB each is not counted
against the 4 MiB queue. `has(key)` searches both the queue and the in-flight
map, which is what makes it a correct duplicate guard. `purgeQueued(pred)` drops
matching queued items and never touches in-flight ones.

`defaultDecode()` wraps the bytes in a `Blob` and calls `createImageBitmap()`. The
decode itself is off the JavaScript thread inside the browser, which is why a
cap of 6 is a memory cap rather than a CPU cap.

`LruCache` is capacity 40, insertion-ordered via a `Map`, with `get()` refreshing
recency. Eviction picks the first **unpinned** key, closing its bitmap; if
everything is pinned it falls back to the oldest key. `onDecodeResolved()` pins
`z === 0`, so the one-tile overview level is evicted last, though not never.
`clear()` closes every bitmap, which is what `selectImage()` does before adopting a
new image.

Rendering calls `cache.get(k)` for every entry on every frame, so a render
refreshes LRU recency. A tile that is merely visible is therefore protected from
eviction by being looked at, which is the intended behavior for a viewport that
has not moved.

### A known tightness at 4K

A 4K viewport (3840 x 2160 CSS px) at full zoom, meaning scale 1.0, needs about
8 x 5 tiles, so 40 tiles, which is exactly the cache capacity. The cache also
pins the single `z = 0` overview tile, which occupies a slot. In that specific
case one visible tile is evicted and re-fetched, and the user may see it flicker
back in on small pans.

This is recorded rather than fixed. Raising `MAX_CACHE` costs browser memory
linearly, and the fallback is correct, just wasteful. If you change it, change
`Config.CACHE_CAP` and `constants.js` together, or parity will fail.

## Rendering

`render()` is best-effort and never throws into the network pipeline. The order is
fixed:

1. `resetTransform()`, then `clearRect(0,0,viewW,viewH)` and a black `fillRect`.
   Screen space, before any transform.
2. `save()`, translate to the viewport center, `scale(camS)`, translate by
   `-camX, -camY`. That is `screenX = Vw/2 + s * (worldX - camX)`.
3. `beginPath()`, `rect(0, 0, W, H)`, `clip()`. The clip is what trims the black
   padding off edge tiles.
4. Collect the cache entries for the current image, sort by `z` **ascending**, and
   draw each at a `512 * 2^(N-z)` footprint with its top-left at
   `(x * 512 * k, y * 512 * k)`. Coarse under fine.
5. `restore()`.

The whole body is wrapped so a failure degrades to a blank frame rather than an
exception in a network callback. A harness test asserts `clearRect` runs before
any tile draw.

## HUD and counters

`updateHud()` writes thirteen fields, all `textContent` on `<b>` elements inside
`#hud`:

| Field | Meaning |
| --- | --- |
| `lod` | desired level from `selectLevel` |
| `effZ` | effective level after the `UNION_CAP` downgrade |
| `rxBytes` | TILE `payloadLen` received, duplicates included |
| `decodedBytes` | payload bytes at cache insert, **not** bitmap size |
| `reqs` | request IDs allocated |
| `evicts` | LRU evictions |
| `cache` | entries currently cached |
| `decJobs` | queued plus in-flight decodes |
| `decBytes` | queued bytes |
| `epoch` | `viewEpoch` |
| `gen` | last allocated reqId |
| `netCov` | `|receivedThisEpoch ∪ serverSkippedThisEpoch|` |
| `covCov` | cached divided by needed, over the union of visible tiles at **all** levels |
`covCov` is observational only and control flow never waits on it. It is worth
knowing that it is computed over the union across every level `0..N` while only
one effective level is being fetched, so in normal operation it reads low and is
not a coverage failure indicator. `netCov` is the network-progress counter and is
the one that matches what the server did. It also survives `BatchState` reclaim,
since a key that was received and then reported skipped counts once.

`decodedBytes` is a payload counter, not a memory counter. The memory envelope is
in [concurrency-and-memory.md](concurrency-and-memory.md).

## The public seam

`globalThis.UltraTile` exports the functions the Node harness needs:
`createReqAllocator`, `connectWs`, `selectImage`, `boot`, `newViewIntent`, the
five codec functions, `selectLevel`, `visibleTileRange`, `effectiveLOD`,
`splitIntoBatches`, `DecodePipeline`, `LruCache`, `epochToken`, `BatchState`,
`classify`, `headroomOk`, `batchBudget`, `newViewEpoch`, `decodeRefs`, `netCov`,
`covCov`, and `switchState`. It is a test seam, not a public API; nothing in the
served page calls it.

`scripts/test_viewer.cjs` concatenates the ten files into one `node:vm` script so
the shared lexical scope behaves the way deferred script tags make it behave in a
browser, then runs 42 tests against it. No browser, no network, no dependencies.
