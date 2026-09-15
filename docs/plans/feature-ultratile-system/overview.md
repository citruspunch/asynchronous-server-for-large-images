---
goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
status: 'Planned'
tags: [feature, ultratile, java21, tiling, websocket, offline]
plan_type: split
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Build UltraTile end-to-end from empty repo (`README.md:1`, `project_instructions.md:1-94`). JDK-only Java 21 `ServerSocketChannel` server (reader VT + dispatcher VT per WS session, one serialized `WsWriter` on `ReentrantLock`, `transferTile` declaring `24+fileSize` with `writeFully` + `transferTo` loop, mid-frame failure fatal) serves frontend over an honest HTTP/1.1 subset and padded 512x512 JPEG tiles over sealed-generation UTP/1.0 on RFC 6455. Per-generation lifecycle: `VIEWPORT_UPDATE*` chunks (same REQ_ID, capped) → `0x05 VIEWPORT_COMMIT` (seal; empty seal legal) → dispatch on sealed → `TILE*` → `0x04 GENERATION_END` iff sealed && !canceled && queueEmpty && inFlight==0 (ABORT/supersede is terminal, no END). Bookkeeping lives in per-generation `GenerationState` with explicit `Atomic`/`volatile` visibility. Viewer pins Z0, composites coarse→fine clipped to `[0,W)×[0,H)`, fits work to M=40 via effective LOD + ≤30-tile sequential batches, generation-scoped queues. Demos 2048 (21) + 4096 (85) via atomic `.ready` publish; live rescan, no restart. Offline grading.

## 1. Requirements & Constraints

