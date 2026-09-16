---
phase: phase-03-utp-codec
goal: GOAL-003 Sealed-generation codec 28B/8B/8B/24B/16B round-trips
status: 'Planned'
parent: ./overview.md
version: 1.12
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 03 — UTP Codec ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0`
    ONLY (values 1/2 reserved → reject — a mode field with no semantics is
    not shipped as functionality), FORMAT `1` JPEG implemented (`2` WebP
    reserved: parsed, never emitted); subprotocol `ultratile.utp.v1`
    (handshake-level, phase-05); REQ_ID u32 no-wrap via the allocator
    (reconnect before max; never reset on image switch, 1 only on new WS;
    `lastReqIdSeen` advances ONLY on accepted new generation; rejected reqIds
    remembered under the no-evict discipline).
    - `0x01` 28B `>BBHBBHIIIII`
      (freeze/mismatch-invalid/post-seal-rejected).
    - `0x05` 8B `>BBHI` (seal; three-way COMMIT — the newer-empty case
      installs sealed-empty `work=List.of()` through the SAME coalesced
      slot; the dispatcher sends its END, never a reader-side END;
      invalid-newer COMMIT → immediate 1002, never record-and-ignore).
    - `0x03` 8B `>BBHI` (`(imageId,reqId)` must match — wrong-image ignored
      as stale, never advances seen; terminal, no END).
    - `0x02` 24B `>BBHBBHIIII` (LEN u32 + ≤`MAX_TILE_BYTES`).
    - `0x04` 16B `>BBHIII` (sealed/non-canceled/active/empty/inflight0
      only).
    - Span≤128/packet; unique set ≤`GEN_TILE_CAP=256` with the DEDUPE-AWARE
      check `if (!requested.contains(key) &&
      requested.size()==GEN_TILE_CAP) reject` (duplicate at cap accepted;
      257th UNIQUE key rejected). Validate-before-supersede.
  - **REQ-003**: HTTP-subset serves bundle; UTP/1.0 over RFC 6455 documented.
- Prior-phase deps: none beyond phase-01 layout (pure codec, no I/O).
- Inputs: sealed-generation spec. Outputs: gated `TileHeader` +
  `ViewportCommit` codecs with u32 discipline + golden tests +
  non-normative pointer.

## Tasks

### TASK-001 — Message records

- Create `NEW src/main/java/com/ultratile/proto/UtpMessages.java`:
  `ViewportUpdate(imageId,zoom,lodMode,tileSize,reqId,minX,maxX,minY,maxY)`,
  `ViewportCommit(imageId,reqId)`, `AbortStream(imageId,abortReqId)`,
  `TileHeader(imageId,zoom,format,tileSize,reqId,tileX,tileY,payloadLen)`
  (NO bytes; `payloadLen` 1..`MAX_TILE_BYTES`),
  `GenerationEnd(imageId,reqId,sent,skipped)`; consts + `T_COMMIT=0x05` +
  `SUBPROTOCOL="ultratile.utp.v1"`.
- Validate id/zoom/tileSize==512/LOD==0 (1/2 reserved → throw)/
  format∈{1,2} wire-parseable BUT document `2` reserved (server never emits;
  viewer treats as unsupported)/coords/span≤128/LEN gate.
- u32 wire values carried as Java `long` (0..4294967295); `reqId`
  1..0xFFFFFFFE per no-wrap rule.
- Done when: `mvn -q compile` passes (offline validation track).

### TASK-002 — Big-endian codec with u32 discipline

- Create `NEW src/main/java/com/ultratile/proto/UtpCodec.java` BIG_ENDIAN:
  parse every u32 field via `buf.getInt()` →
  `Integer.toUnsignedLong(...)` (NEVER raw signed `int`); explicitly require
  `minX≤maxX` and `minY≤maxY`; check image-agnostic sanity (coords ≤65535
  here; image-specific bounds in phase-05 with registry); compute
  widths/spans in `long` (`maxX-minX+1L`, product in `long`) before comparing
  to `SPAN_CAP`/`GEN_TILE_CAP`.
- Offsets as v1.6 (28B viewport, 8B commit/abort, 24B header with LEN@20-23,
  16B end); throw on MAGIC/type/len/TILE_SIZE/LOD(≠0)/span/LEN-gate/shape.
- Empty COMMIT legal (phase-05 unified dispatcher path: sealed-empty
  `work=List.of()` through the coalesced slot, with the sealed-empty state
  carrying the frozen `zoom=-1, lodMode=-1` sentinel — zoom/LOD are absent
  on the COMMIT wire bytes, so the state MUST NOT invent semantic values
  the client never sent; asserted in SessionTest via
  the dispatched END, never a direct reader write).
- Done when: `mvn -q test -Dtest=UtpCodecTest` passes (offline validation
  track).

### TASK-003 — Codec golden tests (16 tests)

- Create `NEW src/test/java/com/ultratile/proto/UtpCodecTest.java`
  (16 tests): v1.6 set ADJUSTED (28B viewport with `lodMode=0`, 8B
  commit/abort, 24B header golden `0x00120304`→`00 12 03 04` with `format=1`,
  16B end, reject MAGIC/TILE_SIZE(256)/LOD(1 — reserved, not merely
  out-of-range)/LEN(3MiB)/truncated/span>128, big-endian) PLUS u32-shape
  vectors: `minX=0xffffffff` decodes to 4294967295 and fails
  image-bounds/span validation (never wraps to -1); reversed `minX=5,maxX=3`
  rejected (not an empty range); `minX=0,maxX=0xffffffff` span product
  computed in `long` (4294967296 > caps, rejected — never int-overflow);
  `LEN=0xffffffff` rejected by gate; `format=2` round-trips at codec level
  (reserved, never emitted — emission + viewer handling covered in
  SessionTest/`test_viewer.cjs`); DEDUPE-AWARE cap unit vector (fill a
  256-key set, re-add an existing key → accepted; add a 257th unique key →
  rejected).
- Python vectors: `>BBHBBHIIIII`=28, `>BBHI`=8, `>BBHBBHIIII`=24,
  `>BBHIII`=16.
- Done when: `mvn -q test` green (16/16, offline validation track).

### TASK-004 — Non-normative spec pointer

- Create `NEW src/main/java/com/ultratile/proto/UTP_SPEC.md` (SHORT pointer +
  golden packet table ONLY — explicitly NON-NORMATIVE; header states
  "Normative specification: docs/protocol/UTP-1.0.md — this file MUST NOT
  duplicate lifecycle rules"): 28/8/8/24/16 offset table, DataView notes
  (`getUint32` — JS is unsigned-safe; Java MUST use `toUnsignedLong`),
  one-line seal/stale-vs-invalid/COMMIT-liveness/no-evict-rejected/
  LOD-0-only/FORMAT-1/unified-empty-COMMIT/dedupe-aware-cap pointers WITHOUT
  restating the rules (no second source of truth to drift).
- Done when: `grep -q "NON-NORMATIVE" UTP_SPEC.md` +
  `grep -q lastReqIdSeen UTP_SPEC.md`.

## Validation Commands

Offline validation track:

```sh
mvn -q test -Dtest=UtpCodecTest
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,0,2,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,5,0,1))==8; assert len(struct.pack('>BBHI',0xAA,3,0,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,0,3,1,512,1,0,0,4))==24; assert len(struct.pack('>BBHIII',0xAA,4,0,1,4,0))==16; print('struct-ok')"
```

## Notes for Implementer

- u32 discipline is a security property (path/coordinate bypass via sign
  confusion), not style: `0xffffffff` must read as 4294967295 and be
  REJECTED, never silently become -1 or a small span.
- Seen-advancement table lives NORMATIVELY in `docs/protocol/UTP-1.0.md`
  (phase-07); the v1.8 table here is intentionally demoted to a pointer so
  the accept/reject rules cannot drift between two documents.
- LOD-0-only and FORMAT-1-implemented are honesty freezes: the wire keeps
  its fields, but unimplemented values are rejected/reserved instead of
  presented as supported.
- The dedupe-aware cap check is a one-line invariant with a real interop
  consequence: a client re-sending an already-requested tile at a full
  generation must NOT be punished for the server's set size. The vector pins
  it.
