---
phase: phase-02-tile-engine
goal: GOAL-002 Ceiling store plus validated import plus strict meta plus 106-tile demos
status: 'Historical'
parent: ./overview.md
version: 1.15
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 02 — Tile Engine ![Status: Historical](https://img.shields.io/badge/status-Historical-lightgrey)

> **Historical implementation plan.** The system has since been
> implemented and has evolved beyond what this file describes. It is preserved
> deliberately: it records the reasoning, the rejected alternatives, the
> sequencing, and the validation decisions, including assumptions that later
> turned out to be wrong. Statements here about what a phase "will" do, and any
> constant, path, or test count it names, are historical and may be superseded.
>
> - Current behavior: [`docs/implementation/README.md`](../../implementation/README.md)
> - Normative UTP behavior: [`docs/protocol/UTP-1.0.md`](../../protocol/UTP-1.0.md),
>   which wins over every other document
> - Unresolved constraints: [`docs/implementation/known-limitations.md`](../../implementation/known-limitations.md)
>
> Where this file disagrees with the code, the code is what ships.

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-001**: Progressive/selective 512x512 tiling (ceiling pyramid,
    post-padded edges, full-bitmap compositing with screen-space clear +
    clip); never full image.
  - **REQ-008**: dz/onetile + direct n→Z + post-pad +
    tmp/validate/`.ready`/atomic-rename (immutable after); import START
    recovers leftover `.tmp-<id>` (quarantine-or-remove, logged); CLI IDs
    decimal `0..65535` CANONICAL — `^[0-9]+$` plus NO leading zeros except
    `"0"` itself (`01`/`0001` → exit 2; every path uses the canonical
    decimal string); ready target → no-op; non-ready numeric dir →
    `.stale-<id>-<epoch>/` quarantine; ignore `.tmp-*`/`.stale-*`.
    - FROZEN canonical tile naming as a RELATIVE path:
      `tileRelativePath(z,x,y) = "level-<Z>/<X>_<Y>.jpg"` — ONE naming
      algorithm owned by the store, never bound to a root. Serving resolves
      `imageRoot(id).resolve(relative)`; ingest staging resolves
      `tmpRoot.resolve(relative)`; the atomic rename publishes the staged
      tree. (v1.10's final-root method could not be used by staging without
      bypassing it.)
    - Synthetic fallback bounded O(tile-size),
      crop-then-downsample-then-pad-output.
    - Bounded JDK `ImageIO` real-image mode (`--image <file> <id>` —
      convenience fallback ONLY: open an `ImageInputStream`, pick an
      `ImageReader`, inspect `getWidth(0)`/`getHeight(0)` BEFORE `read()`;
      refuse unless `max(w,h) <= IMPORT_IMAGE_MAX_DIM=8192` AND `(long)w*h
      <= IMPORT_IMAGE_MAX_PIXELS=16777216` with a "use vips" error — the
      bound is enforced pre-decode because `ImageReader.read` returns a
      complete `BufferedImage`; honest peak O(W×H) source memory bounded by
      the pixel cap, where the cap is an RGBA8 ESTIMATE (≈64 MiB pixels),
      not a true worst case).
    - Writers emit canonical `"name":"image-<id>"` (never interpolate
      source paths into JSON); missing demo IDs 0 and 1 ensured
      INDEPENDENTLY; DEMO-REPAIR: a demo 0/1 target with `.ready` but
      registry-INVALID metadata is quarantined to
      `.stale-invalid-<id>-<epoch>/` and regenerated (user imports stay
      immutable/no-op); trust `.ready` only.
  - Metadata: tiny STRICT hand parser for the exact generated schema,
    hard-bounded BEFORE parsing (`META_MAX_BYTES=16KiB` pre-read cap,
    `META_NAME_MAX=128`) — oversize → ignore + WARNING;
    malformed/inconsistent `.ready` metadata → ignore + WARNING (never
    500); `levels` must equal PAT-001 `levelCount(w,h)` AND `meta.id` must
    equal the numeric directory id (positional, never self-claimed) AND
    `meta.name` must equal `"image-"+id` AND the directory name itself must
    equal `Integer.toString(parsedId)` (so `data/images/01` can never
    validate as image 1).
  - **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))`
    min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches (`depth onetile` =
    pyramid down to one tile; `skip_blanks -1` disables blank skipping —
    validated post-generation, never assumed per libvips version).
    (2048 → N=2; 4096 → N=3.)
  - **PAT-001a (arithmetic width, load-bearing)**: tile-count and pixel
    products are `long`, never `int`. This is not defensive. At the derived
    representability ceiling (33,554,432 px/axis) the finest level alone holds
    65,536 × 65,536 = 2^32 tiles, which overflows a signed 32-bit int; the
    whole pyramid totals 5,726,623,061. `totalTiles` therefore returns `long`,
    and `cols`/`rows` do their `+TILE-1` rounding in `long` so the rounding
    step cannot wrap either. `PyramidTileStore.plan(w,h)` returns a
    `PyramidPlan(w, h, levels, finestCols, finestRows, pixels, totalTiles)`
    with every count widened — this is the object the importer reports before
    doing expensive work, and the object the tests assert against.
  - **PAT-001b (validation cost, measured on REAL images)**: full-pyramid
    validation is retained and is NOT the bottleneck. Measured end-to-end on
    the three real ESO imports:

    | | 409 tiles | 2,470 tiles | 6,270 tiles |
    | --- | --- | --- | --- |
    | `dzsave` + tree transform | 1 s | 6 s | 18 s |
    | post-pad pass | 5 s | 12 s | 19 s |
    | validation (names + size) | 1 s | 1 s | 2 s |

    The post-pad figure is **O(perimeter), not O(area)**: only genuinely short
    edge tiles are re-encoded — 66 / 171 / 272 of them (measured, `cols + rows
    − 1` per level) versus 409 / 2,470 / 6,270 tiles overall — at ~70 ms per
    `vips embed` process. Validation is ~50 µs of bash per tile (whole-directory
    scans measured at ~16 µs/file on APFS), so it stays in seconds. Correctness
    was NOT traded for speed; no strategy change was needed.
  - **PAT-001d (layout is adequate at grading scale, measured)**: one level is
    one directory (`level-Z/X_Y.jpg`). Benchmarked with 262,144 files in a single
    directory on APFS: `stat` 73 µs, `find` 4.1 s, `ls -U` 4.4 s, bash glob +
    name extract 4.0 s, `sort` 4.4 s, create 21 s, `rm -rf` 32 s. Nothing
    degrades non-linearly. The largest single directory in the real grading
    ladder is 4,661 tiles (image-6 finest level), two orders of magnitude below
    the benchmarked size, so the layout is kept — no sharding, no migration, no
    metadata change.
  - **PAT-001e (`IMPORT_MAX_TILES` derived, 2^24)**: the previous 2^28
    (268,435,456) was not a useful safety policy — at the measured ~140 KB per
    real tile it implies 37 TB, which no disk check would ever admit, while the
    validation it nominally protected would take ~3.7 h. At the measured
    ~50 µs/tile validation cost, 2^24 caps that at ~14 min and still leaves
    >100× headroom over a 9 gigapixel image (45,252 tiles) and ~8× over the
    brief's aspirational 400 gigapixels (~2.0 M tiles). The disk floor, not this
    cap, is the real practical gate.
  - **PAT-001f (configurable data root)**: `Config.DATA_ROOT` (default
    `data/images`), overridable with `--data-root` on both the server and
    `import_vips.sh`. Needed because at grading scale the source is several
    times LARGER than its pyramid, so both may have to live on an external
    volume. Staging and published images remain siblings under one root, so
    atomic same-filesystem publication is preserved; canonical id validation and
    the registry's path handling are unchanged; Java and shell defaults are
    parity-pinned so an import can never publish where the server does not look.
  - **PAT-001g (bounded staging quarantine)**: a crashed import leaves a
    `.tmp-<id>/`, which the next run renames to `.stale-tmp-<id>-<epoch>`. That
    is safe but leaked disk: at grading scale a partial pyramid is tens of GB and
    nothing reclaimed it. Retention is now bounded to the newest
    `ULTRASTILE_STALE_TMP_KEEP` (default 2), pruning older staging after a
    successful publish and logging the reclaimed bytes. Target quarantine
    (`.stale-<id>-*`) is deliberately never pruned: that content sat at the
    published path and may be an operator's image.
  - **PAT-001c (no dimension ceiling of its own)**: nothing in the store,
    registry or importer picks a maximum dimension. The only dimension rule is
    the derived representability check, and it is O(1) per request — serving a
    33-megapixel-wide image costs exactly what serving a 2,048 px one does.
    Large images are never decoded whole: `scripts/import_vips.sh` is the only
    path for them, it reads the header with `vipsheader` and streams the encode
    through `vips dzsave`, and the bounded `ImageIO` fallback refuses anything
    over 8192 px / 16 MP precisely because it calls `read(0)`.
- Prior-phase deps:
  - **DEP-001**: Requires phase-01 pins + `Config` (incl. `GEN_TILE_CAP`,
    `MAX_TILE_BYTES`, `META_MAX_BYTES`, `META_NAME_MAX`,
    `IMPORT_IMAGE_MAX_DIM`, `IMPORT_IMAGE_MAX_PIXELS`) + stub + `build.sh` +
    ready convention.
- Inputs: phase-01 skeleton. Outputs: store math + 106-tile demos +
  validated atomic importer (synthetic + pre-decode-capped-ImageIO) + live
  registry with strict bounded meta (no forward dependency).

## Tasks

### TASK-001 — PyramidTileStore with relative-path naming

- Create `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`:
  `TILE=512`, ceiling `levelCount/maxLevel/levelW/levelH/cols/rows`.
- Naming (frozen): `static String tileRelativePath(z,x,y)` returns
  `"level-<z>/<x>_<y>.jpg"` (pure string, no root); `servePath(id,z,x,y) =
  imageRoot(id).resolve(tileRelativePath(z,x,y))`;
  `stagePath(tmpRoot,z,x,y) = tmpRoot.resolve(tileRelativePath(z,x,y))`.
  Ingest MUST stage through `stagePath`; serving MUST open through
  `servePath`. No other tile-path construction exists anywhere
  (`rg -n "level-" src/main/java --glob '!*PyramidTileStore.java'` for
  `level-` literals outside the store must print NOTHING).
- `openTileChannel(id,z,x,y)` + `tileSize(path)`; `checkSize(path)` rejects
  missing/unreadable/empty/`size>MAX_TILE_BYTES`; optional SOI/EOI pre-check
  only; test-only `readTile` byte[]; id/z/coords validated (`id` int
  0..65535 before path join); invariant: edge JPEG physically 512x512
  post-padded.
- Done when: `mvn -q compile` passes (offline validation track).

### TASK-002 — IngestTool (synthetic + pre-decode-capped ImageIO)

- Create streaming `NEW src/main/java/com/ultratile/tiles/IngestTool.java`
  with TWO input modes behind ONE publish path.
- Canonical-ID gate FIRST in both modes: `id` must match `^[0-9]+$`, parse
  to `0..65535`, AND the raw string must equal `Integer.toString(parsed)`
  (rejects `01`, `0001`, `+1`, ` 1`); violations → stderr + exit 2 with NO
  path built. All subsequent paths use the canonical string.
- Mode (a) synthetic `IngestTool <id> <w> <h>`: validate `w,h >= 1`, then
  `PyramidTileStore.checkRepresentable` (DERIVED limit, see below) and the
  `IMPORT_MAX_TILES` operational cap;
  IMPORT-START recovery (existing `.tmp-<id>/` quarantined to
  `.stale-tmp-<id>-<epoch>/`, logged, or removed — never built into blindly,
  never blocks); finest tiles from `pixel(gx,gy)`; parents
  crop-mosaic-to-actual BEFORE downsample, pad OUTPUT to 512 with the FROZEN
  fill (solid black, content top-left — identical convention to the vips
  post-pad pass); Q85; tiles
  written ONLY via `stagePath(tmpRoot,...)` (never a hand-built final
  path — writing through a final-root method would bypass staging).
- Mode (b) bounded real-image `IngestTool --image <file> <id>`:
  `ImageIO.createImageInputStream` + `ImageIO.getImageReaders` (no reader →
  exit 2 "unreadable"); `reader.setInput(iis)`; `w=reader.getWidth(0)`,
  `h=reader.getHeight(0)`; if `Math.max(w,h) > IMPORT_IMAGE_MAX_DIM` OR
  `(long)w*h > IMPORT_IMAGE_MAX_PIXELS` → stderr "too large for ImageIO
  fallback — use import_vips.sh", exit 2, BEFORE `reader.read(0)` (the
  decode that allocates the full raster; a post-`read` check bounds nothing
  — forbidden); else `read(0)` then `Graphics2D`/`drawImage` per level, same
  post-pad + Q85 writer into the staged tree.
- Shared publish: canonical `"name":"image-<id>"` meta (fixed literal —
  never the source path); full-validate (PAT-001, every coord, 512 dims,
  every canonical relative pathname present, each ≤`MAX_TILE_BYTES`),
  `.ready`, atomic rename; ready target → `already-ready` exit 0 untouched;
  non-ready target → `.stale-<id>-<epoch>/` quarantine first.
- Demos `0 2048 2048`→21, `1 4096 4096`→85. Peak bounded O(tile-size)
  synthetic / O(W×H capped by `IMPORT_IMAGE_MAX_PIXELS`) ImageIO.
- Done when: both demos 21 + 85 JPEGs with `.ready`; rerun exits 0
  unchanged.

### TASK-003 — import_vips.sh with exact dzsave + tree transform

- Create `NEW scripts/import_vips.sh <src> <id>`: quote `"$src"`/`"$id"`
  everywhere; canonical-ID gate identical to TASK-002 (regex + range + no
  leading zeros, exit 2) BEFORE any path use; same `.tmp-<id>` recovery +
  ready-no-op + non-ready-quarantine as TASK-002.
- PRE-DIMENSION GATE (frozen, before any expensive work — the vips path must
  enforce the same limits the Java importers do, not validate after the
  pyramid is built): query `w=$(vipsheader -f width "$src")` and
  `h=$(vipsheader -f height "$src")` (`vipsheader` ships with libvips — same
  package as `vips`, no new dependency); if either query fails → stderr +
  exit 2 naming the loader problem. Then a FEASIBILITY REPORT (overflow-safe,
  bash 64-bit): pixels, level count, finest-level cols×rows, total expected
  tiles. Refusals, each with its own reason, BEFORE `dzsave`:
  - tiles per axis > 65,536 → "tile grid exceeds protocol coordinate range"
    (vips is the scalable path, so only the dimension ceiling applies here,
    not `IMPORT_IMAGE_MAX_PIXELS`);
  - total tiles > `IMPORT_MAX_TILES` → "pyramid tile count exceeds
    operational limit";
  - free space on the target volume below `total_tiles × 4 KiB` (a FLOOR, not
    an estimate — Q85 tile size is content-dependent) → "insufficient space".
  An accidentally oversized source must never pay for a full pyramid it will
  fail afterward.
  > **DIMENSION CEILING IS DERIVED, NOT CHOSEN.** The shell mirrors
  > `UtpMessages.maxRepresentableDim()`:
  > `MAX_DIM = (MAX_TILE_COORD + 1) * TILE = 65536 * 512 = 33554432`.
  > The previous literal `MAX_DIM=262144` had no derivation — it permitted
  > only 512 tiles per axis where the protocol addresses 65,536, so it was
  > 128× stricter than the wire requires and silently rejected valid images.
  > `check_const_parity.py` asserts Java and shell agree on the derivation and
  > that neither reintroduces a literal ceiling.
- FROZEN exact command (portable suffix form — NO `--Q` flag, hence NO
  libvips ≥8.15 requirement; trade-off stated in Notes: suffix mode gives up
  libvips' newer direct-JPEG fast path for version portability):
  `vips dzsave "$src" "$tmp/pyr" --depth onetile --tile-size 512 --overlap 0
  --skip-blanks -1 --suffix '.jpg[Q=85]'`
   then transform the libvips output tree `$tmp/pyr_files/<n>/<x>_<y>.jpg`
   → staged `$tmp/level-<n>/<x>_<y>.jpg` (dzsave nests levels under
   `<name>_files/` — writing "directly to level-N" was never the CLI
   behavior); remove `$tmp/pyr.dzi` and `$tmp/pyr_files` after the move.
 - FROZEN post-pad pass (the architecture's "post-pad" is a REAL step here,
   not a comment — dzsave emits CLIPPED edge extents, so arbitrary
   dimensions would otherwise fail the every-JPEG-is-512x512 validation):
   for every staged `$tmp/level-<n>/<x>_<y>.jpg`, query
   `vipsheader -f width/height`; any tile not exactly 512x512 is padded via
   `pad="${tile%.jpg}.pad.jpg"; vips embed "$tile" "$pad[Q=85]" 0 0 512 512
   --extend black && mv "$pad" "$tile"` — the output name MUST keep a
   recognized `.jpg` suffix (libvips selects output format from the
   filename suffix, so `$tile.pad` would NOT write JPEG) and MUST carry
   `[Q=85]` (JPEG defaults to Q75, below the frozen quality); the
   same-directory `mv` keeps replacement atomic — FROZEN fill policy: solid
   BLACK (0,0,0),
   content anchored TOP-LEFT, pad on right/bottom (same convention as the
   synthetic Java importer, so both paths produce identical edge geometry).
   Per-file `mv` keeps replacement atomic; the pass runs BEFORE validation
   (validation then re-asserts all-512 + size gate + PAT-001 counts).
- `meta.json` with canonical `"name":"image-<id>"` (shell-safe by
  construction — arbitrary basenames MUST NOT be interpolated into JSON);
  validate (PAT-001, all coords, canonical pathnames, 512 dims, size gate);
  `.ready`; atomic rename; `git add --chmod=+x scripts/import_vips.sh`.
- `--depth one`/google-layout/missing-skip-blanks/direct-`--Q` forbidden.
- Done when: `bash -n` passes + invalid-id exits 2 (set-e-safe probe below)
  + `[ -x scripts/import_vips.sh ]`.

### TASK-004 — ImageRegistry with canonical-dirname + demo repair

- Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`:
  `ImageInfo(id 0..65535,name,w,h,levels)` where `w,h` must satisfy
  `PyramidTileStore.checkRepresentable` — the SAME derived rule the importer
  enforces, so a successfully imported image can never be silently dropped
  here; `levelsFor` all Z0..N ceiling; trust iff `<id>/` has `meta.json` +
  `.ready`. The registry deliberately does NOT apply `IMPORT_MAX_TILES`: that
  is an import-time resource policy, not a validity claim, so the registry is
  always more permissive than the importer and never stricter. Rejections log a
  WARNING naming the actual reason.
