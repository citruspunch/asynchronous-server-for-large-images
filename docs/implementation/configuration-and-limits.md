# Configuration and limits

> This document is the implementation-level inventory of every limit, its owner,
> its category, and its consequence. It is authoritative for the **code as it
> stands**. Where a limit is also a protocol fact, UTP-1.0.md is normative and this
> table is a pointer to it.
>
> The distinction that matters most in this project:
>
> ```text
> protocol representability  !=  practical importability
> ```
>
> An operational guard is not a protocol limit and must never be described as one.

## Categories

| Category | Meaning | Consequence of exceeding it |
| --- | --- | --- |
| **protocol / wire** | Fixes what can appear on the wire. Changing it is a UTP version decision. | Packet rejected, or a deterministic Close. |
| **implementation safety** | A bound chosen so the implementation cannot be pushed into a bad state. | Refused with a message naming the actual cause. |
| **operational / resource policy** | "Can we afford to build or serve this?" Not a claim about validity. | Import refused before any work. Never enforced at serve time. |
| **viewer policy** | A browser-side budget with no Java counterpart. | Smaller batch, level downgrade, or retry. |
| **test-only** | Exists for a probe, a self-test, or a harness. | Test fails or the probe reports. |

## Protocol and wire

| Name | Value | Owner | On exceeding |
| --- | --- | --- | --- |
| Tile size | 512 px | `Config.TILE_SIZE`, `PyramidTileStore.TILE`, `UtpMessages` records, `import_vips.sh` `--tile-size 512`, viewer `TILE` | Any value other than 512 in a chunk or TILE header is rejected. Parity fails if the copies disagree. |
| Wire magic | `0xAA` | `UtpMessages.MAGIC` | Packet rejected. |
| Type codes | `0x01` viewport, `0x02` tile, `0x03` abort, `0x04` end, `0x05` commit | `UtpMessages` | Unknown type fails session with 1002. |
| Subprotocol | `ultratile.utp.v1` | `UtpMessages.SUBPROTOCOL` | Handshake 400. The exactly-one-header rule is labeled a handshake profile, not an RFC claim. |
| LOD mode | 0 (nearest) only | `UtpMessages.LOD_NEAREST` | 1 and 2 are reserved; a chunk carrying them fails with 1002. |
| Format | 1 (JPEG) only | `UtpMessages.FORMAT_JPEG` | 2 (WebP) parses but is never emitted. The viewer treats a received 2 as terminal. |
| Request ID range | `1 .. 0xFFFFFFFE` | `UtpMessages.REQ_ID_MAX` | Rejected by the record constructor. No wrap; the viewer reconnects and restarts at 1. |
| Image ID range | `0 .. 65535` | `UtpMessages.MAX_IMAGE_ID` | Rejected. It is a genuine u16 wire width. |
| Tile coordinate range | `0 .. 65535` per axis | `UtpMessages.MAX_TILE_COORD` | Chunk or TILE header rejected. **This is a policy bound on u32 fields, not a wire limit**; see the note below. |
| Max tiles per axis | 65,536 | `UtpMessages.MAX_TILES_PER_AXIS` (= `MAX_TILE_COORD + 1`) | The input is not representable. |
| Max representable dimension | 33,554,432 px/axis | `UtpMessages.maxRepresentableDim()`, re-exported as `PyramidTileStore.MAX_REPRESENTABLE_DIM` | Input refused by `checkRepresentable()`. |
| Chunk span | 128 per axis | `Config.SPAN_CAP` | Rejected in both the record constructor and the decoder, with the span compared in `long`. |
| Generation tile cap | 256 unique tiles | `Config.GEN_TILE_CAP` | A chunk whose product exceeds 256 is rejected. At the set level, a duplicate at 256 is admitted and the 257th unique key is refused: matching-active closes with 1002, a new generation is recorded in `rejectedReqIds`. |
| Max tile bytes | 2,097,152 | `Config.MAX_TILE_BYTES` | Rejected at `TileHeader` construction; a file over the cap is a skip at serve time; an oversize staged tile fails import. |
| Inbound WS application cap | 1,024 bytes | `Config.WS_MSG_CAP`, re-exported as `WsFrame.INBOUND_CAP` | A well-formed oversize message is 1009. Checked before the payload is read, so an oversize payload is never buffered. |
| Close reason cap | 123 bytes | `SessionCoordinator.CLOSE_REASON_MAX` | Truncated on a UTF-8 boundary, so the Close payload stays within the 125-byte control limit. |
| Browser violation code | 4002 | viewer `CLOSE_UTP_ERROR` | Private use. A browser cannot send 1002 from script, and the server echoes 4002 with no UTP meaning attached. |

