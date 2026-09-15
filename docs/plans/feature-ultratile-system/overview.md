---
goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
version: 1.7
date_created: 2026-09-15
last_updated: 2026-09-15
status: 'Planned'
tags: [feature, ultratile, java21, tiling, websocket, offline]
plan_type: split
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Build UltraTile end-to-end from empty repo (`README.md:1`, `project_instructions.md:1-94`). JDK-only Java 21 `ServerSocketChannel` server (reader VT + dispatcher VT per WS session, `WsWriter` on `ReentrantLock` with `writeFully`, `transferTile` declaring `24+fileSize`, mid-frame failure fatal) serves frontend over a strict GET-only HTTP/1.1 subset (multi-value header map, absolute-form, bodyless upgrades) and padded 512x512 JPEG tiles over sealed-generation UTP/1.0 on RFC 6455. Generation history is monotonic `lastReqIdSeen`, advanced ONLY on accepted new generations (first valid chunk, or valid empty COMMIT); same-gen chunks, matching COMMITs, ABORTs, and rejects never advance it. COMMIT builds the immutable set off-queue, attaches it, seals last, then enqueues ONE ready token — the dispatcher cannot consume pre-seal work. u32 wire fields parse to `long` with `min<=max`, image bounds, and `long` span math. Client bridges wire→visual identity with `BatchState{reqId,epoch,…}` retained for the active epoch plus recently canceled generations; batches and retries are decoder-capacity-aware; in-flight decodes suppress re-requests; `rxBytes` counts network receipt while `decodedBytes` counts useful decodes. Demos via atomic `.ready` publish with stale-tmp recovery and strict `meta.json` parsing; live rescan, no restart. Node is test-only tooling; the app never needs it. Offline grading.

## 1. Requirements & Constraints

