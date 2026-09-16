---
phase: phase-06-viewer-frontend
goal: GOAL-006 Epoch-cleanup viewer plus serverSkipped plus wire-codec vectors
status: 'Planned'
parent: ./overview.md
version: 1.11
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 06 — Viewer Frontend ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-004**: Locally served, offline; `resizeCanvas()` DPR=1 first;
    drag/wheel pointer-anchored within scales + `isFinite` +
    capture/`pointercancel`; immediate cached render + debounced network
    intent (new `viewEpoch` per intent). Node test-only; app Node-free.
  - **REQ-005**: LOD `zFloat=N+log2(s)` clamp; `effectiveLOD` per-Z
    recompute, union ≤36; HUD desired-vs-effective (+`epoch`, `rxBytes` vs
    `decodedBytes`, `netCov` vs `covCov`); screen-space clear +
    full-bitmap compositing + `[0,W)` clip.
  - **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 +
    queue jobs≤24 AND bytes≤4MiB (distinct names); `viewEpoch` intent
    counter.
    - `BatchState{reqId,epoch,imageId,zoom,expectedKeys:Set,
      receivedKeys:Set,serverSkipped:Set,networkComplete,canceled}` with
      FROZEN lifetime (insert on send; reclaim a current-epoch state when
      `networkComplete && decodeRefs==0` where `decodeRefs` = queued+inflight
      payloads carrying its reqId; retain canceled previous-epoch states
      only while that epoch is the immediate predecessor — starting a third
      epoch drops the oldest).
    - REQ_IDs ONLY from the `createReqAllocator()` closure (return current,
      then increment; start at 1 per WS connection; if allocation would pass
      `0xFFFFFFFE`, reconnect and restart at 1 on the new WS; the counter is
      closure-private — no mutable module-level `nextReqId` exists for call
      sites to bypass; exclusivity is proven BEHAVIORALLY in TASK-004, never
      by grepping for `++`).
    - FROZEN connection model — `connectWs()` opens ONE socket per page:
      `new WebSocket(wsUrl, "ultratile.utp.v1")` (the mandatory subprotocol
      MUST be offered — a bare `new WebSocket(wsUrl)` never completes the
      phase-05 handshake), `wsUrl` derived from the loaded page as
      `` `ws://${location.host}/ws` `` (same-origin: with `--bind 0.0.0.0` a
      hard-coded `ws://localhost:8080/ws` fails the server's own
      Origin-vs-Host rule when the page is served via 127.0.0.1, a
      hostname, or a LAN IP); assert
      `ws.protocol === "ultratile.utp.v1"`, set
      `ws.binaryType = "arraybuffer"` (the parser assumes binary buffers),
      await `open` before sending any UTP frame. `selectImage(id)` reuses
      the session socket and preserves REQ_ID continuity (v1.10's
      `connectImage(id)`-per-image wrongly implied a new socket per picker
      change); only a genuine WS reconnect resets the allocator to 1.
    - FROZEN coordinate ownership: needed → pending-network (sent, member of
      expectedKeys) → received/decode-owned → cached; TILE receipt REMOVES
      pending immediately; admission overflow → `retryNeeded` (reschedule
      clears marker); JPEG rejection of a VALID current-batch expected tile
      OR `format!=1` on such a tile → epoch-scoped `terminalFailed`,
      INCLUDED in suppression; SUPPRESSION SET (frozen) = cached ∪ pending
      ∪ decode-queued ∪ decode-IN-FLIGHT (`decodePipeline.has(key)`) ∪
      `terminalFailed`(epoch) ∪ `serverSkipped`(epoch) — the builder MUST
      consult all six, so a permanently missing tile is never re-requested
      in the same epoch (v1.10's count-without-a-set left this hole).
    - On network END: FIRST verify `END.(imageId,reqId)` matches a live
      batch (no match → PROTOCOL-FATAL: `endIdentityFatal++`, `ws.close()`,
      fail every waiter — never counter-and-continue); THEN the FROZEN
      triple accounting — `sent + skipped == expectedKeys.size()` AND
      `sent == receivedKeys.size()` AND
      `skipped == expectedKeys.size() - receivedKeys.size()` (totals alone
      let a duplicate TILE mask a missing TILE; TCP ordering guarantees
      every preceding TILE arrived before END, so any mismatch is a
      peer bug, not jitter → PROTOCOL-FATAL: `endCountMismatch++`,
      `ws.close()`, fail waiters); THEN derive server-skipped:
      `unreceived = expectedKeys - receivedKeys` are added to the
      epoch-scoped `serverSkipped` set and their `pending` entries removed
      (never retried this epoch). `netCov` is well-defined from the two
      sets: `netCov = receivedKeys.size + serverSkipped.size`.
    - DUPLICATE TILE (key ∈ `receivedKeys`) → drop + `dupTiles++` (wire
      payload bytes still counted in `rxBytes`; exactly one decode per key
      per batch); decode accepted iff mapped epoch === currentViewEpoch.
    - `receivedKeys` is STRICTLY network bookkeeping (receipt + duplicate
      detection + END accounting). Visual coverage is separate:
      `covCov = cachedTargetKeys / neededTargetKeys` (pixels on screen;
      retry/decode-pending/received-undecoded NEVER count — computed from
      the cache, never from `receivedKeys`). Control flow awaits
      `networkComplete` + decode resolution/drain, NEVER `covCov == 100%`
      (`covCov` is observational/HUD state: skipped or terminally
      undecodable tiles may keep it below 100% forever, and waiting on it
      would hang progress to later work — v1.10's "await coverage" wording).
    - FROZEN epoch cleanup on EVERY `newViewEpoch()` (pan/zoom/resize/switch
      alike): in this order — bump epoch FIRST, cancel old awaiters, remove
      old-epoch `pending` entries, clear old epoch's `retryNeeded` +
      `terminalFailed` + `serverSkipped`, purge queued (not in-flight)
      decode payloads of older epochs, move old `BatchState`s to the
      retained-canceled window. A tile that terminal-failed in E is
      requestable again in E+1; no canceled-generation entry survives to
      suppress a fresh intent.
    - NO network batch without real headroom:
      `headroomOk = inflight<MAX_DECODE && queueJobs<DQ_JOBS &&
      freeBytes>=MAX_TILE_BYTES`; batch budget
      `min(BATCH_CAP, freeJobSlots, max(1,floor(freeBytes/avgTileBytes)))`,
      `avgTileBytes` = running mean over received TILE `payloadLen` (SAME
      quantity as `rxBytes`), seed 131072, RESET to seed on every image
      switch; END ≠ decoder-ready.
    - FROZEN initial camera: `camX=W/2, camY=H/2,
      s=clamp(min(Vw/W,Vh/H),SCALE_MIN,SCALE_MAX)` (no margin fudge).
    - Viewer wire codec (frozen API): `encodeViewport(chunk fields)` →
      exact 28B big-endian `ArrayBuffer`; `encodeCommit(imageId,reqId)` →
      exact 8B; `encodeAbort(imageId,reqId)` → exact 8B;
      `parseTileHeader(buffer)` → `{imageId,zoom,format,tileSize,reqId,
      tileX,tileY,payloadLen}` with full validation; `parseEnd(buffer)` →
      `{imageId,reqId,sent,skipped}` with full validation. The sender and
      the `onmessage` path MUST both go through these functions (no
      second hand-rolled encoder in the send path) so the TASK-004 vectors
      prove what the browser actually puts on the wire.
    - Picker populates options via `textContent` (never HTML interpolation).
      Duplicated Java constants EXPLICIT with `check_const_parity.py`
      pinning EVERY shared constant (phase-02 TASK-006).
  - **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y).
- Prior-phase deps:
  - **DEP-005**: Requires phase-03 (sealed layouts, three-way COMMIT,
    LOD-0-only, no-wrap + seen-rule, freeze) + phase-04 (picker/info routes
    incl. `rxBytes` HUD ids, readiness) + phase-05 (mandatory subprotocol,
    close-on-invalid semantics, session lifecycle the viewer depends on).
- Inputs: phase-04 placeholder `index.html`/`viewer.js`. Outputs:
  epoch-cleaned ownership viewer with skipped-set suppression, exact END
  accounting, wire-codec vectors, deterministic pan + zoom eviction proofs,
  full parity script.

## Tasks

### TASK-001 — Full HUD shell

- Overwrite `src/main/resources/web/index.html` (≤110 lines):
  `<canvas id="view">`, `<select id="image">`, HUD
  `lod/effZ/rxBytes/decodedBytes/reqs/evicts/cache/decJobs/decBytes/
  epoch/gen/netCov/covCov`, `<script src="/viewer.js" defer>`; zero external
  refs. Overwrite `NEW src/main/resources/web/styles.css` fullscreen. (Both
  `NEW` relative to a phase-04-only tree; overwrite here with full HUD.)
- Done when: `curl -s /` contains `id="image"` + `id="rxBytes"`.

### TASK-002 — viewer.js part A (state, allocator, cache, pipeline)

- Consts incl. `TILE=512,MAX_CACHE=40,MAX_TILE_BYTES=2097152,BATCH_CAP=30,
  MAX_DECODE=6,DECODE_QUEUE_MAX_JOBS=24,DECODE_QUEUE_MAX_BYTES=4MiB,
  AVG_TILE_SEED=131072,SCALE_MIN/MAX,TAU` (all covered by the TASK-004
  parity map — any change touches `Config.java` + `viewer.js` + the map
  together).
- FROZEN `createReqAllocator()`: returns `{allocReqId}` closing over a
  private counter starting at 1; each call returns the current value then
  increments; if the return value would exceed `0xFFFFFFFE`, reconnect first
  and restart at 1 on the new WS. One allocator instance per WS connection;
  `selectImage` NEVER resets it. No module-level mutable counter exists.
- `viewEpoch` u32 (0 reserved; per intent);
  per-epoch `epochToken{epoch,canceled,awaiters[]}`;
  `BatchState{reqId,epoch,imageId,zoom,expectedKeys:Set,receivedKeys:Set,
  serverSkipped:Set,networkComplete,canceled}` in `batches:Map` with FROZEN
  lifetime (reclaim current-epoch when `networkComplete && decodeRefs==0`;
  drop previous-epoch states when a third epoch starts);
  `decodeRefs(reqId)` = queued + inflight decode payloads carrying reqId;
  `classify(reqId)` returns epoch or `stale-unknown` (→discard path).
- Ownership stores: `pending:Map(key→reqId)` (removed THE MOMENT its TILE is
  received — before admission); `retryNeeded:Set(key)` (same-epoch only;
  cleared per-key on reschedule AND wholesale on epoch change);
  `terminalFailed:Set(key)` (epoch-scoped; suppression; wholesale-cleared);
  `serverSkipped:Set(key)` (epoch-scoped; suppression; wholesale-cleared;
  populated ONLY by the END derivation in TASK-003); `avgTileBytes`
  (running mean over `payloadLen`, seed 131072, RESET to seed on image
  switch); `dupTiles`, `droppedUnexpected`, `endCountMismatch`,
  `endIdentityFatal` counters; `headroomOk()` + `batchBudget()` as v1.8.
- `resizeCanvas()` DPR=1; controller + half-open `visibleTileRange(Z)`;
  `selectLevel` frozen; `effectiveLOD(desiredZ)` per-Z recompute + union
  count → first Z `≤36` as `{desired,effective,downgraded}`; `LruCache` 40
  (target+Z0 protected, eviction `close()`s the bitmap, bumps `evicts`);
  `DecodePipeline` inflight≤6, queue jobs≤24 AND bytes≤4MiB, `has(key)` TRUE
  for queued AND in-flight, purge STALE-EPOCH QUEUED payloads on every epoch
  bump (in-flight decodes run to completion, accepted iff their epoch is
  still current at completion).
- `rxBytes+=payloadLen` on EVERY valid TILE receipt (UTP payload bytes only
  — NOT the 24B header, NOT WS framing; counted before decode, duplicates
  included), `decodedBytes+=payloadLen` only on cache insert;
  `netCov()` = `receivedKeys.size + serverSkipped.size` (summed over live
  batches of the epoch); `covCov()` = `cachedTargetKeys /
  neededTargetKeys` from the cache.
- `newViewEpoch()` runs the FROZEN cleanup order (bump → cancel awaiters →
  drop old pending → clear old retry/terminal/skipped → purge stale queued
  payloads → retire BatchStates).
- Wire codec functions per REQ-006 (exact sizes, big-endian, full
  validation on parse).
- Expose `globalThis.UltraTile={createReqAllocator,connectWs,selectImage,
  encodeViewport,encodeCommit,encodeAbort,parseTileHeader,parseEnd,
  selectLevel,visibleTileRange,effectiveLOD,splitIntoBatches,DecodePipeline,
  LruCache,epochToken,BatchState,classify,headroomOk,batchBudget,
  newViewEpoch,decodeRefs,netCov,covCov}` (DOM-free seam).
- Done when: `node --check viewer.js` passes.

### TASK-003 — viewer.js part B (flows + receive pipeline)

- FROZEN `connectWs()`: `ws = new WebSocket(wsUrl, "ultratile.utp.v1")`
  with `` wsUrl = `ws://${location.host}/ws` ``; on `open` assert
  `ws.protocol === "ultratile.utp.v1"` else fail the connection;
  `ws.binaryType = "arraybuffer"` BEFORE any message can be processed.
- FROZEN `selectImage(id)`: reuses the `connectWs()` socket (no new WS, no
  allocator reset); `fetch(/info)`→N/W/H; `avgTileBytes` reset to seed;
  `allocReqId()` + `newViewEpoch()` → pin Z0 gen (chunks+COMMIT via
  `encodeViewport`/`encodeCommit`; `lodMode=0`, `format` expected `1`);
  await `networkComplete` + decode resolution (NOT `covCov==100%`), then
  effective-Z work as HEADROOM-GATED sequential budgeted batches sharing
  `viewEpoch`.
- Batch loop: WAIT for `headroomOk()` (else wait `decodeDrain` event — the
  v1.7 `queueBytes<max` check is TOO WEAK and forbidden here);
  send `batchBudget()`-sized batch (chunks+COMMIT via the wire codec, fresh
  allocator REQ_ID, `BatchState` with
  `imageId/zoom/expectedKeys/receivedKeys/serverSkipped={}` registered);
  await `END-or-epochCancel-or-wsClose`:
  - on END → identity check (no live match → PROTOCOL-FATAL:
    `endIdentityFatal++`, `ws.close()`, fail every waiter) → triple
    accounting (any mismatch → `endCountMismatch++`, `ws.close()`, fail
    waiters) → derive server-skipped (`unreceived = expectedKeys -
    receivedKeys` → `serverSkipped` add + `pending.delete`, never retried)
    → loop incl. `retryNeeded` coords as a same-epoch later gen AFTER
    re-checking `headroomOk()`.
  - on epoch-cancel → abandon instantly (a live generation with no possible
    END is closed server-side per phase-05 — the client NEVER waits past
    cancel/close); on close → fail chain. All batches co-reside ≤40.
- Builder subtracts the FROZEN six-set (cached ∪ pending(current-gen) ∪
  decode-queued ∪ decode-IN-FLIGHT (`has(key)`) ∪ `terminalFailed`(epoch) ∪
  `serverSkipped`(epoch)), same-Z row-runs, one REQ_ID, COMMIT.
- `sendAbort(old)` + 80ms debounce starts a new epoch via `newViewEpoch()`
  (cleanup order frozen in TASK-002; late decodes accepted iff
  `classify(reqId).epoch===currentViewEpoch` — batch-G-after-G+1 case).
- FROZEN `onmessage` pipeline (in this order, no reordering):
  1. 24B structural parse via `parseTileHeader` (incl. `payloadLen` gate).
  2. `rxBytes+=payloadLen` immediately (even for discarded/stale/duplicate
     frames; header bytes NEVER counted).
  3. `classify(reqId)` (unknown→discard; stale-epoch→discard-or-`close()`).
  4. MEMBERSHIP: key `(image,z,x,y)` MUST be in `BatchState.expectedKeys`
     AND `imageId/zoom` MUST match the batch else discard +
     `droppedUnexpected++`.
  5. DUPLICATE: key ∈ `receivedKeys` → drop + `dupTiles++` (no second
     decode, no second pending touch) → else `receivedKeys.add(key)`.
  6. `pending.delete(key)` (unconditional at receipt).
  7. THEN interpret: `format!=1` → `terminalFailed.add(key)` + fallback kept
     (reserved WebP never decodes here — reachable ONLY for valid
     current-batch expected tiles, so stale/foreign FORMAT=2 can never
     poison the epoch); admission gate (jobs+bytes; over-either →
     `retryNeeded.add(key)`, never terminal) → queue → `createImageBitmap`
     → cache + `decodedBytes+=payloadLen` (rejection →
     `terminalFailed.add(key)` + fallback kept, never retried this epoch).
  8. `0x04` via `parseEnd` → identity check → triple accounting →
     `BatchState.networkComplete=true`, reconcile `netCov`, resolve
     never-received expected keys as server-SKIPPED (step order above).
- Picker change AND every pan/zoom/resize intent: `sendAbort(old)` where
  applicable, `newViewEpoch()` FIRST (frozen cleanup), then: picker
  additionally calls `selectImage(newId)` on the SAME socket (no
  allocator reset), cache-`clear()` closing EVERY bitmap, discard pre-decode
  buffers (no `close()` pre-bitmap), reset cam to the FROZEN initial camera
  (`camX=W/2, camY=H/2, s=clamp(min(Vw/W,Vh/H),SCALE_MIN,SCALE_MAX)`), then
  re-pin Z0.
- Interactions: drag/wheel clamped+finite+anchored, `pointercancel` ends
  drag, immediate `render()`, debounced intent; LOD/resize→new epoch
  (resize→frustum first). Layer `render()`: `resetTransform` + FULL-canvas
  `clearRect`/fill FIRST, then `save`/world-transform/`clip([0,W)×[0,H))`/
  full-bitmap draws/`restore`.
- Done when: `node --check` +
  `grep -q "serverSkipped\|connectWs\|selectImage\|encodeViewport\|parseTileHeader\|netCov\|covCov" viewer.js`.

### TASK-004 — test_viewer.cjs (bootstrap/ownership/wire-codec vectors)

- Create `NEW scripts/test_viewer.cjs` (`node:vm` + `node:assert`/
  `node:test`, zero deps, TEST-ONLY — app stays Node-free): vm-sandbox
  `viewer.js` with stubbed browser globals → `UltraTile` API.
- Wire-codec vectors (close the independent-interop gap): `encodeViewport`
  golden (28B, MAGIC at 0, type at 1, big-endian `0x00120304`-style field
  check, LOD byte 0, tileSize 512 at its offset); `encodeCommit`/
  `encodeAbort` golden (8B each, exact offsets); `parseTileHeader` golden
  (24B incl. LEN@20-23, rejects bad MAGIC/LEN-gate/truncation);
  `parseEnd` golden (16B, rejects truncation); round-trip
  encode→parse field equality; sender-path check (capture what the batch
  sender emits for a known chunk and byte-compare with `encodeViewport`
  output — proves the send path uses the codec, not a parallel encoder).
- Bootstrap: socket constructed WITH `ultratile.utp.v1`; `wsUrl` derived
  from `location.host` (stub host `example:8080` → `ws://example:8080/ws`,
  never hard-coded localhost); wrong/missing `ws.protocol` → connection
  failed; `binaryType==="arraybuffer"` before first send; `selectImage`
  reuses the socket (no new WebSocket, allocator NOT reset — next REQ_ID is
  previous+1); only `connectWs` reconnect resets to 1.
- Allocator behavior: first allocation is 1 (never 2); monotonic across
  image switches; no module-global mutable counter (assert
  `UltraTile.nextReqId === undefined` — encapsulation, not grep).
- FORMAT ordering: stale/foreign FORMAT=2 TILE → discarded WITHOUT touching
  current-epoch `terminalFailed`; valid current-batch FORMAT=2 →
  `terminalFailed`.
- END semantics: wrong-image END → `endIdentityFatal`, socket closed,
  waiters resolved; triple-accounting violation (e.g. duplicate TILE masking
  a missing key: `sent+skipped==size` but `sent != receivedKeys.size`) →
  `endCountMismatch`, socket closed, waiters failed; happy END populates
  `serverSkipped` with exactly the unreceived keys and a same-epoch rebuild
  does NOT re-request them (suppression), while the NEXT epoch MAY.
- netCov/covCov split: received-but-undecoded + retry keys count in
  `netCov`, NOT in `covCov`; `covCov` computed from cache; progress does
  NOT wait on `covCov==100%` when skips/terminals exist (assert the batch
  loop resolves on `networkComplete` + drain with `covCov<1`).
- `rxBytes` semantics: TILE with `payloadLen=100` adds exactly 100 (24B
  header excluded); avgTileBytes reset (seed restored on image switch).
- Epoch cleanup: terminal-fail key K in E → `newViewEpoch()` → K
  requestable again in E+1 (incl. serverSkipped key K: requestable in E+1);
  two rapid bumps purge old pending + cancel old awaiters + drop
  previous-previous BatchStates; duplicate TILE (same key twice → one
  decode, `dupTiles==1`, `rxBytes` counts both payloads); BatchState
  lifetime (current-epoch state with `networkComplete` + `decodeRefs==0`
  reclaimed; previous-epoch retained until third epoch); initial camera
  (`camX==W/2`, `camY==H/2`, `s==clamp(min(Vw/W,Vh/H))`).
- DETERMINISTIC PAN + ZOOM eviction as v1.10 (serpentine 64 keys →
  `evicts>0`; 3→1 transition → `rxBytes↑`, effZ recorded, `close()`d).
- Run `node scripts/test_viewer.cjs` green.
- Done when: `node scripts/test_viewer.cjs` + full parity green (phase-02
  TASK-006 covers `check_const_parity.py`).

## Validation Commands

Offline validation track:

```sh
node --check src/main/resources/web/viewer.js
node scripts/test_viewer.cjs
python3 scripts/check_const_parity.py
rg -n "https?://|cdn" src/main/resources/web/ || echo "offline-clean"
grep -n "allocReqId\|BatchState\|viewEpoch\|rxBytes\|decodedBytes\|terminalFailed\|serverSkipped\|headroomOk\|expectedKeys\|receivedKeys\|newViewEpoch\|netCov\|covCov\|binaryType\|connectWs\|selectImage\|encodeViewport\|parseTileHeader\|MAX_CACHE=40\|MAX_TILE_BYTES=2097152\|BATCH_CAP=30\|effectiveLOD" src/main/resources/web/viewer.js
```

Authoritative track (manual browser smoke — no scripted assertions):

```sh
./build.sh
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
```

(Open `http://localhost:8080/`, pick images 0/1, pan/zoom; tiles + HUD update; no console errors.)

```sh
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- `classify(reqId)` is THE v1.7 client bridge; v1.8 added the ownership
  machine; v1.9 added the epoch boundary; v1.10 added bootstrap+ordering;
  v1.11 completes the set: `serverSkipped` (suppression with a set, not a
  count), triple END accounting (exactness, not totals), `connectWs` vs
  `selectImage` (one socket, continuous REQ_IDs), and the wire codec
  (the browser as a third independent UTP implementation with its own
  vectors). Each has dedicated tests.
- `receivedKeys` vs coverage is the v1.10 conceptual fix, hardened in v1.11:
  network receipt is a transport fact, visual coverage is a cache fact.
  `netCov` answers "is the batch done on the wire", `covCov` answers "can I
  render". Never gate progress on `covCov`.
- Headroom discipline unchanged from v1.8: `headroomOk()` gates SENDING;
  `batchBudget()` sizes WHAT to send.
- Duplicated constants are a deliberate, pinned trade-off (no build step, no
  shared module between Java and static JS): the parity script — not
  discipline — keeps them honest. Any value change MUST update `Config.java`
  + `viewer.js` + the parity map together.
