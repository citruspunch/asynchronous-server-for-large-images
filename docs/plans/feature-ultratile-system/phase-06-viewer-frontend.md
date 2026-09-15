---
phase: phase-06-viewer-frontend
goal: GOAL-006 viewEpoch viewer plus batches plus unit-tested helpers
status: 'Planned'
parent: ./overview.md
version: 1.6
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 06 — Viewer Frontend ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-004**: Locally served, offline; `resizeCanvas()` DPR=1 first; drag/wheel pointer-anchored within scales + `isFinite` + capture/`pointercancel`; immediate cached render + debounced network intent (new `viewEpoch` per intent).
  - **REQ-005**: LOD `zFloat=N+log2(s)` clamp; `effectiveLOD` per-Z recompute, union ≤36; HUD desired-vs-effective; screen-space clear + full-bitmap compositing + `[0,W)` clip.
  - **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 + queue jobs≤24 AND bytes≤4MiB (distinct names); `viewEpoch` acceptance (`job.viewEpoch===currentViewEpoch` across batch REQ_IDs); epoch-cancel token (never wait missing END; WS close cancels all); byte-overflow→`retryNeeded` same-epoch later gen (JPEG rejection terminal-for-view); per-gen ≤30 sequential batches to END; pending `key→reqId` gen-scoped; network vs coverage split; switch keeps `nextReqId`, closes bitmaps, discards pre-decode buffers.
  - **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y).
- Prior-phase deps:
  - **DEP-005**: Requires phase-04 (picker/info routes, readiness) + phase-03 (sealed layouts, empty-COMMIT, no-wrap, freeze).
