# Image import

> This document describes the current importer behavior. The implementation is
> authoritative if this document becomes stale: `scripts/import_vips.sh` and
> `com.ultratile.tiles.IngestTool` are the only import paths that exist.
>
> For the storage layout these paths produce see
> [tile-pyramid-and-storage.md](tile-pyramid-and-storage.md).

## Three paths, one publish protocol

| Path | Command | Scales past RAM | Use it for |
| --- | --- | --- | --- |
| libvips | `scripts/import_vips.sh [--data-root DIR] <src> <id>` | yes | Anything real. This is the production path. |
| ImageIO fallback | `IngestTool --image <file> <id>` | no | Convenience for small images. Capped and deliberate. |
| Synthetic | `IngestTool <id> <w> <h>` | no | Tests, and the two startup demos. |

All three end identically: stage under `.tmp-<id>/`, validate the staged tree,
write `meta.json` and `.ready`, atomically rename into `<data root>/<id>/`. The
only difference is how the tiles are produced and which admission checks apply
before any work starts.

All three reject a non-canonical ID first, before touching any path. `01`, `0001`,
`-1`, `70000`, and `../0` are all refused with exit 2.

## The libvips path

```sh
scripts/import_vips.sh [--data-root <dir>] <src> <id>
```

libvips is keg-only in Homebrew, so the binaries may not be on `PATH`:

```sh
export PATH="/opt/homebrew/opt/vips/bin:$PATH"
```

### Order of operations

The script refuses cheaply before it spends anything expensive. That ordering is
the reason a 40 gigapixel candidate is rejected in under a second instead of after
hours.

**1. Argument and ID gate.** Parses `--data-root` first, then two positionals.
Refuses an unknown option, a wrong positional count, a non-decimal ID, a
leading-zero ID, or an ID above 65535.

**2. Tool and file preconditions.** `vips` and `vipsheader` must both be on
`PATH`, and the source must be a regular file.

**3. Quarantine.** A ready target is a no-op. A leftover `.tmp-<id>/` becomes
`.stale-tmp-<id>-<epoch>/`. A non-ready `<id>/` becomes `.stale-<id>-<epoch>/`.

**4. The pre-dimension gate.** This is the step that makes the script safe to run
against a 100 GB file. `vipsheader -f width` and `-f height` read the image header
and nothing else. No pixel is decoded. A loader that cannot be detected surfaces
here as a non-zero exit with "unsupported loader or unreadable file".

That is the script's only loader detection: it does not enumerate loaders, it lets
`vipsheader` fail. It therefore cannot distinguish "no loader" from "a fallback
loader that will decode the whole image", which matters because a fallback loader
silently defeats the streaming property this path depends on. All three real ESO
sources report `tiffload`, which is streaming. Checking
`vipsheader -f vips-loader` yourself is worth doing on an unfamiliar format, and
[`docs/grading-preflight.md`](../grading-preflight.md) lists the streaming loaders
to expect (`tiffload`, `jpegload`, `pngload`, `webpload`) and treats a fallback as
a stop-and-convert condition.

**5. Representability.** `cols_finest = ceil(w / 512)` and
`rows_finest = ceil(h / 512)` must each be at most 65,536. The refusal message
names the coordinate bound and the derived pixel ceiling rather than saying
"too large".

**6. Shape and feasibility report.** Level count and per-level tile counts are
computed in bash's 64-bit signed arithmetic. Because the representability gate
already bounded `w` and `h` at 33,554,432, the largest intermediate is about
1.1e15 for pixels and 5.7e9 for tiles, both far inside the range, so no silent
overflow is possible past this point. The script prints one summary line:

```text
feasibility: 40000x30131  pixels=1205240000  levels=8  finest=79x59 tiles  total_tiles=6270
```

