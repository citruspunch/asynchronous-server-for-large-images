---
phase: phase-03-utp-codec
goal: GOAL-003 Sealed-generation codec 28B/8B/8B/24B/16B round-trips
status: 'Planned'
parent: ./overview.md
version: 1.8
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 03 — UTP Codec ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0/1/2`, FORMAT jpeg/webp; REQ_ID u32 no-wrap (reconnect before max; never reset on image switch, 1 only on new WS; `lastReqIdSeen` advances ONLY on accepted new generation — first valid chunk OR valid empty COMMIT even with an older active present; same-gen chunks, matching COMMITs, ABORTs, rejects never advance; below it is stale unless the active continuation): `0x01` 28B `>BBHBBHIIIII` (freeze/mismatch-invalid/post-seal-rejected); `0x05` 8B `>BBHI` (seal; three-way COMMIT incl. newer-empty → sealed-empty + END 0/0 regardless of older active); `0x03` 8B `>BBHI` (`(imageId,reqId)` must match the canceled generation — wrong-image ignored, never advances seen; terminal, no END); `0x02` 24B `>BBHBBHIIII` (LEN u32 + ≤`MAX_TILE_BYTES`); `0x04` 16B `>BBHIII` (sealed/non-canceled/active/empty/inflight0 only). Span≤128/packet; unique set ≤`GEN_TILE_CAP=256`. Validate-before-supersede (newer→mark-old-canceled-then-supersede).
  - **REQ-003**: HTTP-subset serves bundle; UTP/1.0 over RFC 6455 documented.
- Prior-phase deps: none beyond phase-01 layout (pure codec, no I/O).
- Inputs: sealed-generation spec. Outputs: gated `TileHeader` + `ViewportCommit` codecs with u32 discipline + golden tests.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/proto/UtpMessages.java`: `ViewportUpdate(imageId,zoom,lodMode,tileSize,reqId,minX,maxX,minY,maxY)`, `ViewportCommit(imageId,reqId)`, `AbortStream(imageId,abortReqId)`, `TileHeader(imageId,zoom,format,tileSize,reqId,tileX,tileY,payloadLen)` (NO bytes; `payloadLen` 1..`MAX_TILE_BYTES`), `GenerationEnd(imageId,reqId,sent,skipped)`; consts + `T_COMMIT=0x05`; validate id/zoom/tileSize==512/LOD∈{0,1,2}/format∈{1,2}/coords/span≤128/LEN gate. u32 wire values carried as Java `long` (0..4294967295); `reqId` 1..0xFFFFFFFE per no-wrap rule. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/proto/UtpCodec.java` BIG_ENDIAN with u32 discipline: parse every u32 field via `buf.getInt()` → `Integer.toUnsignedLong(...)` (NEVER raw signed `int`); explicitly require `minX≤maxX` and `minY≤maxY`; check image-agnostic sanity (coords ≤65535 here; image-specific bounds in phase-05 with registry); compute widths/spans in `long` (`maxX-minX+1L`, product in `long`) before comparing to `SPAN_CAP`/`GEN_TILE_CAP`. Offsets as v1.6 (28B viewport, 8B commit/abort, 24B header with LEN@20-23, 16B end); throw on MAGIC/type/len/TILE_SIZE/LOD/span/LEN-gate/shape. Empty COMMIT legal (phase-05 three-way COMMIT: newer-empty installs sealed-empty + END 0/0 even with an older active present; asserted in SessionTest). | TASK-001 | `mvn -q test -Dtest=UtpCodecTest` passes |  |  |
| TASK-003 | Create `NEW src/test/java/com/ultratile/proto/UtpCodecTest.java` (15 tests): v1.6 set (28B viewport, 8B commit/abort, 24B header golden `0x00120304`→`00 12 03 04`, 16B end, reject MAGIC/TILE_SIZE(256)/LOD(7)/LEN(3MiB)/truncated/span>128, big-endian) PLUS u32-shape vectors: `minX=0xffffffff` decodes to 4294967295 and fails image-bounds/span validation (never wraps to -1); reversed `minX=5,maxX=3` rejected (not an empty range); `minX=0,maxX=0xffffffff` span product computed in `long` (4294967296 > caps, rejected — never int-overflow); `LEN=0xffffffff` rejected by gate. Python vectors: `>BBHBBHIIIII`=28, `>BBHI`=8, `>BBHBBHIIII`=24, `>BBHIII`=16. | TASK-002 | `mvn -q test` green (15/15) |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/proto/UTP_SPEC.md` (20 lines): offset tables 28/8/8/24/16, DataView notes (`getUint32` — JS is unsigned-safe; Java MUST use `toUnsignedLong`), seal incl. three-way COMMIT (match→seal; valid-newer-empty→sealed-empty + END 0/0 REGARDLESS of older active incl. post-ABORT; else stale) + END-only-non-canceled-active rule, freeze/mismatch-invalid, validate-before-supersede + seen-advancement table (first-valid-chunk: advance; valid-newer-empty-COMMIT: advance; same-chunk/matching-COMMIT/ABORT/reject: never), ABORT `(imageId,reqId)` match rule + active CAS-clear, GEN_TILE_CAP pre-insert reject, no-wrap + no-reset-on-switch, FORMAT map. | TASK-002 | `grep -q lastReqIdSeen UTP_SPEC.md` |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=UtpCodecTest
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,0,2,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,5,0,1))==8; assert len(struct.pack('>BBHI',0xAA,3,0,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,0,3,1,512,1,0,0,4))==24; assert len(struct.pack('>BBHIII',0xAA,4,0,1,4,0))==16; print('struct-ok')"
```

## Notes for Implementer

- u32 discipline is a security property (path/coordinate bypass via sign confusion), not style: `0xffffffff` must read as 4294967295 and be REJECTED, never silently become -1 or a small span.
- Seen-advancement table is the frozen anti-poisoning rule; ABORT's exclusion is load-bearing (a future ABORT must not shift history). The v1.8 addition — valid-newer-empty-COMMIT advances — is the cache-subtracted-update path: it is an ACCEPTED new generation, so it advances like any other.