### On the tile-coordinate bound

`MAX_TILE_COORD = 65535` is worth being precise about, because an earlier
revision of the codebase documented it wrongly. It is **not** forced by the
`(x << 32) | y` tile-key packing. That packing round-trips correctly across the
whole u32 range, including `x = 2^31` and `x = 2^32 - 1`, because `x` is a `long`
and `key >>> 32` recovers it even when the packed value has its sign bit set. It
is a policy bound, retained because it is specified, implemented, and tested;
because widening it is a protocol-visible change with no benefit at any plausible
image size; and because keeping coordinates inside 16 bits means the wire codec,
the key packing, the `int` path components in the tile store, and the viewer's JS
number arithmetic are all trivially in range without per-layer range reasoning.

Headroom is about 309x a 9 gigapixel mosaic. Widening it would be a UTP/1.1
decision and would need no wire-format change.

`MAX_IMAGE_ID` and `MAX_TILE_COORD` both equal 65535 by coincidence. One is a
wire width, the other is a policy bound. They have distinct names for that reason
and `PyramidLimitTest.imageIdAndTileCoordBoundsAreDistinctConcepts()` asserts both
values without conflating them.

## Implementation safety

| Name | Value | Owner | On exceeding |
| --- | --- | --- | --- |
| Importer metadata size | 16,384 bytes | `Config.META_MAX_BYTES` | `readBounded` refuses before parsing; the image is dropped with a WARNING. |
| Importer name length | 128 characters | `Config.META_NAME_MAX` | Image dropped with a WARNING. Names must also be exactly `image-<id>`. |
| Remembered rejected request IDs | 64 | `Config.REJECTED_CAP` | The 65th **live** rejected ID closes the connection. Live entries are never evicted; entries purge only once `id <= lastReqIdSeen`. Evicting one would let a refused reqId come back as valid. |
| HTTP head cap | 16,384 bytes | `NioHttpServer.HEAD_CAP` (private, not in `Config`) | 431, then close. |
| HTTP read timeout | 5,000 ms | `NioHttpServer.handle` (private) | Connection dropped. Cleared with `setSoTimeout(0)` after a WebSocket upgrade, since tile streams may idle. |

## Operational and resource policy

| Name | Value | Owner | On exceeding |
| --- | --- | --- | --- |
| Import tile cap | 16,777,216 tiles (2^24) | `Config.IMPORT_MAX_TILES`, mirrored as `IMPORT_MAX_TILES` in `import_vips.sh` | Import refused with a message naming the constant. **Never enforced by `ImageRegistry`.** |
| ImageIO fallback max axis | 8,192 px | `Config.IMPORT_IMAGE_MAX_DIM` | `--image` refused before decode, pointing at `import_vips.sh`. |
| ImageIO fallback max pixels | 16,777,216 | `Config.IMPORT_IMAGE_MAX_PIXELS` | Same. Checked from the header, so no raster is allocated. |
| Import disk floor | 4,096 bytes per tile | `import_vips.sh` `MIN_TILE_BYTES` (private) | Refused only when fitting is impossible. A `df` failure skips the check rather than aborting. |
| Stale staging retention | newest 2 | `import_vips.sh` `STALE_TMP_KEEP`, env `ULTRASTILE_STALE_TMP_KEEP` | Older `.stale-tmp-*` directories are deleted and the reclaimed size reported. `.stale-<id>-*` is never pruned. |

The tile cap's job is to bound how much generation, filesystem, and validation
work one import may request. It is deliberately far above what a real image
needs: a 262,144 x 262,144 image is 68.7 gigapixels and only 349,525 tiles, and a
40000 x 30131 image is 6,270.

It is **not** a defense against a malformed `meta.json`. `ImageRegistry` never
reads it. The registry's own exposure to bad metadata is bounded separately by
`META_MAX_BYTES` and the strict hand parser, which reject oversize, malformed, and
inconsistent input before it is used. The `long` return type of `totalTiles` then
keeps the count range-checked at a known-safe magnitude rather than merely
happening not to overflow.

## Viewer policy

These have no Java counterpart, and `check_const_parity.py` fails if one is added
to the parity map.

