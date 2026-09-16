---
phase: phase-06-viewer-frontend
goal: GOAL-006 Epoch-cleanup viewer plus epoch transport sets plus wire-codec vectors
status: 'Planned'
parent: ./overview.md
version: 1.14
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
      receivedKeys:Set,networkComplete,canceled}` — `receivedKeys` is
      PER-GENERATION validation state ONLY (END triple accounting +
      duplicate detection within that reqId; insert on send). Epoch-level
      transport history lives OUTSIDE batches in `receivedThisEpoch:Set` +
      `serverSkippedThisEpoch:Set` (single pair per epoch; every receipt
      adds to `receivedThisEpoch`, every END derivation adds to
      `serverSkippedThisEpoch`; cleared wholesale on `newViewEpoch()`).
      FROZEN lifetime (reclaim a current-epoch state when `networkComplete
      && decodeRefs==0` where `decodeRefs` = queued+inflight payloads
      carrying its reqId; retain canceled previous-epoch states only while
      that epoch is the immediate predecessor — starting a third epoch
      drops the oldest). The bare name `serverSkipped` MUST NOT exist
      anywhere — epoch set or nothing.
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
      `terminalFailed`(epoch) ∪ `serverSkippedThisEpoch` — the builder MUST
      consult all six, so a permanently missing tile is never re-requested
      in the same epoch (v1.10's count-without-a-set left this hole).
    - On network END: FIRST `classify(reqId)` — STALE/old-epoch END
      (unknown reqId or superseded-epoch reqId) → discard +
      `staleEnds++`, connection alive (the server may send an old END
      before processing a supersession the browser has already moved past;
      TILEs already classify stale and END gets the same concept — the
      v1.11 no-live-batch-fatal rule wrongly killed this legal race).
    ONLY a current-epoch END takes the strict path: verify
    `END.(imageId,reqId)` matches a live batch (no live match →
    PROTOCOL-FATAL: `endIdentityFatal++`, `ws.close(4002, reason)`, fail
    every waiter — never counter-and-continue); THEN the FROZEN
    triple accounting — `sent + skipped == expectedKeys.size()` AND
    `sent == receivedKeys.size()` AND
    `skipped == expectedKeys.size() - receivedKeys.size()` (totals alone
    let a duplicate TILE mask a missing TILE; TCP ordering guarantees
    every preceding TILE arrived before END, so any mismatch is a
    peer bug, not jitter → PROTOCOL-FATAL: `endCountMismatch++`,
    `ws.close(4002, reason)`, fail waiters); THEN derive server-skipped:
      `unreceived = expectedKeys - receivedKeys` are added to
      `serverSkippedThisEpoch` and their `pending` entries removed
      (never retried this epoch). `netCov` is epoch-level and
      reclamation-proof: `netCov = |receivedThisEpoch ∪
      serverSkippedThisEpoch|` (union cardinality — a key sitting in both
      sets after a receive→overflow→retry→skip sequence counts once).
    - DUPLICATE TILE (key ∈ that batch's `receivedKeys`) → drop +
      `dupTiles++` (wire payload bytes still counted in `rxBytes`; exactly
      one decode per key per batch — dup detection is per-generation, while
      a same-key re-request in a LATER same-epoch batch is a legitimate
      retry, not a duplicate); decode accepted iff mapped epoch ===
      currentViewEpoch.
    - `receivedKeys` (per-batch) is STRICTLY network bookkeeping (receipt +
      duplicate detection + END accounting). Epoch transport history
      (`receivedThisEpoch`/`serverSkippedThisEpoch`) feeds `netCov`; visual
      coverage is separate:
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
      `terminalFailed` + `serverSkippedThisEpoch` + `receivedThisEpoch`,
      purge queued (not in-flight) decode payloads of older epochs, move
      old `BatchState`s to the retained-canceled window. A tile that
      terminal-failed in E is requestable again in E+1; no
      canceled-generation entry survives to suppress a fresh intent.
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
      tileX,tileY,payloadLen}` with full validation INCL. exact
      frame-length equality (`buffer.byteLength === 24 + payloadLen` —
      short/long TILE messages are PROTOCOL-FATAL via `tileLenMismatch++`
      + `ws.close(4002, reason)`, decided inside the parser before any
      receipt/accounting/decode); `parseEnd(buffer)` →
      `{imageId,reqId,sent,skipped}` with full validation. The sender and
      the `onmessage` path MUST both go through these functions (no
      second hand-rolled encoder in the send path) so the TASK-004 vectors
      prove what the browser actually puts on the wire.
    - Picker populates options via `textContent` (never HTML interpolation).
      Duplicated Java constants EXPLICIT with `check_const_parity.py`
      pinning EVERY shared constant (framework phase-02 TASK-006, full JS
      map + green gate HERE in TASK-004).
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
- Frozen viewer-local `CLOSE_UTP_ERROR=4002` ("UTP protocol error"): the
  code for EVERY browser-detected UTP violation, sent as
  `ws.close(4002, shortReason)` with a short ASCII reason (≤123 bytes).
  Script-sent 1002 is NOT a fallback — `ws.close(1002)` throws
  `InvalidAccessError` (only 1000/3000–4999 are legal from script). 4002
  is viewer-local SEMANTICALLY: the server attaches no UTP meaning to it
  and defines no `Config` constant for it, but its generic Close parser
  accepts and echoes 4002 as a valid private-use peer code (phase-05).
  4002 is therefore deliberately OUTSIDE the parity map — no SHARED
  constant exists or may be added for it.
