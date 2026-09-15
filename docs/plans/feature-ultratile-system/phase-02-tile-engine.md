---
phase: phase-02-tile-engine
goal: GOAL-002 Ceiling store plus validated import plus registry with .ready demos
status: 'Planned'
parent: ./overview.md
version: 1.6
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 02 — Tile Engine ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-001**: Progressive/selective 512x512 tiling (ceiling pyramid, post-padded edges, full-bitmap compositing with screen-space clear + clip); never full image.
  - **REQ-008**: dz/onetile + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); CLI IDs decimal `0..65535` validated BEFORE any path use, all path/shell args quoted; ready target → successful no-op; non-ready → `.stale-<id>-<epoch>/` quarantine (logged); ignore `.tmp-*`/`.stale-*`; synthetic fallback bounded O(tile-size), crop-then-downsample-then-pad-output; demos auto-generated if no `.ready`; trust `.ready` only.
  - **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches.
- Prior-phase deps:
  - **DEP-001**: Requires phase-01 pins + `Config` (incl. `GEN_TILE_CAP`, `MAX_TILE_BYTES`) + stub + `build.sh` + ready convention.
- Inputs: phase-01 skeleton. Outputs: store math + dual-demo pyramids + validated atomic importer + live registry (no forward dependency).

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`: `TILE=512`, ceiling `levelCount/maxLevel/levelW/levelH/cols/rows`; `openTileChannel(id,z,x,y)` + `tileSize(path)`; `checkSize(path)` rejects missing/unreadable/empty/`size>MAX_TILE_BYTES` (pre-frame SKIPPED sources; browser owns corrupt verdict); optional SOI/EOI pre-check only; test-only `readTile` byte[]; id/z/coords validated (`id` int 0..65535 before path join); invariant: edge JPEG physically 512x512 post-padded. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create streaming `NEW src/main/java/com/ultratile/tiles/IngestTool.java`: CLI `main([id,w,h])` validates `id` matches `^[0-9]+$` and `0..65535` (reject `../`, negative, huge — exit 2, no path built) and `w,h` 1..`MAX_DIM`; finest tiles from `pixel(gx,gy)`; parents crop-mosaic-to-actual BEFORE downsample, pad OUTPUT to 512; Q85; build under `.tmp-<id>/`, full-validate (PAT-001, every coord, 512 dims, each ≤`MAX_TILE_BYTES`), `.ready`, atomic rename; if target `<id>/` already has `.ready` → print `already-ready` and exit 0 WITHOUT touching it (repeatable validation); if target exists without `.ready` → quarantine to `.stale-<id>-<epoch>/` first. Demos `0 2048 2048`→21, `1 4096 4096`→85. Peak bounded O(tile-size). | TASK-001 | both demos 21 + 85 JPEGs with `.ready`; rerun exits 0 unchanged |  |  |
| TASK-003 | Create `NEW scripts/import_vips.sh <src> <id>`: quote `"$src"`/`"$id"` everywhere; validate `id` decimal `0..65535` (regex + bounds, exit 2 otherwise); `vips dzsave` dz/onetile/512/overlap-0/`--skip-blanks -1`/`--Q 85`; dz `n`→`level-n` direct; post-pad edges Q85; `meta.json`; validate (PAT-001, all coords, 512 dims, size gate); `.ready`; ready-target no-op (exit 0); non-ready-target quarantine; atomic rename. `--depth one`/google/missing-skip-blanks forbidden. | TASK-001 | `bash -n scripts/import_vips.sh` passes + rejects `id=../x` |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`: `ImageInfo(id 0..65535,name,w 1..MAX_DIM,h,levels)`; `levelsFor` all Z0..N ceiling; trust iff `<id>/` has `meta.json` + `.ready`; startup: quarantine non-ready numeric dirs, `IngestTool`-generate demos 0/1 if still absent (same-phase call — compiles); `list()` AND `get()` each build from a FRESH directory snapshot per call (an import visible in `/api/images` is equally visible in `/info` — no stale-`get` window); ignore `.tmp-*`/`.stale-*`. | TASK-002 | `mvn -q compile` passes |  |  |
| TASK-005 | Create `NEW src/test/java/com/ultratile/tiles/TileMathTest.java`: ceiling (2048→3, 256→1, 17→1px, 513→257), totals 21/85, padded dims, `readTileMissingThrows`, no-black-bleed, `.ready`-gate, quarantine (stale renamed, ready untouched), size-gate (>2MiB rejected), direct n→Z, ID validation (`../0`, `-1`, `70000` rejected before path use), idempotent no-op rerun (timestamps unchanged). | TASK-004 | `mvn -q test -Dtest=TileMathTest` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=TileMathTest
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
find data/images/0 data/images/1 -name "*.jpg" | wc -l
ls data/images/0/.ready data/images/1/.ready
bash -n scripts/import_vips.sh
```

## Notes for Implementer

- Filesystem IDs are untrusted input: decimal-shape + range check precedes EVERY `Path.resolve`; quoted shell expansions throughout (injection-safe by construction).
- Idempotent no-op makes validation reruns (and double startup) safe; quarantine (not delete) preserves evidence for non-ready leftovers.
