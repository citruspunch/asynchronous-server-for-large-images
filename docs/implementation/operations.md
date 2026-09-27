# Operations

> This document describes how to run UltraTile today. Every command here was
> checked against the current code. Where a command's behavior is not obvious
> from the flags, it is explained.
>
> The implementation is authoritative where this document is stale. For
> evaluator-scale images, [`docs/grading-preflight.md`](../grading-preflight.md) is
> the procedure; for what the system does internally, start at
> [README.md](README.md).

## Prerequisites

Required at runtime, on any machine that serves or builds:

| Tool | Why | Required? |
| --- | --- | --- |
| JDK 21 | Build and run the server | yes |
| `bash`, `find`, `cp`, `rm`, `mkdir`, `jar` | `build.sh` | yes |
| A browser | The viewer | yes |

Optional, and only for specific tasks:

| Tool | Needed for | Notes |
| --- | --- | --- |
| `libvips` (`vips`, `vipsheader`) | Importing any real image | Keg-only in Homebrew |
| `python3` | The validation probes | stdlib only |
| Node | `scripts/test_viewer.cjs` | no dependencies |
| Maven with a primed `~/.m2` | `mvn -o test` | never needed to build or run |
| `curl` or similar | Ad-hoc HTTP probing | not required by anything |

libvips on macOS with Homebrew:

```sh
export PATH="/opt/homebrew/opt/vips/bin:$PATH"
vips --version
```

## Build

```sh
./build.sh
```

Produces `target/ultratile-1.0.jar`. It is a full clean of `target/classes`, then
`javac --release 21`, then a copy of the resources, then `jar` with
`com.ultratile.Main` as the main class. The jar is self-contained: the viewer is
served from inside it.

There is no dependency resolution, no network access, and no Maven. If the build
fails, the failure is in the source.

## Run

```sh
java -jar target/ultratile-1.0.jar
```

Then open <http://localhost:8080/>.

Options, in either order:

```sh
java -jar target/ultratile-1.0.jar --bind 0.0.0.0
java -jar target/ultratile-1.0.jar --data-root /Volumes/SSD/pyr
java -jar target/ultratile-1.0.jar --bind 0.0.0.0 --data-root /Volumes/SSD/pyr
```

| Option | Default | Notes |
| --- | --- | --- |
| `--bind <addr>` | `127.0.0.1` | `0.0.0.0` opts into a trusted LAN. There is no authentication, so think before using it beyond one. |
| `--data-root <dir>` | `data/images` | Where pyramids live. Created if absent. |

An unknown flag, a missing value, or an empty value prints the usage line and
exits 2. Nothing silently falls back to a default, because a mistyped
`--data-root` would publish a pyramid where the server is not looking.

The port is **not** an option. It is `Config.PORT`, currently 8080. To use another
port, change the constant and rebuild.

There is no log file. The server logs to stderr through `java.util.logging`, and
`FINE` is off by default, so a normal run is close to silent. To see the routing
and protocol chatter you need a logging config file, because `java.util.logging`
has no system property for the root logger level (setting only
`ConsoleHandler.level` leaves the logger filtering the records out):

```sh
cat > /tmp/ultratile-logging.properties <<'EOF'
handlers=java.util.logging.ConsoleHandler
.level=INFO
java.util.logging.ConsoleHandler.level=FINE
java.util.logging.ConsoleHandler.formatter=java.util.logging.SimpleFormatter
com.ultratile.level=FINE
EOF

java -Djava.util.logging.config.file=/tmp/ultratile-logging.properties \
     -jar target/ultratile-1.0.jar
```

Verified: this prints `FINE: GET /healthz` and similar per-request lines.

## Startup behavior

The server does not accept connections until the data root is prepared. On a cold
root that means generating two demo pyramids first:

- image 0, 2048x2048, 21 tiles
- image 1, 4096x4096, 85 tiles

`data/images/` is gitignored in its entirety, so the first run on a fresh clone
regenerates them. It takes a moment and needs no arguments.

Also at startup: any numeric directory without `.ready` is quarantined to
`.stale-<id>-<epoch>/`. A demo that exists and is ready but whose metadata does not
validate is quarantined to `.stale-invalid-<id>-<epoch>/` and regenerated. Custom
IDs are never touched by demo ensure.