- FROZEN `createReqAllocator()`: returns `{allocReqId}` closing over a
  private counter starting at 1; each call returns the current value then
  increments; if the return value would exceed `0xFFFFFFFE`, reconnect first
  and restart at 1 on the new WS. One allocator instance per WS connection;
  `selectImage` NEVER resets it. No module-level mutable counter exists.
- `viewEpoch` u32 (0 reserved; per intent);
  per-epoch `epochToken{epoch,canceled,awaiters[]}`;
  `BatchState{reqId,epoch,imageId,zoom,expectedKeys:Set,receivedKeys:Set,
  networkComplete,canceled}` in `batches:Map` with FROZEN lifetime (reclaim
  current-epoch when `networkComplete && decodeRefs==0`; drop
  previous-epoch states when a third epoch starts — reclamation touches
  ONLY per-batch state, never the epoch sets below);
  `decodeRefs(reqId)` = queued + inflight decode payloads carrying reqId;
  `classify(reqId)` returns epoch or `stale-unknown` (→discard path;
  ENDs classify here FIRST — stale ENDs discard, never fatal).
- Ownership stores: `pending:Map(key→reqId)` (removed THE MOMENT its TILE is
  received — before admission); `retryNeeded:Set(key)` (same-epoch only;
  cleared per-key on reschedule AND wholesale on epoch change);
  `terminalFailed:Set(key)` (epoch-scoped; suppression; wholesale-cleared);
  `receivedThisEpoch:Set(key)` + `serverSkippedThisEpoch:Set(key)`
  (epoch-scoped; suppression + `netCov`; wholesale-cleared; populated ONLY
  by receipt and the END derivation in TASK-003 — the ONLY sets these
  concepts live in; a bare `serverSkipped` identifier MUST NOT exist);
  `avgTileBytes` (running mean over `payloadLen`, seed 131072, RESET to
  seed on image switch);   `dupTiles`, `droppedUnexpected`, `staleTiles`, `staleEnds`,
  `tileLenMismatch`, `endCountMismatch`, `endIdentityFatal` counters;
  `headroomOk()` + `batchBudget()` as v1.8.
- `resizeCanvas()` DPR=1; controller + half-open `visibleTileRange(Z)`;
  `selectLevel` frozen; `effectiveLOD(desiredZ)` per-Z recompute + union
  count → first Z `≤36` as `{desired,effective,downgraded}`; `LruCache` 40
  (target+Z0 protected, eviction `close()`s the bitmap, bumps `evicts`);
  `DecodePipeline` inflight≤6, queue jobs≤24 AND bytes≤4MiB, `has(key)` TRUE
  for queued AND in-flight, purge STALE-EPOCH QUEUED payloads on every epoch
  bump (in-flight decodes run to completion, accepted iff their epoch is
  still current at completion).
