# Grading-image preflight

Everything to check the moment a real evaluator image becomes available. This is
the **single operational source** for the evaluator tiers; other documents link
here rather than restating them.

Written against measured behaviour of the three real ESO Milky Way TIFFs
(75 MP, 471 MP, 1.2 gigapixels), which are the same mosaic at three downsample
factors.

## Evaluator tiers

The evaluator images for this project are supplied separately and are expected at
these approximate source sizes:

| Tier | Source size (approx) |
| --- | ---: |
| 1 | 17 GB |
| 2 | 28 GB |
| 3 | 55 GB |
| 4 | 93 GB |

These figures are not in `project_instructions.md`; they come from separately
supplied evaluation information and are recorded here only. **No image in this
repository is an evaluator file.** The ESO sources in `data/sources/` and the
public VVV mosaic are reference inputs, not evaluation assets, and must not be
described as any tier.

### Provenance of `data/sources/`

The three ESO TIFFs are the **VVV public survey** mosaic of the central Milky
Way, from the VISTA telescope at ESO's Paranal Observatory, combined from
thousands of exposures through three infrared filters. The full mosaic is
**108,200 x 81,500 pixels (8.8 gigapixels)**; the three files here are
downsample factors of it, at ÷10.82, ÷4.33 and ÷2.705 respectively. All three
are LZW-compressed, 8-bit, 3-band, single-plane TIFFs written by Adobe Photoshop
CS6 on Windows, at 72 pixels/inch.

This is **published survey data, not a unique capture**, so the files can be
re-obtained from ESO if they are ever reclaimed under disk pressure. That is why
the `data/sources/` policy in `AGENTS.md` is ordered and conditional rather than
an absolute ban. It is also why these files are reference inputs and must never
be described as an evaluator tier.