**7. Operational tile cap.** `total_tiles` must not exceed
`IMPORT_MAX_TILES = 16777216` (2^24), mirroring `Config.IMPORT_MAX_TILES`. The
refusal says which constant to raise if the intent is deliberate. See
[why 2^24](configuration-and-limits.md#why-the-tile-cap-is-224-and-not-larger)
for the measurement behind that value.

**8. Disk-space floor.** The script walks up to the nearest existing ancestor of
the data root (the root itself may not exist yet) and measures that filesystem
with `df -Pk`. It then requires

```text
total_tiles * 4096 bytes  <=  free space
```

4,096 bytes per tile is a deliberate **floor**, not an estimate. Q85 tile size is
content-dependent and cannot be predicted from the source file size, so the only
honest check refuses cases that cannot possibly fit. A `df` failure degrades to
"could not determine free space" and skips the check rather than aborting a valid
import under `set -e`. Before this, the script reports how much space is held by
quarantined staging from earlier crashed runs, since that reduces what is
available now.

**9. Encode.** One `dzsave` invocation:

```sh
vips dzsave "$src" "$tmp/pyr" --depth onetile --tile-size 512 --overlap 0 \
  --skip-blanks -1 --suffix '.jpg[Q=85]'
```

`--depth onetile` builds the pyramid down to one tile per axis, `--skip-blanks -1`
disables blank-tile skipping so the tile set is exactly what the level geometry
says, and `--overlap 0` means no overlap halos, which keeps the served tiles
byte-exact to the requested coordinates.

**10. Tree transform.** `dzsave` writes into `pyr_files/<N>/`, and there is a
`pyr.dzi` descriptor. The script renames each `pyr_files/<N>/` to `level-<N>/` and
deletes both leftovers. The move is chunked at 2000 files per process, because a
level can hold hundreds of thousands of files and an unbounded `mv` would exceed
`ARG_MAX`.

**11. Post-pad.** Every staged tile must end up 512x512. Only the last column and
the last row of each level can be short, so only those are probed, and they are
probed with batched `vipsheader` calls: `vipsheader -f width f1 f2 ... f400` prints
one value per file in argument order, so a whole edge row costs one process
instead of one per file. Short tiles are padded with
`vips embed ... 0 0 512 512 --extend black` into a `.pad.jpg` sibling which then
replaces the original.

The batching is not a micro-optimization. The original naive form spawned
`vipsheader` four times per tile at roughly 63 ms per spawn, which is about
250 ms of pure process startup per tile and roughly 24 hours for a 350,000-tile
pyramid, while the actual image work in `dzsave` was under a second.

**12. Validation.** Three independent passes over the staged tree:

- *Name set per level.* Expected names are generated from the level geometry and
  compared against the directory listing with two `sort`s and a `cmp`, so a
  mismatch reports specific missing and extra names instead of failing on a
  single `stat`. This is what proves there are no missing tiles and no unexpected
  ones.
- *Size gate.* One `find` over the whole tree rejects any zero-byte tile and any
  tile over 2,097,152 bytes, which is the same `MAX_TILE_BYTES` the server
  enforces at serve time.
- *Final edge geometry.* Edge tiles are probed again after padding; a still-short
  tile means the pad did not take effect, which is a hard failure.

**13. Metadata and publish.**

```sh
printf '{"id":%s,"name":"image-%s","w":%s,"h":%s,"levels":%s,"tile":512}' ... > "$tmp/meta.json"
touch "$tmp/.ready"
mv "$tmp" "$target"
```

**14. Prune.** Stale staging beyond `STALE_TMP_KEEP` (default 2) is reclaimed and
the reclaimed size is reported.

### Why this path can exceed RAM

libvips is a demand-driven, region-wise image library. Its `dzsave` reads the
source through a pipeline of demand-driven operations and writes each output tile
as it is produced. With a streaming native loader it does not materialize the full
decoded raster, which is the property this path exists for.

The intended property is precisely stated: the scalable path does not hold the
whole decoded raster in memory. It is not "memory is a constant", and it would be
wrong to document it that way. Peak RSS can still depend on the loader, strip or
tile geometry, image width, the pipeline operations used, libvips' cache
configuration (`VIPS_CONCURRENCY`, tile cache), and temporary working regions. A
pathologically wide image, or a format whose loader falls back to whole-image
decode, can still be memory-hungry.

The measured evidence is consistent with bounded, demand-driven behavior on the
three real images: peak RSS was 100 MB, 172 MB, and 252 MB against raw RGB of
0.23 GB, 1.41 GB, and 3.62 GB. The ratio falls as the image grows, which is what
you would expect if RSS tracks a working set rather than the full raster. That is
evidence, not a proof, and it is evidence about these inputs with `tiffload`.
`scripts/measure_import.py` records peak RSS per import under `/usr/bin/time` so
you can repeat it on your own input rather than trusting the numbers above.

The Java importers do the opposite and say so: `ImageIO`'s
`ImageReader.read(0)` returns one `BufferedImage` for the entire decoded image,
which is exactly why that path carries a hard cap.

### Portability constraint

The script must run under the bash 3.2 that macOS ships, so it uses no `mapfile`,
no `${var,,}`, and no associative arrays. Globals stand in for namerefs. Array
expansions use the `${a[@]+"${a[@]}"}` idiom because bash 3.2 under `set -u`
treats an empty array expansion as an unbound variable. The Python test harnesses
that drive it hardcode `/opt/homebrew/opt/vips/bin` for the same reason.

## The ImageIO fallback

```sh
java -cp target/classes com.ultratile.tiles.IngestTool --image <file> <id>
```

This exists so a small real image can be imported with nothing but a JDK. It is
intentionally bounded, and the bound is a memory limit rather than a
representability one.

The order inside `IngestTool.runImage()` matters:

1. Canonical-ID gate.
2. Ready-target no-op.
3. Open an `ImageInputStream`, get a reader, and read `getWidth(0)` and
   `getHeight(0)`. **Only the header.**
4. Refuse unless `max(w,h) <= IMPORT_IMAGE_MAX_DIM` (8192) **and**
   `(long) w * h <= IMPORT_IMAGE_MAX_PIXELS` (16,777,216).
5. Only now call `reader.read(0)`.

Step 4 before step 5 is the whole point. A 4097 x 4097 PNG is refused on its
header alone, before any raster is allocated, which
`TileMathTest.imageIoPixelCapOnly()` pins by writing a minimal header-only PNG
with no pixel data at all. A refused import writes no directory.

16 MP is an RGBA8 estimate of about 64 MiB, not a true worst case. Higher
bit-depth sources and downsampling working images allocate beyond the raw pixel
product, so the real figure is higher than 64 MiB. The constant is a policy
choice about when the convenience path stops being convenient.

The refusal message points at the right tool:

```text
too large for ImageIO fallback — use import_vips.sh: 40000x30131
```

When to use libvips instead: anything over 8192 px on an axis, anything over
16 MP, anything TIFF that ImageIO has no reader for, and anything at all where
memory is a concern. In practice, always, for real images.

### A gap worth knowing about

`IngestTool.main()` always resolves its base directory from
`PyramidTileStore.defaultRoot()`, so the Java CLI has **no** `--data-root` flag.
Importing into a custom root with the Java tool means calling
`IngestTool.runSynthetic(base, ...)` or `IngestTool.runImage(base, ...)` from
code, which is what the tests do. `scripts/import_vips.sh` does accept
`--data-root`, and the server accepts it, so the external-volume workflow is a
libvips-only workflow today. This is an asymmetry, not a design decision I can
justify from the code; it is listed in the discrepancies section of the report.

## The synthetic importer

```sh
java -cp target/classes com.ultratile.tiles.IngestTool <id> <w> <h>
```

It generates a deterministic gradient plus a 32-pixel checker texture
(`IngestTool.pixel()`), writes it level by level through the same
ceiling-pyramid geometry, and pads every tile black first so content lands
top-left. There is no source file at all.

It exists for two reasons. The server needs two images to exist at startup so the
viewer has something to open and `/healthz` has something to report on, and the
test suite needs a fast, dependency-free way to produce a real pyramid on disk.

What it proves: the geometry is right, the naming is right, the padding is right,
the metadata is right, the publish sequence is right, the size gate is right, and
the registry accepts the result. `TileMathTest.noBlackBleed()` decodes an edge
tile and asserts both that the far corner is exactly black and that the
top-left content pixel is not.

What it does not prove: anything about real content. Because a smooth gradient
compresses to roughly 15 KB per tile, a synthetic pyramid tells you nothing about
the 120 to 175 KB per tile that photographic content produces at the same Q85
setting. It is also not a test of any decoder, since the browser receives the
same well-formed JPEGs either way.

Memory: one `BufferedImage` of 512x512 `TYPE_INT_RGB` at a time, roughly 1 MiB,
released per tile. It scales with tile size, not with image size. Generating a
33,554,432 square this way is refused by the tile cap before any work starts.

## The real test files

`data/sources/` holds the ESO Milky Way survey TIFFs. They are inputs, not
generated assets. They are gitignored, they are the only irreplaceable copy of
that data, and no test modifies or deletes them. The repository comment in
`.gitignore` says it directly: keep this tree clear of `rm -rf data/images/*`.

Dimensions were read with `vipsheader` and are all 3-band 8-bit
(`VIPS_FORMAT_UCHAR`) TIFFs, loaded through `tiffload`, which is a streaming
loader rather than a whole-image fallback. All three are LZW-compressed (TIFF
compression tag 5), 8 bits per sample, 3 samples per pixel, RGB photometric
interpretation. LZW *expands* this noisy photographic content, which is why each
source is slightly larger than its own raw RGB.

Do not read `VIPS_CODING_NONE` as "uncompressed". It is libvips' pixel *coding*
after load (the band format is plain 8-bit uchar, with no band-coding
interpretation applied), and it says nothing about how the file on disk is
compressed. To learn the container compression, read the first
`Compression Scheme:` line of `tiffinfo file.tif` (this libtiff build rejects
`tiffinfo -k 259`), or parse tag 259 out of the IFD directly.

| File | Size | Dimensions | Intended image ID | Pyramid |
| --- | ---: | --- | ---: | --- |
| `eso_milky_way_248MB.tif` | 247,623,888 B | 10000 x 7533 | 4 | 6 levels, 409 tiles |
| `eso_milky_way_1.65GB.tif` | 1,647,002,712 B | 25000 x 18832 | 5 | 7 levels, 2470 tiles |
| `eso_milky_way_4.21GB.tif` | 4,212,364,900 B | 40000 x 30131 | 6 | 8 levels, 6270 tiles |

They are the same mosaic at three downsample factors, which makes the ladder a
clean scaling series rather than three unrelated pictures.

The ID convention is the one `verify_pyramid.py` and `measure_import.py` both
hardcode, and it is not enforced by any production code path. It exists so the
two harnesses can map an image ID back to its source. Images 4, 5, and 6 currently
exist under `data/images/`; 0 and 1 are the generated demos.

To add another image, pick an unused ID in `0..65535`, keep the name canonical,
and import it with the same staging and publish protocol. The registry will pick
it up on the next request without a restart.

## Importing today

```sh
# Inspect before committing to an import. This reads the header only.
export PATH="/opt/homebrew/opt/vips/bin:$PATH"
vipsheader -f width  data/sources/eso_milky_way_4.21GB.tif
vipsheader -f height data/sources/eso_milky_way_4.21GB.tif
vipsheader -f bands  data/sources/eso_milky_way_4.21GB.tif
vipsheader data/sources/eso_milky_way_4.21GB.tif      # summary, loader used

# Import. The script prints the feasibility line and the space floor.
scripts/import_vips.sh data/sources/eso_milky_way_4.21GB.tif 6

# Same import onto an external volume. The server must be started with the
# same --data-root or it will not see the pyramid.
scripts/import_vips.sh --data-root /Volumes/SSD/pyr big.tif 7
java -jar target/ultratile-1.0.jar --data-root /Volumes/SSD/pyr
```

More operational detail, including monitoring a long import and verifying
publication, is in [operations.md](operations.md). For the evaluator-scale
workflow, see [`docs/grading-preflight.md`](../grading-preflight.md).
