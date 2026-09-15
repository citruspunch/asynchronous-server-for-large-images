---
phase: phase-02-tile-engine
goal: GOAL-002 Ceiling store plus validated import plus strict meta plus 106-tile demos
status: 'Planned'
parent: ./overview.md
version: 1.8
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 02 — Tile Engine ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-001**: Progressive/selective 512x512 tiling (ceiling pyramid, post-padded edges, full-bitmap compositing with screen-space clear + clip); never full image.
  - **REQ-008**: dz/onetile + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); import START recovers leftover `.tmp-<id>` (quarantine-or-remove, logged); CLI IDs decimal `0..65535` pre-path, all args quoted; ready target → no-op; non-ready numeric dir → `.stale-<id>-<epoch>/` quarantine; ignore `.tmp-*`/`.stale-*`; synthetic fallback bounded O(tile-size), crop-then-downsample-then-pad-output; writers emit canonical `"name":"image-<id>"` (never interpolate source paths into JSON); demos auto-generated if no `.ready`; trust `.ready` only. Metadata: tiny STRICT hand parser for the exact generated schema, hard-bounded BEFORE parsing (`META_MAX_BYTES=16KiB` pre-read cap, `META_NAME_MAX=128`) — oversize → ignore + WARNING; malformed/inconsistent `.ready` metadata → ignore + WARNING (never 500); `levels` must equal PAT-001 `levelCount(w,h)` AND `meta.id` must equal the numeric directory id (identity is positional, never self-claimed).
  - **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches.
- Prior-phase deps:
  - **DEP-001**: Requires phase-01 pins + `Config` (incl. `GEN_TILE_CAP`, `MAX_TILE_BYTES`, `META_MAX_BYTES`, `META_NAME_MAX`) + stub + `build.sh` + ready convention.