## Check it is up

```sh
curl -sS http://localhost:8080/healthz; echo
```

`200` with body `OK` means **both** demo 0 and demo 1 resolve. Anything else is
`503` with body `not ready`. Note this is a demo-readiness probe: a server
serving only real images would answer 503. For a general liveness check, use the
image list instead.

```sh
curl -sS http://localhost:8080/api/images | python3 -m json.tool
curl -sS http://localhost:8080/api/images/6/info | python3 -m json.tool
```

If you have no curl, the same two requests work from a browser address bar.

## Import an image

### With libvips, for anything real

Inspect first. `vipsheader` reads image metadata without materializing the full
decoded raster, so with the expected native loader this is normally cheap
compared with the import itself. (It is not guaranteed to be cheap for every
format; a loader that has to work hard to produce a header will show up as a slow
command.) Note the field name is `vips-loader`; `-f loader` does not exist and
exits non-zero with `field "loader" not found`.

```sh
export PATH="/opt/homebrew/opt/vips/bin:$PATH"

vipsheader -f width       big.tif    # 40000
vipsheader -f height      big.tif    # 30131
vipsheader -f bands       big.tif    # 3
vipsheader -f vips-loader big.tif    # tiffload
vipsheader big.tif        # one-line summary: size, format, bands, coding, loader
```

Pick an unused ID in `0..65535`. Canonical decimal only: `7` is fine, `07` is
refused.

```sh
scripts/import_vips.sh big.tif 7
```

The script prints a feasibility line and a space check before it starts:

```text
feasibility: 40000x30131  pixels=1205240000  levels=8  finest=79x59 tiles  total_tiles=6270
  note: 0 KiB held by quarantined staging from earlier runs (pruned after this import)
space floor ok: need >= 25626 KiB, 65524568 KiB available on /path (for data/images)
```

followed, on success:

```text
imported image-7 (40000x30131, 8 levels)
```

If the target is already ready it prints `already-ready image-7` and exits 0
without touching anything.

### Onto an external volume

At evaluation scale the source and the pyramid both need space, and the pyramid is
the thing that persists. Point both the importer and the server at the same root:

```sh
scripts/import_vips.sh --data-root /Volumes/SSD/pyr big.tif 7
java -jar target/ultratile-1.0.jar --data-root /Volumes/SSD/pyr
```

Two details that matter. The defaults must agree, or the import publishes
somewhere the server does not look, and `check_const_parity.py` asserts the
defaults are the identical string. And the atomic rename still works, because
staging and target are always siblings under one root.

Note that only the shell importer takes `--data-root` on the command line. The
Java `IngestTool` CLI always uses the default root, so the external-volume
workflow is a libvips workflow today.

### Small images through the Java fallback

```sh
java -cp target/classes com.ultratile.tiles.IngestTool --image small.png 8
```

Refused unless the image is at most 8192 px on each axis **and** at most 16
megapixels, checked from the header before anything is decoded. Above that it
prints `too large for ImageIO fallback — use import_vips.sh: WxH` and exits 2.

### Synthetic

```sh
java -cp target/classes com.ultratile.tiles.IngestTool 8 1024 768
```

