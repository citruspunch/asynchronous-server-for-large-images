# Tile pyramid and on-disk storage

> This document describes the current image representation as implemented in
> `PyramidTileStore`, `ImageRegistry`, and the two importers. The formulas below
> were read from the code and, where numbers are quoted, verified against the
> real imported pyramids under `data/images/`.
>
> The code is authoritative where this document is stale. For the wire view of
> levels and coordinates, and for the normative representability rule, see
> [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md) §2 and §7.1.

## The 512x512 invariant

Every stored tile file is physically 512x512 pixels, on every level, including
the levels that are smaller than one tile. The tile edge is
`PyramidTileStore.TILE` in Java, `Config.TILE_SIZE` in the tuning file, `TILE` in
the viewer, and `--tile-size 512` in the libvips importer. `check_const_parity.py`
pins all four against each other, so they cannot drift.

This is a real invariant, not an aspiration. `PyramidTileStore.checkSize()` only
gates the byte length; the pixel dimensions are asserted at import time by
`IngestTool.validateStaged()` (via `jpegDims()`, a header read, never a full
decode) and again by the post-pad pass and the final geometry assertion in
`import_vips.sh`. A pyramid containing a short tile cannot be published.

The browser draws full 512x512 bitmaps at a `512 * 2^(N-z)` pixel footprint and
lets a world-space clip to `[0,W) x [0,H)` cut the pad away, so the viewer never
has to reason about partial tiles.

## Ceiling pyramid math

Let `TILE = 512` and `max = max(W, H)`.

**Level count.** The implementation walks a doubling counter rather than taking a
logarithm:

```java
int n = 0; long size = TILE;
while (size < max) { size *= 2; n++; }
levels = n + 1;          // levelCount(w, h)
```

which is the same value as `N = max(0, ceil(log2(max(W,H) / 512)))` for `N` as the
index of the finest level. The integer loop is used deliberately: it cannot
disagree with the log form through floating-point rounding at a power-of-two
boundary. The viewer's `maxLevelFor()` does use the log form, and the two agree on
every dimension in the repository's test set.

**Level extent.** With `shift = n - z` and `div = 2^shift`:

```java
levelW(w, h, z) = max(1, ceil(w / div))     // computed as (w + div - 1) / div in long
levelH(w, h, z) = max(1, ceil(h / div))
```

**Grid.** `cols(w,h,z) = ceil(levelW / 512)` and `rows(w,h,z) = ceil(levelH / 512)`,
each computed in `long` so the `+511` rounding step cannot wrap.

**Level orientation.** `z = 0` is the coarsest level, always at or under one tile
per axis. `z = n` is the finest, at full resolution. `zoom` on the wire is this
same `z`.

**Tile totals.** `totalTiles(w, h)` returns `long` and sums `cols * rows` over all
levels. This is not defensive. A 33,554,432 square is a legal image, and its
finest level alone is 65,536 x 65,536 = 2^32 tiles, which does not fit in an
`int`. `PyramidPlan.pixels()` is likewise a `long`: the same image is 2^50
pixels. `PyramidLimitTest` pins both facts, including the case where a naive
`d * d` in `int` wraps to exactly 0.

## Canonical tile path

One naming algorithm, owned by the store, never bound to a root:

```java
tileRelativePath(z, x, y) = "level-" + z + "/" + x + "_" + y + ".jpg"
```

Serving resolves `imageRoot(id).resolve(relative)`; ingest stages under
`.tmp-<id>/` and joins the same relative path. `TileMathTest.noTilePrefixLiteralsOutsideStore()`
walks `src/main/java` and fails if any file other than `PyramidTileStore` contains
the string `level-`, so a second naming scheme cannot creep in.

Negative `z`, `x`, or `y` throw. That guard is the last line of defense against a
path traversal if a coordinate ever reached the store unvalidated.

## On-disk layout

```text
<data root>/
  0/                          image 0, demo, 2048x2048
    .ready                    zero-byte marker, written last
    meta.json
    level-0/0_0.jpg
    level-1/{x}_{y}.jpg
    ...
  1/                          image 1, demo, 4096x4096
  4/ 5/ 6/                    real imported ESO pyramids
  .tmp-6/                     staging, never visible to the registry
  .stale-tmp-6-<epoch>/       quarantined staging from a crashed run
  .stale-6-<epoch>/           quarantined non-ready directory that sat at 6/
  .stale-invalid-0-<epoch>/   a ready demo whose metadata did not validate
```

The data root is `Config.DATA_ROOT`, currently `data/images`, overridable with
`--data-root`. The shell importer has its own `--data-root` default that
`check_const_parity.py` asserts is the identical string, because a mismatch would
mean publishing where the server does not look.

## The metadata schema

Six keys, no more. `IngestTool.writeMeta()` emits a single line:

