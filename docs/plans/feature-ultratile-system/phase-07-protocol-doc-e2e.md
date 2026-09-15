---
phase: phase-07-protocol-doc-e2e
goal: GOAL-007 Protocol doc plus deterministic abort/eviction E2E
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 07 — Protocol Doc E2E ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: Initial HTTP/1.1 serves static bundle + metadata; image control uses custom UTP/1.0 binary protocol over WebSocket (RFC 6455), fully documented with RFC references.
  - **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, FORMAT JPEG/WebP; logical-viewport REQ_ID no-wrap: `0x01` 28B `>BBHBBHIIIII`, `0x03` 8B `>BBHI`, `0x02` 24B `>BBHBBHIIII`+payload, `0x04` 16B `>BBHIII`; newer→supersede, ==→append+dedupe, older→ignore.
  - **REQ-001**: Java 20/21 async server serves ultra-high-res images with progressive/selective loading via 512x512 tiling (ceiling pyramid, padded edge tiles, layer compositing); never serves full ultra-res image.
- Prior-phase deps:
  - **DEP-006**: Requires all prior (Nio serialized WS, `TileHeader`/`0x04`, dual demos, compositing viewer).
- Inputs: generational system + 2048/4096 demos. Outputs: corrected doc + deterministic E2E (abort-use, not abort-arrival) + eviction proof on 4096.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW docs/protocol/UTP-1.0.md` (≤240 lines): 1 Nio overview (no HttpServer), 2 ceiling pyramid + dual-demo tables (2048: 1+4+16=21; 4096: 1+4+16+64=85) + google/onetile padded import + half-open frustum + empty-range rule, 3 LOD + layer compositing (no ancestor-stretch) + centered camera, 4 packets with offsets (28B viewport `>BBHBBHIIIII`, 8B abort `>BBHI`, 24B tile (20-23 LEN) + `0x04` 16B SENT/SKIPPED) + same-REQ_ID chunk + dedupe + no-wrap + FORMAT map, 5 lifecycle (newer clear/==append/older ignore, canceled-set, 3-point checks, serialized writer, transferTo-loop sendfile-style, `0x04` completion, missing→SKIPPED/corrupt→browser), 6 pipelines (LRU-40 scoped ≤2048 + paging/downgrade, decode 6/queue 24 + purge, queue 256, center-first), 7 limits (span 128 + split, 1 KiB WS cap, codes 1002/1003/1009 + 2/4/10B server headers, `http://<Host>` origin, no full-image), 8 refs (6455, 9110, dzsave google, transferTo, 101 thread). Verbatim `vips dzsave <src> <tmp> --layout google --depth onetile --tile-size 512 --overlap 0 --background 0 --skip-blanks -1 --Q 85` + `6455` + `9110`. | — | `wc -l` ≤250 + contains dzsave-google + `GENERATION_END` |  |  |
| TASK-002 | Create `NEW scripts/e2e_utp.py` (stdlib only): handshake no-Origin to `/ws`; send VIEWPORT gen=1 on id1 4096 Z=3 range 4x4=16 with CORRECT `struct.pack(">BBHBBHIIIII",0xAA,1,1,3,0,512,1,0,3,0,3)` (assert len==28); read 1 TILE gen=1 (assert 24B `TILE_SIZE==512`, `REQ_ID==1`, `FFD8`); send VIEWPORT gen=2 shifted same-Z (same-REQ_ID chunk test: send 2 packets gen=2 covering overlapping ranges) + `ABORT gen=1` via `struct.pack(">BBHI",0xAA,3,1,1)` (len==8); collect 5s: assert ≥1 gen=2 TILE arrives AND `0x04 gen=2` eventually arrives AND client-rule simulation accepts 0 gen=1 post-switch (discard, do NOT assert zero gen=1 bytes on TCP — buffered stale allowed) AND server log/counter shows queued gen=1 stopped; missing-tile subtest (out-of-range viewport → `0x04` SKIPPED>0, session alive). Print `E2E-OK use-ok completion-ok`. | TASK-001 | `python3 scripts/e2e_utp.py` prints `E2E-OK` |  |  |
| TASK-003 | Offline + concurrency + eviction proof: `mvn -o -q package` + `./build.sh`, start JAR, `curl /api/images` lists 0:2048 + 1:4096 full levels, `rg https?:// web/` empty, 10x parallel E2E OK, `rg "HttpExchange|com.sun.net.httpserver|byte\[\] data.*TilePayload|transferTo\(0,size,sock\)[^;]*;(?![^;]*while)" src/` empty (no hijack, no byte[] hot path, no single-shot transferTo); 4096 LOD sweep HUD `bytes↑ evicts↑ cache≤40 decodes≤6 q≤24`; 2048 asserted smoke-only. Write `NEW docs/protocol/E2E-REPORT.md` (Commands/Observed/Checklist <80 lines). | TASK-002 | 10x green + report with eviction numbers |  |  |
| TASK-004 | Rehearsal: `mvn -o -q test` + `./build.sh` green; `/`, `/viewer.js`, `/api/images`, `/ws` 101; offline reload; doc has 6455/9110/google cmd + 28B python assert; report PASS with `LOD→bytes↑→evicts↑` on 4096. | TASK-003 | All PASS |  |  |

## Validation Commands

```sh
mvn -o -q test
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,1,3,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,3,1,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,1,3,1,512,2,3,2,4))==24; print('struct-ok')"
python3 scripts/e2e_utp.py
for i in 1 2 3 4 5 6 7 8 9 10; do python3 scripts/e2e_utp.py & done; wait
```

## Notes for Implementer

- Fixes v1.2 `">BBHBBHIIIIII"` (32B/12-val) bug; 28B viewport is `>BBHBBHIIIII`.
- Abort determinism: REQ_ID guarantees non-use + queued-cancel, not TCP recall; test asserts use/completion/counters, never zero-stale-bytes.
- Eviction requires 4096 (85 tiles); 2048 total 21 can never evict M=40 — assert this explicitly in report.
- `0x04` makes missing/completion testable: `SENT+SKIPPED` reconciles requested minus deduped/canceled.