- **REQ-001**: Java 20/21 async server serves ultra-high-resolution images with progressive/selective loading via 512x512 tiling (ceiling pyramid, post-padded edges, clear-then-clip compositing); never serves full ultra-res image.
- **REQ-002**: Per WS session one reader VT + one dispatcher VT; one serialized `WsWriter` (`ReentrantLock`; reader may call `writeControl` under it); blocking-on-VT model (NOT selector async; report states plainly). Visibility: `AtomicReference<GenerationState> active`, `AtomicLong lastReqIdSeen` (reader-updated ONLY on accepted new generation: first valid chunk of a newer REQ_ID, or valid empty COMMIT — same-gen chunks, matching COMMITs, ABORTs, rejects never advance; anything below it is stale unless the active generation's allowed continuation), `volatile` sealed/canceled, `AtomicBoolean` closed, atomic tile-channel ref, idempotent cleanup; dispatcher owns `sent/skipped/inFlight`; requested set reader-owned pre-seal. Close coordination as v1.6; I/O/EOF aborts immediately. No deadlines by design.
- **REQ-003**: Strict HTTP/1.1 subset: GET-only (`405` + `Allow: GET`), origin-form + absolute-form normalization, exactly-one valid Host, headers stored as `Map<String,List<String>>` (multiplicity preserved; duplicates detected before collapsing — never a lossy single-value map), `writeFully`/`readFully`, leftover bytes only after bodyless valid upgrade; UTP/1.0 over RFC 6455 documented.
- **REQ-004**: Frontend locally served, offline; `resizeCanvas()` DPR=1 first; drag/wheel pointer-anchored within scales + `isFinite` + capture/`pointercancel`; immediate cached render + debounced network intent (new `viewEpoch` per intent). Node (`node --check`, `test_viewer.cjs`) is TEST-ONLY tooling: the shipped app (Java + static JS, no build step) never requires Node; E2E/manual validation paths without Node are documented in the report.
- **REQ-005**: LOD frozen (`zFloat`, clamp, ceil/floor/frac≥0.5); `effectiveLOD` per-Z recompute, union ≤36; HUD desired-vs-effective; clear-then-clip full-bitmap compositing.
- **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 in-flight + queue jobs≤24 AND bytes≤4MiB (distinct names); per-intent `viewEpoch`: ≤30-tile batches share one epoch; wire→visual bridge is explicit `BatchState{reqId,epoch,expectedKeys,networkComplete,canceled}` retained for the active epoch PLUS recently canceled REQ_IDs (bounded: current intent's batches + last superseded intent) so buffered stale frames classify deterministically; decode accepted iff mapped epoch === currentViewEpoch. Batch/retry scheduling is decoder-capacity-aware: before sending the next batch or a `retryNeeded` gen, wait for decoder headroom (inflight<max AND queue jobs/bytes below caps) or a coverage/drain threshold — `0x04` END means network done, never decoder-ready. Suppression set = cached ∪ pending ∪ decode-queued ∪ decode-IN-FLIGHT (`decodePipeline.has(key)` covers both queued and decoding; equivalently the pending marker survives until decode success/failure). Byte-overflow → `retryNeeded` same-epoch later gen; JPEG rejection terminal-for-view. `rxBytes` increments on every valid TILE receipt (transfer proof); `decodedBytes`/`usefulBytes` track post-decode value separately. `networkComplete` vs `coverageComplete` split stands.
- **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0/1/2`, FORMAT jpeg/webp; REQ_ID u32 no-wrap (reconnect before max; never reset on image switch, 1 only on new WS): `0x01` 28B `>BBHBBHIIIII` (freeze/mismatch-invalid/post-seal-rejected); `0x05` 8B `>BBHI` (seal; empty COMMIT → END 0/0); `0x03` 8B `>BBHI` (cancel needs matching `(imageId,reqId)` — wrong-image ABORT ignored/rejected and never touches `lastReqIdSeen`; terminal, no END); `0x02` 24B `>BBHBBHIIII` (LEN u32 + ≤`MAX_TILE_BYTES`); `0x04` 16B `>BBHIII` (sealed/non-canceled/active/empty/inflight0 only). Span≤128/packet; unique set ≤`GEN_TILE_CAP=256` pre-insert reject; validate-before-supersede (newer→mark-old-canceled-then-supersede + advance `lastReqIdSeen` ONLY on acceptance; ==→append+dedupe; older→ignore).
- **REQ-008**: dz/onetile import + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); import START handles a leftover `.tmp-<id>` (crash recovery: quarantine to `.stale-tmp-<id>-<unique>/` or remove after logging — never reuse blindly, never block forever); CLI IDs decimal `0..65535` pre-path, all args quoted; ready target → no-op; non-ready numeric dir → `.stale-<id>-<epoch>/` quarantine; ignore `.tmp-*`/`.stale-*`. Synthetic fallback bounded O(tile-size), crop-then-downsample-then-pad-output. Metadata: tiny STRICT hand parser for the exact generated `meta.json` schema (JDK has no general JSON parser); a `.ready` dir with malformed/inconsistent metadata is ignored with WARNING (never 500); `levels` must equal PAT-001 `levelCount(w,h)`. Startup auto-generates demos if no `.ready`; trust `.ready` only.
- **REQ-009**: Dispatch on sealed READY TOKENS (not raw queue occupancy): COMMIT builds/sorts the complete immutable set OFF the dispatch queue, attaches it to the state, publishes `sealed=true` last, then enqueues exactly one ready token + signals (dispatcher dequeues the token, never scans for sealed work — pre-seal consumption structurally impossible; empty COMMIT publishes sealed-empty + immediate END 0/0); per-`GenerationState` 3-point checks; `transferTile` WS `24+fileSize` + `writeFully` + loop; size gate pre-frame; SKIPPED pre-frame only; post-start fatal; `0x04` additionally requires `active.get()==state`. u32 discipline everywhere: `Integer.toUnsignedLong(...)` on receipt, explicit `min<=max`, image-specific coordinate bounds, widths/spans in `long` (vectors: `0xffffffff`, reversed min/max, span-product overflow).
- **SEC-001**: Validate id/Z/coords/`TILE_SIZE==512`/LOD/span/`GEN_TILE_CAP`/u32-shape (see REQ-009); client subtracts cached∪pending∪decode-queued∪in-flight, same-Z row-runs, ≤30/batch, COMMIT; server dedupes; priority queue defensive backstop only.
- **SEC-002**: `0.0.0.0:8080`; normalized `http://` Origin vs `Host` (absent allowed); `/ws` bodyless-only; queue 256; 1 KiB cap (1009/1002/1003); version-mismatch 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
- **CON-001**: Java 21, Maven (exact pins) + `build.sh` (bash, `set -euo pipefail`, cleans classes, empty-safe copy, JDK-only).
- **CON-002**: `Config` single source (v1.6 set + `BATCH_CAP=30` already): `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `GEN_TILE_CAP=256`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `BATCH_CAP=30`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`; demos id0 2048 (21) + id1 4096 (85); live rescan per call, no restart. Node is NOT a runtime dep (test-only).
- **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
- **GUD-001**: `Cache-Control` split; FINE logs (redirectable); HUD/E2E bytes(active-Z/reqs/evicts/decodes, with `rxBytes` vs `decodedBytes` split) prove transfer+eviction.
- **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches; n=0 smallest direct map.
- **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y); cam = viewport-center world point.
- **PAT-003**: Half-open + empty-range: intersect native `[cam-Vw/2s,cam+Vw/2s)` with `[0,W)`, empty→no request; scale `2^(Z-N)`; `minTile=floor(min/512)`, `maxTile=min(C-1,ceil(max/512)-1)`.
- **PAT-004**: Screen-space clear FIRST, then world transform, clip `[0,W)×[0,H)`, full padded 512 bitmaps at `512*2^(N-z)` footprints (never crop-stretch); fine overlays coarse.

## 2. Phase Index

| Phase | File | Goal | Status |
| ----- | ---- | ---- | ------ |
| 01 | ./phase-01-project-scaffolding.md | GOAL-001: Exact-pin Maven + robust build.sh + compilable stub | Planned |
| 02 | ./phase-02-tile-engine.md | GOAL-002: Ceiling store + validated import + strict meta + 106-tile demos | Planned |
| 03 | ./phase-03-utp-codec.md | GOAL-003: Sealed-generation codec 28B/8B/8B/24B/16B round-trips | Planned |
| 04 | ./phase-04-http-bootstrap.md | GOAL-004: Strict GET-only multi-value-header HTTP + live metadata | Planned |
| 05 | ./phase-05-concurrency-sessions.md | GOAL-005: Token-gated sessions + u32 discipline + seen-rule | Planned |
| 06 | ./phase-06-viewer-frontend.md | GOAL-006: BatchState viewer + capacity-aware batches + unit tests | Planned |
| 07 | ./phase-07-protocol-doc-e2e.md | GOAL-007: Sealed-lifecycle doc + contract/unit-split E2E | Planned |

## 3. Alternatives

- **ALT-001**: `HttpServer` hijack — rejected BLOCKER, no 101/raw-socket API in Java 21.
- **ALT-002**: IIIF-only — rejected, no custom protocol.
- **ALT-003**: CDN framework — rejected, offline violation.
- **ALT-004**: 256px/120-cache — rejected, 4x index + dispatch cost.
- **ALT-005**: Jetty/Netty — rejected, hides handler + offline risk.
- **ALT-006**: google-layout vips source — rejected BLOCKER: pre-expands canvas; dz + post-pad preserves PAT-001.
- **ALT-007**: Paging oversized viewports through M=40 — rejected: 77-tile frame cannot co-reside in 40; effective-LOD downgrade instead.

## 4. Dependencies

- **DEP-001**: Phase 02 requires phase 01 pins + `Config` + stub + `build.sh` + ready convention.
- **DEP-002**: Phase 03 requires phase 01 layout only.
- **DEP-003**: Phase 04 requires phases 01 + 02 (`ImageRegistry`, `.ready` demos).
- **DEP-004**: Phase 05 requires 02 (channel API, padded store) + 03 (codecs) + 04 (HTTP parser/router it extends).
- **DEP-005**: Phase 06 requires 04 (picker/info routes) + 03 (sealed layouts).
- **DEP-006**: Phase 07 requires all prior.

## 5. Files

- **FILE-001**: `NEW pom.xml` — exact plugin versions + manifest.
- **FILE-002**: `NEW build.sh` — bash, `set -euo pipefail`, cleans classes, empty-safe copy.
- **FILE-003**: `NEW src/main/java/com/ultratile/net/NioHttpServer.java` — multi-value headers + GET-only + absolute-form + leftover policy.
- **FILE-004**: `NEW src/main/java/com/ultratile/proto/UtpCodec.java` — `TileHeader` (gated LEN) + `ViewportCommit` + `0x04` + u32 discipline.
- **FILE-005**: `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java` — ceiling + channel API + size gate.
- **FILE-006**: `NEW scripts/import_vips.sh` — validated IDs, dz/onetile + post-pad + atomic publish + idempotent no-op + tmp recovery.
- **FILE-007**: `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `WsWriter.java` (`ReentrantLock` + `writeFully`) + `SessionCoordinator.java` (`GenerationState`, `lastReqIdSeen`, ready tokens).
- **FILE-008**: `NEW src/main/resources/web/viewer.js` — viewEpoch + `BatchState` + capacity-aware batches + compositing (exposes `globalThis.UltraTile`).
- **FILE-009**: `NEW docs/protocol/UTP-1.0.md` — sealed-lifecycle doc.
- **FILE-010**: `NEW scripts/test_viewer.cjs` — `node:vm` unit tests (test-only; app Node-free).
- Verified ground truth: v1.6 plans (`overview.md:1-103`, `phase-01:1-48`, `phase-02:1-48`, `phase-03:1-41`, `phase-04:1-51`, `phase-05:1-48`, `phase-06:1-51`, `phase-07:1-51`); impl files `NEW`.

## 6. Testing

- **TEST-001**: `mvn -o -q test` + `./build.sh` + `node scripts/test_viewer.cjs` green (codec incl. `0x05`/LEN-gate/LOD/u32 vectors, ceiling, GenerationState seal-token/empty-END/mismatch/cap/seen-rule/poisoning/supersede-cancel/no-END/active-guard, writer serialization + `writeFully`, transferTo `2,0,2` + partial + fatal-after-start, WS matrix incl. version-advertise, half-open/empty, no-wrap, viewer LOD/ranges/batches/epoch/BatchState/capacity/retry/rxBytes).
- **TEST-002**: `curl` static/info (+405 non-GET); live registry; readiness loops FAIL LOUD on budget exhaustion (`ready` flag / nonzero helper — no silent fall-through to `kill`); absolute-form probe; split-line lifecycle (no AND-list backgrounding, no fixed sleeps).
- **TEST-003**: E2E contract only — fresh `os.urandom(4)` mask per frame (`0x82`, `0x80|len`, XOR; no 126/127-send), chunks + COMMIT, one gen1 tile THEN switch (never wait gen1 END), buffered gen1 tolerated, gen2 TILE + `0x04`, Ping→Pong, 2/4/10 + 64-bit parse; cancel/missing/validation in unit tests.
- **TEST-004**: Offline; LRU≤40, inflight≤6, decodeQ jobs≤24 + bytes≤4MiB; deterministic 4096 fixed-path pan (>40 unique @ fixed effective Z) asserts `evicts>0` + desired-vs-effective; 2048 smoke-only. Node absence must not block app use: report documents the no-Node manual/E2E path.

## 7. Risks & Assumptions

- **RISK-001**: Custom Nio subset; mitigation: multi-value headers + strict validation + golden vectors + single `ReentrantLock` writer + caps, isolate `net/`.
- **RISK-002**: No gigapixel asset; mitigation: auto 2048/4096 + `import_vips.sh` dz/onetile + post-pad.
- **RISK-003**: WS state machine; mitigation: frag/close/size/code/version matrix tests.
- **RISK-004**: 512px ~45-95 KB (64-bit WS form common), 4K HQ ~77; mitigation: 128 cap + GEN_TILE_CAP + sealed chunks + center-first + effective LOD + Z0 fallback + ≤30 epoch batches + retryable overflow + capacity-aware scheduling.
- **RISK-005**: No send/header/deadline handling by design; mitigation: documented scope limitation (local grading harness, `0.0.0.0` noted).
- **ASSUMPTION-001**: `build.sh` is the clean-machine JDK-only build; Maven offline works only after plugins/deps are primed — needs confirmation whether the grader mandates Maven from a fresh cache, and of port 8080.
- **ASSUMPTION-002**: `libvips` absent on grader — needs confirmation; default needs no vips.
- **ASSUMPTION-003**: Node available for JS tests — TEST-ONLY; needs confirmation, else the documented no-Node path applies (app itself never needs Node).

## 8. Related Specifications / Further Reading

- RFC 6455 (fresh mask per frame, frag/control, 2/4/10 headers, codes 1002/1003/1009, version advertise); RFC 9110/9112 (GET/405, Host multiplicity, absolute-form, body rules); libvips dzsave (`dz` vs google, `onetile` vs `one`, n=0 smallest, `--skip-blanks -1`); `FileChannel.transferTo` short-transfer + loop; `SocketChannel` one-reader/one-writer + partial writes; Java 21 virtual-thread pinning (`ReentrantLock` over monitors for I/O).