```json
{"id":6,"name":"image-6","w":40000,"h":30131,"levels":8,"tile":512}
```

`ImageRegistry.parseMeta()` is a hand-written strict parser, not a JSON library,
and it enforces all of the following. A failure logs a WARNING and drops the
image; it never becomes a 500 and never throws out of a request.

| Check | Rule |
| --- | --- |
| Size | `readBounded` refuses anything over `META_MAX_BYTES` (16 KiB) before parsing |
| Key set | exactly six keys: `id`, `name`, `w`, `h`, `levels`, `tile` |
| Types | `name` string, the other five integers |
| Duplicates | rejected |
| Trailing data | rejected |
| Control characters in strings | rejected |
| `tile` | must equal 512 |
| Representability | `PyramidTileStore.isRepresentable(w, h)` must hold, the same rule the importer enforces |
| `name` | must equal `image-<id>`, and must be under 128 characters |
| `id` | must equal the directory name |
| Directory name | canonical decimal, so `01` is ignored even when its `meta.json` says `1` |
| `levels` | must equal `levelCount(w, h)` |

The representability check is the one that makes the registry and importer agree
by construction: both call `PyramidTileStore.checkRepresentable()`. An image the
importer accepted can never be silently dropped at serve time.

The registry deliberately does **not** apply `Config.IMPORT_MAX_TILES`. That limit
answers "can we afford to build this?", not "is this metadata valid". Enforcing it
at serve time would drop a pyramid that legitimately exists on disk, for example
one imported before the cap was raised. The registry is therefore always more
permissive than the importer and never stricter, and
`PyramidLimitTest.registryIsMorePermissiveThanTheImporter()` asserts exactly that
relationship across a probe list of widths.

## `.ready`, staging, and atomic publication

An image becomes visible in one rename.

1. Refuse early if the ID is not canonical decimal `0..65535`. `01` is rejected in
   Java, in the shell importer, and by the registry, and every path built from an
   ID uses `Integer.toString(id)`.
2. If `<id>/.ready` already exists, print `already-ready image-<id>` and exit 0.
   A ready image is never touched, never re-encoded, and never partially
   overwritten. `TileMathTest.idempotentNoOp()` checks the metadata mtime is
   unchanged across a rerun.
3. Quarantine any leftover `.tmp-<id>/` to `.stale-tmp-<id>-<epoch>/`.
4. Quarantine a non-ready `<id>/` to `.stale-<id>-<epoch>/`.
5. Build the whole pyramid under `.tmp-<id>/`.
6. Write `meta.json`.
7. Validate the staged tree.
8. `createFile(".ready")`.
9. `Files.move(tmp, target, ATOMIC_MOVE)`. **There is no non-atomic fallback.**
   A filesystem that refuses it aborts the import with an explanatory
   `IOException`.

### The atomicity guarantee, precisely

`ATOMIC_MOVE` is required rather than preferred, and that is a deliberate
correction. A plain `Files.move` degrades to copy-then-delete with unspecified
copy order, so the zero-byte `.ready` could land before the tiles it certifies,
exposing exactly the partial-publication state `.ready` exists to hide. Failing
loudly is the smaller risk: staging and target are always siblings under one
root, so a same-filesystem rename is the normal case, and a filesystem that
refuses it is a real deployment problem worth seeing.

What is guaranteed, and by what:

| Guarantee | Held by | Notes |
| --- | --- | --- |
| A published directory never appears without a complete, validated tree | Java: required `ATOMIC_MOVE`; shell: `mv` between siblings | Both paths rename a fully built and validated staging directory |
| The registry never adopts a staging or quarantine directory | `ImageRegistry.list()` / `get()` skip `.tmp-` and `.stale-` | Independent of atomicity |
| A crash mid-import never damages an already-published image | The ready-target short-circuit, step 2 | Verified by `crash_recovery_test.py` |
| Atomicity on an external volume | The filesystem | Same-filesystem `rename` is the textbook atomic case and holds on APFS, ext4, and NTFS, but this is a property of the filesystem, not of this code. The Java path now *detects* a filesystem that cannot do it and refuses rather than degrading silently. |

The shell importer uses plain `mv`. Because `.tmp-<id>` and `<id>` are siblings
under one root, that is a same-directory rename, which POSIX `rename(2)` performs
atomically, so the shell path does not need to request atomicity explicitly. It
does not *verify* it either. The two paths are therefore equivalent in practice
and differ in how they behave if that assumption is ever violated: the shell
would cross-copy silently, the Java path would refuse.

### What `.ready` proves, and what it does not

`.ready` is a publication marker created after staged validation. It records
what the importer knew at publication time. It is not a checksum and not a live
integrity record, and nothing re-verifies the tile tree afterwards.

Concretely, this is the verified behaviour:

```text
rm -rf data/images/N/level-*        # .ready and meta.json left in place
```

