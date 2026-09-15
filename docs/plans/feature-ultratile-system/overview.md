---
goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
version: 1.6
date_created: 2026-09-15
last_updated: 2026-09-15
status: 'Planned'
tags: [feature, ultratile, java21, tiling, websocket, offline]
plan_type: split
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Build UltraTile end-to-end from empty repo (`README.md:1`, `project_instructions.md:1-94`). JDK-only Java 21 `ServerSocketChannel` server (reader VT + dispatcher VT per WS session, `WsWriter` on `ReentrantLock` with `writeFully`, `transferTile` declaring `24+fileSize`, mid-frame failure fatal) serves frontend over an honest HTTP/1.1 subset (GET-only) and padded 512x512 JPEG tiles over sealed-generation UTP/1.0 on RFC 6455. Per-generation lifecycle: chunks (same REQ_ID, capped) → `0x05 COMMIT` (publish-then-seal; empty seal → END 0/0) → dispatch → `TILE*` → `0x04` iff sealed && !canceled && active && empty && inFlight==0. State in `GenerationState` with `Atomic`/`volatile` visibility plus monotonic `lastReqIdSeen`; supersession cancels the old state first. Client separates intent from transport: one `viewEpoch` per pan/zoom/LOD/image intent spans sequential ≤30-tile REQ_ID batches; decodes accepted iff `job.viewEpoch === currentViewEpoch`; epoch change cancels batch awaiters immediately (no END waited). Byte-overflow is retryable (`retryNeeded` → later sealed gen, same epoch); JPEG rejection is terminal-for-view. Demos via atomic `.ready` publish (idempotent no-op on ready targets); live rescan, no restart. Offline grading.

## 1. Requirements & Constraints