- **REQ-001**: Java 20/21 async server serves ultra-high-resolution images with progressive/selective loading via 512x512 tiling (ceiling pyramid, post-padded edges, full-bitmap layer compositing clipped to image rect); never serves full ultra-res image.
- **REQ-002**: Per WS session one reader VT + one dispatcher VT; one serialized `WsWriter` (`ReentrantLock`, never a monitor across I/O — Java 21 pins carriers on blocking monitors); at most one thread writes at a time, so the reader VT may invoke `writeControl` (Ping→Pong, Close echo) under the same lock; `SocketChannel` one-reader/one-writer concurrency is the frozen model (blocking I/O isolated on virtual threads — NOT selector-style async; report states this plainly). Visibility frozen: `AtomicReference<GenerationState> active`, `volatile sealed/canceled`, `AtomicBoolean closed`, atomically registered current tile channel, idempotent cleanup; dispatcher owns `sent/skipped/inFlight`; requested set reader-owned pre-seal. Received Close stops app work, coordinates writer, emits reply, tears down once; I/O/EOF aborts immediately. No send/header deadlines (deliberate scope limitation, documented).
- **REQ-003**: Honest HTTP/1.1 subset (origin-form + absolute-form normalization, exactly-one valid Host, `writeFully`/`readFully`, leftover bytes kept only after bodyless valid upgrade) serves static + metadata; UTP/1.0 over RFC 6455 documented.
- **REQ-004**: Frontend locally served, zero external requests, offline grading; `resizeCanvas()` DPR=1 first; drag `cam-=Δscreen/s`, wheel `s` pointer-anchored (world-under-cursor fixed, `MIN_SCALE=1e-3`/`MAX_SCALE=32`, `isFinite` guard, pointer capture + `pointercancel`); immediate cached render + debounced network gen; LOD/resize → new generations.
- **REQ-005**: LOD frozen: `zFloat=N+log2(s)`, clamp `[0,N]`; Quality=`ceil`, Performance=`floor`, Auto frac≥0.5 (↔τ≈0.7071); `effectiveLOD` recomputes the half-open frustum at EVERY candidate Z walking down, counts actual union `{visible target}∪{Z0}`, downgrades until protected ≤36 (40 minus 4 headroom); HUD desired-vs-effective; compositing draws each cached tile once at its own `512*2^(N-z)` footprint, ctx clipped to `[0,W)×[0,H)`.
- **REQ-006**: LRU-40 logical budget; Z0 pinned per image; intermediates opportunistic; decode ≤6 in-flight + queue `DECODE_QUEUE_MAX_JOBS=24` AND `DECODE_QUEUE_MAX_BYTES=4MiB` (both enforced; HUD/tests name jobs vs bytes distinctly), stale-gen purge; per-generation requested target tiles ≤30 (6+24) — larger desired sets go as sequential sealed generations (each to END; all co-reside ≤40); pending `key→reqId` gen-scoped; `networkComplete` vs `coverageComplete` (decode rejection = failed, fallback kept).
- **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0/1/2`, FORMAT `0x01`→`image/jpeg`/`0x02`→`image/webp`; REQ_ID u32 logical generation, no wrap (reconnect before max; never reset on image switch, 1 only on new WS): `0x01 VIEWPORT_UPDATE` 28B `>BBHBBHIIIII` (chunks share REQ_ID; first freezes `(imageId,zoom,lodMode,tileSize)`, mismatch→invalid, post-seal→rejected); `0x05 VIEWPORT_COMMIT` 8B `>BBHI` (seal; COMMIT-only empty generation legal: validate image/REQ_ID, supersede older, sealed-empty state, immediate END 0/0 — covers cache-subtracted-to-zero updates); `0x03 ABORT_STREAM` 8B `>BBHI` (marks canceled, terminal, no END); `0x02 TILE_PAYLOAD` 24B `>BBHBBHIIII`+payload (header from file size); `0x04 GENERATION_END` 16B `>BBHIII` (REQ_ID,SENT,SKIPPED) ONLY for sealed, non-canceled, normally completing generations. Per-packet span≤128; per-generation unique set capped `GEN_TILE_CAP=256` (pre-insert reject, so accepted sets always fit the queue — no normal-path eviction); every accepted tile ends sent or pre-frame-skipped. New generation fully validated BEFORE superseding; newer→supersede, ==current→append+dedupe, older→ignore.
- **REQ-008**: Pyramids via `scripts/import_vips.sh`: `vips dzsave <src> <tmp> --layout dz --depth onetile --tile-size 512 --overlap 0 --skip-blanks -1 --Q 85`, level `n`→`level-n` directly, post-pad edges to 512, build in `.tmp-<id>/`, validate PAT-001 + all coords + 512 dims + `MAX_TILE_BYTES`, write `.ready`, atomic rename (immutable after); stale recovery frozen: any `<id>/` without `.ready` is renamed to `.stale-<id>-<epoch>/` (logged) before a new tmp build; registry ignores `.tmp-*`/`.stale-*`. Or streaming synthetic fallback (bounded O(tile-size), crop-mosaic-then-downsample-then-pad-output). Startup auto-generates demos if no `.ready`; registry trusts `.ready` only.
- **REQ-009**: Dispatch waits for COMMIT (global center-first over full unique set) into per-`GenerationState` (REQ_ID, image/Z/LOD, requested set, sent/skipped, sealed, canceled, in-flight; `TileReq` refs state; no shared resets): checks current+!canceled before open, after open, under writer lock; `transferTile` = WS header len `24+fileSize` (2/4/10B) + 24B UTP via `writeFully` + `transferTo` loop; pre-frame size gate `MAX_TILE_BYTES=2MiB` (`TileHeader` validates u32 + ≤max); SKIPPED pre-frame only; post-start failure kills session; `0x04` closes normal generations; browser owns corrupt verdict.
- **SEC-001**: Validate id, Z, coords, `TILE_SIZE==512`, LOD 0..2, span≤128/packet, `GEN_TILE_CAP=256`/generation; client subtracts cached∪pending∪decode-queued, same-Z row-runs, one REQ_ID, COMMIT; server dedupes same-gen keys; bounded priority queue is a defensive backstop only (accepted sets fit by construction).
- **SEC-002**: `0.0.0.0:8080`; Origin `http://` only, normalized authority (host ci + effective port) vs `Host`, absent allowed; `/ws` bodyless-only; queue 256; WS cap 1 KiB (oversize→1009 incl. cumulative frag, bad framing→1002 incl. 64-bit high-bit, valid-text→1003); unsupported WS version → 400 + `Sec-WebSocket-Version: 13` advertise (tested); frag/close/UTF-8 matrix tested.
- **CON-001**: Java 21, Maven (exact pins) + `build.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`, cleans classes, JDK-only).
- **CON-002**: `Config` single source: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `GEN_TILE_CAP=256`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`; demos id0 2048 (21) + id1 4096 (85); registry scans all numeric dirs per call (live rescan, no restart).
- **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
- **GUD-001**: `Cache-Control` split; FINE logs (harness may redirect); HUD/E2E bytes/active-Z/reqs/evicts/decodes prove transfer+eviction.
- **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches; n=0 smallest direct map.
- **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y); cam = viewport-center world point.
- **PAT-003**: Half-open + empty-range: intersect native `[cam-Vw/2s,cam+Vw/2s)` with `[0,W)`, empty→no request; scale `2^(Z-N)`; `minTile=floor(min/512)`, `maxTile=min(C-1,ceil(max/512)-1)`.
- **PAT-004**: Post-pad + full-bitmap composite + clip: draw the FULL padded 512 bitmap at its `512*2^(N-z)` world footprint (never crop-stretch edge source over a full-size destination); ctx clipped to `[0,W)×[0,H)` absorbs ceil overhang (513→257×2=514) and padding.

## 2. Phase Index

| Phase | File | Goal | Status |
| ----- | ---- | ---- | ------ |
| 01 | ./phase-01-project-scaffolding.md | GOAL-001: Exact-pin Maven + clean build.sh + compilable stub | Planned |
| 02 | ./phase-02-tile-engine.md | GOAL-002: Ceiling store + import + registry with `.ready` demos | Planned |
| 03 | ./phase-03-utp-codec.md | GOAL-003: Sealed-generation codec 28B/8B/8B/24B/16B round-trips | Planned |
| 04 | ./phase-04-http-bootstrap.md | GOAL-004: Strict HTTP-subset + live metadata + readiness | Planned |
| 05 | ./phase-05-concurrency-sessions.md | GOAL-005: GenerationState sessions + transferTile + visibility | Planned |
| 06 | ./phase-06-viewer-frontend.md | GOAL-006: Z0-pinned viewer + effective LOD + gen-scoped queues | Planned |
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
- **DEP-004**: Phase 05 requires 03 (`TileHeader`, `0x04`/`0x05`) + 02 (channel API, padded store).
- **DEP-005**: Phase 06 requires 04 (picker/info routes) + 03 (sealed layouts).
- **DEP-006**: Phase 07 requires all prior.

## 5. Files

- **FILE-001**: `NEW pom.xml` — exact plugin versions + manifest.
- **FILE-002**: `NEW build.sh` — bash, `set -euo pipefail`, cleans classes.
- **FILE-003**: `NEW src/main/java/com/ultratile/net/NioHttpServer.java` — strict subset + absolute-form + leftover policy.
- **FILE-004**: `NEW src/main/java/com/ultratile/proto/UtpCodec.java` — `TileHeader` + `ViewportCommit` + `0x04`.
- **FILE-005**: `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java` — ceiling + channel API + size gate.
- **FILE-006**: `NEW scripts/import_vips.sh` — dz/onetile + post-pad + atomic publish.
- **FILE-007**: `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `WsWriter.java` (`ReentrantLock`) + `SessionCoordinator.java` (`GenerationState`).
- **FILE-008**: `NEW src/main/resources/web/viewer.js` — Z0 pin + effective LOD + compositing.
- **FILE-009**: `NEW docs/protocol/UTP-1.0.md` — sealed-lifecycle doc.
- Verified ground truth: v1.4 plans (`overview.md:1-101`, `phase-01:1-47`, `phase-02:1-50`, `phase-03:1-42`, `phase-04:1-47`, `phase-05:1-47`, `phase-06:1-47`, `phase-07:1-46`); impl files `NEW`.