After that, `ImageRegistry.get(N)` still returns the image and `list()` still
lists it, because both only require `.ready` plus a valid `meta.json`. The image
is served, and requests for the missing tiles come back as END `skipped`. Worse,
re-running the importer does not repair it: the ready-target short-circuit
returns `already-ready image-N` and exits 0.

That is a real gap in self-healing, not a documentation problem, and it is
recorded as a known limitation. The repair procedure is in
[operations.md](operations.md#repair-a-corrupted-published-image): verify the
damage, remove the whole published directory, then re-import. Checking tree
integrity is `verify_pyramid.py`'s job, not `.ready`'s.

`scripts/crash_recovery_test.py` kills the importer at nine different moments and
asserts, after each kill, that no published directory lacks `.ready`, that the
registry never adopts partial data, that a previously-ready image is undamaged,
and that a rerun recovers to a byte-complete pyramid.

### Quarantine naming and retention

Every quarantine name ends in a Unix epoch in seconds, so a lexicographic sort is
chronological. `import_vips.sh` prunes `.stale-tmp-*` beyond the newest
`STALE_TMP_KEEP` (default 2, overridable with `ULTRASTILE_STALE_TMP_KEEP`) and
reports how much it reclaimed. The reason is scale: a partial pyramid at
evaluation size is tens of gigabytes, so repeated crashed imports would otherwise
fill the volume with quarantined staging that nothing reclaims. It also reports
the space held by quarantined staging before it starts, since that silently
reduces the room available for the current import.

`.stale-<id>-*` is never pruned automatically. That content sat at the published
path and may be an image an operator wants. Removing it is a deliberate act.

## Registry discovery

`ImageRegistry` takes a snapshot per call. `list()` walks the data root, skips
anything starting with `.tmp-` or `.stale-`, skips non-directories, validates each
remaining numeric directory, and sorts by ID. `get(id)` resolves
`base/Integer.toString(id)`, requires a directory plus a regular `.ready` file,
then validates the metadata.

There is no cache and no in-memory index, so importing a new image takes effect on
the very next request with no server restart. The cost is a `readdir` plus one
bounded metadata read per call, which is irrelevant next to serving tiles.

Startup repair lives in `ImageRegistry.ensureStartup(base)`: quarantine every
numeric directory missing `.ready`, then ensure demos 0 and 1 per-ID. Demo repair
is also per-ID, so a corrupt demo 0 does not disturb a valid demo 1, and custom
IDs such as 7 are left completely alone.

## Edge padding

`dzsave` clips the right and bottom edges of each level, so an edge tile can come
out short. Both importers pad it back to 512x512 with solid black, content at the
top-left:

- The shell importer runs `vips embed <tile> <tile>.pad.jpg 0 0 512 512 --extend black`
  and moves the result over the original, re-encoding at Q85. It probes only the
  tiles that can differ, namely the last column and the last row, and does so with
  batched `vipsheader` calls (one process for many files) rather than one process
  per tile. Interior tiles are 512x512 by construction and are never probed.
- The Java synthetic and ImageIO paths fill the whole tile black with `Graphics2D`
  before drawing content into the top-left `aw x ah` region.

Degenerate levels need no special case. When a level is 1xN, Nx1, or 1x1, every
tile satisfies `tx == cols-1 || ty == rows-1`, so the probe naturally covers all
of them, including the single-tile overview level whose content is smaller than
512 in both axes.

Because the pad is JPEG-encoded at Q85 rather than stored as raw black, it is
visually black but not numerically zero: the 8x8 DCT block straddling the
content/pad boundary rings. `verify_pyramid.py` therefore asserts a step at the
right offset rather than exact zero, specifically that the **mean** luminance of
the pad region is under 2.0 of 255 while the content immediately left of or above
the pad is not black. That catches a pad applied to the wrong side, at the wrong
width, or not at all, without failing on correct output. An exact-zero assertion
was tried first and produced 30 false failures on a correct pyramid.

Individual pad pixels do ring higher than the mean. Measured on image 6 across 280
edge tiles, the worst single pad pixel is 23.33 of 255 with a median of 13.33,
which is ringing confined to the boundary block. A mean-based assertion is what
distinguishes a correct pad from a missing one; a peak-based one would fail on
correct output.

## JPEG output

Both importers write Q85. `IngestTool.writeJpeg()` sets
`MODE_EXPLICIT` with `JPEG_QUALITY / 100.0f`, and the shell importer encodes with
the `[Q=85]` suffix. Measured on the three real ESO pyramids:

| Image | Source | Tiles | Pyramid on disk | Mean tile | Median | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 248 MB | 409 | 50 MB | 119 KB | 128 KB | 154 KB |
| 5 | 1.65 GB | 2,470 | 349 MB | 138 KB | 146 KB | 172 KB |
| 6 | 4.21 GB | 6,270 | 902 MB | 140 KB | 147 KB | 173 KB |

The synthetic demos compress far harder, around 15 to 16 KB per tile, because
their content is a smooth gradient. That difference is why a synthetic pyramid is
a poor stand-in for a real one when the question is payload size or network
behaviour. See [testing.md](testing.md).

The three real sources are the same mosaic at three downsample factors, all
loading through libvips' streaming `tiffload`, and all LZW-compressed (TIFF
compression tag 5, 8 bits/sample, 3 bands). Their pyramids came out at 22 to 25 %
of raw RGB (0.23 GB to 50 MB, 1.41 GB to 349 MB, 3.62 GB to 902 MB), and the
sources themselves at 110 to 117 % of raw RGB, because LZW expands noise rather
than compressing it.

