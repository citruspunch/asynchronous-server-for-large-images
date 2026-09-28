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
| 2 | `structures.js` | `createReqAllocator`, `LfudaCache`, `DecodePipeline`. No module-state reads. |
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

**The page has to start itself.** `boot()` is the only startup flow, and it is
also the entry point: the last top-level block in `app.js` calls it, guarded by
`typeof window !== "undefined"`. Without that call the page did nothing at all
on load — no `GET /api/images`, so the picker stayed empty; no
`installHandlers()`, so the dropdown had no `change` listener; and no
`render()`, so the canvas stayed at its `#000` CSS background. That presented as
a black page under a live header, and nothing in the suite caught it because
every test drives `boot()` explicitly through the seam.

Two properties of the guard matter. It is the same `typeof window` probe
`installHandlers()` already uses, and neither the `vm` sandbox in
`scripts/test_viewer.cjs` nor the one in
`scripts/cache_workload_benchmark.cjs` defines a `window` binding, so both
harnesses still boot only when they call `boot()`, and `bootPromise` keeps a
second call idempotent regardless. And the block is last in the file, so it is
the only top-level side effect in the viewer and everything it needs is already
defined above it.

The same block drives the `#status` pill in the header: `starting`, then
`connected`, or `startup failed: <message>`. A rejected boot is the difference
between a working viewer and a black rectangle, so the page states which
happened instead of failing silently. It is also the one place a boot failure
is visible at all, since `render()` never runs to paint the HUD.

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
   └─ decode resolves ─────▶ cached             (LfudaCache)
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

### The LFUDA-40 decoded-bitmap cache

`LfudaCache` is the decoded-bitmap cache, capacity `MAX_CACHE = 40`, and its
replacement policy is **LFUDA, Least Frequently Used with Dynamic Aging**. That
is the whole policy name; it is not a private invention and it is not a
renamed recency list. LRU is deliberately absent from this codebase: the course
requires each group to use a distinct replacement algorithm, and another group
has taken LRU.

The policy is **frozen**. This section, together with the 25 vectors under
`lfuda cache` and `lfuda integration` in `scripts/test_viewer.cjs` and the
invariants in `scripts/cache_workload_benchmark.cjs`, is the whole specification.
Future work must not change it for benchmark results or for aesthetics. Reopen it
only for a reproducible correctness problem found in a browser, an instructor
rejecting the adaptation, or a grading requirement. The frozen properties are:

```text
LFUDA-40                capacity 40, LFUDA among eligible entries
priority rule           priority = age + frequency
monotonic age           age = max(previousAge, victim.priority)
epoch reference rule    at most one frequency per viewport epoch
victim comparator       (priority, insertedSeq), never recency
admission guard         the just-admitted key is never its own victim
target/Z0 protection    eligibility only, never a fake frequency
bitmap ownership        exactly-once close() on eviction, clear and replace
```

LFUDA is the LRFU-family policy that subsumes plain LFU. The core idea is a
per-entry frequency plus a global aging watermark, so that popularity earned
long ago stops mattering as the cache keeps working, instead of pinning a tile
forever the way naive LFU does.

Precisely what is textbook LFUDA and what is an UltraTile adaptation. The
distinction matters because a viewer adds a protection layer that a textbook
cache does not have, and the adaptation exists only to keep LFUDA working under
it:

```text
LFUDA core, unchanged:
  frequency              reuse count for a tile
  priority = age + frequency
  dynamic aging          age rises as the cache works
  victim                 the lowest priority among the candidates

UltraTile adaptations, each documented and tested below:
  viewport + z0 eligibility   which keys MAY be evicted
  admission exclusion         the just-admitted key is never its own victim
  once-per-epoch references   what counts as a frequency
  monotonic watermark         age = max(age, victim.priority)
```

Stated as one sentence: UltraTile uses LFUDA replacement among **eligible** cache
entries, with dynamic frequency-based priorities and aging; because viewport and
`z0` protection filter the candidate set, the global LFUDA age is maintained as a
**monotonic** watermark using `max(currentAge, victimPriority)`.