| Name | Value | Owner | Effect |
| --- | --- | --- | --- |
| Browser cache size | 40 tiles | viewer `MAX_CACHE` | LRU eviction, closing the bitmap. `z === 0` is pinned against eviction, but not against a fully pinned cache. |
| Browser decode concurrency | 6 | viewer `MAX_DECODE` | Admission waits for a drain event. |
| Browser decode queue jobs | 24 | viewer `DECODE_QUEUE_MAX_JOBS` | A received tile goes to `retryNeeded` rather than blocking. |
| Browser decode queue bytes | 4,194,304 | viewer `DECODE_QUEUE_MAX_BYTES` | Same. Counts queued bytes only, not in-flight. |
| Browser batch cap | 30 | viewer `BATCH_CAP` | Upper clamp on the computed budget. |
| Planning floor | 65,536 bytes | viewer `PLAN_FLOOR` | Lower bound on the assumed tile size, so a cheap-to-compress pyramid cannot inflate the batch size past `GEN_TILE_CAP`. |
| Union cap | 36 tiles | viewer `UNION_CAP` | `effectiveLOD` downgrades to a coarser level whose visible union across all levels fits. |
| Intent debounce | 80 ms | viewer `INTENT_DEBOUNCE_MS` | Coalesces a pointermove stream into one viewport intent. |
| Viewport scale | `1e-3 .. 32` | viewer `SCALE_MIN`, `SCALE_MAX` | Clamped on zoom and on initial fit. |
| Average tile seed | 131,072 bytes | viewer `AVG_TILE_SEED` | Starting value for the running mean, reset on every image switch. |

The batch budget is the composed version, and the clamp order is what makes it
safe:

```text
budget = min(BATCH_CAP, freeJobs, max(1, floor(freeBytes / planTileBytes)))
```

## Test-only

| Name | Value | Owner | Purpose |
| --- | --- | --- | --- |
| Parser self-test vectors | 12 | `scripts/test_e2e_parser.py` | Frame-parser vectors, no server. |
| Viewer tests | 42 | `scripts/test_viewer.cjs` | Runs the concatenated viewer in `node:vm`. |
| Real pipeline clients | 10 (default) | `scripts/real_pipeline_test.py` `--clients` | Concurrency against a running server. |
| Real pipeline images | 4, 5, 6 | `scripts/real_pipeline_test.py` `--images` | The imported ESO ladder. |
| Verifier deep sample | 40 interior tiles per level | `scripts/verify_pyramid.py` | Full decode of a sample. |
| Verifier seam sample | 12 seams | `scripts/verify_pyramid.py` | Boundary gradient sampling. |
| Crash kill schedule | 9 moments, 0.05 s to 3.4 s | `scripts/crash_recovery_test.py` | Import interruption. |
| EOS pyramid depth | 8 levels | `scripts/measure_import.py` `LADDER` | Expected geometry per rung, verified not trusted. |

## Constants in `Config.java` the server never reads

This is the single most misleading thing about the file, so it is worth stating
plainly. `Config.java` is both the operational tuning set and the parity anchor
for the browser. These constants have **zero** references outside `Config.java`
itself:

```text
CACHE_CAP  DECODE_MAX  DECODE_QUEUE_JOBS  DECODE_QUEUE_BYTES
BATCH_CAP  AVG_TILE_SEED  SCALE_MIN  SCALE_MAX
```

They exist so `check_const_parity.py` can assert that the viewer's copies of
those numbers have not drifted, and so the two sides are reviewable in one place.
The server enforces none of them: it has no tile cache, does no decoding, and has
no viewport. Treating `CACHE_CAP = 40` as a server-side cache size would be wrong.

The constants the server does read are `PORT`, `BIND`, `DATA_ROOT`, `TILE_SIZE`,
`WS_MSG_CAP`, `MAX_TILE_BYTES`, `GEN_TILE_CAP`, `SPAN_CAP`, `REJECTED_CAP`,
`JPEG_QUALITY`, `META_MAX_BYTES`, `META_NAME_MAX`, `IMPORT_MAX_TILES`,
`IMPORT_IMAGE_MAX_DIM`, and `IMPORT_IMAGE_MAX_PIXELS`.

## Constant ownership

Two Java files, never mixed, and the split is enforced:

| File | Owns |
| --- | --- |
| `Config.java` | Operational tuning: tile size, caps, budgets, seeds, scale bounds, bind, port, data root |
| `proto/UtpMessages.java` | Wire magic, UTP type codes, the subprotocol token, ID and coordinate bounds, and the derived representable dimension |