- Metadata via tiny STRICT hand parser accepting ONLY the exact generated
  schema (`{"id":int,"name":string,"w":int,"h":int,"levels":int,
  "tile":512}` with JSON string escapes for `name`), bounded BEFORE parsing
  (read at most `META_MAX_BYTES+1` bytes; longer → ignore dir + WARNING).
- Require `tile==512`, `PyramidTileStore.checkRepresentable(w,h)` (the DERIVED
  limit: `ceil(dim/512) <= 65536` per axis, i.e. `dim <= 33554432`; NOT a
  hand-picked constant, and NOT `IMPORT_MAX_TILES` — see PAT-001a),
  `name.length<=META_NAME_MAX`,
  `name.equals("image-"+dirId)`, `levels == levelCount(w,h)`, `meta.id ==
  dirId` (positional identity), AND the directory name equals
  `Integer.toString(dirId)` (non-canonical `01` → ignored + WARNING, never
  adopted). Any violation → ignore dir + WARNING (registry/list/info NEVER
  500 on bad metadata).
- Startup: quarantine non-ready numeric dirs, then per-ID demo ensure with
  DEMO-REPAIR — for each demo id in {0,1}: absent → generate; present with
  `.ready` but registry-INVALID → quarantine to
  `.stale-invalid-<id>-<epoch>/` + regenerate (keeps `/healthz` repairable;
  normal user imports are NEVER touched — immutable/no-op).
