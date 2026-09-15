---
goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
status: 'Planned'
tags: [feature, ultratile, java21, tiling, websocket, offline]
plan_type: split
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Build UltraTile end-to-end from empty repo (`README.md:1`, `project_instructions.md:1-94`). JDK-only Java 21 `ServerSocketChannel` server (reader VT + dispatcher/writer VT per WS session, single serialized writer, `transferTo` loop) serves frontend over HTTP/1.1 and padded 512x512 JPEG tiles over generational UTP/1.0 on RFC 6455. Viewer uses centered camera, half-open frustum, LOD with coarse→fine layer compositing, logical-viewport REQ_ID with chunk append, bounded LRU-40 + decode-6/queue-24 pipelines, image picker, and HUD transfer/eviction counters. Demos: 2048 smoke (21 tiles) + 4096 eviction (85 tiles), auto-generated at startup if absent. No full image ever sent; offline grading.

## 1. Requirements & Constraints

- **REQ-001**: Java 20/21 async server serves ultra-high-res images with progressive/selective loading via 512x512 tiling (ceiling pyramid, padded edge tiles, layer compositing); never serves full ultra-res image.
- **REQ-002**: Server handles concurrent clients via Java 21 virtual threads; per WS session exactly one reader/connection VT plus one dispatcher/writer VT; reader parses, dispatcher transmits; close lifecycle marks closed, clears queue, cancels dispatcher, closes tile channels, removes state, closes socket once.
- **REQ-003**: Initial HTTP/1.1 serves static bundle + metadata; image control uses custom UTP/1.0 binary protocol over WebSocket (RFC 6455), fully documented with RFC references.
- **REQ-004**: Frontend HTML/JS/CSS, all libs locally served; zero external requests; offline grading; canvas resize sets backing store to CSS pixels at DPR=1 before camera/frustum math.
- **REQ-005**: Centered continuous zoom + three LOD policies (Auto tau=0.7071 default, Quality ceil, Performance floor) with layer compositing: render cached coarse layers at own world positions first, overlay finer layers; never stretch one ancestor into each child rect.
- **REQ-006**: Bounded pipelines: LRU-40 logical decoded-pixel budget (~42 MB logical) with supported viewport ≤2048px wide (aligned 1080p ≈12, misaligned ≤20 + ancestors <40); larger working sets page via sequential generations or memory-aware LOD downgrade (never claim absolute protected-set under unbounded viewport); decode max 6 in-flight + queue cap 24 with immediate stale-gen purge; frustum-aware pruning.
- **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, FORMAT `0x01`=JPEG→`image/jpeg` / `0x02`=WebP→`image/webp`; logical-viewport generation REQ_ID u32, no wrap per WS session (reconnect before overflow): C->S `0x01 VIEWPORT_UPDATE` 28B `>BBHBBHIIIII` (REQ_ID + 4 coords), chunks of one viewport share same REQ_ID; C->S `0x03 ABORT_STREAM` 8B `>BBHI` (ABORT_REQ_ID); S->C `0x02 TILE_PAYLOAD` 24B header `>BBHBBHIIII` + payload (REQ_ID echo); S->C `0x04 GENERATION_END` 16B `>BBHIII` (REQ_ID, SENT, SKIPPED). Server: newer REQ_ID→clear/supersede, ==current→append+dedupe tile keys, older→ignore. TILE header built from file size without loading bytes.
- **REQ-008**: 512x512 JPEG Q85 pyramid with padded edges via `scripts/import_vips.sh` running `vips dzsave <src> <tmp> --layout google --depth onetile --tile-size 512 --overlap 0 --background 0 --skip-blanks -1 --Q 85` then normalizing to `data/images/{id}/level-{Z}/tile-{X}-{Y}.jpg` + `meta.json` validated to PAT-001; or streaming synthetic fallback (finest from global coords, parents crop-mosaic-then-downsample, pad output); startup auto-generates 2048 + 4096 demos if absent; never advertise missing files.
- **REQ-009**: Raw `ServerSocketChannel` dispatcher, center-first priority, generation + canceled-set checks before/after open and before transmit, `transferTo`-loop sendfile-style path (loop until done, no tile `byte[]` copy; not claimed as guaranteed kernel zero-copy) with single serialized writer holding output lock across WS header + UTP header + file bytes; missing/unreadable files skipped with WARNING + counted SKIPPED and closed by `0x04`; browser decode failure handles corrupt JPEG (server optionally SOI-checks only).
- **SEC-001**: Validate `IMAGE_ID` 0..65535, `Z` 0..N, coords in range, `TILE_SIZE==512`; cap 128 tiles per `0x01` packet; client splits larger rects into same-REQ_ID chunks and subtracts cached/pending first; server dedupes same-gen keys.
- **SEC-002**: Bind `0.0.0.0:8080`; Origin must equal `http://<Host>` exactly (HTTP-only server; `https://` rejected; absent allowed for raw E2E); queue cap 256 drop-oldest; WS client messages cap 1 KiB (oversize→1009, malformed framing→1002, valid-text-but-binary-only→1003, 64-bit high-bit set→1002).
- **CON-001**: Java 21, Maven + `build.sh` fallback (`javac`+`jar`, JDK-only); no server deps; custom `NioHttpServer` on `ServerSocketChannel` + `Thread.ofVirtual()`.
- **CON-002**: Constants single-sourced in `Config`: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ=24`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`; demos id0 `2048x2048` N=2 (21 tiles) + id1 `4096x4096` N=3 (85 tiles).
- **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
- **GUD-001**: `Cache-Control` static vs `no-store` metadata; FINE logs; HUD/E2E show bytes, active Z, reqs, evicts, decodes proving transfer+eviction.
- **PAT-001**: `N=max(0,ceil(log2(max(W,H)/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; ceil-div only.
- **PAT-002**: `screenX=Vw/2+s*(worldX-camX)`, `screenY=Vh/2+s*(worldY-camY)`; cam = viewport-center world point.
- **PAT-003**: Half-open frustum: intersect `[camX-Vw/2s,camX+Vw/2s)` with `[0,W)` at native scale, scale by `2^(Z-N)` to level Z, then `minTile=floor(min/512)`, `maxTile=min(C-1,ceil(max/512)-1)`; empty intersection → empty range (fully out-of-image pan legal, requests nothing).
- **PAT-004**: Pad-to-512 + clip + layer compositing + bounded progressive: `actualW=min(512,W_Z-x*512)`; each cached tile drawn once at `worldX=x*512*2^(N-Z)` size `512*2^(N-Z)` clipped to image rect; fine overlays coarse.

## 2. Phase Index

| Phase | File | Goal | Status |
| ----- | ---- | ---- | ------ |
| 01 | ./phase-01-project-scaffolding.md | GOAL-001: Maven + build.sh skeleton, compilable Nio stub, executable JAR | Planned |
| 02 | ./phase-02-http-bootstrap.md | GOAL-002: Raw HTTP with exact channel semantics + dual-demo metadata | Planned |
| 03 | ./phase-03-utp-codec.md | GOAL-003: Logical-generation codec 28B/8B/24B/16B round-trips | Planned |
| 04 | ./phase-04-tile-engine.md | GOAL-004: Ceiling store + google import + streaming padded ingest | Planned |
| 05 | ./phase-05-concurrency-sessions.md | GOAL-005: Serialized Nio WS with canceled-set + transferTo loop | Planned |
| 06 | ./phase-06-viewer-frontend.md | GOAL-006: Layer-compositing viewer with picker + bounded queues | Planned |
| 07 | ./phase-07-protocol-doc-e2e.md | GOAL-007: Protocol doc + deterministic abort/eviction E2E | Planned |

## 3. Alternatives

- **ALT-001**: `HttpServer` hijack — rejected BLOCKER, no 101/raw-socket API in Java 21.
- **ALT-002**: IIIF-only — rejected, no custom protocol.
- **ALT-003**: CDN framework — rejected, offline violation.
- **ALT-004**: 256px/120-cache — rejected, 4x index + dispatch cost.
- **ALT-005**: Jetty/Netty — rejected, hides handler + offline risk.

## 4. Dependencies

- **DEP-001**: Phase 02 requires phase 01 `pom.xml` + `Config` + compilable `NioHttpServer` + `build.sh`.
- **DEP-002**: Phase 03 requires phase 01 layout only.
- **DEP-003**: Phase 04 requires phase 01 layout; contract `ImageRegistry`.
- **DEP-004**: Phase 05 requires 03+04 (generational codec, ceiling store, `TileHeader`).
- **DEP-005**: Phase 06 requires 02 routes + 03 layouts (28B/24B/16B).
- **DEP-006**: Phase 07 requires all prior.

## 5. Files

- **FILE-001**: `NEW pom.xml` — pinned compiler/surefire + jar manifest.
- **FILE-002**: `NEW build.sh` — JDK-only `javac`+`jar` fallback.
- **FILE-003**: `NEW src/main/java/com/ultratile/net/NioHttpServer.java` — compilable stub with stored port.
- **FILE-004**: `NEW src/main/java/com/ultratile/proto/UtpCodec.java` — `TileHeader` (no bytes) + `0x04`.
- **FILE-005**: `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java` — ceiling + padded + channel API.
- **FILE-006**: `NEW scripts/import_vips.sh` — google/onetile normalize + validate.
- **FILE-007**: `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `SessionCoordinator.java` — serialized writer + canceled-set.
- **FILE-008**: `NEW src/main/resources/web/viewer.js` — layer renderer + picker + bounded queues.
- **FILE-009**: `NEW docs/protocol/UTP-1.0.md` — graded doc.
- Verified ground truth: v1.2 plans (`overview.md:1-99`, `phase-01:1-47`, `phase-02:1-52`, `phase-03:1-44`, `phase-04:1-49`, `phase-05:1-50`, `phase-06:1-49`, `phase-07:1-51`); impl files `NEW`.