- Inputs: phase-01 skeleton. Outputs: store math + 106-tile demos + validated atomic importer + live registry with strict bounded meta (no forward dependency).

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`: `TILE=512`, ceiling `levelCount/maxLevel/levelW/levelH/cols/rows`; `openTileChannel(id,z,x,y)` + `tileSize(path)`; `checkSize(path)` rejects missing/unreadable/empty/`size>MAX_TILE_BYTES`; optional SOI/EOI pre-check only; test-only `readTile` byte[]; id/z/coords validated (`id` int 0..65535 before path join); invariant: edge JPEG physically 512x512 post-padded. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create streaming `NEW src/main/java/com/ultratile/tiles/IngestTool.java`: CLI validates `id` `^[0-9]+$` + `0..65535` (exit 2, no path built) and `w,h` 1..`MAX_DIM`; IMPORT-START recovery: existing `.tmp-<id>/` (prior crash) is quarantined to `.stale-tmp-<id>-<epoch>/` (logged) or removed — never built into blindly, never blocks; finest tiles from `pixel(gx,gy)`; parents crop-mosaic-to-actual BEFORE downsample, pad OUTPUT to 512; Q85; write `meta.json` with canonical `"name":"image-<id>"` (fixed literal — never the source path; no escaping burden by construction); full-validate (PAT-001, every coord, 512 dims, each ≤`MAX_TILE_BYTES`), `.ready`, atomic rename; ready target → `already-ready` exit 0 untouched; non-ready target → `.stale-<id>-<epoch>/` quarantine first. Demos `0 2048 2048`→21, `1 4096 4096`→85. Peak bounded O(tile-size). | TASK-001 | both demos 21 + 85 JPEGs with `.ready`; rerun exits 0 unchanged |  |  |
| TASK-003 | Create `NEW scripts/import_vips.sh <src> <id>`: quote `"$src"`/`"$id"` everywhere; validate `id` decimal `0..65535` (regex + bounds, exit 2 otherwise) BEFORE any path use; same `.tmp-<id>` recovery + ready-no-op + non-ready-quarantine as TASK-002; `vips dzsave` dz/onetile/512/overlap-0/`--skip-blanks -1`/`--Q 85`; dz `n`→`level-n` direct; post-pad edges Q85; `meta.json` with canonical `"name":"image-<id>"` (shell-safe by construction — arbitrary basenames MUST NOT be interpolated into JSON); validate (PAT-001, all coords, 512 dims, size gate); `.ready`; atomic rename; `git add --chmod=+x scripts/import_vips.sh`. `--depth one`/google/missing-skip-blanks forbidden. | TASK-001 | `bash -n` passes + `./import_vips.sh x '../x'` exits 2 (assert BEFORE any vips probe) + `[ -x scripts/import_vips.sh ]` |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`: `ImageInfo(id 0..65535,name,w 1..MAX_DIM,h,levels)`; `levelsFor` all Z0..N ceiling; trust iff `<id>/` has `meta.json` + `.ready`; metadata via tiny STRICT hand parser accepting ONLY the exact generated schema (`{"id":int,"name":string,"w":int,"h":int,"levels":int,"tile":512}` with JSON string escapes for `name`), bounded BEFORE parsing: read at most `META_MAX_BYTES+1` bytes — file longer than `META_MAX_BYTES=16384` → ignore dir + WARNING (never parse unbounded local input); then require `tile==512`, `1<=w,h<=MAX_DIM`, `name.length<=META_NAME_MAX`, `levels == levelCount(w,h)`, AND `meta.id == directory numeric id` (positional identity — `data/images/5/meta.json` claiming `id:0` is ignored + WARNING, never adopted); any violation → ignore dir + WARNING (registry/list/info NEVER 500 on bad metadata); startup: quarantine non-ready numeric dirs, `IngestTool`-generate demos 0/1 if still absent (same-phase call — compiles); `list()` AND `get()` each build from a FRESH directory snapshot per call; ignore `.tmp-*`/`.stale-*`. | TASK-002 | `mvn -q compile` passes |  |  |
| TASK-005 | Create `NEW src/test/java/com/ultratile/tiles/TileMathTest.java`: ceiling (2048→3, 256→1, 17→1px, 513→257), totals 21/85, padded dims, `readTileMissingThrows`, no-black-bleed, `.ready`-gate, quarantine incl. `.tmp-<id>` recovery (seeded stale tmp quarantined, build proceeds), size-gate, direct n→Z, ID validation (`../0`, `-1`, `70000` pre-path), idempotent no-op rerun, strict-meta vectors (malformed JSON / `tile:256` / `levels:9-for-2048` / bad escapes → ignored + WARNING, no throw; `id:0`-in-dir-`5` → ignored + WARNING; 17KiB `meta.json` → ignored pre-parse + WARNING; 200-char `name` → ignored + WARNING; canonical `image-<id>` accepted). | TASK-004 | `mvn -q test -Dtest=TileMathTest` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=TileMathTest
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 1 4096 4096
[ "$(find data/images/0 data/images/1 -name '*.jpg' | wc -l)" = "106" ] || { echo "expected 21+85=106 tiles" >&2; exit 1; }
ls data/images/0/.ready data/images/1/.ready
bash -n scripts/import_vips.sh
[ -x scripts/import_vips.sh ] || { echo "import_vips.sh not executable" >&2; exit 1; }
./scripts/import_vips.sh dummy-src '../x'; [ "$?" = "2" ] || { echo "invalid id must exit 2" >&2; exit 1; }
```

## Notes for Implementer

- Validation asserts the 106 total (21 + 85) instead of printing it — the v1.6 block never created id1 yet expected its `.ready`.
- Crash recovery is a first-class path: `.tmp-<id>` leftovers and non-ready dirs are quarantined with distinct prefixes (`.stale-tmp-` vs `.stale-`) so post-mortems stay distinguishable.
- Canonical display names remove an entire bug class: no writer ever serializes an attacker-influenced string, so JSON escaping cannot be forgotten in shell. The parser still accepts escapes (robustness), covered by vectors.