- `list()` AND `get()` each build from a FRESH directory snapshot per call;
  ignore `.tmp-*`/`.stale-*`.
- Done when: `mvn -q compile` passes (offline validation track).

### TASK-005 — TileMathTest incl. pathname/ID/repair vectors

- Create `NEW src/test/java/com/ultratile/tiles/TileMathTest.java`:
  ceiling (2048→3 levels N=2, 256→1, 17→1px, 513→257), totals 21/85, padded
  dims, canonical relative pathnames
  (`tileRelativePath(3,0,4).equals("level-3/0_4.jpg")`), no `level-` literals
  outside the store (`rg` assertion), `readTileMissingThrows`,
  no-black-bleed, `.ready`-gate, quarantine incl. `.tmp-<id>` recovery,
  size-gate, direct n→Z, ID validation (`../0`, `-1`, `70000`, `01`,
  `0001` — the last two rejected for leading zeros, pre-path), idempotent
  no-op rerun, per-ID demo rule (seed ready custom id7 only → startup still
  generates 0+1), demo repair (seed corrupt `.ready` demo 0 → startup
  quarantines to `.stale-invalid-0-*` and regenerates a valid demo 0),
  strict-meta vectors (malformed JSON / `tile:256` / `levels:9-for-2048` /
  bad escapes → ignored + WARNING, no throw; `id:0`-in-dir-`5` → ignored;
  `name:"other"`-in-dir-`5` → ignored; `01`-dirname with valid meta →
  ignored; 17KiB `meta.json` → ignored pre-parse; 200-char `name` →
  ignored; canonical `image-<id>` accepted).