**Entry metadata.** Each cached tile carries `bitmap`, `bytes` (payload length,
for the `decodedBytes` counter), `frequency`, `priority`, `insertedSeq`, and
`lastCountedEpoch`. The cache additionally owns one global `age`, and two
protection sets: `pinned` (the `z === 0` overview, set at insert) and `target`
(the current viewport epoch's visible set).

An entry's `priority` is fixed when it is written and rebased only when it is
referenced again, so `priority - frequency` is the watermark as it stood at that
moment. With the monotonic rule, an entry may legitimately sit **below** the
current watermark: viewport protection can hold it there. That is not an error. It
means a stale entry whose frequency has not been refreshed in a long time and
which survived only because it was protected. Sitting below the floor is exactly
what makes it the strongest eviction candidate once protection goes away, which
is the aging working as intended rather than against it. And if the tile turns out
to be useful again before it is evicted, the next epoch's reference reprices it
from the *current* watermark, so it is not permanently disadvantaged by having
been stale.

**Insertion.** `insert(key, bitmap, {bytes, pin, epoch})` sets
`frequency = 1` and `priority = age + frequency`, and stamps
`insertedSeq` from a counter that increases monotonically for the life of the
page. The admission is itself that epoch's first reference, so a tile is not
counted twice for the epoch that fetched it.

**What counts as a reference.** A *cache reference* is: a cached tile satisfies
the requirements of a new viewport epoch that needs that tile. That happens in
exactly one place, `requestableKeys()`, which calls `cache.markNeeded(key,
epoch)` for each key the new epoch needs. The rule is:

```text
frequency += 1
priority   = age + frequency
lastCountedEpoch = epoch
```

and `markNeeded()` returns without counting if `lastCountedEpoch` already equals
the current epoch. So a tile gains **at most one frequency per viewport epoch**,
no matter how many internal paths ask. Rendering is a separate, non-accounting
read: `render()` uses `peek(key)`, and `has(key)` is membership only. This
matters because the browser redraws the same cached bitmap many times per pan,
per animation frame and per HUD update; counting those would make frequency a
redraw counter rather than a measure of useful reuse.

**Victim selection.** When capacity pressure requires an eviction:

1. build the eligible candidate set (below),
2. take the entry with the **lowest `priority`**,
3. break equal priorities by the **oldest `insertedSeq`**,
4. set `age = max(age, victim.priority)`, which is the monotonic watermark,
5. `close()` the victim bitmap exactly once,
6. drop it and increment `evicts`.

Access recency is not a metric here, not a tie-break, and not stored. The
`Map` is insertion-ordered, which makes it admission order, not recency order,
and `markNeeded()` never reorders anything. Eviction is a linear scan over at
most 40 entries. There is no heap, no tree, and no auxiliary index, because at
40 entries a scan is both fast enough and the thing a grader can audit.

**The watermark is monotone by construction.** Step 4 assigns
`age = max(previousAge, victim.priority)`. Textbook LFUDA writes
`age = victim.priority` and relies on the victim being the global
minimum-priority object, which makes that assignment a floor that can only
rise. UltraTile does not have that guarantee: the tiers above restrict the
candidate set to eligible keys, so the selected victim can be a
higher-priority entry than some protected one. A protected key can therefore
sit below the watermark, and evicting it later would drag the floor back down
and undo the discount the aging exists to apply. The `max` is the minimal
adaptation that restores the watermark property under eligibility filtering,
and it is a no-op whenever the victim is the global minimum, because
`victim.priority >= age` already holds in that case. So ordinary LFUDA eviction
is unchanged, and the test `ordinary LFUDA eviction, where the victim is the
global minimum, is unchanged` pins exactly that.

**Protection is eligibility, LFUDA is the choice.** Two policies are kept
separate on purpose:

```text
viewport policy:  who may be evicted?
LFUDA:            among those candidates, who loses?
```

`runViewportBatches()` hands the cache the union of the visible tiles at every
level the epoch will work on, via `protectTarget()`. `newViewEpoch()` calls
`clearTarget()`, so an epoch that never reaches the batch loop over-protects
nothing, which is the safe direction. Protection never inflates a frequency; it
only removes keys from the candidate set. The `z === 0` overview tile is pinned
at insert and keeps that protection for the life of the image.

When there is no eligible candidate, `selectVictim()` falls back through bounded
tiers rather than exceeding capacity:

| Tier | Candidates | Reached when |
| ---: | --- | --- |
| 1 | not pinned, not in the target | the normal path |
| 2 | not pinned | the viewport target has filled the cache |
| 3 | everything | the cache is fully pinned |

Every tier excludes the key being admitted. That guard is a deliberate,
UltraTile-specific deviation from textbook LFUDA and it is load-bearing: a fresh
entry's priority is `age + 1`, which is by construction the global minimum, so
without the guard a needed tile that the viewport re-requests every epoch would
be its own permanent victim, re-fetched forever and never drawn. The guard
costs the pure scan-resistance that textbook LFUDA has, and buys a viewport
that always converges. `MAX_CACHE` is never exceeded under any of the tiers.

**Cleanup.** Every eviction closes the victim's bitmap exactly once. Replacing
an existing key closes the previous bitmap rather than leaking it. `clear()`
closes every retained bitmap once and resets `age` to 0, since the watermark
describes what the cache has held; `evicts`, `hits` and `misses` are cumulative
and deliberately survive `clear()`, because the HUD and the tests read them
across an image switch. `selectImage()` calls `clear()`, so an image switch
closes everything the previous image retained.

### Why LFUDA and not LRU

The choice is forced and then made deliberate:

- **LRU is unavailable.** The course requires a distinct algorithm per group
  and another group holds LRU, so this had to be something else.
- **Plain LFU is worse.** It retains historically popular tiles indefinitely. In
  a tiled viewer a tile that was hot for one region stays hot for the whole
  session and the region the user is actually looking at can never displace it.
- **LFUDA adds dynamic aging.** `age` is raised to each victim's priority, so the
  floor for a new entry rises with the cache's own history and old popularity
  bleeds off, and the rise is monotonic. The test `dynamic aging retires
  popularity that naive LFU would keep forever` walks a hot tile to
  `priority 6` and then shows it surviving 11 further admissions before aging
  catches up and evicts it, which naive LFU could never do. A second test,
  `dynamic aging still retires popularity under a raised watermark`, repeats
  that from a watermark already well above zero, which is the case the
  monotonic rule makes reachable.
- **Reuse frequency is meaningful here.** Tiled-image users pan, zoom and come
  back to nearby regions, so a tile referenced across many viewport epochs is
  genuinely the one worth keeping.
- **Size-aware policies would buy nothing.** Every retained bitmap is
  512 x 512, so all entries cost the same and there is no size dimension for a
  policy like GDSF to exploit.
- **Protection stays orthogonal.** Viewport and `z === 0` protection are
  eligibility, applied before LFUDA, and are not encoded as fake frequencies.

This is a trade-off, not a claim of universal superiority. Against a strict
single-pass scan, LFUDA's scan resistance is deliberately weakened by the
admission guard described above. The position taken here is that for a viewer
whose working set is roughly the viewport, converging beats resisting.

One thing worth recording about the implementation this replaced. The old
`LruCache.get()` refreshed recency by deleting and re-inserting the key, and
`render()` called `get()` for every cached entry on every frame, in the order
`keys()` returned them. Deleting and re-inserting in iteration order leaves the
`Map` in exactly the order it was already in, so those per-frame refreshes were
a no-op on the ordering. The practical consequence is that the old recency order
was, for every rendered entry, the admission order: on a viewport that redraws
continuously, that policy was FIFO over admissions. That is a fair reading of why
frequency-based selection is a real behavioural change here and not a rename, and
it is consistent with the measured re-fetch improvement below.

### Why the 4K viewport is not actually tight any more

This section used to claim that a 4K viewport (3840 x 2160 CSS px) at scale 1.0
needs 8 x 5 tiles, which is 40, which is exactly `MAX_CACHE`, so one visible tile
is evicted and re-fetched. The arithmetic about the **desired** level is right
and has been right. The conclusion no longer follows, and the symptom could not
be reproduced on the real ladder under either replacement policy.

`effectiveLOD()` refuses any level whose union of visible tiles across levels
0..E exceeds `UNION_CAP = 36`, and 36 is **below** `MAX_CACHE = 40`. The
requested set is `visibleTileRange(E)` for the effective level E, and that is a
subset of the union, so one viewport can never ask for more than 36 tiles and
can never evict anything by itself. The `z = 0` overview pin is inside that
union, so it does not consume a slot outside it either.

Measured on image-6 (40000 x 30131), sweeping every scale to find the most
cache-stressed operating point, over 131 viewport operations per session:

| Viewport | Largest single-viewport request observed | Cache peak |
| --- | ---: | ---: |
| 1920 x 1080 | 24 tiles | 40 |
| 3840 x 2160 | 24 tiles | 40 |

The cache does reach 40 and does evict, but only because the session visits
enough distinct regions to accumulate history across epochs. The re-fetch
behaviour there is a history effect, not a 4K effect, and §
[Cache policy on the real ladder](#cache-policy-on-the-real-ladder) measures it
for both policies.

`UNION_CAP` below `MAX_CACHE` is a structural invariant, not a coincidence, and
the viewer suite asserts it directly in `a single viewport can never ask for
more than UNION_CAP tiles`. If someone later raises `UNION_CAP` above
`MAX_CACHE`, that assertion is the thing that will fail first, which is the
point of having it.

Raising `MAX_CACHE` is still not the answer to anything measured here: it did
not change the hit or miss counts in either direction. If it is ever changed,
`Config.CACHE_CAP` and `constants.js` must move together, or parity fails.

### Cache policy on the real ladder

Both policies were measured on the same server, the same scripted session, the
same instrument, and the same ten traces: pans in each direction, a repeated
back-and-forth pan, a zoom ladder with a revisit, a serpentine sweep, a 20-step
sweep, a 14-step vertical sweep, a deep zoom revisit ladder, and an image switch
out and back. "Re-fetch" counts TILE frames for a key the session had already
seen, taken from the wire rather than from the cache's own counters.

| Workload | misses LFUDA / LRU | evictions | re-fetches | re-fetched bytes | total rxBytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| image-4, 1920x1080 | 143 / 147 | 98 / 102 | 28 / 44 | 2.53 / 4.50 MB | 17.03 / 17.50 MB |
| image-5, 1920x1080 | 220 / 221 | 175 / 176 | 47 / 67 | 2.59 / 4.51 MB | 18.10 / 17.65 MB |
| image-6, 1920x1080 | 223 / 220 | 178 / 175 | 29 / 52 | 3.12 / 5.63 MB | 27.34 / 26.56 MB |
| image-6, 3840x2160 | 218 / 226 | 159 / 167 | 37 / 62 | 3.76 / 6.52 MB | 26.49 / 26.89 MB |

Read honestly, that is **not** a clean win. Miss counts, eviction counts and
total received bytes are within about 4 % either way, and on image-6 at
1920x1080 LFUDA is marginally the worse of the two on all three. What LFUDA does
consistently better is re-fetching: 30 to 44 % fewer re-fetched tiles and 42 to
45 % fewer re-fetched bytes on every workload. That is the frequency signal doing
what it is supposed to: tiles the user keeps coming back to survive, so the
second and third visit is a hit.

The LFUDA aging watermark is not idle in any of these sessions; it peaked at 25,
55, 38 and 35 respectively, so the aging is genuinely driving decisions rather
than sitting at zero.

**Qualification, added after the benchmark was built.** That harness's `recenter`
passed `(anchor - camera)` to a pointer handler that subtracts the delta, so it
reflected the camera about the image centre instead of moving it there. The
camera drifted into clipped image corners and three of the nine traces became
degenerate, recording zero misses, zero evictions and zero re-fetches: about 51
of the roughly 128 viewport operations contributed nothing. The two columns were
produced by the same harness in the same session shape, so the comparison
between them stands, but the session is not one a user would have produced.

The numbers above are kept as recorded. They live in
`scripts/cache-baseline-lru.json` as historical data, they are not regenerated,
and `scripts/cache_workload_benchmark.cjs` prints them side by side without
differencing them. For current, reproducible, non-degenerate measurements on
the same images, see [cache-benchmark.md](cache-benchmark.md#results); that
harness cannot produce an LFUDA-versus-LRU verdict, because LRU no longer exists
to measure.

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

`updateHud()` writes sixteen fields, all `textContent` on `<b>` elements inside
`#hud`:

| Field | Meaning |
| --- | --- |
| `lod` | desired level from `selectLevel` |
| `effZ` | effective level after the `UNION_CAP` downgrade |
| `rxBytes` | TILE `payloadLen` received, duplicates included |
| `decodedBytes` | payload bytes at cache insert, **not** bitmap size |
| `reqs` | request IDs allocated |
| `evicts` | LFUDA evictions |
| `cache` | entries currently cached |
| `hits` | viewport needs a cached tile already satisfied |
| `miss` | viewport needs a tile the cache did not have, so a re-fetch follows |
| `lfuAge` | the LFUDA aging watermark |
| `decJobs` | queued plus in-flight decodes |
| `decBytes` | queued bytes |
| `epoch` | `viewEpoch` |
| `gen` | last allocated reqId |
| `netCov` | `|receivedThisEpoch ∪ serverSkippedThisEpoch|` |
| `covCov` | cached divided by needed, over the union of visible tiles at **all** levels |

`hits`, `miss` and `lfuAge` are the cache-policy diagnostics: `hits` against
`miss` is the cache effectiveness of the policy, `miss` counts the tiles a
viewport had to re-fetch, and `lfuAge` shows whether the aging watermark is
moving. Per-entry frequency is deliberately not in the HUD; `cacheSnapshot()`
exposes it for tests instead.

**The page shell is presentation only.** `styles.css` and the markup in
`index.html` carry the layout and nothing else; no viewer logic reads them, and
the sixteen `<b>` values stay raw numbers because the harness reads them
numerically (`+hud.rxBytes.textContent`, and `hud.effZ` compared as a string).
The body is a flex column with the header and footer as `flex: 0 0 auto` and
`main` as `flex: 1; min-height: 0`, so the canvas takes the space the header
leaves rather than being pinned below a guessed offset. The offset approach was
the old rule (`main { position: fixed; top: 3rem }`) and it was wrong: the HUD
wraps onto a second line on an ordinary window, so 3rem was not the header
height and the canvas overlapped it. `#view` is `position: absolute; inset: 0`
inside a `position: relative` `main` so its box is always definite, which is
what `resizeCanvas()` reads through `clientWidth`/`clientHeight` to size the
backing store. Each HUD field also carries a `title` explaining what it counts
and, for `effZ` and `covCov`, why a low value is correct rather than a fault.
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
`splitIntoBatches`, `DecodePipeline`, `LfudaCache`, `epochToken`, `BatchState`,
`classify`, `headroomOk`, `batchBudget`, `newViewEpoch`, `decodeRefs`, `netCov`,
`covCov`, `switchState`, `cameraState`, and `cacheSnapshot`. It is a test seam,
not a public API; nothing in the served page calls it.

`cameraState()` is a read-only observer of the camera, added for
`scripts/cache_workload_benchmark.cjs`; see
[cache-benchmark.md](cache-benchmark.md#the-one-production-seam-this-needed) for
why it exists and why the alternative was worse.

`scripts/test_viewer.cjs` concatenates the ten files into one `node:vm` script so
the shared lexical scope behaves the way deferred script tags make it behave in a
browser, then runs 68 tests against it. No browser, no network, no dependencies.
`scripts/cache_workload_benchmark.cjs` loads the same ten files the same way, but
against a live server, to measure behaviour rather than prove correctness.