- `rxBytes+=payloadLen` on EVERY valid-length TILE receipt (UTP payload
  bytes only — NOT the 24B header, NOT WS framing; counted before decode,
  duplicates included; length-mismatched frames NEVER reach accounting —
  they are fatal inside `parseTileHeader`),
  `decodedBytes+=payloadLen` only on cache insert;
  `netCov()` = union cardinality `new Set([...receivedThisEpoch,
  ...serverSkippedThisEpoch]).size` (a receive→overflow→retry→skip key
  sits in both sets and counts ONCE; BatchState reclamation cannot move
  it); `covCov()` = `cachedTargetKeys / neededTargetKeys` from the cache.
- `newViewEpoch()` runs the FROZEN cleanup order (bump → cancel awaiters →
  drop old pending → clear old retry/terminal/`serverSkippedThisEpoch`/
  `receivedThisEpoch` → purge stale queued payloads → retire BatchStates).
- Wire codec functions per REQ-006 (exact sizes, big-endian, full
  validation on parse INCL. the TILE `24 + payloadLen` frame-length
  equality inside `parseTileHeader`).
- Expose `globalThis.UltraTile={createReqAllocator,connectWs,selectImage,
  newViewIntent,encodeViewport,encodeCommit,encodeAbort,parseTileHeader,
  parseEnd,selectLevel,visibleTileRange,effectiveLOD,splitIntoBatches,
  DecodePipeline,LruCache,epochToken,BatchState,classify,headroomOk,
  batchBudget,newViewEpoch,decodeRefs,netCov,covCov}` (DOM-free seam).
- Done when: `node --check viewer.js` passes.

### TASK-003 — viewer.js part B (flows + receive pipeline)

- FROZEN `connectWs()`: `ws = new WebSocket(wsUrl, "ultratile.utp.v1")`
  with `` wsUrl = `ws://${location.host}/ws` ``; on `open` assert
  `ws.protocol === "ultratile.utp.v1"` else fail the connection;
  `ws.binaryType = "arraybuffer"` BEFORE any message can be processed.