Generates a deterministic gradient. Useful for exercising the geometry quickly;
not representative of real content (see [testing.md](testing.md#why-a-synthetic-pyramid-is-not-a-substitute)).

## Monitor a long import

```sh
# In another terminal: watch the staging tree grow and the level count.
watch -n 5 'du -sh data/images/.tmp-7 2>/dev/null; ls data/images/.tmp-7 2>/dev/null | wc -l'
```

Or once, without watching:

```sh
du -sh data/images/.tmp-7
ls -1 data/images/.tmp-7
find data/images/.tmp-7 -name '*.jpg' | wc -l
df -h data/images
```

What to expect. `dzsave` is the fast phase; the image work is seconds even on
multi-gigapixel input. The slow phases are the post-pad pass and the two
validation passes, both of which probe with batched `vipsheader` calls. The batch
size matters enormously here: the original unbatched form spawned four
`vipsheader` processes per tile at about 63 ms each, which is roughly 24 hours
for a 350,000-tile pyramid.

A killed import leaves `.tmp-7/` behind. That is by design, and it is never
reachable by the registry. The next import of that ID quarantines it to
`.stale-tmp-7-<epoch>/`, and quarantined staging beyond the newest
`STALE_TMP_KEEP` (default 2) is reclaimed afterwards.

## Verify a successful publication

```sh
ls -la data/images/7/ | head                 # .ready and meta.json must both exist
cat data/images/7/meta.json                  # id, name, w, h, levels, tile
find data/images/7 -name '*.jpg' | wc -l     # must equal levelsDetail summed
curl -sS http://localhost:8080/api/images/7/info | python3 -m json.tool
```

What `.ready` proves, exactly: that the importer finished validating the staged
tree before publishing it. Because it is written inside staging and the directory
appears at the published path in one atomic rename, a published directory with
`.ready` was published as a validated whole.

What it does NOT prove: that the files are still intact now. `.ready` is a
publication marker, not a checksum and not a live integrity record. The registry
re-reads `meta.json` and checks for `.ready` on every request; it does not walk
the tile tree. So if you delete tiles by hand and leave `.ready` and `meta.json`
in place, the registry keeps serving that image and requests for the missing tiles
come back as END `skipped`.

The count above is therefore the check that matters, not `.ready`. For a real
integrity check use `verify_pyramid.py` (libvips required):

```sh
python3 scripts/verify_pyramid.py 7
```

That script has a hardcoded source map for images 4, 5, and 6. For another ID it
reports `no source mapped` and stops, so it is only useful for the ESO ladder
unless you edit its `SRC` table.

## Inspect disk usage

```sh
du -sh data/images
du -sh data/images/*
du -sh data/sources

# Per-level tile counts and byte totals for one image.
du -sh data/images/6/level-*
ls -1 data/images/6/level-7 | wc -l

# Quarantined content, which is real disk you may want back.
du -sh data/images/.stale-* 2>/dev/null
```

`.stale-tmp-*` is safe to delete: it is quarantined staging that by construction
was never published. `.stale-<id>-*` and `.stale-invalid-<id>-*` are **not**
obviously safe to delete. That content sat at the published path, so it may be an
image you wanted. The importer never prunes those, on purpose.

## Remove generated images

Safe to delete, regenerated at the next startup:

```sh
rm -rf data/images/0        # demo, 2048x2048
rm -rf data/images/1        # demo, 4096x4096
rm -rf data/images/*        # everything, including images 4, 5, 6
```

What is **not** safe to delete:

```sh
rm -rf data/sources         # THE ONLY COPY of the ESO TIFFs
rm -rf data/images/4/level-7    # a partial pyramid under a ready directory
```

Two rules worth internalizing, and the first one is a trap. A partially deleted
pyramid under a ready directory is **not** invisible: the registry only checks for
`.ready` plus valid `meta.json`, so it keeps listing the image and serving it, and
the missing tiles surface as END `skipped`. And re-running the importer against
that same ID will **not** repair it, because a ready target short-circuits to
`already-ready image-N` and exits 0. Deleting part of a pyramid puts you in a
state neither the importer nor the registry will fix for you; use the repair
procedure below.

The pyramid under `data/images/4|5|6` is a few minutes of import time to rebuild
from `data/sources/`, so replacing it is recoverable. Deleting `data/sources/` is
not.

If you want to reclaim quarantine space safely:

```sh
du -sh data/images/.stale-tmp-*        # safe to delete
rm -rf data/images/.stale-tmp-*
```

## Recover from a crashed or interrupted import

Nothing to do, in most cases. Re-run the same import:

```sh
scripts/import_vips.sh big.tif 7
```

It will quarantine any leftover `.tmp-7/` to `.stale-tmp-7-<epoch>/`, quarantine a
non-ready `7/` to `.stale-7-<epoch>/`, rebuild, validate, and publish. A
previously-ready image is never damaged, because a ready target short-circuits
before anything else happens.

## Repair a corrupted published image

This is a different situation from a crashed import, and it needs a different
procedure. The trigger is a published image whose tiles are missing or wrong while
`.ready` is still present, whether from a manual `rm`, a failed copy, or a disk
problem.

Do **not** just re-run the import. It will report `already-ready` and change
nothing, because `.ready` is still there.

```sh
# 1. Confirm the damage rather than assuming it.
find data/images/7 -name '*.jpg' | wc -l          # compare with levelsDetail
python3 scripts/verify_pyramid.py 7               # 0 if libvips is available

# 2. Remove the WHOLE published directory so the ready marker goes with it.
#    Quarantine rather than delete if you want to inspect it afterwards.
mv data/images/7 "data/images/.stale-7-corrupt-$(date +%s)"

# 3. Re-import from the source.
scripts/import_vips.sh data/sources/big.tif 7
```

If a published directory lost its `.ready`, the next startup quarantines it to
`.stale-<id>-<epoch>/` and, for the demo IDs, regenerates it. Do not `touch` the
marker back into place: that would assert a validation that did not happen.

## Staging and quarantine reference

| Path | Meaning | Registry sees it? | Safe to delete? |
| --- | --- | --- | --- |
| `<root>/<id>/` | published image | yes, if `.ready` and valid | only if you re-import |
| `<root>/.tmp-<id>/` | import in progress or interrupted | no | yes |
| `<root>/.stale-tmp-<id>-<epoch>/` | quarantined staging | no | yes |
| `<root>/.stale-<id>-<epoch>/` | a non-ready directory that sat at the published path | no | think first |
| `<root>/.stale-invalid-<id>-<epoch>/` | a ready demo whose metadata did not validate | no | think first |

The registry skips any entry starting with `.tmp-` or `.stale-`, and any
non-numeric name, so none of these can ever be served.

## External-disk workflow, end to end

```sh
export PATH="/opt/homebrew/opt/vips/bin:$PATH"
ROOT=/Volumes/SSD/ultratile

mkdir -p "$ROOT"

# Put the source somewhere with room, then inspect and import.
cp /path/to/big.tif "$ROOT/big.tif"
vipsheader -f width "$ROOT/big.tif"
df -h "$ROOT"
scripts/import_vips.sh --data-root "$ROOT/pyr" "$ROOT/big.tif" 7

# Start the server against the same root.
java -jar target/ultratile-1.0.jar --data-root "$ROOT/pyr"

# Confirm it sees the image.
curl -sS http://localhost:8080/api/images
```

Two things the demos need. `ensureStartup` runs against whatever root you pass, so
demos 0 and 1 are generated there too, on first start, which needs room for about
2 MB. And the data root must be the same string for the importer and the server,
which is why the flag is passed to both rather than to one.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `healthz` returns 503 | demos 0 or 1 missing or invalid | check `ls data/images/0 data/images/1`; they regenerate at startup |
| Connection refused right after launch | the server is still generating demos | wait; watch stderr |
| `invalid id (leading zeros rejected): 07` | non-canonical ID | use `7` |
| `too large for ImageIO fallback` | over 8192 px or 16 MP | use `import_vips.sh` |
| `unsupported loader or unreadable file` | `vipsheader` could not read the header | check the file, check the extension against the content |
| `insufficient space on target volume` | disk floor exceeded | free space, or use a bigger `--data-root` |
| `tile grid exceeds protocol coordinate range` | past 33,554,432 px on an axis | the image cannot be addressed on the wire at all |
| `pyramid tile count ... exceeds operational limit` | past 16,777,216 tiles (2^24) | raise `IMPORT_MAX_TILES` in `Config.java` **and** `import_vips.sh` **and** `check_const_parity.py`, or use a smaller image |
| Server 404s an image just imported | the roots differ | compare `--data-root` against the importer's |
| Browser shows tiles then goes blank on switch | expected; the cache is cleared and refilled | not a fault |
| `TileMathTest.noTilePrefixLiteralsOutsideStore` fails | a `level-` string crept into another Java file | move the path building back into `PyramidTileStore` |
| Parity failure after editing a constant | the copies disagree | see [testing.md](testing.md#parity-is-a-test-not-a-style-choice) |
