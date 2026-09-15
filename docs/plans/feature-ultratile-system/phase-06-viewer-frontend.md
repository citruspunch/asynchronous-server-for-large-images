---
phase: phase-06-viewer-frontend
goal: GOAL-006 BatchState viewer plus capacity-aware batches plus unit tests
status: 'Planned'
parent: ./overview.md
version: 1.7
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 06 — Viewer Frontend ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-004**: Locally served, offline; `resizeCanvas()` DPR=1 first; drag/wheel pointer-anchored within scales + `isFinite` + capture/`pointercancel`; immediate cached render + debounced network intent (new `viewEpoch` per intent). Node test-only; app Node-free.
  - **REQ-005**: LOD `zFloat=N+log2(s)` clamp; `effectiveLOD` per-Z recompute, union ≤36; HUD desired-vs-effective (+`epoch`, `rxBytes` vs `decodedBytes`); screen-space clear + full-bitmap compositing + `[0,W)` clip.
  - **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 + queue jobs≤24 AND bytes≤4MiB (distinct names); `viewEpoch` intent counter + `BatchState{reqId,epoch,expectedKeys,networkComplete,canceled}` retained for active epoch + recently canceled (bounded); capacity-aware batch/retry scheduling (END ≠ decoder-ready); suppression covers queued AND in-flight (`decodePipeline.has(key)`); byte-overflow→`retryNeeded` same-epoch later gen (JPEG rejection terminal-for-view); per-gen ≤30 sequential batches; pending `key→reqId` gen-scoped; network vs coverage split; switch keeps `nextReqId`, closes bitmaps, discards pre-decode buffers.
  - **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y).
- Prior-phase deps:
  - **DEP-005**: Requires phase-04 (picker/info routes incl. `rxBytes` HUD ids, readiness) + phase-03 (sealed layouts, empty-COMMIT, no-wrap + seen-rule, freeze).