- FROZEN `selectImage(id)`: the SOLE owner of the image-switch transaction
  — executed EXACTLY ONCE per picker change, in THIS order, with NO caller
  doing any of these steps before or after:
  1. `sendAbort(oldReqId)` where a live old generation exists (same socket,
     no new WS, no allocator reset);
  2. `const myEpoch = newViewEpoch()` (ONE bump — the frozen TASK-002
     cleanup; the returned epoch is this switch's liveness token);
  3. abort the previous in-flight `/info` fetch (`infoAbort?.abort()`) and
     start this switch's fetch under a FRESH `AbortController`
     (`infoAbort = new AbortController()`); `await` the response AND
     `await` `.json()` — then IMMEDIATELY re-check `myEpoch ===
     currentViewEpoch`: on mismatch ABANDON SILENTLY (return without
     touching camera, cache, `avgTileBytes`, or the allocator — A's slow
     fetch resolving after B's switch must not switch the server back to
     A; the abort is best-effort cancellation, the epoch check is the
     correctness gate, because an already-resolved fetch cannot be
     un-resolved);
  4. clear image-specific state: cache-`clear()` closing EVERY bitmap,
     discard pre-decode buffers (no `close()` pre-bitmap);
  5. reset cam to the FROZEN initial camera (`camX=W/2, camY=H/2,
     s=clamp(min(Vw/W,Vh/H),SCALE_MIN,SCALE_MAX)`); reset `avgTileBytes`
     to seed;
  6. `allocReqId()` + pin ONE Z0 generation (chunks+COMMIT via
     `encodeViewport`/`encodeCommit`; `lodMode=0`, `format` expected `1`);
  steps 4–6 run SYNCHRONOUSLY after the last guard check (no `await`
  between check and pin — no second race fits through); then await
  `networkComplete` + decode resolution (NOT `covCov==100%`), then
  effective-Z work as HEADROOM-GATED sequential budgeted batches sharing
  `viewEpoch`. General rule for the whole file: EVERY async continuation
  re-checks its epoch after EVERY `await` and abandoned continuations
  return without touching shared state (`newViewIntent`'s drain/END
  awaits resolve via epoch-cancel under the same rule).
- FROZEN `newViewIntent()` (pan/zoom/resize path — SEPARATE from image
  switching): `sendAbort(old)` where applicable → `newViewEpoch()` → budgeted
  batch loop below. NO cache clear, NO camera reset, NO `avgTileBytes`
  reset (the viewport moved; the image did not change).
- Picker `onchange` handler body is exactly `await selectImage(newId)` —
  any additional `newViewEpoch()`/clear/reset/pin in the handler is a
  double-bump bug (two epochs, potentially two Z0 generations, with the
  clear landing between the pins) and the TASK-004 single-bump vector
  fails it.
- Batch loop: WAIT for `headroomOk()` (else wait `decodeDrain` event — the
  v1.7 `queueBytes<max` check is TOO WEAK and forbidden here);
  send `batchBudget()`-sized batch (chunks+COMMIT via the wire codec, fresh
  allocator REQ_ID, `BatchState` with
  `imageId/zoom/expectedKeys/receivedKeys={}` registered — NO skipped set
  on the batch); await `END-or-epochCancel-or-wsClose`:
  - on END → `classify(reqId)` FIRST (stale/old-epoch END → discard +
    `staleEnds++`, keep waiting — a late previous-generation END is legal,
    never fatal) → current-epoch END: identity check (no live match →
    PROTOCOL-FATAL: `endIdentityFatal++`, `ws.close(4002, reason)`, fail
    every waiter) → triple accounting (any mismatch → `endCountMismatch++`,
    `ws.close(4002, reason)`, fail waiters) → derive server-skipped (`unreceived = expectedKeys -
    receivedKeys` → `serverSkippedThisEpoch` add + `pending.delete`, never
    retried) → loop incl. `retryNeeded` coords as a same-epoch later gen
    AFTER re-checking `headroomOk()`.
  - on epoch-cancel → abandon instantly (a live generation with no possible
    END is closed server-side per phase-05 — the client NEVER waits past
    cancel/close); on close → fail chain. All batches co-reside ≤40.
- Builder subtracts the FROZEN six-set (cached ∪ pending(current-gen) ∪
  decode-queued ∪ decode-IN-FLIGHT (`has(key)`) ∪ `terminalFailed`(epoch) ∪
  `serverSkippedThisEpoch`), same-Z row-runs, one REQ_ID, COMMIT.
- `sendAbort(old)` + 80ms debounce starts a new epoch via `newViewEpoch()`
  (cleanup order frozen in TASK-002; late decodes accepted iff
  `classify(reqId).epoch===currentViewEpoch` — batch-G-after-G+1 case).
- FROZEN `onmessage` pipeline (in this order, no reordering):
  1. Structural parse via `parseTileHeader` (incl. `payloadLen` gate AND
     exact frame-length equality `message.byteLength === 24 + payloadLen`
     — short/long TILE frames are PROTOCOL-FATAL via `tileLenMismatch++`
     + `ws.close(4002, reason)` + fail waiters, BEFORE any accounting below).
  2. `rxBytes+=payloadLen` immediately (even for discarded/stale/duplicate
     frames; header bytes NEVER counted).
  3. `classify(reqId)` (unknown reqId→discard + `droppedUnexpected++`;
     stale/old-epoch TILE→discard + `staleTiles++`, connection stays OPEN —
     a STRUCTURALLY VALID stale TILE is the expected
     frame-boundary-cancellation race (server sent before processing the
     supersession), never a violation; only MALFORMED frames are fatal,
     and those die in step 1 before classification).
  4. MEMBERSHIP: key `(image,z,x,y)` MUST be in `BatchState.expectedKeys`
     AND `imageId/zoom` MUST match the batch else discard +
     `droppedUnexpected++`.
  5. DUPLICATE: key ∈ that batch's `receivedKeys` → drop + `dupTiles++` (no
     second decode, no second pending touch) → else `receivedKeys.add(key)`
     AND `receivedThisEpoch.add(key)` (both sets, same moment).
  6. `pending.delete(key)` (unconditional at receipt).
  7. THEN interpret: `format!=1` → `terminalFailed.add(key)` + fallback kept
     (reserved WebP never decodes here — reachable ONLY for valid
     current-batch expected tiles, so stale/foreign FORMAT=2 can never
     poison the epoch); admission gate (jobs+bytes; over-either →
     `retryNeeded.add(key)`, never terminal) → queue → `createImageBitmap`
     → cache + `decodedBytes+=payloadLen` (rejection →
     `terminalFailed.add(key)` + fallback kept, never retried this epoch).
  8. `0x04` via `parseEnd` → `classify(reqId)` FIRST (stale END → discard +
     `staleEnds++`, connection alive) → current-epoch END: identity check
     → triple accounting → `BatchState.networkComplete=true`, add
     unreceived expected keys to `serverSkippedThisEpoch`, reconcile
     `netCov` (step order above).