- **REQ-001**: Java 20/21 async server serves ultra-high-resolution images with progressive/selective loading via 512x512 tiling (ceiling pyramid, post-padded edges, full-bitmap compositing with screen-space clear + image-rect clip); never serves full ultra-res image.
- **REQ-002**: Per WS session one reader VT + one dispatcher VT; one serialized `WsWriter` (`ReentrantLock`; at most one writer at a time — reader VT may call `writeControl` under the same lock); `SocketChannel` one-reader/one-writer blocking-on-VT model (NOT selector async; report states plainly). Visibility: `AtomicReference<GenerationState> active`, `AtomicLong lastReqIdSeen`, `volatile sealed/canceled`, `AtomicBoolean closed`, atomic tile-channel ref, idempotent cleanup; dispatcher owns `sent/skipped/inFlight`; requested set reader-owned pre-seal. Close coordination as v1.5; I/O/EOF aborts immediately. No deadlines by design.
- **REQ-003**: Honest HTTP/1.1 subset: GET-only (`405` + `Allow: GET` otherwise), origin-form + absolute-form normalization, exactly-one valid Host, `writeFully`/`readFully`, leftover bytes only after bodyless valid upgrade; UTP/1.0 over RFC 6455 documented.
- **REQ-004**: Frontend locally served, offline; `resizeCanvas()` DPR=1 first; drag/wheel pointer-anchored within [`SCALE_MIN`,`SCALE_MAX`] + `isFinite` + capture/`pointercancel`; immediate cached render + debounced network intent; LOD/resize → new intent (new `viewEpoch`, never REQ_ID reset except new WS).
- **REQ-005**: LOD frozen (`zFloat=N+log2(s)`, clamp, ceil/floor/frac≥0.5); `effectiveLOD` recomputes frustum per candidate Z, union `{target}∪{Z0}` ≤36; HUD desired-vs-effective; full-bitmap layers at own footprints after screen-space clear + `[0,W)` clip.
- **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 in-flight + queue `DQ_JOBS=24` AND `DQ_BYTES=4MiB` (distinct names); per-intent `viewEpoch` (u32 monotonic, client-only): sequential ≤30-tile batch REQ_IDs share one epoch; decode accepted iff `job.viewEpoch === currentViewEpoch` (batch-G resolves after G+1 starts — accepted, not purged); new intent bumps epoch and resolves pending batch awaiters as `canceled` at once (AbortController-like token; never waits a no-END ABORT); WS close/error cancels all. Byte-queue overflow → `retryNeeded` coordinates (later sealed gen, same epoch), never terminal; JPEG decode rejection terminal-for-that-view (fallback kept). `networkComplete` vs `coverageComplete` split stands.
- **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0/1/2`, FORMAT jpeg/webp; REQ_ID u32, no wrap (reconnect before max; never reset on image switch, 1 only on new WS): `0x01` 28B `>BBHBBHIIIII` (first chunk freezes metadata, mismatch→invalid, post-seal→rejected); `0x05` 8B `>BBHI` (seal; empty COMMIT legal → END 0/0); `0x03` 8B `>BBHI` (cancel, terminal, no END); `0x02` 24B `>BBHBBHIIII` (size-built, LEN u32 + ≤`MAX_TILE_BYTES`); `0x04` 16B `>BBHIII` (sealed, non-canceled, active, empty, inFlight==0 only). Span≤128/packet; unique set ≤`GEN_TILE_CAP=256` pre-insert reject; validate-before-supersede; newer→mark-old-canceled-then-supersede, ==→append+dedupe, older→ignore.
- **REQ-008**: `scripts/import_vips.sh` dz/onetile + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); CLI IDs validated decimal `0..65535` BEFORE any path use, every path/shell arg quoted (`IngestTool` + script); ready target → successful no-op (repeatable validation); non-ready numeric dir → `.stale-<id>-<epoch>/` quarantine (logged); registry ignores `.tmp-*`/`.stale-*`. Streaming synthetic fallback (bounded O(tile-size), crop-then-downsample-then-pad-output). Startup auto-generates demos if no `.ready`; trust `.ready` only.
- **REQ-009**: Dispatch on sealed; per-`GenerationState` (REQ_ID, image/Z/LOD, requested set, sent/skipped, sealed, canceled, in-flight; `TileReq` refs state); COMMIT path builds/sorts/enqueues the COMPLETE immutable work set FIRST, then publishes `sealed=true` as final release + signals dispatcher (dispatcher can never see sealed-but-empty-transient; empty COMMIT publishes sealed-empty + END 0/0); 3-point current+!canceled checks; `transferTile` WS `24+fileSize` + `writeFully` + `transferTo` loop; `MAX_TILE_BYTES=2MiB` pre-frame gate; SKIPPED pre-frame only; post-start fatal; `0x04` additionally requires `active.get()==state` (defensive: superseded states never END even if counters align).
- **SEC-001**: Validate id/Z/coords/`TILE_SIZE==512`/LOD/span/`GEN_TILE_CAP`; client subtracts cached∪pending∪decode-queued, same-Z row-runs, one REQ_ID per ≤30 batch, COMMIT; server dedupes; priority queue defensive backstop only.
- **SEC-002**: `0.0.0.0:8080`; normalized `http://` Origin vs `Host` (absent allowed); `/ws` bodyless-only; queue 256; 1 KiB cap (1009/1002/1003); version-mismatch 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
- **CON-001**: Java 21, Maven (exact pins) + `build.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`, cleans classes, `cp -a resources/.` so empty trees work, JDK-only).
- **CON-002**: `Config` single source: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `GEN_TILE_CAP=256`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `BATCH_CAP=30`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`; demos id0 2048 (21) + id1 4096 (85); live rescan per call (`list()` AND `get()` from fresh snapshot), no restart.
- **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
- **GUD-001**: `Cache-Control` split; FINE logs (redirectable); HUD/E2E bytes/active-Z/reqs/evicts/decodes prove transfer+eviction.
- **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches; n=0 smallest direct map.
- **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y); cam = viewport-center world point.
- **PAT-003**: Half-open + empty-range: intersect native `[cam-Vw/2s,cam+Vw/2s)` with `[0,W)`, empty→no request; scale `2^(Z-N)`; `minTile=floor(min/512)`, `maxTile=min(C-1,ceil(max/512)-1)`.
- **PAT-004**: Screen-space clear FIRST (`resetTransform` + full-canvas `clearRect`/fill), then world transform, clip `[0,W)×[0,H)`, full padded 512 bitmaps at `512*2^(N-z)` footprints (never crop-stretch); fine overlays coarse.

## 2. Phase Index

| Phase | File | Goal | Status |
| ----- | ---- | ---- | ------ |
| 01 | ./phase-01-project-scaffolding.md | GOAL-001: Exact-pin Maven + robust build.sh + compilable stub | Planned |
| 02 | ./phase-02-tile-engine.md | GOAL-002: Ceiling store + validated import + registry with `.ready` demos | Planned |
| 03 | ./phase-03-utp-codec.md | GOAL-003: Sealed-generation codec 28B/8B/8B/24B/16B round-trips | Planned |
| 04 | ./phase-04-http-bootstrap.md | GOAL-004: Strict GET-only HTTP-subset + live metadata + readiness | Planned |
| 05 | ./phase-05-concurrency-sessions.md | GOAL-005: Ordered-COMMIT sessions + transferTile + visibility | Planned |
| 06 | ./phase-06-viewer-frontend.md | GOAL-006: viewEpoch viewer + batches + unit-tested helpers | Planned |
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
- **FILE-003**: `NEW src/main/java/com/ultratile/net/NioHttpServer.java` — strict GET-only subset + absolute-form + leftover policy.
- **FILE-004**: `NEW src/main/java/com/ultratile/proto/UtpCodec.java` — `TileHeader` (gated LEN) + `ViewportCommit` + `0x04`.
- **FILE-005**: `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java` — ceiling + channel API + size gate.
- **FILE-006**: `NEW scripts/import_vips.sh` — validated IDs, dz/onetile + post-pad + atomic publish + idempotent no-op.
- **FILE-007**: `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `WsWriter.java` (`ReentrantLock` + `writeFully`) + `SessionCoordinator.java` (`GenerationState`, `lastReqIdSeen`).
- **FILE-008**: `NEW src/main/resources/web/viewer.js` — viewEpoch + batches + effective LOD + compositing (exposes `globalThis.UltraTile` pure API).
- **FILE-009**: `NEW docs/protocol/UTP-1.0.md` — sealed-lifecycle doc.
- **FILE-010**: `NEW scripts/test_viewer.cjs` — `node:vm` unit tests for viewer helpers (no DOM needed).
- Verified ground truth: v1.5 plans (`overview.md:1-102`, `phase-01:1-46`, `phase-02:1-48`, `phase-03:1-41`, `phase-04:1-50`, `phase-05:1-48`, `phase-06:1-47`, `phase-07:1-48`); impl files `NEW`.

