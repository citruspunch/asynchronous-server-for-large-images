---
phase: phase-02-tile-engine
goal: GOAL-002 Ceiling store plus validated import plus strict meta plus 106-tile demos
status: 'Planned'
parent: ./overview.md
version: 1.13
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 02 — Tile Engine ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

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
- Mode (a) synthetic `IngestTool <id> <w> <h>`: validate `w,h` 1..`MAX_DIM`;
  IMPORT-START recovery (existing `.tmp-<id>/` quarantined to
  `.stale-tmp-<id>-<epoch>/`, logged, or removed — never built into blindly,
  never blocks); finest tiles from `pixel(gx,gy)`; parents
  crop-mosaic-to-actual BEFORE downsample, pad OUTPUT to 512; Q85; tiles
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
  enforce `MAX_DIM` the way the Java importers do, not validate after the
  pyramid is built): query `w=$(vipsheader -f width "$src")` and
  `h=$(vipsheader -f height "$src")` (`vipsheader` ships with libvips — same
  package as `vips`, no new dependency); if either query fails → stderr +
  exit 2; if `max(w,h) > MAX_DIM=262144` → stderr "too large" + exit 2
  BEFORE `dzsave` (an accidentally oversized source must never pay for a
  full pyramid it will fail afterward; vips is the scalable path so only the
  dimension ceiling applies here, not `IMPORT_IMAGE_MAX_PIXELS`).
- FROZEN exact command (portable suffix form — NO `--Q` flag, hence NO
  libvips ≥8.15 requirement; trade-off stated in Notes: suffix mode gives up
  libvips' newer direct-JPEG fast path for version portability):
  `vips dzsave "$src" "$tmp/pyr" --depth onetile --tile-size 512 --overlap 0
  --skip-blanks -1 --suffix '.jpg[Q=85]'`
  then transform the libvips output tree `$tmp/pyr_files/<n>/<x>_<y>.jpg`
  → staged `$tmp/level-<n>/<x>_<y>.jpg` (dzsave nests levels under
  `<name>_files/` — writing "directly to level-N" was never the CLI
  behavior); remove `$tmp/pyr.dzi` and `$tmp/pyr_files` after the move.
- `meta.json` with canonical `"name":"image-<id>"` (shell-safe by
  construction — arbitrary basenames MUST NOT be interpolated into JSON);
  validate (PAT-001, all coords, canonical pathnames, 512 dims, size gate);
  `.ready`; atomic rename; `git add --chmod=+x scripts/import_vips.sh`.
- `--depth one`/google-layout/missing-skip-blanks/direct-`--Q` forbidden.
- Done when: `bash -n` passes + invalid-id exits 2 (set-e-safe probe below)
  + `[ -x scripts/import_vips.sh ]`.

### TASK-004 — ImageRegistry with canonical-dirname + demo repair

- Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`:
  `ImageInfo(id 0..65535,name,w 1..MAX_DIM,h,levels)`; `levelsFor` all Z0..N
  ceiling; trust iff `<id>/` has `meta.json` + `.ready`.
- Metadata via tiny STRICT hand parser accepting ONLY the exact generated
  schema (`{"id":int,"name":string,"w":int,"h":int,"levels":int,
  "tile":512}` with JSON string escapes for `name`), bounded BEFORE parsing
  (read at most `META_MAX_BYTES+1` bytes; longer → ignore dir + WARNING).
- Require `tile==512`, `1<=w,h<=MAX_DIM`, `name.length<=META_NAME_MAX`,
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
  available now — `Config.T` vs `tile-size 512` in `import_vips.sh`, Q85 in
  `import_vips.sh`/`IngestTool` vs the frozen quality, plus every
  `Config.java` numeric constant the script can parse (tile/cache/decode/
  budget/seed/scales + UTP magic and type codes + `SPAN_CAP` +
  `GEN_TILE_CAP`). The JavaScript side CANNOT be pinned here: the real
  `viewer.js` does not exist until phase-06, so this phase's script takes a
  frozen `--java-shell-only` flag that checks Java+shell and exits 0 without
  touching `viewer.js`. (Rule as of this phase: EITHER a Java/shell constant
  is pinned here OR it is removed from `Config`/the shell — full JS parity
  is phase-06's completion task, never this phase's green gate.)
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