- ImageIO mode: 96x64 PNG via `ImageIO` → `--image` import → 1-level pyramid
  + `.ready` with canonical pathnames; 9000px-wide PNG → refused exit 2
  naming vips; 4097×4097 source (both axes ≤8192, area 16,785,409 >
  16,777,216 — pixel-cap-only, dimension-cap-clean) → refused exit 2 BEFORE
  decode; the test SHOULD generate only an image header sufficient for
  `getWidth/getHeight` (e.g. a minimal valid PNG with the right IHDR, or a
  small image whose metadata is patched) rather than allocating a >64 MB
  raster to prove the bound.
- Cross-importer pathname test: one synthetic id and one `--image` id both
  expose every tile through `servePath` at `level-<Z>/<X>_<Y>.jpg`.
- Done when: `mvn -q test -Dtest=TileMathTest` green (offline validation
  track).

### TASK-006 — Parity framework over Java+shell constants (JS deferred)

- Create `NEW scripts/check_const_parity.py` (stdlib, TEST-ONLY) as a
  FRAMEWORK in this phase: mapping table covering the Java↔shell constants
  available now, reading TWO Java owners — `Config.java` (operational
  tuning: tile/cache/decode/budget/seed/scales) and `UtpMessages.java`
  (wire magic + UTP type codes; protocol constants live here, NOT in
  `Config`) — plus shell duplicates (`tile-size 512` and `Q=85` in
  `import_vips.sh`, Q85 in `IngestTool`). The JavaScript side CANNOT be
  pinned here: the real `viewer.js` does not exist until phase-06, so this
  phase's script takes a frozen `--java-shell-only` flag that checks
  Java+shell and exits 0 without touching `viewer.js`. (Rule as of this
  phase: EITHER a Java/shell constant is pinned here OR it is removed from
  `Config`/`UtpMessages`/the shell — full JS parity is phase-06's
  completion task, never this phase's green gate.)
- Run `python3 scripts/check_const_parity.py --java-shell-only` green.
- Done when: flag-mode green + intentional mismatch (temp edit) fails loud.
  Full `python3 scripts/check_const_parity.py` (with the JS map) is
  phase-06 TASK-004's gate, not this phase's.

## Validation Commands

Offline validation track:

```sh
mvn -q test -Dtest=TileMathTest
python3 scripts/check_const_parity.py --java-shell-only
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 1 4096 4096
[ "$(find data/images/0 data/images/1 -name '*.jpg' | wc -l)" = "106" ] || { echo "expected 21+85=106 tiles" >&2; exit 1; }
ls data/images/0/.ready data/images/1/.ready
ls data/images/0/level-2/0_0.jpg data/images/1/level-3/0_0.jpg || { echo "canonical pathnames missing" >&2; exit 1; }
bash -n scripts/import_vips.sh
[ -x scripts/import_vips.sh ] || { echo "import_vips.sh not executable" >&2; exit 1; }
if ./scripts/import_vips.sh dummy-src '../x' 2>/dev/null; then echo "invalid id must fail" >&2; exit 1; else rc=$?; [ "$rc" = "2" ] || { echo "invalid id must exit 2, got $rc" >&2; exit 1; }; fi
if ./scripts/import_vips.sh dummy-src '01' 2>/dev/null; then echo "leading-zero id must fail" >&2; exit 1; else rc=$?; [ "$rc" = "2" ] || { echo "leading-zero id must exit 2, got $rc" >&2; exit 1; }; fi
grep -q "tile-size 512" scripts/import_vips.sh && grep -q "Q=85" scripts/import_vips.sh || { echo "shell tile-size/Q drifted" >&2; exit 1; }
grep -q "vipsheader" scripts/import_vips.sh || { echo "vips pre-dimension gate missing" >&2; exit 1; }
grep -q "vips embed" scripts/import_vips.sh && grep -q '\.pad\.jpg' scripts/import_vips.sh && grep -q 'Q=85' scripts/import_vips.sh || { echo "vips post-pad pass missing/malformed (needs embed + .pad.jpg + Q=85)" >&2; exit 1; }
if command -v vips >/dev/null 2>&1; then vips black /tmp/pad-src.png 513 777 --bands 3 && ./scripts/import_vips.sh /tmp/pad-src.png 7 && [ "$(find data/images/7 -name '*.jpg' | wc -l)" = "5" ] || { echo "513x777 vips pyramid must be 4+1=5 tiles" >&2; exit 1; }; bad=0; for j in $(find data/images/7 -name '*.jpg'); do [ "$(vipsheader -f width "$j")x$(vipsheader -f height "$j")" = "512x512" ] || { echo "unpadded edge tile: $j" >&2; bad=1; }; done; [ "$bad" = "0" ] || exit 1; ls data/images/7/.ready; else echo "SKIP vips live proof (no vips binary; bash -n + gate greps above still enforced)"; fi
```

## Notes for Implementer

- Validation asserts the 106 total (21 + 85) instead of printing it — the
  v1.6 block never created id1 yet expected its `.ready`.
- Crash recovery is a first-class path: `.tmp-<id>` leftovers and non-ready
  dirs are quarantined with distinct prefixes (`.stale-tmp-` vs `.stale-`
  vs `.stale-invalid-`) so post-mortems stay distinguishable.
- Canonical display names remove an entire bug class: no writer ever
  serializes an attacker-influenced string, so JSON escaping cannot be
  forgotten in shell; the registry additionally rejects non-canonical
  names AND non-canonical directory spellings, so `01` can never shadow `1`.
  The parser still accepts escapes (robustness), covered by vectors.
- The invalid-id probes use `if/else` (never `cmd; [ "$?" = ... ]`) so they
  are safe under an outer `set -e` — v1.8's form was fragile there.
- Pre-decode bounding is load-bearing: `ImageReader.read` allocates the
  COMPLETE raster, so any dimension/pixel check placed after `read()` is
  theater. The 4097×4097 vector pins the pixel cap independently of the
  dimension cap (tall-thin 8192px images stay legal; huge-area images die
  before decode) — and the test itself must not allocate the raster it
  proves the implementation refuses.
- The `.jpg[Q=85]` suffix is the portability decision: it works on
  libvips versions predating the direct `--Q` flag (8.15+) at the cost of
  the newer direct-JPEG fast path. No version gate may reject an older
  libvips for the quality flag.
