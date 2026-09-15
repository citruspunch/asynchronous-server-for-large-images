---
phase: phase-02-tile-engine
goal: GOAL-002 Ceiling store plus import plus registry with .ready demos
status: 'Planned'
parent: ./overview.md
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 02 — Tile Engine ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-001**: Progressive/selective 512x512 tiling (ceiling pyramid, post-padded edges, full-bitmap compositing clipped to image rect); never full image.
  - **REQ-008**: `scripts/import_vips.sh` dz/onetile + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); stale recovery: non-`.ready` numeric dirs renamed to `.stale-<id>-<epoch>/` (logged) before rebuilds; registry ignores `.tmp-*`/`.stale-*`; streaming synthetic fallback (bounded O(tile-size), crop-mosaic-then-downsample-then-pad-output); demos auto-generated if no `.ready`; trust `.ready` only.
  - **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches.
- Prior-phase deps:
  - **DEP-001**: Requires phase-01 pins + `Config` (incl. `GEN_TILE_CAP`, `MAX_TILE_BYTES`) + stub + `build.sh` + ready convention.
- Inputs: phase-01 skeleton. Outputs: store math + dual-demo pyramids + atomic importer + live registry (no forward dependency — this reorder fixes the v1.4 block where HTTP referenced a not-yet-created `IngestTool`).

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`: `TILE=512`, ceiling `levelCount/maxLevel/levelW/levelH/cols/rows`; `openTileChannel(id,z,x,y)` + `tileSize(path)` for `transferTile`; `checkSize(path)` rejects missing/unreadable/`size>MAX_TILE_BYTES`/empty (pre-frame SKIPPED sources; browser owns corrupt verdict); optional SOI/EOI pre-check only; test-only `readTile` byte[]; id/z/coords validation; invariant: stored edge JPEG physically 512x512 post-padded. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create streaming `NEW src/main/java/com/ultratile/tiles/IngestTool.java`: `<id> <w> <h>`; finest tiles from `pixel(gx,gy)`; parents crop-mosaic-to-actual BEFORE downsample to actual parent dims, pad OUTPUT to 512; Q85; build under `data/images/.tmp-<id>/`, full-validate (PAT-001 counts, every coord, 512 dims, each ≤`MAX_TILE_BYTES`), write `.ready`, atomic rename to `<id>/`. Demos `0 2048 2048`→1+4+16=21, `1 4096 4096`→1+4+16+64=85. Peak bounded O(tile-size), independent of W/H. | TASK-001 | both demos produce 21 + 85 JPEGs with `.ready` |  |  |
| TASK-003 | Create `NEW scripts/import_vips.sh <src> <id>`: `vips dzsave <src> <tmpdz> --layout dz --depth onetile --tile-size 512 --overlap 0 --skip-blanks -1 --Q 85`; map dz levels `n`→`level-n` directly (NO reversal; rearrange coords/naming per observed `_files` layout only); post-pad every edge JPEG to 512x512 Q85; write `meta.json`; validate (PAT-001, all coords, 512 dims, size gate); `.ready`; atomic rename. `--depth one`, google layout, missing `--skip-blanks -1` forbidden. | TASK-001 | `bash -n scripts/import_vips.sh` passes |  |  |
| TASK-004 | Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`: `ImageInfo(id 0..65535,name,w 1..MAX_DIM,h,levels)`; `levelsFor` all Z0..N ceiling; trust rule: id valid iff `<id>/` has `meta.json` + `.ready` (no per-tile walk at runtime); startup: quarantine any numeric `<id>/` lacking `.ready` to `.stale-<id>-<epoch>/` (log WARNING), then `IngestTool`-generate demos 0/1 if still absent (same-phase call — compiles); `list()` scans ALL numeric dirs per call (live rescan, no restart; ignores `.tmp-*`/`.stale-*`); `get`→404 unknown/incomplete. | TASK-002 | `mvn -q compile` passes |  |  |
| TASK-005 | Create `NEW src/test/java/com/ultratile/tiles/TileMathTest.java`: ceiling (2048→3, 256→1, 17→1px, 513→257), totals 21/85, padded 512 dims, `readTileMissingThrows`, no-black-bleed edge parent, `.ready`-gate (tmp without `.ready` ignored), quarantine test (stale dir renamed, ready untouched), size-gate test (>2MiB rejected), direct n→Z map (dz n=0 smallest == Z0). | TASK-004 | `mvn -q test -Dtest=TileMathTest` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=TileMathTest
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 1 4096 4096
find data/images/0 data/images/1 -name "*.jpg" | wc -l
ls data/images/0/.ready data/images/1/.ready
bash -n scripts/import_vips.sh
```

## Notes for Implementer

- This phase owns the whole tile foundation (store + ingest + import + registry) precisely so later phases never create a forward compile edge — the v1.4 HTTP→IngestTool inversion is gone.
- Publish path is identical for synthetic and vips flows: tmp → validate → `.ready` → atomic rename; published stores immutable.