- Picker change: the handler calls ONLY `selectImage(newId)` (the whole
  transaction lives there — see above). Every pan/zoom/resize intent calls
  `newViewIntent()` (epoch bump + budgeted batches; resize→frustum first).
- Interactions: drag/wheel clamped+finite+anchored, `pointercancel` ends
  drag, immediate `render()`, debounced intent; LOD/resize→new epoch
  (resize→frustum first). Layer `render()`: `resetTransform` + FULL-canvas
  `clearRect`/fill FIRST, then `save`/world-transform/`clip([0,W)×[0,H))`/
  full-bitmap draws/`restore`.
- Done when: `node --check` +
  `grep -q "serverSkippedThisEpoch\|receivedThisEpoch\|connectWs\|selectImage\|newViewIntent\|myEpoch\|AbortController\|infoAbort\|CLOSE_UTP_ERROR\|4002\|encodeViewport\|parseTileHeader\|tileLenMismatch\|staleTiles\|staleEnds\|netCov\|covCov" viewer.js` +
  `! grep -q "serverSkipped[^T]" viewer.js` (bare name extinct outside
  historical notes — see Notes) +
  `! grep -q "ws\.close(1002\|ws\.close()" viewer.js` (browser never
  attempts a script-sent 1002 or a codeless close for UTP violations).

### TASK-004 — test_viewer.cjs (bootstrap/ownership/wire-codec vectors)

- Create `NEW scripts/test_viewer.cjs` (`node:vm` + `node:assert`/
  `node:test`, zero deps, TEST-ONLY — app stays Node-free): vm-sandbox
  `viewer.js` with stubbed browser globals → `UltraTile` API.
- Wire-codec vectors (close the independent-interop gap): `encodeViewport`
  golden (28B, MAGIC at 0, type at 1, big-endian `0x00120304`-style field
  check, LOD byte 0, tileSize 512 at its offset); `encodeCommit`/
  `encodeAbort` golden (8B each, exact offsets); `parseTileHeader` golden
  is a COMPLETE 40-byte TILE message (24B header with `payloadLen=16` at
  20-23 + 16 payload bytes — header field offsets inspected within it;
  a bare 24-byte header with LEN>0 is an INCOMPLETE message and MUST
  reject, since no valid complete message is 24 bytes; 24-byte header-only
  vectors live in the Java `UtpCodecTest`, where header-only parsing is
  actually the API); `parseEnd` golden (16B, rejects truncation);
  round-trip encode→parse field equality; sender-path check (capture what
  the batch sender emits for a known chunk and byte-compare with
  `encodeViewport` output — proves the send path uses the codec, not a
  parallel encoder).
- Browser close-code vectors: EVERY fatal above (`endIdentityFatal`,
  `endCountMismatch`, `tileLenMismatch`) asserts the stub socket's
  `close` was called with code EXACTLY 4002 (never 1002 — script-sent
  1002 throws; capture args, assert `code===4002` + short string reason);
  `CLOSE_UTP_ERROR` is NOT in the parity map (assert the parity script
  defines no SHARED 4002 constant — no-UTP-semantics by design; the
  server-side 4002 parse/echo is covered by phase-05's peer-Close
  vectors, not by parity).
