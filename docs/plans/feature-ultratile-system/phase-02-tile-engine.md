---
phase: phase-02-tile-engine
goal: GOAL-002 Ceiling store plus validated import plus strict meta plus 106-tile demos
status: 'Planned'
parent: ./overview.md
version: 1.9
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 02 — Tile Engine ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-001**: Progressive/selective 512x512 tiling (ceiling pyramid, post-padded edges, full-bitmap compositing with screen-space clear + clip); never full image.
  - **REQ-008**: dz/onetile + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); import START recovers leftover `.tmp-<id>` (quarantine-or-remove, logged); CLI IDs decimal `0..65535` pre-path, all args quoted; ready target → no-op; non-ready numeric dir → `.stale-<id>-<epoch>/` quarantine; ignore `.tmp-*`/`.stale-*`; synthetic fallback bounded O(tile-size), crop-then-downsample-then-pad-output; bounded JDK `ImageIO` real-image mode (`--image <file> <id>` — ordinary-size sources only, `max(w,h) > IMPORT_IMAGE_MAX=8192` refused with a "use vips" error; documented convenience fallback so "add a new image" is demonstrable with no libvips and no network); writers emit canonical `"name":"image-<id>"` (never interpolate source paths into JSON); missing demo IDs 0 and 1 ensured INDEPENDENTLY (per-ID rule — a ready custom image never suppresses demo generation); trust `.ready` only. Metadata: tiny STRICT hand parser for the exact generated schema, hard-bounded BEFORE parsing (`META_MAX_BYTES=16KiB` pre-read cap, `META_NAME_MAX=128`) — oversize → ignore + WARNING; malformed/inconsistent `.ready` metadata → ignore + WARNING (never 500); `levels` must equal PAT-001 `levelCount(w,h)` AND `meta.id` must equal the numeric directory id (identity is positional, never self-claimed).
  - **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches (`depth onetile` = pyramid down to one tile; `skip_blanks -1` disables blank skipping — validated post-generation, never assumed per libvips version).
- Prior-phase deps:
  - **DEP-001**: Requires phase-01 pins + `Config` (incl. `GEN_TILE_CAP`, `MAX_TILE_BYTES`, `META_MAX_BYTES`, `META_NAME_MAX`, `IMPORT_IMAGE_MAX`) + stub + `build.sh` + ready convention.
