# UTP/1.0 Packet Layouts (NON-NORMATIVE)

Normative specification: docs/protocol/UTP-1.0.md — this file MUST NOT
duplicate lifecycle rules.

This file is a short pointer plus golden packet table only. All
seal/stale-vs-invalid/COMMIT-liveness/no-evict-rejected/LOD-0-only/FORMAT-1/
unified-empty-COMMIT/dedupe-aware-cap behavior is defined normatively in
docs/protocol/UTP-1.0.md. Pointers below name the rule without restating it.

## Golden packet table (big-endian)

| Type | Size | Layout |
| ---- | ---- | ------ |
| 0x01 viewport | 28B | `>BBHBBHIIIII`: MAGIC@0, type@1, imageId H@2, zoom B@4, lodMode B@5, tileSize H@6, reqId I@8, minX I@12, maxX I@16, minY I@20, maxY I@24 |
| 0x05 commit | 8B | `>BBHI`: MAGIC@0, type@1, imageId H@2, reqId I@4 |
| 0x03 abort | 8B | `>BBHI`: MAGIC@0, type@1, imageId H@2, abortReqId I@4 |
| 0x02 tile header | 24B | `>BBHBBHIIII`: MAGIC@0, type@1, imageId H@2, zoom B@4, format B@5, tileSize H@6, reqId I@8, tileX I@12, tileY I@16, payloadLen(LEN) I@20 |
| 0x04 end | 16B | `>BBHIII`: MAGIC@0, type@1, imageId H@2, reqId I@4, sent I@8, skipped I@12 |

## DataView notes

- JS is unsigned-safe: use `getUint32` for u32 wire fields.
- Java MUST use `Integer.toUnsignedLong(buf.getInt())` for every u32 field
  (never raw signed `int`).

## Rule pointers (see normative doc)

- Sealed generations advance `lastReqIdSeen` only on accepted new generations.
- Stale-vs-invalid discipline decides history before full validation.
- COMMIT liveness split: invalid-newer CHUNK records, invalid-newer COMMIT closes.
- Rejected ids use no-evict discipline under the frozen cap.
- LOD-0-only: values 1/2 are reserved and rejected.
- FORMAT-1 implemented: value 2 parses but is never emitted.
- Unified empty COMMIT flows through the same coalesced slot.
- Dedupe-aware cap: duplicates at cap are accepted, new uniques are rejected.
