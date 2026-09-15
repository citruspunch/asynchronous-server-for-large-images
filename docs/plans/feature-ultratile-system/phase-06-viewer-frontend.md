---
phase: phase-06-viewer-frontend
goal: GOAL-006 Layer-compositing viewer with picker plus bounded queues
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 06 — Viewer Frontend ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-004**: Frontend HTML/JS/CSS, all libs locally served; zero external requests; offline grading; canvas resize sets backing store to CSS pixels at DPR=1 before camera/frustum math.
  - **REQ-005**: Centered continuous zoom + three LOD policies (Auto tau=0.7071 default, Quality ceil, Performance floor) with layer compositing: render cached coarse layers at own world positions first, overlay finer layers; never stretch one ancestor into each child rect.
  - **REQ-006**: Bounded pipelines: LRU-40 logical decoded-pixel budget with supported viewport ≤2048px wide; larger working sets page via sequential generations or memory-aware LOD downgrade; decode max 6 in-flight + queue cap 24 with immediate stale-gen purge; frustum-aware pruning.
  - **PAT-002**: Centered camera: `screenX=Vw/2+s*(worldX-camX)`, `screenY=Vh/2+s*(worldY-camY)`; `cam` is world point at viewport center.
- Prior-phase deps:
  - **DEP-005**: Requires phase-02 dual-demo routes + picker contract and phase-03 logical-generation layouts (28B/24B/16B, no-wrap, same-REQ_ID chunks).
- Inputs: placeholder `index.html`/`viewer.js`. Outputs: compositing viewer with picker, half-open frustum, cache-subtracted requests.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Overwrite `NEW src/main/resources/web/index.html` (≤110 lines): `<canvas id="view">`, `<select id="image">` (populated from `/api/images`), HUD `lod/bytes/reqs/evicts/cache/decodes/gen`, `<script src="/viewer.js" defer>`; zero external refs. Overwrite `NEW src/main/resources/web/styles.css` fullscreen. Add `resizeCanvas()` in viewer (phase TASK-002) setting `canvas.width=clientWidth`, `height=clientHeight` at DPR=1 on `resize` + init before any frustum math. | — | `curl -s /` contains `id="image"` + `id="bytes"` |  |  |
| TASK-002 | Implement `viewer.js` part A: consts `TILE=512,MAX_CACHE=40,MAX_DECODE=6,DECODE_QUEUE_MAX=24,TAU=0.7071`; `nextReqId` 1..0xFFFFFFFE (on max → `ws.close(1000)` + reconnect, never wrap); `ViewportController` centered + half-open `visibleTileRange` (intersect `[cam-Vw/2s,cam+Vw/2s)` with `[0,W)`, empty→`{empty:true}`, `maxTile=min(C-1,ceil(max/512)-1)`, out-of-image pan returns empty, no `min>max`); `selectLevel` + memory-aware guard (if estimated target tiles >32, stay one level coarser or page viewport into sequential same-image generations, log to HUD); `LruCache` 40 with protected = rendered layers (target + present ancestors), key `imageId:z:x:y` (never REQ_ID); `DecodePipeline` inflight≤6 + queue≤24, on new generation purge queued stale-gen ArrayBuffers immediately. | TASK-001 | `node --check viewer.js` passes |  |  |
| TASK-003 | Implement `viewer.js` part B: init flow `fetch(/api/images)` → populate picker → `fetch(/api/images/{id}/info)` → set `N/W/H/levels` → abort old gen + `nextReqId++` + clear cache/re-scope + init cam=center + request; on picker change same flow. Request builder: compute target range, subtract `cachedKeys ∪ pendingKeys ∪ decodeQueuedKeys`, group remainder into contiguous row-runs (same Z, same Y, consecutive X) each as one 28B `VIEWPORT_UPDATE` sharing ONE logical `reqId` (split >128 into multiple same-reqId packets); server dedupes. `sendAbort(oldGen)` 8B then debounced 80ms `sendViewport(newGen)`. `onmessage`: 24B header (`TILE_SIZE==512`, FORMAT→`image/jpeg`/`image/webp` Blob type), if `reqId!==currentGen` → `close()` discard (stale TCP allowed); else bounded-decode; `0x04 GENERATION_END` → mark `reqId` complete (`sent/skipped`), release fallback parents no longer needed, update HUD; missing coords permanently marked failed for that gen (fallback persists). Layer `render()`: `clearRect`, for `z=0..targetZ` draw every cached tile of that layer once at own world rect (`worldX=x*512*2^(N-z)`, size `512*2^(N-z)`, clipped by `actualW/H` via `drawImage(bmp,0,0,actualW,actualH,dstX,dstY,dstW,dstH)` with centered camera); fine overlays coarse; never per-child ancestor stretch. | TASK-002 | `node --check` + `grep -q "GENERATION_END\|nextReqId\|DECODE_QUEUE_MAX" viewer.js` |  |  |
| TASK-004 | Audit: external `rg` empty; `MAX_CACHE=40` + `MAX_DECODE=6` + queue 24 + `TILE=512`; 4096 Z3 eviction run shows `bytes↑/evicts↑` + `cache≤40` + `decodes≤6` + queue≤24; 2048 smoke only; picker switches image (cache cleared, gen reset); Network localhost-only. | TASK-003 | 4096 LOD sweep evicts>0 + bounds hold |  |  |

## Validation Commands

```sh
node --check src/main/resources/web/viewer.js
rg -n "https?://|cdn" src/main/resources/web/ || echo "offline-clean"
grep -n "MAX_CACHE=40\|MAX_DECODE=6\|DECODE_QUEUE_MAX\|nextReqId\|GENERATION_END\|resizeCanvas" src/main/resources/web/viewer.js
curl -s http://localhost:8080/ | grep -o '<canvas[^>]*>'
```

## Notes for Implementer

- Layer compositing replaces v1.2 per-target ancestor-stretch (geometrically wrong: one parent covers 4 children); coarse tiles drawn at own footprints, fine cover arrived regions, partial coverage correct incl. padded edges.
- M=40 invariant scoped: supported ≤2048px wide (≈12-20 + ancestors <40); 4K HQ ~77 must page (sequential gens, evicting behind) or downgrade one LOD; document choice in HUD (`lod` shows effective Z).
- Cache keys exclude REQ_ID so generations share tiles; pending/decode sets prevent resend on pans.
- `0x02 FORMAT` mapping mandatory; unknown FORMAT → discard + console warn.