## 6. Testing

- **TEST-001**: `mvn -o -q test` and `./build.sh && java -jar` both pass (codec 28/24/16 offsets incl. 20-23 LEN, ceiling, generation/cancel, WS codes 1002/1003/1009, half-open frustum).
- **TEST-002**: `curl` static + `/api/images` lists 2048 + 4096 with full levels; no external refs.
- **TEST-003**: Deterministic E2E: gen1→1 tile→gen2 supersede/abort gen1→assert gen2 arrives, client renders 0 gen1 post-switch, server queued-gen1 counter stops (stale TCP frames may still arrive and are discarded); missing tile yields `0x04` SKIPPED; 10 clients distinct.
- **TEST-004**: Offline; LRU≤40, inflight≤6, decode-queue≤24; 4096 LOD change shows bytes↑/evicts↑; 2048 is smoke-only (21 tiles cannot evict).

## 7. Risks & Assumptions

- **RISK-001**: Custom Nio correctness; mitigation: golden WS vectors + `curl` + single-writer + 1 KiB cap, isolate `net/`.
- **RISK-002**: No gigapixel asset; mitigation: auto-generated 2048/4096 + `import_vips.sh` google/onetile for real sources.
- **RISK-003**: WS framing; mitigation: mask/RSV/frag/Ping-Pong/Close/high-bit/length tests with exact codes.
- **RISK-004**: 512px ~45-95 KB, 4K HQ ~77 tiles; mitigation: cap 128 + same-REQ_ID chunks + center-first + layer fallback; >32-target viewports page or downgrade LOD.
- **ASSUMPTION-001**: Grader `mvn package && java -jar` on 8080 offline — needs confirmation of port/build.
- **ASSUMPTION-002**: `libvips` absent on grader — needs confirmation; default needs no vips (streaming demos).

## 8. Related Specifications / Further Reading

- RFC 6455; RFC 9110; BigTIFF; libvips pyramids (`onetile`, google padding, `--skip-blanks -1`); `FileChannel.transferTo` loop semantics; OpenJDK 101 discussion.