## 6. Testing

- **TEST-001**: `mvn -o -q test` + `./build.sh` + `node scripts/test_viewer.cjs` green (codec incl. `0x05`/LEN-gate/LOD, ceiling, GenerationState seal-order/empty-END/mismatch/cap/supersede-cancel/no-END/active-guard/lastSeen, writer serialization + `writeFully`, transferTo `2,0,2` + partial + fatal-after-start, WS matrix incl. version-advertise, half-open/empty, no-wrap, viewer LOD/ranges/batches/epoch/retry).
- **TEST-002**: `curl` static/info (+405 non-GET); live registry; readiness loop =registry-ready; absolute-form probe; split-line server lifecycle (`pid=$!` + trap, no AND-list backgrounding, no fixed sleeps).
- **TEST-003**: E2E contract only — fresh `os.urandom(4)` mask per frame (`0x82`, `0x80|len`, XOR; no 126/127-send), chunks + COMMIT, one gen1 tile THEN switch (never wait gen1 END), buffered gen1 tolerated, gen2 TILE + `0x04`, Ping→Pong, 2/4/10 + 64-bit parse; cancel/missing/validation in unit tests.
- **TEST-004**: Offline; LRU≤40, inflight≤6, decodeQ jobs≤24 + bytes≤4MiB; deterministic 4096 fixed-path pan (>40 unique @ fixed effective Z) asserts `evicts>0` + desired-vs-effective; 2048 smoke-only.

## 7. Risks & Assumptions

- **RISK-001**: Custom Nio subset; mitigation: strict validation + golden vectors + single `ReentrantLock` writer + caps, isolate `net/`.
- **RISK-002**: No gigapixel asset; mitigation: auto 2048/4096 + `import_vips.sh` dz/onetile + post-pad.
- **RISK-003**: WS state machine; mitigation: frag/close/size/code/version matrix tests.
- **RISK-004**: 512px ~45-95 KB (64-bit WS form common), 4K HQ ~77; mitigation: 128 cap + GEN_TILE_CAP + sealed chunks + center-first + effective LOD + Z0 fallback + ≤30 epoch batches + retryable overflow.
- **RISK-005**: No send/header/deadline handling by design; mitigation: documented scope limitation (local grading harness, `0.0.0.0` noted).
- **ASSUMPTION-001**: `build.sh` is the clean-machine JDK-only build; Maven offline works only after plugins/deps are primed — needs confirmation whether the grader mandates Maven from a fresh cache, and of port 8080.
- **ASSUMPTION-002**: `libvips` absent on grader — needs confirmation; default needs no vips.

## 8. Related Specifications / Further Reading

- RFC 6455 (fresh mask per frame, frag/control, 2/4/10 headers, codes 1002/1003/1009, version advertise); RFC 9110/9112 (GET/405, Host, absolute-form, body rules); libvips dzsave (`dz` vs google, `onetile` vs `one`, n=0 smallest, `--skip-blanks -1`); `FileChannel.transferTo` short-transfer + loop; `SocketChannel` one-reader/one-writer + partial writes; Java 21 virtual-thread pinning (`ReentrantLock` over monitors for I/O).
