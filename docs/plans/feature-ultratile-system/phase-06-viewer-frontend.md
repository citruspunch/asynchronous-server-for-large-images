---
phase: phase-06-viewer-frontend
goal: GOAL-006 Z0-pinned viewer plus effective LOD plus gen-scoped queues
status: 'Planned'
parent: ./overview.md
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 06 — Viewer Frontend ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-004**: Locally served, offline; `resizeCanvas()` DPR=1 first; drag `cam-=Δscreen/s`, wheel `s` pointer-anchored within [`SCALE_MIN`,`SCALE_MAX`] + `isFinite` guard + capture/`pointercancel`; immediate cached render + debounced network gen; LOD/resize → new gens.
  - **REQ-005**: LOD `zFloat=N+log2(s)` clamp; `effectiveLOD` recomputes half-open frustum at EVERY candidate Z, counts union `{visible target}∪{Z0}`, downgrades to protected ≤36; HUD desired-vs-effective; full-bitmap compositing + `[0,W)` clip.
  - **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 + queue `DQ_JOBS=24` AND `DQ_BYTES=4MiB` (distinct HUD/test names), stale-gen purge; per-gen requested ≤30 with sequential sealed batches to END; pending `key→reqId` gen-scoped; network vs coverage split; switch keeps `nextReqId`, closes every bitmap, discards pre-decode buffers.
  - **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y).
- Prior-phase deps:
  - **DEP-005**: Requires phase-04 (picker/info routes, readiness) + phase-03 (sealed layouts `0x01`/`0x05`/`0x03`, COMMIT incl. empty, no-wrap, freeze).
- Inputs: phase-04 placeholder `index.html`/`viewer.js`. Outputs: pinned viewer, explicit interactions, deterministic eviction path.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Overwrite `src/main/resources/web/index.html` (≤110 lines): `<canvas id="view">`, `<select id="image">`, HUD `lod/effZ/bytes/reqs/evicts/cache/decJobs/decBytes/gen/netCov/covCov`, `<script src="/viewer.js" defer>`; zero external refs. Overwrite `NEW src/main/resources/web/styles.css` fullscreen. (Both `NEW` relative to a phase-04-only tree; overwrite here with full HUD.) | — | `curl -s /` contains `id="image"` + `id="effZ"` |  |  |
| TASK-002 | Implement `viewer.js` part A: consts `TILE=512,MAX_CACHE=40,MAX_DECODE=6,DECODE_QUEUE_MAX_JOBS=24,DECODE_QUEUE_MAX_BYTES=4*1024*1024,SCALE_MIN=1e-3,SCALE_MAX=32,TAU=0.7071`; `nextReqId` 1..0xFFFFFFFE, NEVER reset on image switch (1 only on new WS; max→reconnect); `resizeCanvas()` DPR=1 before math; centered controller + half-open `visibleTileRange(Z)` (empty-safe); `selectLevel` frozen formula; `effectiveLOD(desiredZ)`: for Z from desired down to 0 recompute range AT Z, count `|targetKeys(Z) ∪ {Z0}|`, return first Z with `≤36` as `{desired,effective,downgraded}` (a `range` computed once must NOT be reused across Z — v1.4 bug); `LruCache` 40 protecting visible-target+Z0; `DecodePipeline` inflight≤6, queue jobs≤24 AND bytes≤4MiB (track `byteLength` sum; reject over either), purge stale-gen on supersede; `pending:Map(key→reqId)` (supersede deletes old-gen entries; cache gen-independent). | TASK-001 | `node --check viewer.js` passes |  |  |
| TASK-003 | Implement `viewer.js` part B: init `fetch(/api/images)`→picker→`fetch(/info)`→N/W/H→`nextReqId++`→pin Z0 gen G (chunks+COMMIT), await coverage, then effective-Z work as sequential ≤30-tile sealed generations (one REQ_ID per batch: chunks+COMMIT, wait END, next batch; all co-reside ≤40 — NOT the rejected 77-through-40 paging); picker change: `sendAbort(old)`, cache `clear()` closing EVERY bitmap, discard pre-decode buffers (no `close()` pre-bitmap), reset cam/image, monotonic reqId, re-pin Z0. Builder subtracts cached∪pending(current-gen)∪decode-queued, same-Z row-runs, one REQ_ID, COMMIT. `sendAbort(old)` + 80ms debounce. `onmessage`: 24B (512, FORMAT→mime, reqId) stale→discard-or-`close()`; `0x04`→`networkComplete`, reconcile `coverageComplete` (decode-reject→failed, fallback kept). Interactions: `pointerdown/move/up` (+`setPointerCapture`, `pointercancel`→end drag), `wheel` preventDefault `s*=1.12^(-deltaY/100)` clamped + `isFinite` else ignore, anchor `cam = worldAtCursor-(cursor-V/2)/sNew`; immediate `render()`, debounced viewport; LOD/resize→new gen (resize→frustum first). Layer `render()`: `save`, world transform, `clip([0,W)×[0,H))`, background fill, for `z=0..effZ` draw each cached tile FULL padded bitmap at `512*2^(N-z)` footprint (frozen: never crop-stretch edge source); `restore`. | TASK-002 | `node --check` + `grep -q "VIEWPORT_COMMIT\|effectiveLOD\|SCALE_MIN" viewer.js` |  |  |
| TASK-004 | Deterministic audit: external `rg` empty; bounds (40/6/24jobs/4MiB) + `TILE=512`; FIXED pan path on id1 4096 at fixed effective Z (e.g. Z3 left→right rows 0..3 full sweeps = 64 unique >40) asserting `evicts>0` + `cache≤40` + jobs/bytes bounds; Z0 pin resists eviction; switch closes all bitmaps; 2048 smoke-only; localhost-only. | TASK-003 | fixed-path eviction green + bounds hold |  |  |

## Validation Commands

```sh
node --check src/main/resources/web/viewer.js
rg -n "https?://|cdn" src/main/resources/web/ || echo "offline-clean"
grep -n "MAX_CACHE=40\|MAX_DECODE=6\|DECODE_QUEUE_MAX_JOBS\|DECODE_QUEUE_MAX_BYTES\|nextReqId\|VIEWPORT_COMMIT\|effectiveLOD\|SCALE_MIN\|clip(" src/main/resources/web/viewer.js
curl -s http://localhost:8080/ | grep -o '<canvas[^>]*>'
```

## Notes for Implementer

- Decode bound (6+24jobs/4MiB ⇒ ≤30/gen) and LOD bound (protected ≤36) are DIFFERENT constraints: batching (sequential sealed ≤30 gens) bridges them inside the 40 cache. Name jobs vs bytes distinctly everywhere (`decJobs`/`decBytes`).
- Full-bitmap + clip replaces v1.4 source-crop language (cropping 464px over a 512 destination was the stretch bug); `actualW` is no longer a render input.
- Fixed pan path (not "a sweep") makes eviction deterministic regardless of canvas size.