- Inputs: phase-04 placeholder `index.html`/`viewer.js`. Outputs: bridged epoch viewer, explicit interactions, `UltraTile` testable API, deterministic eviction path.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Overwrite `src/main/resources/web/index.html` (≤110 lines): `<canvas id="view">`, `<select id="image">`, HUD `lod/effZ/rxBytes/decodedBytes/reqs/evicts/cache/decJobs/decBytes/epoch/gen/netCov/covCov`, `<script src="/viewer.js" defer>`; zero external refs. Overwrite `NEW src/main/resources/web/styles.css` fullscreen. (Both `NEW` relative to a phase-04-only tree; overwrite here with full HUD.) | — | `curl -s /` contains `id="image"` + `id="rxBytes"` |  |  |
| TASK-002 | Implement `viewer.js` part A: consts incl. `TILE=512,MAX_CACHE=40,MAX_DECODE=6,DECODE_QUEUE_MAX_JOBS=24,DECODE_QUEUE_MAX_BYTES=4MiB,SCALE_MIN/MAX,TAU`; `nextReqId` 1..0xFFFFFFFE (never reset on switch; 1 only on new WS; max→reconnect); `viewEpoch` u32 (0 reserved; per intent); per-epoch `epochToken{epoch,canceled,awaiters[]}`; `BatchState{reqId,epoch,expectedKeys:Set,networkComplete,canceled}` in `batches:Map(reqId→BatchState)` — insert on send, retain while epoch is current OR previous (bounded: drop states older than previous intent once their frames classify; monotonic REQ_IDs keep the window tiny); `classify(reqId)` returns epoch or `stale-unknown` (→discard path). `resizeCanvas()` DPR=1; controller + half-open `visibleTileRange(Z)`; `selectLevel` frozen; `effectiveLOD(desiredZ)` per-Z recompute + union count → first Z `≤36` as `{desired,effective,downgraded}`; `LruCache` 40 (target+Z0 protected); `DecodePipeline` inflight≤6, queue jobs≤24 AND bytes≤4MiB, `has(key)` TRUE for queued AND in-flight (suppression covers decoding tiles — v1.6 re-request bug fixed), purge stale-epoch on supersede; `pending:Map(key→reqId)` gen-scoped; `rxBytes+=frameLen` on EVERY valid TILE receipt (before decode — transfer proof), `decodedBytes+=len` only on cache insert; expose `globalThis.UltraTile={selectLevel,visibleTileRange,effectiveLOD,splitIntoBatches,DecodePipeline,LruCache,epochToken,BatchState,classify}` (DOM-free seam). | TASK-001 | `node --check viewer.js` passes |  |  |
| TASK-003 | Implement `viewer.js` part B: init `fetch(/api/images)`→picker→`fetch(/info)`→N/W/H→`nextReqId++` + `newViewEpoch()`→pin Z0 gen (chunks+COMMIT), await coverage, then effective-Z work as CAPACITY-AWARE sequential ≤30-tile batches sharing `viewEpoch`: send batch (chunks+COMMIT, fresh REQ_ID, `BatchState` registered), await `END-or-epochCancel-or-wsClose` (on END → FIRST wait decoder headroom: `inflight<MAX_DECODE && queueJobs<max && queueBytes<max`, else wait `decodeDrain` event — sending into a full decoder just re-overflows; then next batch incl. `retryNeeded` coords as same-epoch later gen; on epoch-cancel→abandon instantly; on close→fail chain); all batches co-reside ≤40. Builder subtracts cached∪pending(current-gen)∪decode-queued∪decode-IN-FLIGHT (`has(key)`), same-Z row-runs, one REQ_ID, COMMIT. `sendAbort(old)` + 80ms debounce starts new epoch (bump FIRST: cancels chains, purges stale queued payloads, old `BatchState`s move to retained-canceled window; late decodes accepted iff `classify(reqId).epoch===currentViewEpoch` — batch-G-after-G+1 case). `onmessage`: 24B checks → `rxBytes+=frameLen` immediately → `classify(reqId)` (unknown→discard; stale-epoch→discard-or-`close()`) → admit gate (jobs+bytes; over-either → `retryNeeded`, never terminal) → queue → `createImageBitmap` → cache + `decodedBytes+=len` (rejection→terminal-failed-for-view, fallback kept); `0x04`→ matching `BatchState.networkComplete`, reconcile `coverageComplete`. Picker change: `sendAbort(old)`, bump epoch FIRST, cache `clear()` closing EVERY bitmap, discard pre-decode buffers (no `close()` pre-bitmap), reset cam/image, monotonic reqId, re-pin Z0. Interactions: drag/wheel clamped+finite+anchored, `pointercancel` ends drag, immediate `render()`, debounced intent; LOD/resize→new epoch (resize→frustum first). Layer `render()`: `resetTransform` + FULL-canvas `clearRect`/fill FIRST, then `save`/world-transform/`clip([0,W)×[0,H))`/full-bitmap draws/`restore`. | TASK-002 | `node --check` + `grep -q "BatchState\|viewEpoch\|rxBytes" viewer.js` |  |  |
| TASK-004 | Create `NEW scripts/test_viewer.cjs` (`node:vm` + `node:assert`/`node:test`, zero deps, TEST-ONLY — app stays Node-free): vm-sandbox `viewer.js` with stubbed browser globals → `UltraTile` API; assert: effectiveLOD per-Z recompute, half-open edges (2560→5 cols; empty-range), batch split `30+6` same epoch, epoch-cancel resolves awaiter without END, G-decode-after-G+1 accepted (same epoch via `classify`), byte-overflow→`retryNeeded` + re-requested next same-epoch gen (not failed), stale-epoch (previous-previous intent, evicted `BatchState`) discarded as unknown, in-flight key suppressed from rebuild (`has(key)` true while decoding), `rxBytes` counts receipt even for discarded/stale frames while `decodedBytes` counts only inserts, capacity gate (no next batch while decoder full despite END). Run `node scripts/test_viewer.cjs` green. | TASK-002 | `node scripts/test_viewer.cjs` green |  |  |

## Validation Commands

```sh
node --check src/main/resources/web/viewer.js
node scripts/test_viewer.cjs
rg -n "https?://|cdn" src/main/resources/web/ || echo "offline-clean"
grep -n "BatchState\|viewEpoch\|rxBytes\|decodedBytes\|MAX_CACHE=40\|effectiveLOD" src/main/resources/web/viewer.js
./build.sh
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$pid"; exit 1; }
curl -s http://localhost:8080/ | grep -o '<canvas[^>]*>'
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- `classify(reqId)` is THE v1.7 client bridge: without `reqId→epoch` state, epoch acceptance cannot be computed from wire data. Retention window (current + previous intent) bounds memory; monotonic REQ_IDs make eviction safe.
- END-gated-but-capacity-waited scheduling: network completion only STARTS the decoder-readiness wait; the next batch goes out when both are satisfied.
- Validation builds its own JAR first (`./build.sh`) — fully self-contained like phases 04/05/07.
