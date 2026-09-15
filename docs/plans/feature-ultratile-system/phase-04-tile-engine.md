---
phase: phase-04-tile-engine
goal: GOAL-004 Ceiling store plus google import plus streaming padded ingest
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 04 — Tile Engine ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-001**: Java 20/21 async server serves ultra-high-resolution images with progressive/selective loading via 512x512 tiling (ceiling pyramid, padded edge tiles, layer compositing); never serves full ultra-res image.
  - **REQ-008**: 512x512 JPEG Q85 pyramid with padded edges via `scripts/import_vips.sh` running `vips dzsave <src> <tmp> --layout google --depth onetile --tile-size 512 --overlap 0 --background 0 --skip-blanks -1 --Q 85` then normalizing to `data/images/{id}/level-{Z}/tile-{X}-{Y}.jpg` + `meta.json` validated to PAT-001; or streaming synthetic fallback (finest from global coords, parents crop-mosaic-then-downsample, pad output); startup auto-generates 2048 + 4096 demos if absent; never advertise missing files.
  - **PAT-001**: `N=max(0,ceil(log2(max(W,H)/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; ceil-div only.
- Prior-phase deps:
  - **DEP-003**: Requires phase-01 layout; contract `ImageRegistry`.
- Inputs: empty `data/images/`. Outputs: dual-demo pyramids (21 + 85 tiles), import script, channel API.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`: `TILE=512`, `levelCount=max(0,ceil(log2(max/512)))+1`, `levelW=ceildiv(W,1<<(N-Z))` min 1, `cols=ceildiv`, `actualW=min(512,Wz-x*512)`; `openTileChannel(id,z,x,y)` + `tileSize(path)` for transferTo-loop; optional `hasJpegMarkers(path)` SOI (`FFD8`)/EOI (`FFD9`) pre-check only (corrupt-JPEG authority is browser decode, server skips only missing/unreadable); test-only `readTile` byte[]; validate id/z/coords; edge invariant: stored JPEG always 512x512 padded. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create streaming `NEW src/main/java/com/ultratile/tiles/IngestTool.java`: `<id> <w> <h>`; finest tiles from `pixel(gx,gy)` independently; parents by reading ≤4 children, cropping mosaic to actual source dims BEFORE 2x downsample to actual parent dims, then padding OUTPUT to 512 (never shrink black padding into edge pixels); Q85; `meta.json` with levels. Demos: `0 2048 2048` → N=2, 1+4+16=21 tiles (corrects v1.2 `4+4+16=24`); `1 4096 4096` → N=3, 1+4+16+64=85 tiles. Peak ≤~5 MB. | TASK-001 | `IngestTool 0 2048 2048 && IngestTool 1 4096 4096` produce 21 + 85 JPEGs |  |  |
| TASK-003 | Create `NEW scripts/import_vips.sh <src> <id>`: runs `vips dzsave <src> <tmp> --layout google --depth onetile --tile-size 512 --overlap 0 --background 0 --skip-blanks -1 --Q 85` (google pads edges; `one` forbidden — it emits highest layer only), maps google output levels to `level-{Z}` (reverse numbering validated), renames to `tile-{X}-{Y}.jpg`, writes `meta.json`, validates every level counts vs PAT-001 + every coordinate exists + JPEG 512x512, rejects incomplete. | TASK-001 | `bash -n scripts/import_vips.sh` passes |  |  |
| TASK-004 | Create `NEW src/test/java/com/ultratile/tiles/TileMathTest.java`: `levelCount(2048)==3`, `256→1`, `17→1px min`, `513→257`, half-open helper `ceildiv`, `actualW(2000,x=3)==464`, 2048 total 21 + 4096 total 85, padded 512 dims, `readTileMissingThrows`, parent-edge no-black-bleed (edge parent corner pixel differs from pure black padding when source non-black). | TASK-001 | `mvn -q test -Dtest=TileMathTest` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=TileMathTest
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 1 4096 4096
find data/images/0 data/images/1 -name "*.jpg" | wc -l
bash -n scripts/import_vips.sh
```

## Notes for Implementer

- `onetile` (shrink until one tile) + `google` (pads edges) is the only valid dzsave combo for this store; `--depth one` and default DeepZoom must not be used.
- Crop-then-downsample-then-pad order is mandatory for odd/padded edges.
- Missing/unreadable → skip + SKIPPED; corrupt JPEG → browser `createImageBitmap` rejection path (phase-06), server does not claim decode detection.