**Do not infer dimensions from file size.** A 28 GB file could be 26 gigapixels of
near-lossless TIFF or 300 gigapixels of heavily compressed JPEG. Always read the
header. Equally, do not infer pyramid size from file size: see
[Disk planning](#2-disk-planning) below.

## 0. Prerequisites

```sh
export PATH="/opt/homebrew/opt/vips/bin:$PATH"   # libvips is keg-only on Homebrew
vips --version
df -h /Volumes/<ssd>                            # target volume must exist
cd <repo> && ./build.sh
```

## 1. Inspect before importing anything

```sh
SRC=/path/to/evaluator.tif
stat -f %z "$SRC"                                  # SOURCE BYTES (see caveat below)
vipsheader -f width "$SRC"                          # DIMENSIONS
vipsheader -f height "$SRC"
vipsheader -f bands "$SRC"
vipsheader -f vips-loader "$SRC"                   # LOADER: must be streaming
vipsheader "$SRC"                                   # one-line summary
tiffinfo "$SRC" | grep -i compression  # TIFF container compression, if TIFF
```

The libtiff build in use here does not accept `tiffinfo -k <tag>` (it reports
`illegal option -- k`), so read the compression from the plain `tiffinfo` output
instead. On the three ESO sources the first `Compression Scheme:` line is `LZW`
and a trailing `None` appears per strip; the file-level value is the first one.
The same answer, tag 259 = 5, is readable directly from the IFD if you prefer not
to depend on `tiffinfo` at all.

The field name is `vips-loader`. `vipsheader -f loader` does not exist and exits
non-zero with `field "loader" not found`. `vipsheader` inspects image metadata
without materializing the full decoded raster; with the expected native loader
this is normally cheap compared with the import itself, though it is not
guaranteed cheap for every format.

Do not confuse `vipsheader -f coding` with the file's compression. Coding
describes libvips' post-load pixel interpretation; the container compression is
the TIFF compression tag, read with `tiffinfo` or by parsing the IFD.

Gate before proceeding:

| Check | Requirement | Why |
| --- | --- | --- |
| `vips-loader` | `tiffload` / `jpegload` / `pngload` / `webpload` | a fallback loader means whole-image decode |
| `width`,`height` ≤ 33,554,432 | each axis | protocol representability |
| `ceil(w/512)`, `ceil(h/512)` ≤ 65,536 | per axis | same thing, stated in tiles |
| `w`,`h` ≥ 1 | positive | `checkRepresentable` |
| bands | 3 or 4 (or 1 with expansion) | `FORMAT_JPEG` only; band count is not on the wire |
| free space on target | see [Disk planning](#2-disk-planning) | source bytes do not predict pyramid bytes |
| free space on target | headroom for quarantined staging | bounded but not zero |

Predict the pyramid before importing (this is what the importer prints anyway):

```
levels      = 1 + ceil(log2(max(w,h) / 512))
finest grid = ceil(levelW/512) x ceil(levelH/512)   at level index levels-1
total tiles ≈ sum over levels of cols x rows  (≈ 4/3 x finest grid)
```

## 2. Disk planning

**Source file size does not predict JPEG pyramid size.** Pyramid size depends on
dimensions, content entropy, source encoding and compression, channel count, bit
depth, and pyramid overhead. A source that is already JPEG-compressed tells you
very little about what Q85 tiles will cost, and a heavily compressed source can
produce a pyramid LARGER than the original file.

Measured on the three ESO ladder inputs, for calibration only:

| Input | Raw RGB | Source bytes | Pyramid bytes | Pyramid / raw RGB | Source / raw RGB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10000 x 7533 | 0.23 GB | 248 MB | 50 MB | 22 % | 110 % |
| 25000 x 18832 | 1.41 GB | 1.65 GB | 349 MB | 25 % | 117 % |
| 40000 x 30131 | 3.62 GB | 4.21 GB | 902 MB | 25 % | 117 % |

Those sources are LZW-compressed TIFFs, and LZW *expands* this noisy
photographic content, so each source is larger than its own raw RGB. A different
source encoding will give different numbers in both directions.

The importer reports two tiers, because the floor alone is not enough:

- a hard **floor** of 4 KiB/tile, which refuses only what cannot possibly fit;
- a **planning figure** of 128 KiB/tile -- the measured real median -- which
  **warns** when headroom is thin and never refuses, since real content may
  compress far better or far worse.

The gap between the tiers is not academic. A 45,252-tile image "needs" 185 MB by
the floor, so the floor alone waves through an import whose real output is about
6 GB, which then dies of ENOSPC partway and leaves a quarantined `.stale-tmp-*`
tree behind. Treat the planning warning as the thing to act on.

### Peak usage is source PLUS pyramid, not either alone

`dzsave` reads the source while writing the pyramid, so both must be resident
simultaneously: **peak = source + pyramid ~ 1.21 x source** for this family.
That is what decides the order to upload tiers in. Against 67.2 GB free with
7.4 GB already held by this repository's own ladder:

| Scenario | source | pyramid | peak | % of free | verdict |
| --- | --- | --- | --- | --- | --- |
| 28 GB alone | 28.0 GB | 6.0 GB | **41.4 GB** | 62 % | fits, 25.8 GB spare |
| 17 GB then 28 GB, keeping both | 45.0 GB | 9.6 GB | **62.0 GB** | 92 % | fits on paper, **5.1 GB spare** |
| 28 GB at 96 GB raw (4x denser pixels) | 28.0 GB | 23.9 GB | 59.3 GB | 88 % | fits, 7.9 GB spare |
| 28 GB at 206 GB raw (protocol maximum) | 28.0 GB | 51.4 GB | 86.8 GB | 129 % | would not fit |

**Take the largest tier first, on its own.** In the keep-both ordering the
5.1 GB of spare room is *smaller than the 6.0 GB pyramid being built*, so that
order exhausts the volume mid-import. Doing the 28 GB alone leaves 25.8 GB
spare, roughly four times the pyramid it produces.

A 28 GB file cannot reach the last row: 206 GB of raw pixels would be a ~240 GB
file. So for a 28 GB tier, disk -- not the protocol and not any dimension limit
-- is the only thing that could refuse, and it does not.

If space does tighten, reclaim in this order, and never the sources:

```sh
du -sh data/images/.stale-tmp-*                  # quarantined staging: never published
rm -rf data/images/.stale-tmp-*
rm -rf data/images/4 data/images/5 data/images/6  # pyramids: regenerable from source
```

`data/sources/` holds the only copy of the ESO data. `verify_pyramid.py` reads
dimensions from those headers and `measure_import.py` re-imports from them, so
deleting them disables real-image validation even though the published pyramids
keep serving normally.

## 3. Import

Put the source and the pyramid where they have room. For the larger tiers the
source alone may need a volume separate from the repository, and the pyramid is
what persists afterwards:

```sh
bash scripts/import_vips.sh --data-root /Volumes/SSD/ultratile "$SRC" 10
```

The importer prints a feasibility line and enforces, each with its own reason:

```text
feasibility: 108200x81500  pixels=8818300000  levels=9  finest=212x160 tiles  total_tiles=45252
space floor ok: need >= 176766 KiB, ... available on /Volumes/SSD
```

Refusal vocabulary, each naming a real cause rather than a bare "too large":

| Message | Cause | Fix |
| --- | --- | --- |
| `tile grid exceeds protocol coordinate range` | > 65,536 tiles/axis | not servable; report to staff |
| `pyramid tile count N exceeds operational limit` | > 16,777,216 tiles (2^24) | raise `Config.IMPORT_MAX_TILES` + the shell copy + the two test pins |
| `insufficient space on target volume` | free space below the 4 KiB/tile floor | bigger volume |
| `filesystem cannot publish atomically` | target filesystem refuses `ATOMIC_MOVE` | staging and target must be siblings on one filesystem |
| `cannot read dimensions (unsupported loader…)` | no streaming loader | convert to TIFF/PNG |
| `invalid dimensions` | an axis < 1 | corrupt file |

## 4. Watch memory while importing

The property being checked is that the scalable path does not materialize the
whole decoded raster. Peak RSS can still depend on the loader, strip or tile
geometry, image width, the pipeline operations, and libvips' cache configuration.
Watch for RSS approaching the raw RGB size, which would mean something decoded
the whole image.

Measured reference points from the real ladder:

| Image | raw RGB | peak RSS | ratio |
| --- | --- | --- | --- |
| 10000x7533 | 0.23 GB | 100 MB | 46 % |
| 25000x18832 | 1.41 GB | 172 MB | 13 % |
| 40000x30131 | 3.62 GB | 252 MB | 7 % |

The falling ratio is evidence consistent with bounded, demand-driven processing,
not a proof, and it is specific to these inputs with `tiffload`.

```sh
# macOS: sample RSS during the import
while kill -0 $IMPORT_PID 2>/dev/null; do
  ps -o rss= -p $(pgrep -f 'vips dzsave') 2>/dev/null || break
  sleep 2
done | sort -n | tail -1
```

Linux: `/usr/bin/time -v bash scripts/import_vips.sh ...` and read
"Maximum resident set size".

## 5. Verify the pyramid

`.ready` records that the importer validated the staged tree before publishing.
It is not a checksum, and nothing re-checks the tile tree afterwards, so verify
integrity explicitly:

```sh
python3 scripts/verify_pyramid.py 10       # after adding the id to SRC in that script
```

Checks `.ready`, exact `meta.json`, exact level count, exact tile coordinate set
with no extras, every tile 512x512 including edges, edge pad black starting at
exactly the computed offset, valid JPEG decode, and seam continuity. Must report
`FAILURES: 0`.

Then record the real pyramid size for the next tier:

```sh
du -sh /Volumes/SSD/ultratile/10
```

## 6. Serve and test

```sh
java -jar target/ultratile-1.0.jar --data-root /Volumes/SSD/ultratile
curl -s localhost:8080/api/images
curl -s localhost:8080/api/images/10/info        # dimensions + levelsDetail

python3 scripts/real_pipeline_test.py --images 10 --clients 10 --seam
python3 scripts/e2e_utp.py                       # must print E2E-OK
python3 scripts/check_const_parity.py            # parity-ok
mvn -o -q test                                   # JUnit suite
node scripts/test_viewer.cjs                     # viewer suite, slow
```

`real_pipeline_test.py` covers corners + centre at three levels, exact END
accounting, generation supersession, image switching, and N concurrent clients.
`FAILURES: 0` is the bar. It tolerates stale-generation TILEs by design; see
[docs/implementation/known-limitations.md](implementation/known-limitations.md).

### Optional: cache workload evidence

Not required, and not a runtime dependency. If Node is available and the ESO
ladder is imported, this reproduces the LFUDA cache measurements on real tiles:

```sh
node scripts/cache_workload_benchmark.cjs        # ~5 min
```

It starts and stops the server itself, needs images 4, 5 and 6 published, and
prints `CACHE-BENCH-OK` plus a per-workload invariant list and decision
signature. A workload whose image is absent is skipped explicitly; a demo image
is never substituted for a ladder rung. It asserts invariants only, never byte
totals, because those move when a pyramid is rebuilt. See
[docs/implementation/cache-benchmark.md](implementation/cache-benchmark.md).

## 7. Manual viewer pass

No browser automation is available in this repo, so do these by hand:

- top-left, top-right, bottom-left, bottom-right, centre
- every zoom transition in both directions, watching for stale tiles
- switch images mid-flight; confirm no CURRENT-generation tile carries the
  previous image's identity. A stale frame from the old generation is allowed to
  arrive and must be discarded by the client, not never sent
- resize the window at full zoom, and watch the HUD `cache` and `lfuAge` fields.
  A 4K viewport does **not** need about 40 tiles: `effectiveLOD()` caps the union
  of visible tiles at `UNION_CAP = 36`, below `MAX_CACHE = 40`, so one viewport
  cannot overflow the cache and the largest single-viewport request measured on
  image 6 was 24 tiles at both 1920x1080 and 3840x2160. The cache does still
  reach 40 and still evicts, from history accumulated across epochs. See
  [docs/implementation/viewer.md](implementation/viewer.md#why-the-4k-viewport-is-not-actually-tight-any-more)

## 8. If it fails

| Symptom | First thing to check |
| --- | --- |
| image absent from `/api/images` | `meta.json` present? `.ready` present? server log WARNING names the reason |
| image listed but tiles never arrive | the published tree may be incomplete: `verify_pyramid.py`, then the repair procedure in [docs/implementation/operations.md](implementation/operations.md#repair-a-corrupted-published-image) |
| tiles 404 over WS | `data/images/<id>/level-Z/X_Y.jpg` on disk, 512x512, non-empty |
| import refuses unexpectedly | the exact refusal string, it names the limit that was hit |
| viewer shows black bands | edge pad; run `verify_pyramid.py` |
| import very slow | expect `post-pad` to dominate; it is `O(perimeter)` |
| disk fills during import | quarantined `.stale-tmp-*`; bounded to the newest 2, prune with `ULTRASTILE_STALE_TMP_KEEP` |