- TILE frame-length vectors (the UTP LEN ↔ WS-message-size relation):
  header with `payloadLen=100` delivered in a 123-byte message → FATAL
  (`tileLenMismatch==1`, socket closed, waiters failed, `rxBytes`
  UNCHANGED — the frame never reaches accounting); same header in a
  125-byte message → FATAL identically; same header in an exact 124-byte
  message → accepted and receipt-counted. `parseTileHeader` called
  directly with a short/long buffer rejects the same way (parser-owned
  invariant, not caller discipline).
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
- END semantics: stale/old-epoch END (reqId unknown or from a superseded
  epoch — incl. the late-previous-generation race: complete gen in E, bump
  to E+1, THEN deliver E's END) → discarded + `staleEnds==1`, connection
  alive, current-epoch waiters unaffected; current-epoch wrong-image END →
  `endIdentityFatal`, socket closed, waiters resolved; triple-accounting
  violation (e.g. duplicate TILE masking a missing key:
  `sent+skipped==size` but `sent != receivedKeys.size`) →
  `endCountMismatch`, socket closed, waiters failed; happy END populates
  `serverSkippedThisEpoch` with exactly the unreceived keys AND
  `receivedThisEpoch` already holds the received ones, and a same-epoch
  rebuild does NOT re-request skipped keys (suppression), while the NEXT
  epoch MAY.
- Stale-TILE race (frame-boundary cancel on the wire): register/complete a
  generation in E, bump to E+1 via `newViewEpoch()`, then deliver a
  STRUCTURALLY VALID E TILE (exact `24 + payloadLen` length, member of E's
  `expectedKeys`) → assert discard (`staleTiles==1`, no decode, no
  `pending` touch, no `receivedThisEpoch`/batch-`receivedKeys` add) AND
  the stub socket still OPEN (`readyState===OPEN`, `close` never called)
  AND current-epoch work unaffected (a subsequent E+1 TILE admits
  normally). The vector's TILE MUST pass `parseTileHeader` — malformed
  fatality lives in step 1; this proves classification is lenient, not
  the parser.
- netCov/covCov split: received-but-undecoded + retry keys count in
  `netCov`, NOT in `covCov`; `covCov` computed from cache; progress does
  NOT wait on `covCov==100%` when skips/terminals exist (assert the batch
  loop resolves on `networkComplete` + drain with `covCov<1`).
- netCov stability across reclamation: complete a batch (END processed,
  `netCov==N`), force `BatchState` reclamation (`decodeRefs==0` +
  `networkComplete`), then assert `netCov` STILL equals N — reclamation
  touches per-batch state only, never `receivedThisEpoch` /
  `serverSkippedThisEpoch`.
- netCov union (no double-count): receive key K (lands in
  `receivedThisEpoch`), force decoder-admission overflow so K lands in
  `retryNeeded`, re-request K in a later same-epoch generation, then have
  the server SKIP K in that generation's END (lands in
  `serverSkippedThisEpoch`) → assert `netCov` counts K exactly ONCE
  (`netCov === |union|`, not the sum).
- Single-owner image switch: seed image 0 with a live Z0 generation, call
  the picker handler for image 1, assert EXACTLY ONE `newViewEpoch` bump
  (epoch E→E+1, never E+2), exactly ONE Z0 COMMIT emitted for image 1, all
  image-0 bitmaps `close()`d BEFORE the new pin's first TILE is admitted,
  and `avgTileBytes` reset to seed; then drive a pan via `newViewIntent()`
  and assert NO cache clear, NO camera reset, NO `avgTileBytes` reset.
- Rapid-switch race (A→B, B's `/info` resolves FIRST): stub `fetch` with
  manually-resolved promises; call `selectImage(A)` (fetch A pending),
  then `selectImage(B)` (fetch B pending — A's fetch may or may not have
  been aborted); resolve B's fetch → B pins Z0 (camera = B dims, REQ_ID
  allocated for B); THEN resolve A's fetch last → assert A abandons
  (no second epoch bump, no A Z0 COMMIT, no A `allocReqId`, camera still
  B, no cache touch). Only B may pin Z0.
- `rxBytes` semantics: TILE with `payloadLen=100` adds exactly 100 (24B
  header excluded); avgTileBytes reset (seed restored on image switch).
- Epoch cleanup: terminal-fail key K in E → `newViewEpoch()` → K
  requestable again in E+1 (incl. `serverSkippedThisEpoch` key K:
  requestable in E+1; `receivedThisEpoch` likewise cleared);
  two rapid bumps purge old pending + cancel old awaiters + drop
  previous-previous BatchStates; duplicate TILE (same key twice → one
  decode, `dupTiles==1`, `rxBytes` counts both payloads); BatchState
  lifetime (current-epoch state with `networkComplete` + `decodeRefs==0`
  reclaimed; previous-epoch retained until third epoch); initial camera
  (`camX==W/2`, `camY==H/2`, `s==clamp(min(Vw/W,Vh/H))`).