## 6. Testing

- **TEST-001**: `mvn -o -q test` + `./build.sh` green (codec incl. `0x05`/LEN 20-23/LOD, ceiling, GenerationState seal/empty-END/mismatch/cap/supersede/cancel, `ReentrantLock` serialization, `writeFully`, transferTo `2,0,2` + partial + fatal-after-start, WS matrix incl. version-advertise, half-open/empty, no-wrap).
- **TEST-002**: `curl` static/info; `/api/images` serializes live registry (0+1 + imports); readiness loop on `/healthz`=registry-ready (no fixed sleeps anywhere); absolute-form probe.
- **TEST-003**: E2E public contract only — masked sends (`0x82`, `0x80|len`, mask+XOR), same-REQ_ID chunks + COMMIT, one gen1 tile THEN switch (never wait gen1 END), buffered gen1 tolerated/discarded, gen2 TILE + `0x04` required, Ping→Pong healthy, 2/4/10 + 64-bit parse; queue-cancel + serial missing-file + validation-reject in unit tests.
- **TEST-004**: Offline; LRU≤40, inflight≤6, decodeQ jobs≤24 + bytes≤4MiB; deterministic 4096 pan path (>40 unique @ fixed effective Z) asserts `evicts>0` + desired-vs-effective shown; 2048 smoke-only.

## 7. Risks & Assumptions

- **RISK-001**: Custom Nio subset; mitigation: strict validation + golden vectors + single `ReentrantLock` writer + caps, isolate `net/`.
- **RISK-002**: No gigapixel asset; mitigation: auto 2048/4096 + `import_vips.sh` dz/onetile + post-pad.
- **RISK-003**: WS state machine; mitigation: frag/close/size/code/version matrix tests.
- **RISK-004**: 512px ~45-95 KB (64-bit WS form common), 4K HQ ~77; mitigation: 128 cap + sealed chunks + GEN_TILE_CAP + center-first + effective LOD + Z0 fallback + ≤30 sequential batches.
- **RISK-005**: No send/header/deadline handling by design; mitigation: documented scope limitation (local grading harness, `0.0.0.0` noted).
- **ASSUMPTION-001**: `build.sh` is the clean-machine JDK-only build; Maven offline works only after plugins/deps are primed — needs confirmation whether the grader mandates Maven from a fresh cache, and of port 8080.
- **ASSUMPTION-002**: `libvips` absent on grader — needs confirmation; default needs no vips.

## 8. Related Specifications / Further Reading

- RFC 6455 (masking `0x80|len`, frag/control, 2/4/10 headers, codes 1002/1003/1009, version advertise); RFC 9110/9112 (Host, absolute-form, body rules); libvips dzsave (`dz` vs google, `onetile` vs `one`, n=0 smallest, `--skip-blanks -1`); `FileChannel.transferTo` short-transfer + loop; `SocketChannel` one-reader/one-writer; Java 21 virtual-thread pinning (`ReentrantLock` over monitors for I/O).