- Inputs: phase-01 skeleton. Outputs: store math + 106-tile demos + validated atomic importer (synthetic + bounded-ImageIO) + live registry with strict bounded meta (no forward dependency).

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`: `TILE=512`, ceiling `levelCount/maxLevel/levelW/levelH/cols/rows`; `openTileChannel(id,z,x,y)` + `tileSize(path)`; `checkSize(path)` rejects missing/unreadable/empty/`size>MAX_TILE_BYTES`; optional SOI/EOI pre-check only; test-only `readTile` byte[]; id/z/coords validated (`id` int 0..65535 before path join); invariant: edge JPEG physically 512x512 post-padded. | — | `mvn -q compile` passes (dev track) |  |  |
| TASK-002 | Create streaming `NEW src/main/java/com/ultratile/tiles/IngestTool.java` with TWO input modes behind ONE publish path: (a) synthetic `IngestTool <id> <w> <h>` — CLI validates `id` `^[0-9]+$` + `0..65535` (exit 2, no path built) and `w,h` 1..`MAX_DIM`; IMPORT-START recovery: existing `.tmp-<id>/` quarantined to `.stale-tmp-<id>-<epoch>/` (logged) or removed — never built into blindly, never blocks; finest tiles from `pixel(gx,gy)`; parents crop-mosaic-to-actual BEFORE downsample, pad OUTPUT to 512; Q85. (b) bounded real-image `IngestTool --image <file> <id>` — same `id` validation FIRST; `ImageIO.read` (null → exit 2 "unreadable"); refuse `max(w,h) > IMPORT_IMAGE_MAX` with stderr "too large for ImageIO fallback — use import_vips.sh" exit 2 (heap-bounded by construction; ImageIO is NEVER the huge-image architecture — ALT-008); downsample with `Graphics2D`/`drawImage` per level, same post-pad + Q85 writer. BOTH modes then share: canonical `"name":"image-<id>"` meta (fixed literal — never the source path); full-validate (PAT-001, every coord, 512 dims, each ≤`MAX_TILE_BYTES`), `.ready`, atomic rename; ready target → `already-ready` exit 0 untouched; non-ready target → `.stale-<id>-<epoch>/` quarantine first. Demos `0 2048 2048`→21, `1 4096 4096`→85. Peak bounded O(tile-size) synthetic / O(source-row) ImageIO. | TASK-001 | both demos 21 + 85 JPEGs with `.ready`; rerun exits 0 unchanged |  |  |
| TASK-003 | Create `NEW scripts/import_vips.sh <src> <id>`: quote `"$src"`/`"$id"` everywhere; validate `id` decimal `0..65535` (regex + bounds, exit 2 otherwise) BEFORE any path use; same `.tmp-<id>` recovery + ready-no-op + non-ready-quarantine as TASK-002; `vips dzsave` dz/onetile/512/overlap-0/`--skip-blanks -1`/`--Q 85`; dz `n`→`level-n` direct; post-pad edges Q85; `meta.json` with canonical `"name":"image-<id>"` (shell-safe by construction — arbitrary basenames MUST NOT be interpolated into JSON); validate (PAT-001, all coords, 512 dims, size gate); `.ready`; atomic rename; `git add --chmod=+x scripts/import_vips.sh`. `--depth one`/google/missing-skip-blanks forbidden. | TASK-001 | `bash -n` passes + invalid-id exits 2 (set-e-safe probe below) + `[ -x scripts/import_vips.sh ]` |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`: `ImageInfo(id 0..65535,name,w 1..MAX_DIM,h,levels)`; `levelsFor` all Z0..N ceiling; trust iff `<id>/` has `meta.json` + `.ready`; metadata via tiny STRICT hand parser accepting ONLY the exact generated schema (`{"id":int,"name":string,"w":int,"h":int,"levels":int,"tile":512}` with JSON string escapes for `name`), bounded BEFORE parsing: read at most `META_MAX_BYTES+1` bytes — file longer than `META_MAX_BYTES=16384` → ignore dir + WARNING (never parse unbounded local input); then require `tile==512`, `1<=w,h<=MAX_DIM`, `name.length<=META_NAME_MAX`, `levels == levelCount(w,h)`, AND `meta.id == directory numeric id` (positional identity — `data/images/5/meta.json` claiming `id:0` is ignored + WARNING, never adopted); any violation → ignore dir + WARNING (registry/list/info NEVER 500 on bad metadata); startup: quarantine non-ready numeric dirs, then INDEPENDENTLY ensure demo IDs: `IngestTool`-generate demo 0 if absent, demo 1 if absent (per-ID rule — a ready custom image 7 never suppresses demo generation; same-phase call — compiles); `list()` AND `get()` each build from a FRESH directory snapshot per call; ignore `.tmp-*`/`.stale-*`. | TASK-002 | `mvn -q compile` passes (dev track) |  |  |
| TASK-005 | Create `NEW src/test/java/com/ultratile/tiles/TileMathTest.java`: ceiling (2048→3, 256→1, 17→1px, 513→257), totals 21/85, padded dims, `readTileMissingThrows`, no-black-bleed, `.ready`-gate, quarantine incl. `.tmp-<id>` recovery (seeded stale tmp quarantined, build proceeds), size-gate, direct n→Z, ID validation (`../0`, `-1`, `70000` pre-path), idempotent no-op rerun, per-ID demo rule (seed ready custom id7 only → startup still generates 0+1), strict-meta vectors (malformed JSON / `tile:256` / `levels:9-for-2048` / bad escapes → ignored + WARNING, no throw; `id:0`-in-dir-`5` → ignored + WARNING; 17KiB `meta.json` → ignored pre-parse + WARNING; 200-char `name` → ignored + WARNING; canonical `image-<id>` accepted), ImageIO mode (test writes a 96x64 PNG via `ImageIO`, imports with `--image` → 1-level pyramid + `.ready`; 9000px-wide PNG → refused exit 2 naming vips). | TASK-004 | `mvn -q test -Dtest=TileMathTest` green (dev track) |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=TileMathTest
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 1 4096 4096
[ "$(find data/images/0 data/images/1 -name '*.jpg' | wc -l)" = "106" ] || { echo "expected 21+85=106 tiles" >&2; exit 1; }
ls data/images/0/.ready data/images/1/.ready
bash -n scripts/import_vips.sh
[ -x scripts/import_vips.sh ] || { echo "import_vips.sh not executable" >&2; exit 1; }
if ./scripts/import_vips.sh dummy-src '../x' 2>/dev/null; then echo "invalid id must fail" >&2; exit 1; else rc=$?; [ "$rc" = "2" ] || { echo "invalid id must exit 2, got $rc" >&2; exit 1; }; fi
```

## Notes for Implementer

- Validation asserts the 106 total (21 + 85) instead of printing it — the v1.6 block never created id1 yet expected its `.ready`.
- Crash recovery is a first-class path: `.tmp-<id>` leftovers and non-ready dirs are quarantined with distinct prefixes (`.stale-tmp-` vs `.stale-`) so post-mortems stay distinguishable.
- Canonical display names remove an entire bug class: no writer ever serializes an attacker-influenced string, so JSON escaping cannot be forgotten in shell. The parser still accepts escapes (robustness), covered by vectors.
- The invalid-id probe uses `if/else` (never `cmd; [ "$?" = ... ]`) so it is safe under an outer `set -e` — v1.8's form was fragile there.
