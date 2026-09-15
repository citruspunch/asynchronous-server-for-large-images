---
phase: phase-03-utp-codec
goal: GOAL-003 Logical-generation codec 28B/8B/24B/16B round-trips
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 03 — UTP Codec ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, FORMAT `0x01`=JPEG→`image/jpeg` / `0x02`=WebP→`image/webp`; logical-viewport generation REQ_ID u32, no wrap per WS session (reconnect before overflow): C->S `0x01 VIEWPORT_UPDATE` 28B `>BBHBBHIIIII` (REQ_ID + 4 coords), chunks of one viewport share same REQ_ID; C->S `0x03 ABORT_STREAM` 8B `>BBHI` (ABORT_REQ_ID); S->C `0x02 TILE_PAYLOAD` 24B header `>BBHBBHIIII` + payload (REQ_ID echo); S->C `0x04 GENERATION_END` 16B `>BBHIII` (REQ_ID, SENT, SKIPPED). Server: newer REQ_ID→clear/supersede, ==current→append+dedupe tile keys, older→ignore. TILE header built from file size without loading bytes.
  - **REQ-003**: Initial HTTP/1.1 serves static bundle + metadata; image control uses custom UTP/1.0 binary protocol over WebSocket (RFC 6455), fully documented with RFC references.
- Prior-phase deps: none beyond phase-01 layout (pure codec, no I/O).
- Inputs: logical-generation spec. Outputs: `TileHeader` codec + `0x04` + golden tests.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/proto/UtpMessages.java`: `ViewportUpdate(imageId,zoom,lodMode,tileSize,reqId,minX,maxX,minY,maxY)` reqId u32 no-wrap (client asserts `reqId!=0xFFFFFFFF`, reconnect before overflow), `AbortStream(imageId,abortReqId)`, `TileHeader(imageId,zoom,format,tileSize,reqId,tileX,tileY,payloadLen)` (NO `byte[]`), `GenerationEnd(imageId,reqId,sent,skipped)`; consts `MAGIC,T_VIEWPORT=0x01,T_TILE=0x02,T_ABORT=0x03,T_END=0x04,FMT_JPEG=0x01,FMT_WEBP=0x02,TILE_SIZE=512`; validate id/zoom/tileSize==512/coords/format/span≤128. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/proto/UtpCodec.java` BIG_ENDIAN: `encodeViewport` 28B struct `>BBHBBHIIIII` (offsets 0:MAGIC,1:TYPE,2-3:ID,4:ZOOM,5:LOD,6-7:512,8-11:REQ_ID,12-15:MIN_X,16-19:MAX_X,20-23:MIN_Y,24-27:MAX_Y); `encodeAbort` 8B `>BBHI`; `encodeTileHeader(TileHeader h)` 24B `>BBHBBHIIII` from `payloadLen` long without bytes (offsets 8-11 REQ_ID,12-15 X,16-19 Y,20-23 LEN); `encodeEnd` 16B `>BBHIII`; matching decodes; throw on MAGIC/type/len/TILE_SIZE/span. | TASK-001 | `mvn -q test -Dtest=UtpCodecTest` passes |  |  |
| TASK-003 | Create `NEW src/test/java/com/ultratile/proto/UtpCodecTest.java`: viewport 28B assert `02 00` at 6-7 + reqId at 8-11 + total 28, abort 8B round-trip, tile header 24B assert LEN at 20-23 + reqId echo, `0x04` 16B round-trip (sent/skipped), reject bad MAGIC/TILE_SIZE/truncated/span>128, big-endian check, logical-chunk rule doc test (same REQ_ID twice → append, not supersede — asserted in SessionTest). Python-equivalent vectors: `struct.pack(">BBHBBHIIIII",0xAA,1,0,2,0,512,1,0,3,0,3)` 28B; `struct.pack(">BBHI",0xAA,3,0,1)` 8B. | TASK-002 | `mvn -q test` green (10/10) |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/proto/UTP_SPEC.md` (14 lines): offset tables 28/8/24/16, DataView notes (`getUint32(8)` reqId, `getUint32(20)` LEN), SPAN 128 + same-REQ_ID chunk + dedupe rule, no-wrap rule, `0x04` completion semantics. | TASK-002 | `grep -q GENERATION_END UTP_SPEC.md` |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=UtpCodecTest
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,0,2,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,3,0,1))==8; print('py-struct-ok')"
```

## Notes for Implementer

- Fixes v1.2 `">BBHBBHIIIIII"` bug (that is 32B/12 vals); 28B viewport is exactly `>BBHBBHIIIII` (8 + 5×4).
- `TileHeader` never owns bytes; production header comes from `FileChannel.size()`; `decodeTileHeader` returns header only.
- No wrap: `nextReqId` 1..0xFFFFFFFE; on reaching max, close WS with 1000 + reconnect; server `newer = reqId>current` (monotonic, no serial arithmetic needed because wrap forbidden).
- FORMAT mapping frozen for viewer: `0x01→image/jpeg`, `0x02→image/webp`.