- Inputs: phase-04 placeholder `index.html`/`viewer.js`. Outputs: epoch viewer, explicit interactions, `UltraTile` testable API, deterministic eviction path.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Overwrite `src/main/resources/web/index.html` (≤110 lines): `<canvas id="view">`, `<select id="image">`, HUD `lod/effZ/bytes/reqs/evicts/cache/decJobs/decBytes/epoch/gen/netCov/covCov`, `<script src="/viewer.js" defer>`; zero external refs. Overwrite `NEW src/main/resources/web/styles.css` fullscreen. (Both `NEW` relative to a phase-04-only tree; overwrite here with full HUD.) | — | `curl -s /` contains `id="image"` + `id="effZ"` |  |  |
| TASK-002 | Implement `viewer.js` part A: consts incl. `TILE=512,MAX_CACHE=40,MAX_DECODE=6,DECODE_QUEUE_MAX_JOBS=24,DECODE_QUEUE_MAX_BYTES=4MiB,SCALE_MIN/MAX,TAU`; `nextReqId` 1..0xFFFFFFFE (never reset on switch; 1 only on new WS; max→reconnect); `viewEpoch` u32 intent counter (0 reserved; bumped on pan-commit/zoom-commit/LOD/image/resize intent — NOT per batch); per-epoch `epochToken{epoch,canceled,awaiters[]}` (`cancelEpoch()` resolves all awaiters `{canceled:true}` at once); `resizeCanvas()` DPR=1; controller + half-open `visibleTileRange(Z)`; `selectLevel` frozen; `effectiveLOD(desiredZ)` per-Z recompute + union count → first Z with `≤36` as `{desired,effective,downgraded}`; `LruCache` 40 (target+Z0 protected); `DecodePipeline` inflight≤6, queue jobs≤24 AND bytes≤4MiB (both tracked; over-either on ADMIT path → job NOT queued, coord added to `retryNeeded`, never terminal); `pending:Map(key→reqId)` gen-scoped; expose `globalThis.UltraTile={selectLevel,visibleTileRange,effectiveLOD,splitIntoBatches,DecodePipeline,LruCache,epochToken}` (pure, DOM-free — the `test_viewer.cjs` seam). | TASK-001 | `node --check viewer.js` passes |  |  |
| TASK-003 | Implement `viewer.js` part B: init `fetch(/api/images)`→picker→`fetch(/info)`→N/W/H→`nextReqId++` + `newViewEpoch()`→pin Z0 gen (chunks+COMMIT), await coverage, then effective-Z work as SEQUENTIAL ≤30-tile batch generations sharing `viewEpoch`: send batch (chunks+COMMIT with fresh REQ_ID), await `END-or-epochCancel-or-wsClose` (on END→next batch incl. `retryNeeded` coords as same-epoch later gen; on epoch-cancel→abandon chain instantly — v1.5 hang fix; on close→fail chain); all batches co-reside ≤40. Builder subtracts cached∪pending(current-gen)∪decode-queued, same-Z row-runs, one REQ_ID, COMMIT. `sendAbort(old)` + 80ms debounce starts new epoch (old chain canceled via token, old decodes resolving later accepted iff `job.viewEpoch===currentViewEpoch` — batch-G-after-G+1 case). `onmessage`: 24B checks, epoch acceptance (stale-epoch→discard-or-`close()`), byte-overflow is SERVER-impossible to see here (client-side admit gate) — decode path: admit→queue→`createImageBitmap`→cache+`bytes+=len` (rejection→terminal-failed-for-view, fallback kept); `0x04`→`networkComplete[reqId]`, reconcile `coverageComplete`. Picker change: `sendAbort(old)`, bump epoch FIRST (cancels chains/purges stale queued payloads), cache `clear()` closing EVERY bitmap, discard pre-decode buffers (no `close()` pre-bitmap), reset cam/image, monotonic reqId, re-pin Z0. Interactions: drag/wheel clamped+finite+anchored (TASK-002 consts), `pointercancel` ends drag, immediate `render()`, debounced intent; LOD/resize→new epoch (resize→frustum first). Layer `render()`: `resetTransform` + FULL-canvas `clearRect`/fill FIRST (exposed off-image pixels must not retain old frames — v1.5 clip-only bug), then `save`/world-transform/`clip([0,W)×[0,H))`/draw full padded bitmaps at own footprints/`restore`. | TASK-002 | `node --check` + `grep -q "viewEpoch\|VIEWPORT_COMMIT\|effectiveLOD" viewer.js` |  |  |
| TASK-004 | Create `NEW scripts/test_viewer.cjs` (`node:vm` + `node:assert`/`node:test`, zero deps): load `viewer.js` source into a vm sandbox with stubbed `window/document/canvas/WebSocket/fetch` globals, grab `UltraTile` API, assert: effectiveLOD per-Z recompute (mock range fn counts differ per Z), half-open edges (aligned 2560 → 5 cols, not 6; empty-range), batch split `30+6` (36 targets → gens of 30+6 sharing one epoch), old-view cancellation (epoch bump resolves batch awaiter `{canceled:true}` without END), batch-G decode resolving after G+1 begins accepted (same epoch), byte-overflow coord lands in `retryNeeded` (not failed) and is re-requested next same-epoch gen, stale-epoch decode discarded. Plus deterministic DOM-less audit: bounds names, `TILE=512`. Run `node scripts/test_viewer.cjs` green. | TASK-002 | `node scripts/test_viewer.cjs` green |  |  |

## Validation Commands

```sh
node --check src/main/resources/web/viewer.js
node scripts/test_viewer.cjs
rg -n "https?://|cdn" src/main/resources/web/ || echo "offline-clean"
grep -n "viewEpoch\|MAX_CACHE=40\|DECODE_QUEUE_MAX_JOBS\|DECODE_QUEUE_MAX_BYTES\|VIEWPORT_COMMIT\|effectiveLOD\|SCALE_MIN\|clearRect" src/main/resources/web/viewer.js
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && break || sleep 2; done
curl -s http://localhost:8080/ | grep -o '<canvas[^>]*>'
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Epoch vs REQ_ID is THE v1.6 client fix: REQ_ID sequences network batches; `viewEpoch` sequences visual intents. Batch-G-after-G+1 acceptance and instant epoch-cancel both fall out of comparing `job.viewEpoch` to `currentViewEpoch`.
- Decode admission is the ONLY place the byte bound is enforced client-side; overflow is scheduling (`retryNeeded`), never quality loss. 30-requested/gen still holds (6 decode + 24 queued jobs); bytes gate additionally.
- `globalThis.UltraTile` seam keeps browser loading (`<script defer>`, no modules) while enabling real unit tests — no build step, no framework.
