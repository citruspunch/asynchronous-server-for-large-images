#!/usr/bin/env bash
# Validated vips importer: dzsave (onetile) + tree transform + post-pad + atomic publish.
set -euo pipefail

src="${1:-}"
id="${2:-}"

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

base="data/images"
target="$base/$canon"
tmp="$base/.tmp-$canon"

if [[ -e "$target/.ready" ]]; then
  echo "already-ready image-$canon"
  exit 0
fi
if [[ -e "$tmp" ]]; then
  epoch="$(date +%s)"
  mv "$tmp" "$base/.stale-tmp-$canon-$epoch"
  echo "recovered leftover staging to .stale-tmp-$canon-$epoch"
fi
if [[ -e "$target" ]]; then
  epoch="$(date +%s)"
  mv "$target" "$base/.stale-$canon-$epoch"
  echo "quarantined non-ready target to .stale-$canon-$epoch"
fi

# PRE-DIMENSION GATE (before any expensive work).
w="$(vipsheader -f width "$src")" || { echo "cannot read dimensions: $src" >&2; exit 2; }
h="$(vipsheader -f height "$src")" || { echo "cannot read dimensions: $src" >&2; exit 2; }
if (( w < 1 || h < 1 )); then
  echo "invalid dimensions: ${w}x${h}" >&2
  exit 2
fi
if (( w > 262144 || h > 262144 )); then
  echo "too large (max 262144): ${w}x${h}" >&2
  exit 2
fi

mkdir -p "$tmp"
vips dzsave "$src" "$tmp/pyr" --depth onetile --tile-size 512 --overlap 0 --skip-blanks -1 --suffix '.jpg[Q=85]'

# Transform the libvips output tree into the staged canonical tree.
for ndir in "$tmp"/pyr_files/*/; do
  [ -d "$ndir" ] || continue
  n="$(basename "$ndir")"
  mkdir -p "$tmp/level-$n"
  for f in "$ndir"*.jpg; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"
    mv "$f" "$tmp/level-$n/$b"
  done
done
rm -f "$tmp/pyr.dzi"
rm -rf "$tmp/pyr_files"

# Post-pad pass: dzsave emits clipped edge extents; every staged tile must be 512x512.
for tile in "$tmp"/level-*/*.jpg; do
  [ -f "$tile" ] || continue
  tw="$(vipsheader -f width "$tile")"
  th="$(vipsheader -f height "$tile")"
  if [[ "$tw" != "512" || "$th" != "512" ]]; then
    pad="${tile%.jpg}.pad.jpg"
    vips embed "$tile" "$pad[Q=85]" 0 0 512 512 --extend black && mv "$pad" "$tile"
  fi
done

# Compute expected pyramid depth from source dims.
max="$w"
if (( h > max )); then max="$h"; fi
depth_n=0
size=512
while (( size < max )); do
  size=$((size * 2))
  depth_n=$((depth_n + 1))
done
levels=$((depth_n + 1))

# Validate: every expected tile present, 512x512, within size gate.
for (( z = 0; z <= depth_n; z++ )); do
  shift=$((depth_n - z))
  div=$((1 << shift))
  lw=$(((w + div - 1) / div))
  if (( lw < 1 )); then lw=1; fi
  lh=$(((h + div - 1) / div))
  if (( lh < 1 )); then lh=1; fi
  cols=$(((lw + 511) / 512))
  rows=$(((lh + 511) / 512))
  for (( ty = 0; ty < rows; ty++ )); do
    for (( tx = 0; tx < cols; tx++ )); do
      f="$tmp/level-$z/${tx}_${ty}.jpg"
      if [[ ! -f "$f" ]]; then
        echo "missing tile: $f" >&2
        exit 1
      fi
      tw="$(vipsheader -f width "$f")"
      th="$(vipsheader -f height "$f")"
      if [[ "$tw" != "512" || "$th" != "512" ]]; then
        echo "tile not 512x512: $f" >&2
        exit 1
      fi
      sz="$(wc -c < "$f")"
      if (( sz <= 0 || sz > 2097152 )); then
        echo "tile size gate failed: $f" >&2
        exit 1
      fi
    done
  done
done

printf '{"id":%s,"name":"image-%s","w":%s,"h":%s,"levels":%s,"tile":512}' "$canon" "$canon" "$w" "$h" "$levels" > "$tmp/meta.json"
touch "$tmp/.ready"
mv "$tmp" "$target"
echo "imported image-$canon (${w}x${h}, $levels levels)"
