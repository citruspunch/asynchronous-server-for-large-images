#!/usr/bin/env bash
# Validated vips importer: dzsave (onetile) + tree transform + post-pad + atomic publish.
#
# SCALING NOTE. The naive form of this script spawned `vipsheader` twice per tile
# in the post-pad pass and twice more in validation. Each spawn costs ~63 ms, so
# that was ~250 ms of pure process-startup per tile and ~24 h for a 350k-tile
# pyramid, while the actual image work (vips dzsave) was under a second. Every
# dimension probe here is therefore either batched (one vipsheader call for many
# files, which prints one width per line in argument order) or restricted to the
# tiles that can actually differ. Interior tiles are 512x512 by construction:
# dzsave only clips the right and bottom edges of each level, so edge tiles are
# the only ones worth probing and most pyramids have far fewer of them.
#
# PORTABILITY. This must run under the bash 3.2 that macOS ships, so: no mapfile,
# no ${var,,}, no associative arrays. Standard Unix userland only, per the
# authoritative build contract.
set -euo pipefail

# usage: import_vips.sh [--data-root <dir>] [--resume] [--dry-run] <src> <id>
# --data-root must match the server's --data-root (or its default) or the
# pyramid lands where the server does not look. check_const_parity.py asserts
# the two DEFAULTS agree; passing it here only changes this invocation.
#
# --resume continues an interrupted import whose dzsave already completed
# (.tmp-<id>/.dzsave-done exists) instead of quarantining the staging tree and
# re-encoding. --dry-run stops after the preflight checks, before any staging.
data_root="data/images"
resume=0
dry_run=0
positional=()
while (( $# > 0 )); do
  case "$1" in
    --data-root)
      if (( $# < 2 )) || [[ -z "${2:-}" ]]; then
        echo "--data-root requires a non-empty directory" >&2
        exit 2
      fi
      data_root="$2"
      shift 2
      ;;
    --resume)
      resume=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --*)
      echo "unknown option: $1" >&2
      echo "usage: import_vips.sh [--data-root <dir>] [--resume] [--dry-run] <src> <id>" >&2
      exit 2
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done
if (( ${#positional[@]} != 2 )); then
  echo "usage: import_vips.sh [--data-root <dir>] [--resume] [--dry-run] <src> <id>" >&2
  exit 2
fi
src="${positional[0]}"
id="${positional[1]}"

# Quarantined STAGING retention.
#
# A leftover .tmp-<id>/ is by construction never published and never reachable
# by the registry, so the next import quarantines it rather than deleting it.
# That is safe but NOT free: at grading scale a partial pyramid is tens of
# gigabytes, so repeated crashed imports would silently fill the volume with
# .stale-tmp-* directories that nothing ever reclaims. Bounded retention keeps
# the most recent STALE_TMP_KEEP for inspection and reclaims the rest.
#
# Target quarantine (.stale-<id>-*) is deliberately NOT pruned: that content sat
# at the published path and may be an image an operator cares about.
STALE_TMP_KEEP="${ULTRASTILE_STALE_TMP_KEEP:-2}"

prune_stale_staging() {
  local keep="$STALE_TMP_KEEP"
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=2
  local -a stale=()
  local d
  for d in "$base"/.stale-tmp-*; do
    [ -d "$d" ] && stale+=("$d")
  done
  if (( ${#stale[@]} <= keep )); then
    return 0
  fi
  # Names end in an epoch, so a lexicographic sort is chronological.
  local sorted
  sorted="$(printf '%s\n' "${stale[@]}" | LC_ALL=C sort)"
  # Delete everything except the LAST `keep` entries (the newest). Indexing
  # forward avoids the off-by-one a countdown gives: with 5 stale and keep=2 a
  # countdown tested after decrementing would keep 3.
  # NB: n must be the array length -- `$#` is the function's own argument
  # count, which is 0.
  local n=${#stale[@]}
  local idx=0
  local reclaimed=0
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    idx=$((idx + 1))
    if (( idx > n - keep )); then
      continue
    fi
    local sz
    sz="$(du -sk "$f" 2>/dev/null | awk '{print $1}')"
    [[ "$sz" =~ ^[0-9]+$ ]] || sz=0
    if rm -rf "$f"; then
      reclaimed=$((reclaimed + sz))
      echo "pruned stale staging $(basename "$f") (${sz} KiB)"
    fi
  done <<< "$sorted"
  if (( reclaimed > 0 )); then
    echo "reclaimed ${reclaimed} KiB of stale staging (kept newest ${keep})"
  fi
}

# Canonical-ID gate FIRST, BEFORE any path use.
if ! [[ "$id" =~ ^[0-9]+$ ]]; then
  echo "invalid id (must be decimal 0..65535): $id" >&2
  exit 2
fi
if [[ "$id" != "0" && "$id" == 0* ]]; then
  echo "invalid id (leading zeros rejected): $id" >&2
  exit 2
fi
parsed=$((10#$id))
if (( parsed < 0 || parsed > 65535 )); then
  echo "invalid id (must be decimal 0..65535): $id" >&2
  exit 2
fi
canon="$parsed"

if [[ "$canon" == "0" || "$canon" == "1" ]]; then
  echo "WARNING: image-$canon is a startup demo id; do not start the server until this import publishes." >&2
  echo "         Startup demo-ensure would quarantine .tmp-$canon and publish a synthetic demo instead." >&2
fi

base="$data_root"
target="$base/$canon"
tmp="$base/.tmp-$canon"
total_t0=$SECONDS
progress_file="$tmp/.progress"

# One-line phase/status file for watchers. Directory traversals over a
# 100k-file level are slow (and can hang entirely under load), so the importer
# keeps this single small file current instead; read it, never `du` the tree.
progress() {
  printf 'phase=%s %s\n' "$1" "${2:-}" > "$progress_file" 2>/dev/null || true
}

# Preconditions. `vipsheader` is the pre-dimension gate and `vips` does the work.
for tool in vips vipsheader; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool (Homebrew keeps libvips keg-only; add /opt/homebrew/opt/vips/bin to PATH)" >&2
    exit 2
  fi
done
if [[ ! -f "$src" ]]; then
  echo "no such source file: $src" >&2
  exit 2
fi

if [[ -e "$target/.ready" ]]; then
  echo "already-ready image-$canon"
  exit 0
fi
if (( resume )); then
  if [[ ! -d "$tmp" ]]; then
    echo "--resume: no staging tree at $tmp" >&2
    exit 2
  fi
  if [[ ! -f "$tmp/.dzsave-done" ]]; then
    echo "--resume: $tmp/.dzsave-done is missing; this staging is not resumable" >&2
    echo "  (run without --resume to quarantine it and rebuild from scratch)" >&2
    exit 2
  fi
  echo "resuming: dzsave already complete"
else
  if (( ! dry_run )) && [[ -e "$tmp" ]]; then
    epoch="$(date +%s)"
    mv "$tmp" "$base/.stale-tmp-$canon-$epoch"
    echo "recovered leftover staging to .stale-tmp-$canon-$epoch"
  fi
fi
if (( ! dry_run )) && [[ -e "$target" ]]; then
  epoch="$(date +%s)"
  mv "$target" "$base/.stale-$canon-$epoch"
  echo "quarantined non-ready target to .stale-$canon-$epoch"
fi

# PRE-DIMENSION GATE + FEASIBILITY REPORT (before any expensive work).
#
# The dimension ceiling is DERIVED, not chosen: an image is addressable only
# while its finest level needs no more tiles per axis than the UTP protocol can
# name, and the largest legal tile coordinate is 65535. So
#   max dimension = (max tile coordinate + 1) * tile size = 65536 * 512 = 33554432
# This mirrors UtpMessages.maxRepresentableDim() and
# PyramidTileStore.checkRepresentable(); check_const_parity.py asserts the three
# stay in agreement. There is deliberately no other dimension cap here: an image
# wider than the old 262144 is refused only if its tile grid genuinely cannot be
# addressed, or if the resource policy below declines it.
TILE=512
MAX_TILE_COORD=65535
MAX_TILES_PER_AXIS=$((MAX_TILE_COORD + 1))
MAX_DIM=$((MAX_TILES_PER_AXIS * TILE))
# Operational policy, mirroring Config.IMPORT_MAX_TILES.
IMPORT_MAX_TILES=16777216
# Space policy, two tiers, because JPEG Q85 tile size is content-dependent and
# cannot be predicted from the source file size:
#
#   MIN_TILE_BYTES  a hard FLOOR (4 KiB/tile). Refuses only what cannot possibly
#                   fit. This part IS predictable: every tile is non-empty.
#   PLAN_TILE_BYTES a PLANNING figure (128 KiB/tile), taken from the measured
#                   median of the real ESO imports (128-147 KB; a 93 GB PNG
#                   import measured ~170 KB/tile, so treat it as content-
#                   dependent). Warns when headroom is thin; never refuses.
#
# The gap between the tiers matters. At 4 KiB/tile a 45,252-tile image "needs"
# 185 MB, so the hard floor alone would wave through an import whose real output
# is ~6 GB, which then dies of ENOSPC partway and leaves a quarantined
# .stale-tmp-* tree behind. The planning tier is what catches that.
MIN_TILE_BYTES=4096
PLAN_TILE_BYTES=131072

w="$(vipsheader -f width "$src")" || { echo "cannot read dimensions: $src (unsupported loader or unreadable file)" >&2; exit 2; }
h="$(vipsheader -f height "$src")" || { echo "cannot read dimensions: $src (unsupported loader or unreadable file)" >&2; exit 2; }
if (( w < 1 || h < 1 )); then
  echo "invalid dimensions ${w}x${h}: both axes must be >= 1" >&2
  exit 2
fi

# Representability: tiles per axis on the finest level must fit the protocol.
cols_finest=$(( (w + TILE - 1) / TILE ))
rows_finest=$(( (h + TILE - 1) / TILE ))
if (( cols_finest > MAX_TILES_PER_AXIS || rows_finest > MAX_TILES_PER_AXIS )); then
  echo "tile grid exceeds protocol coordinate range: ${w}x${h} needs ${cols_finest}x${rows_finest} tiles per axis" >&2
  echo "  but the protocol addresses at most ${MAX_TILES_PER_AXIS} per axis (coordinate bound ${MAX_TILE_COORD} x ${TILE}px tiles = ${MAX_DIM}px)" >&2
  exit 2
fi

# Pyramid shape. All arithmetic below is bash 64-bit signed, and every operand
# is already bounded by the representability gate above (w,h <= 33554432), so the
# largest intermediate is 33554432^2 ~= 1.1e15 for pixels and ~5.7e9 for tiles.
# Both fit comfortably; no silent overflow is possible past this point.
max="$w"
if (( h > max )); then max="$h"; fi
depth_n=0
size=$TILE
while (( size < max )); do
  size=$((size * 2))
  depth_n=$((depth_n + 1))
done
levels=$((depth_n + 1))

total_tiles=0
for (( z = 0; z <= depth_n; z++ )); do
  div=$(( 1 << (depth_n - z) ))
  lw=$(( (w + div - 1) / div )); if (( lw < 1 )); then lw=1; fi
  lh=$(( (h + div - 1) / div )); if (( lh < 1 )); then lh=1; fi
  total_tiles=$(( total_tiles + ((lw + TILE - 1) / TILE) * ((lh + TILE - 1) / TILE) ))
done

echo "feasibility: ${w}x${h}  pixels=$(( w * h ))  levels=${levels}  finest=${cols_finest}x${rows_finest} tiles  total_tiles=${total_tiles}"

if (( total_tiles > IMPORT_MAX_TILES )); then
  echo "pyramid tile count ${total_tiles} exceeds operational limit ${IMPORT_MAX_TILES}" >&2
  echo "  raise Config.IMPORT_MAX_TILES / IMPORT_MAX_TILES deliberately if this is intended" >&2
  exit 2
fi

# Surface quarantined staging from earlier crashed runs, since it silently
# reduces the space available for this import.
stale_bytes=0
for d in "$base"/.stale-tmp-*; do
  [ -d "$d" ] || continue
  sz="$(du -sk "$d" 2>/dev/null | awk '{print $1}')"
  [[ "$sz" =~ ^[0-9]+$ ]] || sz=0
  stale_bytes=$((stale_bytes + sz))
done
if (( stale_bytes > 0 )); then
  echo "  note: ${stale_bytes} KiB held by quarantined staging from earlier runs (pruned after this import)"
fi

# Free space on the target volume, checked against a per-tile FLOOR (see
# MIN_TILE_BYTES above). This is a refusal only when fitting is impossible; it
# never claims to predict the real output size.
# The data root itself may not exist yet (a fresh --data-root target), so walk
# up to the nearest existing ancestor and measure THAT filesystem: it is the one
# the pyramid will be created on. The substitution is guarded because a failure
# here must degrade to "unknown", never abort an otherwise valid import under
# `set -e`.
probe="$base"
while [[ -n "$probe" && ! -d "$probe" ]]; do
  parent="$(dirname "$probe")"
  if [[ "$parent" == "$probe" ]]; then probe=""; break; fi
  probe="$parent"
done
avail_kb=""
if [[ -n "$probe" ]]; then
  avail_kb="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
fi
if [[ -n "$avail_kb" ]]; then
  need_kb=$(( total_tiles * MIN_TILE_BYTES / 1024 ))
  if (( need_kb > avail_kb )); then
    echo "insufficient space on target volume: floor requirement ${need_kb} KiB (${total_tiles} tiles x ${MIN_TILE_BYTES} B) but only ${avail_kb} KiB available in $base" >&2
    echo "  note: actual Q85 tile bytes are content-dependent; this is a floor, not an estimate" >&2
    exit 2
  fi
  echo "space floor ok: need >= ${need_kb} KiB, ${avail_kb} KiB available on $probe (for $base)"
  # Planning estimate: advisory only, because tile bytes are content-dependent.
  plan_kb=$(( total_tiles * PLAN_TILE_BYTES / 1024 ))
  if (( avail_kb < plan_kb )); then
    echo "  WARNING: planning estimate for this pyramid is ~${plan_kb} KiB" >&2
    echo "           (${total_tiles} tiles x ${PLAN_TILE_BYTES} B) but only ${avail_kb} KiB is free." >&2
    echo "           The hard floor passed, so this is ADVISORY, not a refusal --" >&2
    echo "           but a mid-import ENOSPC is likely and would leave a" >&2
    echo "           quarantined .stale-tmp-* tree. Free space before importing." >&2
  else
    echo "  planning estimate ~${plan_kb} KiB fits within ${avail_kb} KiB free"
  fi
else
  echo "  (could not determine free space for $base; skipping space floor check)"
fi

dzsave_s=0
transform_s=0
postpad_s=0
validation_s=0

if (( dry_run )); then
  echo "dry-run: preflight passed; nothing was staged"
  exit 0
fi

if (( resume )); then
  echo "resuming after dzsave; skipping re-encode"
  progress dzsave "resumed (already complete)"
else
  mkdir -p "$tmp"
  progress dzsave "start (${total_tiles} tiles)"
  dzsave_t0=$SECONDS
  vips dzsave "$src" "$tmp/pyr" --depth onetile --tile-size 512 --overlap 0 --skip-blanks -1 --suffix '.jpg[Q=85]'
  touch "$tmp/.dzsave-done"
  dzsave_s=$((SECONDS - dzsave_t0))
  progress dzsave "done in ${dzsave_s}s"
fi

# Transform the libvips output tree into the staged canonical tree. Each
# `pyr_files/<N>/` becomes `level-<N>/` with ONE directory rename: no tile is
# touched individually, so the phase costs one metadata operation per level and
# does not scale with the tile count. (The naive per-file form cost hours on a
# USB HDD at 160k tiles; the rename is seconds.)
#
# A level directory must contain tiles only. The importer's own name-set check
# tolerates extras, but verify_pyramid.py counts any extra file as unexpected,
# so non-JPEG regular files (libvips metadata) are deleted, and an entry that is
# not a regular file refuses the import instead of being deleted silently.
transform_t0=$SECONDS
for ndir in "$tmp"/pyr_files/*/; do
  [ -d "$ndir" ] || continue
  ndir="${ndir%/}"
  n="$(basename "$ndir")"
  dest="$tmp/level-$n"
  progress transform "level-$n"
  if [ -e "$dest" ]; then
    echo "transform target already exists: $dest" >&2
    exit 1
  fi
  mv "$ndir" "$dest"
  bad="$(find "$dest" -mindepth 1 -maxdepth 1 ! -name '*.jpg' ! -type f -print -quit)"
  if [ -n "$bad" ]; then
    echo "unexpected non-file entry under $dest: $bad" >&2
    exit 1
  fi
  extra="$(find "$dest" -mindepth 1 -maxdepth 1 -type f ! -name '*.jpg' -print)"
  if [ -n "$extra" ]; then
    echo "removing non-tile files from $dest:"
    printf '%s\n' "$extra"
    find "$dest" -mindepth 1 -maxdepth 1 -type f ! -name '*.jpg' -exec rm -f {} +
  fi
done
transform_s=$((SECONDS - transform_t0))
rm -f "$tmp/pyr.dzi"
rm -rf "$tmp/pyr_files"

# depth_n and levels are computed once in the pre-dimension gate above, before
# any expensive work, so the same values drive the encode, the validation passes
# and the reported feasibility summary.

# EDGE_NAMES receives the tiles of a level that dzsave may have emitted short:
# the last column and the last row. Every other tile is 512x512 by construction,
# so probing the rest is pure cost. Written into a global because bash 3.2 has
# no namerefs.
#
# Degenerate levels need no special case: when a level is 1xN, Nx1 or 1x1 every
# tile satisfies tx==cols-1 or ty==rows-1, so all of them are returned. That
# matters because the single-tile overview level (z=0) is smaller than 512 and
# still has to be padded to the documented 512x512 post-pad invariant.
EDGE_NAMES=()
load_edges() {
  local cols="$1" rows="$2"
  local tx ty
  EDGE_NAMES=()
  for (( ty = 0; ty < rows; ty++ )); do
    for (( tx = 0; tx < cols; tx++ )); do
      if (( tx == cols - 1 || ty == rows - 1 )); then
        EDGE_NAMES+=("$tx"'_'"$ty.jpg")
      fi
    done
  done
}

# Runs `vipsheader -f <field>` over many files in one process, chunked to stay
# clear of ARG_MAX, one result per line on stdout in input order.
batched_header() {
  local field="$1"; shift
  local chunk=()
  local f
  for f in "$@"; do
    chunk+=("$f")
    if (( ${#chunk[@]} >= 400 )); then
      vipsheader -f "$field" "${chunk[@]}"
      chunk=()
    fi
  done
  if (( ${#chunk[@]} > 0 )); then
    vipsheader -f "$field" "${chunk[@]}"
  fi
}

# Reads newline-separated values into the array named by $1 (again avoiding
# namerefs, which bash 3.2 lacks).
HEADER_VALS=()
read_lines() {
  local line
  HEADER_VALS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    HEADER_VALS+=("$line")
  done
}

# Level geometry, printed as "lw lh cols rows" for the current depth_n.
level_geometry() {
  local z="$1" div lw lh
  div=$((1 << (depth_n - z)))
  lw=$(((w + div - 1) / div)); if (( lw < 1 )); then lw=1; fi
  lh=$(((h + div - 1) / div)); if (( lh < 1 )); then lh=1; fi
  printf '%d %d %d %d\n' "$lw" "$lh" "$(((lw + 511) / 512))" "$(((lh + 511) / 512))"
}

# Probes the edge tiles of a level that actually exist on disk, using batched
# vipsheader calls. Results land in PROBE_FILES / PROBE_WIDTHS / PROBE_HEIGHTS.
# Tiles that are absent are skipped here so the name-set validation below reports
# them precisely, instead of the failure surfacing as a header-read error.
#
# NOTE on the ${a[@]+"${a[@]}"} expansions: under `set -u`, bash 3.2 treats
# "${a[@]}" on an EMPTY array as an unbound variable and aborts. That idiom is the
# portable way to expand an array that may be empty.
PROBE_FILES=(); PROBE_WIDTHS=(); PROBE_HEIGHTS=()
probe_edges() {
  local z="$1" cols="$2" rows="$3"
  local name
  local edges=()
  PROBE_FILES=(); PROBE_WIDTHS=(); PROBE_HEIGHTS=()
  load_edges "$cols" "$rows"
  for name in ${EDGE_NAMES[@]+"${EDGE_NAMES[@]}"}; do
    if [ -f "$tmp/level-$z/$name" ]; then
      edges+=("$tmp/level-$z/$name")
    fi
  done
  if (( ${#edges[@]} == 0 )); then return 0; fi
  read_lines < <(batched_header width  ${edges[@]+"${edges[@]}"}); PROBE_WIDTHS=(${HEADER_VALS[@]+"${HEADER_VALS[@]}"})
  read_lines < <(batched_header height ${edges[@]+"${edges[@]}"}); PROBE_HEIGHTS=(${HEADER_VALS[@]+"${HEADER_VALS[@]}"})
  if (( ${#PROBE_WIDTHS[@]} != ${#edges[@]} || ${#PROBE_HEIGHTS[@]} != ${#edges[@]} )); then
    echo "header read failed at level-$z (${#PROBE_WIDTHS[@]}/${#PROBE_HEIGHTS[@]} of ${#edges[@]})" >&2
    exit 1
  fi
  PROBE_FILES=(${edges[@]+"${edges[@]}"})
}

# A killed run can leave importer-internal *.pad.jpg scratch files behind (the
# embed finished, its mv did not). Only a resumed staging can carry them, and
# validation counts any extra file as a mismatch, so reclaim them first.
if (( resume )); then
  stale_pads="$(find "$tmp" -name '*.pad.jpg' -type f -print)"
  if [ -n "$stale_pads" ]; then
    echo "removing stray pad scratch files:"
    printf '%s\n' "$stale_pads"
    find "$tmp" -name '*.pad.jpg' -type f -exec rm -f {} +
  fi
fi

# Post-pad pass: dzsave emits clipped edge extents; every staged tile must be
# 512x512. Probe only edge tiles, in batches, and pad only the ones that are
# genuinely short.
postpad_t0=$SECONDS
for (( z = 0; z <= depth_n; z++ )); do
  progress postpad "level-$z"
  read -r lw lh cols rows <<< "$(level_geometry "$z")"
  probe_edges "$z" "$cols" "$rows"
  for (( i = 0; i < ${#PROBE_FILES[@]}; i++ )); do
    if [[ "${PROBE_WIDTHS[$i]}" == "512" && "${PROBE_HEIGHTS[$i]}" == "512" ]]; then
      continue
    fi
    tile="${PROBE_FILES[$i]}"
    pad="${tile%.jpg}.pad.jpg"
    vips embed "$tile" "$pad[Q=85]" 0 0 512 512 --extend black && mv "$pad" "$tile"
  done
done
postpad_s=$((SECONDS - postpad_t0))

# Validate: every expected tile present exactly once, no extras, and within the
# size gate. Name sets are compared per level with two sorts rather than a stat
# per file, and the size gate is one `find` over the whole tree.
expected_list="$(mktemp)"
actual_list="$(mktemp)"
trap 'rm -f "$expected_list" "$actual_list"' EXIT
validation_t0=$SECONDS

for (( z = 0; z <= depth_n; z++ )); do
  progress validate "name-set level-$z"
  read -r lw lh cols rows <<< "$(level_geometry "$z")"
  : > "$expected_list"
  for (( ty = 0; ty < rows; ty++ )); do
    for (( tx = 0; tx < cols; tx++ )); do
      printf '%d_%d.jpg\n' "$tx" "$ty" >> "$expected_list"
    done
  done
  for f in "$tmp/level-$z"/*.jpg; do
    [ -f "$f" ] && printf '%s\n' "${f##*/}"
  done | LC_ALL=C sort > "$actual_list"
  LC_ALL=C sort "$expected_list" -o "$expected_list"

  if ! cmp -s "$expected_list" "$actual_list"; then
    missing="$(LC_ALL=C comm -23 "$expected_list" "$actual_list" | head -3 | tr '\n' ' ')"
    extra="$(LC_ALL=C comm -13 "$expected_list" "$actual_list" | head -3 | tr '\n' ' ')"
    echo "tile set mismatch at level-$z (missing: ${missing:-none}; extra: ${extra:-none})" >&2
    exit 1
  fi
done

# Size gate across every tile in one pass: reject empty or oversize JPEGs.
progress validate "size-gate"
empty_tile="$(find "$tmp" -name '*.jpg' -size -1c -print -quit)"
if [[ -n "$empty_tile" ]]; then
  echo "empty tile: $empty_tile" >&2
  exit 1
fi
oversize="$(find "$tmp" -name '*.jpg' -size +2097152c -print -quit)"
if [[ -n "$oversize" ]]; then
  echo "tile size gate failed: $oversize" >&2
  exit 1
fi

# Final edge-tile geometry assertion, now that padding has run. The name-set
# check above has already established that every expected tile exists, so here a
# short tile means padding did not take effect.
for (( z = 0; z <= depth_n; z++ )); do
  progress validate "edge level-$z"
  read -r lw lh cols rows <<< "$(level_geometry "$z")"
  probe_edges "$z" "$cols" "$rows"
  for (( i = 0; i < ${#PROBE_FILES[@]}; i++ )); do
    if [[ "${PROBE_WIDTHS[$i]}" != "512" || "${PROBE_HEIGHTS[$i]}" != "512" ]]; then
      echo "tile not 512x512: ${PROBE_FILES[$i]} (${PROBE_WIDTHS[$i]}x${PROBE_HEIGHTS[$i]})" >&2
      exit 1
    fi
  done
done
validation_s=$((SECONDS - validation_t0))

rm -f "$tmp/.dzsave-done" "$tmp/.progress"
printf '{"id":%s,"name":"image-%s","w":%s,"h":%s,"levels":%s,"tile":512}' "$canon" "$canon" "$w" "$h" "$levels" > "$tmp/meta.json"
touch "$tmp/.ready"
if [[ -e "$target" ]]; then
  echo "refusing to publish: target appeared during import: $target" >&2
  exit 1
fi
mv "$tmp" "$target"
prune_stale_staging
echo "imported image-$canon (${w}x${h}, $levels levels)"
echo "timings: dzsave=${dzsave_s}s transform=${transform_s}s postpad=${postpad_s}s validation=${validation_s}s total=$((SECONDS - total_t0))s"