- DETERMINISTIC PAN + ZOOM eviction as v1.10 (serpentine 64 keys →
  `evicts>0`; 3→1 transition → `rxBytes↑`, effZ recorded, `close()`d).
- Run `node scripts/test_viewer.cjs` green.
- COMPLETE the parity script HERE (phase-02 TASK-006 built the Java+shell
  framework with `--java-shell-only`): add the JavaScript map covering EVERY
  viewer hard-code — `TILE↔Config.T`, `MAX_CACHE↔Config.M`,
  `MAX_DECODE↔Config.D`, `DECODE_QUEUE_MAX_JOBS↔Config.DQ_JOBS`,
  `DECODE_QUEUE_MAX_BYTES↔Config.DQ_BYTES`,
  `MAX_TILE_BYTES↔Config.MAX_TILE_BYTES`, `BATCH_CAP↔Config.BATCH_CAP`,
  `AVG_TILE_SEED↔Config.AVG_TILE_SEED`, `SCALE_MIN↔Config.SCALE_MIN`,
  `SCALE_MAX↔Config.SCALE_MAX`, `MAGIC 0xAA↔Config.MAGIC`, UTP type codes
  (`T_CHUNK 0x01`, `T_TILE 0x02`, `T_ABORT 0x03`, `T_END 0x04`,
  `T_COMMIT 0x05`), `SPAN_CAP`, `GEN_TILE_CAP` where the viewer hard-codes
  them. Parse with regexes, evaluate MiB expressions, non-zero exit + diff
  on mismatch. (Rule completed here: EITHER a constant is pinned here OR it
  is removed from `Config`/the viewer.)
- Done when: `node scripts/test_viewer.cjs` + FULL `python3
  scripts/check_const_parity.py` green + intentional mismatch (temp edit)
  fails loud.

## Validation Commands

Offline validation track:

```sh
node --check src/main/resources/web/viewer.js
node scripts/test_viewer.cjs
python3 scripts/check_const_parity.py
rg -n "https?://|cdn" src/main/resources/web/ || echo "offline-clean"
grep -n "allocReqId\|BatchState\|viewEpoch\|myEpoch\|AbortController\|infoAbort\|CLOSE_UTP_ERROR\|4002\|rxBytes\|decodedBytes\|terminalFailed\|serverSkippedThisEpoch\|receivedThisEpoch\|tileLenMismatch\|staleTiles\|staleEnds\|headroomOk\|expectedKeys\|receivedKeys\|newViewEpoch\|newViewIntent\|netCov\|covCov\|binaryType\|connectWs\|selectImage\|encodeViewport\|parseTileHeader\|MAX_CACHE=40\|MAX_TILE_BYTES=2097152\|BATCH_CAP=30\|effectiveLOD" src/main/resources/web/viewer.js
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
  v1.11 added the skipped set, triple END accounting, `connectWs` vs
  `selectImage`, and the wire codec; v1.12 fixed single-ownership,
  stale ENDs, Close frames, and epoch sets; v1.13 completes the set:
  epoch-guarded `selectImage()` (A→B race), browser-close 4002 (script
  can never send 1002), union `netCov` (no double-count), and the
  complete-message `parseTileHeader` golden. Each has dedicated tests.
- `receivedKeys` (per-batch) vs epoch history vs coverage is the v1.12
  conceptual fix: per-generation receipt is a validation fact, epoch sets
  are the transport-history fact, visual coverage is a cache fact.
  `netCov` answers "is the epoch done on the wire", `covCov` answers "can
  I render". Never gate progress on `covCov`.
- Headroom discipline unchanged from v1.8: `headroomOk()` gates SENDING;
  `batchBudget()` sizes WHAT to send.
- Duplicated constants are a deliberate, pinned trade-off (no build step, no
  shared module between Java and static JS): the parity script — not
  discipline — keeps them honest. Any value change MUST update `Config.java`
  + `viewer.js` + the parity map together.