Those ratios describe these three inputs. They are not a planning rule: pyramid
size depends on dimensions, content entropy, source encoding, channels, and bit
depth, and a compressed source can yield a pyramid larger than the original file.
Never plan disk from a source file size alone.

## Why the server never needs the source

Serving touches only `<data root>/<id>/level-<z>/<x>_<y>.jpg` plus `meta.json`.
`PyramidTileStore.servePath()` builds that path and nothing else. The original
TIFF is not opened, indexed, or stat-ed after import, and it may be deleted or
moved without affecting the server.

The practical consequence is the memory story in
[concurrency-and-memory.md](concurrency-and-memory.md): because serving is a
streamed read of one tile at a time, nothing in the serving path scales with
source size, image dimensions, or the number of distinct tiles already served.

## Worked example: 40000 x 30131

Every number below was produced by running the shipped
`PyramidTileStore` methods and cross-checked against the published pyramid in
`data/images/6`.

```text
max(W, H)                = 40000
N = max level            = 7        (512 -> 1024 -> ... -> 40000)
levels                   = 8
pixels                   = 1,205,240,000
representable            = yes      (79 and 59 tiles per axis, both under 65536)
```

| z | level px | cols x rows | tiles |
| ---: | --- | --- | ---: |
| 0 | 313 x 236 | 1 x 1 | 1 |
| 1 | 625 x 471 | 2 x 1 | 2 |
| 2 | 1250 x 942 | 3 x 2 | 6 |
| 3 | 2500 x 1884 | 5 x 4 | 20 |
| 4 | 5000 x 3767 | 10 x 8 | 80 |
| 5 | 10000 x 7533 | 20 x 15 | 300 |
| 6 | 20000 x 15066 | 40 x 30 | 1200 |
| 7 | 40000 x 30131 | 79 x 59 | 4661 |
| | | **total** | **6270** |

The file count under `data/images/6` is 6270, matching the table.
`PyramidLimitTest.planMatchesTheShippedTestImages()` pins levels 8, finest 79x59,
pixels 1,205,240,000, and total 6270.

Note z=0: 313 x 236 pixels of content, one grid cell, stored as a padded 512x512
JPEG. "One tile" is a grid fact, not a claim that the level is one pixel.

The other two real images, for scale: 25000 x 18832 gives 7 levels, finest 49x37,
2470 tiles; 10000 x 7533 gives 6 levels, finest 20x15, 409 tiles.

## The representability boundary

An image is addressable when `ceil(dim / 512) <= 65536` on each axis. That gives
33,554,432 px per axis, and it is derived rather than chosen:

```text
max tile coordinate (inclusive) = 65535   UtpMessages.MAX_TILE_COORD, a policy bound
max tiles per axis              = 65536   = MAX_TILE_COORD + 1
tile size                       = 512     Config.TILE_SIZE
max representable dimension     = 33554432 px   UtpMessages.maxRepresentableDim()
```

Past that, some tile of the finest level could not be named on the wire, so the
image is unservable regardless of how it is stored. The value lives in exactly one
place, `UtpMessages.maxRepresentableDim()`, and `PyramidTileStore.MAX_REPRESENTABLE_DIM`
delegates to it rather than restating a literal.

There is no other dimension ceiling. An earlier `MAX_DIM = 262144` in `Config` was
removed: it had no derivation, it allowed only 512 tiles per axis where the
protocol addresses 65,536, and it silently rejected valid images in both the
importer and the registry. `PyramidLimitTest.oldCeilingIsNowAnOrdinaryImage()`
now asserts that 262144 x 262144 is an ordinary, acceptable image of 349,525 tiles,
and `check_const_parity.py` fails the build if the literal reappears in `Config`,
`UtpMessages`, or the non-comment lines of `import_vips.sh`.

Representability is not the same as importability. A 33,554,432 square is
representable and would need 5,726,623,061 tiles, which the operational tile cap
of 16,777,216 declines. Two limits, two different reasons, two different
messages. See
[configuration-and-limits.md](configuration-and-limits.md#the-three-limits-people-conflate).