`check_const_parity.py` fails on an owner violation, so a tuning name cannot move
into the wire file or a wire name into the tuning file.

Four places must change together for a shared value:

```text
src/main/java/com/ultratile/Config.java              (or UtpMessages.java for wire)
src/main/resources/web/js/constants.js                the viewer copy
scripts/import_vips.sh                                the shell copy, where it exists
scripts/check_const_parity.py                         the expected value in expect_ints
```

## `Config.MAX_DIM` does not exist

There is no dimension ceiling in `Config.java`. An earlier `MAX_DIM = 262144` was
removed because it had no derivation, permitted only 512 tiles per axis where the
protocol addresses 65,536 (128x stricter than required), and silently rejected
valid images in both the importer and the registry.

Representability now lives in exactly one place, `UtpMessages.maxRepresentableDim()`,
and `PyramidTileStore.MAX_REPRESENTABLE_DIM` delegates to it rather than restating
a literal. `check_const_parity.py` fails if the identifier or the number
`262144` reappears in `Config.java`, in `UtpMessages.java`, or in the non-comment
lines of `import_vips.sh`, and it recomputes the derivation independently
(`(65535 + 1) * 512 == 33554432`) rather than trusting the source comment.

`PyramidLimitTest` pins the behavior: 262144 x 262144 and 300000 x 300000 are
ordinary acceptable images, one pixel past the derived limit is refused with a
message naming the coordinate range and **not** saying "too large", and the
largest representable square is refused by the tile cap with a message naming the
cap and also not saying "too large".

## Why the tile cap is 2^24 and not larger

The cap's role is to bound how much generation, filesystem, and validation work a
single import may request. It is not a defense against malformed `meta.json`:
`ImageRegistry` never reads it, and the registry's metadata handling is bounded
separately by `META_MAX_BYTES` and a strict hand parser, both of which are
implementation safety limits rather than protocol semantics.

The value is also measured rather than chosen. The previous value, 2^28
(268,435,456), was not a useful policy: at the ~140 KB mean tile size of the real
image ladder it implies tens of terabytes, so no filesystem check would ever admit
an image that large, while the validation the cap nominally guarded would take
hours. Measured on APFS with 262,144 files in one directory, a whole-directory
scan runs at about 16 microseconds per file, so the importer's generate plus glob
plus sort plus compare costs about 50 microseconds per tile. 2^24 therefore caps
the validation pass at roughly 14 minutes in the worst case instead of roughly 3.7
hours.

One consequence of tightening it: `check_const_parity.py` pins this value in its
`expect_ints` table and `PyramidLimitTest.tileCapIsDerivedNotArbitrary()` pins it
again as an exact power of two, so raising it means editing the constant, the
shell copy, and two tests.

Headroom over real inputs is large. The public 9 gigapixel VVV mosaic
(108200 x 81500) is 45,252 tiles, verified by `PyramidTileStore.totalTiles()`,
which is more than 100x under the cap. The 400 gigapixel figure from the project
brief works out to about 2,037,270 tiles for a 632,456 square, roughly 8x under
the cap. These are reference anchors, not predictions for any particular
evaluator image.

`PyramidLimitTest.tileCapIsDerivedNotArbitrary()` pins the value to 2^24 exactly,
asserts it is a power of two so the intent stays legible instead of drifting to an
arbitrary literal, and asserts the headroom above both anchors.
`realLadderImagesAreAllWellUnderTheCap()` asserts the four real dimensions,
including the VVV mosaic, are admitted by `IngestTool.admit()`.

## The three limits people conflate

| Question | Answered by | Value | Example that fails it |
| --- | --- | --- | --- |
| Can the protocol name a tile of this image? | `PyramidTileStore.checkRepresentable` | 33,554,432 px/axis | 33,554,433 px |
| Can we afford to build the pyramid? | `Config.IMPORT_MAX_TILES`, disk floor | 16,777,216 tiles, 4 KB/tile of free space | 33,554,432 x 33,554,432 is 5,726,623,061 tiles |
| Will the browser be able to render it? | `UNION_CAP`, `BATCH_CAP`, `GEN_TILE_CAP` | 36 union, 30 per batch, 256 per generation | a deep zoom that wants 400 tiles at one level |

A 33,554,432 square answers yes to the first, no to the second, and the third
depends entirely on the viewport. Each refusal message names which one it was.
