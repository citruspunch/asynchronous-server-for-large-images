---
phase: phase-03-utp-codec
goal: GOAL-003 Sealed-generation codec 28B/8B/8B/24B/16B round-trips
status: 'Planned'
parent: ./overview.md
version: 1.6
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 03 — UTP Codec ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0/1/2`, FORMAT jpeg/webp; REQ_ID u32 no-wrap (reconnect before max; never reset on image switch, 1 only on new WS): `0x01` 28B `>BBHBBHIIIII` (freeze/mismatch-invalid/post-seal-rejected); `0x05` 8B `>BBHI` (seal; empty COMMIT → END 0/0); `0x03` 8B `>BBHI` (cancel, terminal, no END); `0x02` 24B `>BBHBBHIIII` (LEN u32 + ≤`MAX_TILE_BYTES`); `0x04` 16B `>BBHIII` (sealed/non-canceled/active/empty/inflight0 only). Span≤128/packet; unique set ≤`GEN_TILE_CAP=256`. Validate-before-supersede.
  - **REQ-003**: HTTP-subset serves bundle; UTP/1.0 over RFC 6455 documented.
- Prior-phase deps: none beyond phase-01 layout (pure codec, no I/O).
- Inputs: sealed-generation spec. Outputs: gated `TileHeader` + `ViewportCommit` codecs + golden tests.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/proto/UtpMessages.java`: `ViewportUpdate(imageId,zoom,lodMode,tileSize,reqId,minX,maxX,minY,maxY)` (reqId 1..0xFFFFFFFE), `ViewportCommit(imageId,reqId)`, `AbortStream(imageId,abortReqId)`, `TileHeader(imageId,zoom,format,tileSize,reqId,tileX,tileY,payloadLen)` (NO bytes; `payloadLen` 1..`MAX_TILE_BYTES`), `GenerationEnd(imageId,reqId,sent,skipped)`; consts as v1.5 + `T_COMMIT=0x05`; validate id/zoom/tileSize==512/LOD∈{0,1,2}/format∈{1,2}/coords/span≤128/LEN gate. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/proto/UtpCodec.java` BIG_ENDIAN: `encodeViewport` 28B (0:MAGIC,1:TYPE,2-3:ID,4:ZOOM,5:LOD,6-7:512,8-11:REQ_ID,12-27 coords); `encodeCommit`/`encodeAbort` 8B `>BBHI`; `encodeTileHeader` 24B (8-11 REQ_ID,12-15 X,16-19 Y,20-23 LEN); `encodeEnd` 16B `>BBHIII`; decodes mirror; throw on MAGIC/type/len/TILE_SIZE/LOD/span/LEN-gate. Empty COMMIT legal (phase-05 creates sealed-empty + END 0/0; asserted in SessionTest). | TASK-001 | `mvn -q test -Dtest=UtpCodecTest` passes |  |  |
| TASK-003 | Create `NEW src/test/java/com/ultratile/proto/UtpCodecTest.java` (12 tests): 28B viewport (`02 00`@6-7, reqId@8-11, len 28), 8B commit, 8B abort, 24B tile header LEN@20-23 golden `0x00120304`→bytes `00 12 03 04` (≈1.13 MiB, UNDER the 2 MiB gate — v1.5's `0x01020304` ≈16.1 MiB illegally violated its own gate), 16B end, reject bad MAGIC/TILE_SIZE(256)/LOD(7)/LEN(3MiB)/truncated/span>128, big-endian check. Python vectors: `>BBHBBHIIIII`=28, `>BBHI`=8, `>BBHBBHIIII`=24, `>BBHIII`=16. | TASK-002 | `mvn -q test` green (12/12) |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/proto/UTP_SPEC.md` (16 lines): offset tables 28/8/8/24/16, DataView notes, seal incl. empty-gen END 0/0 + END-only-non-canceled-active rule, freeze/mismatch-invalid, validate-before-supersede, GEN_TILE_CAP pre-insert reject, no-wrap + no-reset-on-switch, FORMAT map. | TASK-002 | `grep -q VIEWPORT_COMMIT UTP_SPEC.md` |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=UtpCodecTest
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,0,2,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,5,0,1))==8; assert len(struct.pack('>BBHI',0xAA,3,0,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,0,3,1,512,1,0,0,4))==24; assert len(struct.pack('>BBHIII',0xAA,4,0,1,4,0))==16; print('struct-ok')"
```

## Notes for Implementer

- Golden LEN value must satisfy the gate it tests: `0x00120304` passes, `0x01020304` must throw — the v1.5 test vector contradicted its own validation.
- Codec stays lifecycle-free (no COMMIT ordering logic here); seal/publish rules live in phase-05, epoch rules in phase-06.
