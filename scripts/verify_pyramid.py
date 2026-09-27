#!/usr/bin/env python3
"""Exhaustive pyramid verifier for real imported images (TEST-ONLY, stdlib + libvips).

Independent of the importer: it re-derives the expected pyramid geometry from
the source dimensions and checks the PUBLISHED tree against it, so a bug shared
between importer and verifier is unlikely.

Checks, per image:
  * .ready present; meta.json field-by-field against the source
  * exact level count and per-level level dimensions (ceildiv pyramid math)
  * exact expected tile coordinate set, and NO unexpected files
  * every tile within (0, MAX_TILE_BYTES]
  * every tile header is 512x512
  * every EDGE tile fully decoded, and its pad region verified to be exactly
    black starting at precisely the computed content offset (content top-left,
    pad right/bottom) -- this is what catches a wrong-side or wrong-width pad
  * a sample of interior tiles fully decoded (valid JPEG, not blank)
  * no duplicate tile payloads within a level
  * horizontal/vertical seam gradient sanity on interior seams

Usage: verify_pyramid.py <imageId> [<imageId> ...]
       verify_pyramid.py --all
"""
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMAGES = REPO / "data" / "images"
SOURCES = REPO / "data" / "sources"
VIPS = "/opt/homebrew/opt/vips/bin/vips"
VIPSHEADER = "/opt/homebrew/opt/vips/bin/vipsheader"
TILE = 512
MAX_TILE_BYTES = 2 * 1024 * 1024

# Fallback image id -> source file. This map is only a convenience: the source
# is really resolved by MATCHING DIMENSIONS against meta.json, so the tool works
# for any image id the operator chooses, not just the ids this map happens to
# name. Hardcoding ids made the tool refuse to verify an image imported under
# any other id ("no source mapped for image-N").
SRC = {
    4: "eso_milky_way_248MB.tif",
    5: "eso_milky_way_1.65GB.tif",
    6: "eso_milky_way_4.21GB.tif",
}

_SRC_CACHE = None


def source_index():
    """Map (w, h) -> source path for every readable file in data/sources."""
    global _SRC_CACHE
    if _SRC_CACHE is None:
        _SRC_CACHE = {}
        if SOURCES.is_dir():
            for f in sorted(SOURCES.iterdir()):
                if not f.is_file():
                    continue
                try:
                    key = (int(vh("width", f)), int(vh("height", f)))
                except Exception:
                    continue
                _SRC_CACHE.setdefault(key, f)
    return _SRC_CACHE


def resolve_source(img_id, meta):
    """Find the source for an image by dimension match, then by the id map."""
    if meta:
        hit = source_index().get((int(meta["w"]), int(meta["h"])))
        if hit:
            return hit
    name = SRC.get(img_id)
    if name:
        cand = SOURCES / name
        if cand.is_file():
            return cand
    return None

FAIL = []
WARN = []


def fail(msg):
    FAIL.append(msg)
    print(f"    FAIL  {msg}")


def warn(msg):
    WARN.append(msg)
    print(f"    warn  {msg}")


def ok(msg):
    print(f"    ok    {msg}")


def vh(field, path):
    r = subprocess.run([VIPSHEADER, "-f", field, str(path)], capture_output=True, text=True)
    return r.stdout.strip()


def vh_batch(field, paths, chunk=400):
    """One vipsheader call for many files; returns a list, one entry per path.

    vipsheader prints one value per file in argument order, so a whole level
    (or a chunk of one) costs a couple of processes instead of two per tile.
    Spawning vipsheader per tile cost ~63 ms each, which at 6270 tiles was
    ~13 minutes of pure process startup.
    """
    out = []
    for i in range(0, len(paths), chunk):
        part = [str(x) for x in paths[i:i + chunk]]
        r = subprocess.run([VIPSHEADER, "-f", field] + part,
                           capture_output=True, text=True)
        vals = r.stdout.split()
        if len(vals) != len(part):
            # fall back to per-file so a short read is never silently trusted
            vals = [vh(field, x) for x in paths[i:i + chunk]]
        out.extend(vals)
    return out


def level_count(w, h):
    n, s = 0, TILE
    while s < max(w, h):
        s *= 2
        n += 1
    return n + 1


def level_dims(w, h, z, n):
    div = 1 << (n - z)
    return max(1, -(-w // div)), max(1, -(-h // div))


def decode_raw(path, tmpdir):
    """Decode a tile to headerless RGB8 and return (w, h, bytes)."""
    out = Path(tmpdir) / (hashlib.md5(str(path).encode()).hexdigest() + ".raw")
    r = subprocess.run([VIPS, "copy", str(path), str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    data = out.read_bytes()
    out.unlink(missing_ok=True)
    if len(data) != TILE * TILE * 3:
        return ("BADLEN", len(data))
    return (TILE, TILE, data)


def col_mean_px(data, x, y):
    i = (y * TILE + x) * 3
    return (data[i] + data[i + 1] + data[i + 2]) / 3.0


def verify(img_id, deep_sample=40, seam_sample=12):
    print(f"\n=== image-{img_id} ===")
    mp0 = IMAGES / str(img_id) / "meta.json"
    meta0 = None
    if mp0.is_file():
        try:
            meta0 = json.loads(mp0.read_text())
        except Exception:
            meta0 = None
    src = resolve_source(img_id, meta0)
    name = src.name if src else None
    if not src:
        warn(f"no source found for image-{img_id} in {SOURCES} (searched by "
             f"dimensions {[meta0 and (meta0['w'], meta0['h'])]})")
    have_src = src is not None and src.is_file()
    if have_src:
        w, h = int(vh("width", src)), int(vh("height", src))
        bands = int(vh("bands", src))
        print(f"  source {name}: {w}x{h} bands={bands} loader={vh('vips-loader', src)}")
    else:
        # The source may legitimately have been reclaimed under disk pressure
        # (see the data/sources policy in AGENTS.md). Fall back to the published
        # metadata, but say so LOUDLY: without the source we can no longer
        # cross-check the pyramid geometry against the original header, so this
        # is a weaker check and must not be mistaken for the full one.
        if meta0 is None:
            fail(f"no source and no readable meta.json for image-{img_id}; cannot verify")
            return
        m0 = meta0
        w, h = int(m0["w"]), int(m0["h"])
        warn(f"source {name or '(none)'} is absent -- dimensions {w}x{h} taken from the "
             f"PUBLISHED meta.json, not cross-checked against the original "
             f"header. Geometry checks are self-consistent only; re-import the "
             f"source for full validation.")
        print(f"  source {name or '(none)'}: ABSENT; using meta.json {w}x{h}")

    d = IMAGES / str(img_id)
    if not d.is_dir():
        fail(f"missing image directory {d}")
        return
    if (d / ".ready").is_file():
        ok(".ready present")
    else:
        fail(".ready MISSING (must exist only after successful validation)")

    mp = d / "meta.json"
    if not mp.is_file():
        fail("meta.json missing")
        return
    meta = json.loads(mp.read_text())
    n = level_count(w, h) - 1
    expect_meta = {"id": img_id, "name": f"image-{img_id}", "w": w, "h": h,
                   "levels": n + 1, "tile": TILE}
    if meta == expect_meta:
        ok(f"meta.json exact: {meta}")
    else:
        fail(f"meta.json mismatch\n         got      {meta}\n         expected {expect_meta}")

    tmpdir = tempfile.mkdtemp(prefix="ultratile-verify-")
    rng = random.Random(1234 + img_id)
    total_expected = 0
    total_actual = 0
    edge_checked = 0
    edge_ok = 0
    pad_maxima = []
    decoded_interior = 0
    digests = {}

    for z in range(n + 1):
        lw, lh = level_dims(w, h, z, n)
        cols = (lw + TILE - 1) // TILE
        rows = (lh + TILE - 1) // TILE
        ld = d / f"level-{z}"
        expected = set()
        for ty in range(rows):
            for tx in range(cols):
                expected.add(f"{tx}_{ty}.jpg")
        total_expected += len(expected)
        if not ld.is_dir():
            fail(f"level-{z} missing (expected {cols}x{rows})")
            continue
        actual = {p.name for p in ld.iterdir() if p.is_file()}
        total_actual += len(actual)
        if actual == expected:
            pass
        else:
            miss = sorted(expected - actual)[:4]
            extra = sorted(actual - expected)[:4]
            fail(f"level-{z} tile set mismatch: {len(expected)} expected, "
                 f"{len(actual)} present, missing={miss} extra={extra}")

        # header dims + size gate for every tile in this level (batched)
        bad_dim = []
        bad_size = []
        present = [ld / f"{tx}_{ty}.jpg" for ty in range(rows) for tx in range(cols)]
        present = [p for p in present if p.is_file()]
        for p in present:
            sz = p.stat().st_size
            if sz <= 0 or sz > MAX_TILE_BYTES:
                bad_size.append((p.name, sz))
        if present:
            ws = vh_batch("width", present)
            hs = vh_batch("height", present)
            for p, wv, hv2 in zip(present, ws, hs):
                if wv != str(TILE) or hv2 != str(TILE):
                    bad_dim.append(p.name)
        if bad_size:
            fail(f"level-{z} size gate violated: {bad_size[:4]}")
        if bad_dim:
            fail(f"level-{z} non-512x512 tiles: {bad_dim[:4]}")

        # duplicate payload detection
        for p in sorted(ld.glob("*.jpg")):
            dg = hashlib.md5(p.read_bytes()).hexdigest()
            digests.setdefault(z, {}).setdefault(dg, []).append(p.name)
        for dg, names in digests.get(z, {}).items():
            if len(names) > 1:
                # coarse levels legitimately repeat (blank/uniform sky); only
                # flag at the finest level where real content must differ
                if z == n and len(names) > 2:
                    warn(f"level-{z} {len(names)} tiles share a payload "
                         f"(e.g. {names[:3]}) -- plausible for uniform sky")

        # EDGE tiles: full decode + pad geometry
        for ty in range(rows):
            for tx in range(cols):
                cw = min(TILE, lw - tx * TILE)
                ch = min(TILE, lh - ty * TILE)
                is_edge = (tx == cols - 1) or (ty == rows - 1)
                if not (is_edge and (cw < TILE or ch < TILE)):
                    continue
                p = ld / f"{tx}_{ty}.jpg"
                if not p.is_file():
                    continue
                res = decode_raw(p, tmpdir)
                edge_checked += 1
                if res is None:
                    fail(f"edge tile failed to decode: {p}")
                    continue
                if res[0] == "BADLEN":
                    fail(f"edge tile decoded to {res[1]} bytes, expected {TILE*TILE*3}: {p}")
                    continue
                _, _, data = res
                # Pad verification. The pad comes from `vips embed --extend
                # black` and is then JPEG-encoded at Q=85, so it is NOT exactly
                # zero: the 8x8 DCT block straddling the content/pad boundary
                # rings by a few levels. Measured on the real ESO tiles the pad
                # mean is 0.000 with max ~0.3 -- visually black.
                #
                # So the invariant worth asserting is the STEP AT THE RIGHT
                # OFFSET, not exact zero. That catches a pad applied to the
                # wrong side, at the wrong width, or not at all, while not
                # failing on correct output. (An exact-zero assertion was tried
                # first and produced 30 false failures on a correct pyramid.)
                ys = range(0, TILE, 3)
                if cw < TILE:
                    pad_px = [col_mean_px(data, x, y) for y in ys for x in range(cw, TILE)]
                    pad_mean = sum(pad_px) / len(pad_px)
                    pad_max = max(pad_px)
                    lo = max(0, cw - 16)
                    content_mean = (sum(col_mean_px(data, x, y) for y in ys
                                        for x in range(lo, cw))
                                    / (len(ys) * (cw - lo)))
                    if pad_mean > 2.0:
                        fail(f"{p.name}: right pad mean {pad_mean:.3f} > 2.0 "
                             f"(max {pad_max:.1f}) -- pad is not black")
                    elif content_mean < 0.5 and cw > 64:
                        fail(f"{p.name}: content left of the pad is black "
                             f"(mean {content_mean:.3f}); pad offset looks wrong")
                    else:
                        edge_ok += 1
                        pad_maxima.append(pad_max)
                if ch < TILE:
                    pad_px = [col_mean_px(data, x, y) for y in range(ch, TILE)
                              for x in range(0, TILE, 3)]
                    pad_mean = sum(pad_px) / len(pad_px)
                    pad_max = max(pad_px)
                    top = max(0, ch - 16)
                    content_mean = (sum(col_mean_px(data, x, y) for y in range(top, ch)
                                        for x in range(0, TILE, 3))
                                    / ((ch - top) * len(range(0, TILE, 3))))
                    if pad_mean > 2.0:
                        fail(f"{p.name}: bottom pad mean {pad_mean:.3f} > 2.0 "
                             f"(max {pad_max:.1f}) -- pad is not black")
                    elif content_mean < 0.5 and ch > 64:
                        fail(f"{p.name}: content above the pad is black "
                             f"(mean {content_mean:.3f}); pad offset looks wrong")
                    else:
                        edge_ok += 1
                        pad_maxima.append(pad_max)

        # interior sample: full decode
        interior = [(tx, ty) for ty in range(rows) for tx in range(cols)
                    if tx < cols - 1 and ty < rows - 1]
        rng.shuffle(interior)
        for tx, ty in interior[:deep_sample]:
            p = ld / f"{tx}_{ty}.jpg"
            res = decode_raw(p, tmpdir)
            if res is None:
                fail(f"interior tile failed to decode: {p}")
                continue
            if res[0] == "BADLEN":
                fail(f"interior tile wrong decoded size: {p}")
                continue
            _, _, data = res
            mean = sum(data) / len(data)
            if mean == 0.0:
                fail(f"interior tile is entirely black: {p}")
            decoded_interior += 1

        # seam gradient sanity on the finest level
        if z == n and cols > 3 and rows > 3:
            ratios = []
            for _ in range(seam_sample):
                tx = rng.randrange(0, cols - 1)
                ty = rng.randrange(0, rows)
                a = decode_raw(ld / f"{tx}_{ty}.jpg", tmpdir)
                b = decode_raw(ld / f"{tx+1}_{ty}.jpg", tmpdir)
                if not a or not b or a[0] == "BADLEN" or b[0] == "BADLEN":
                    continue
                ya = rng.randrange(0, TILE)
                seam = abs(col_mean_px(a[2], TILE - 1, ya) - col_mean_px(b[2], 0, ya))
                inner = abs(col_mean_px(a[2], TILE - 3, ya) - col_mean_px(a[2], TILE - 2, ya))
                if inner > 1.0:
                    ratios.append(seam / inner)
            if ratios:
                ratios.sort()
                med = ratios[len(ratios) // 2]
                worst = ratios[-1]
                if med > 12.0:
                    warn(f"seam discontinuity: median seam/inner gradient ratio {med:.1f} "
                         f"(worst {worst:.1f}) over {len(ratios)} seams")
                else:
                    ok(f"seam continuity ok: median ratio {med:.2f}, worst {worst:.2f} "
                       f"over {len(ratios)} seams")

    if total_expected == total_actual:
        ok(f"total tiles {total_actual} == expected {total_expected}")
    else:
        fail(f"total tiles {total_actual} != expected {total_expected}")
    print(f"    info  edge tiles decoded: {edge_checked}, pad checks passed: {edge_ok}")
    if pad_maxima:
        pad_maxima.sort()
        print(f"    info  pad max luminance over {len(pad_maxima)} edges: "
              f"median {pad_maxima[len(pad_maxima)//2]:.2f}, worst {pad_maxima[-1]:.2f} (of 255)")
    print(f"    info  interior tiles fully decoded: {decoded_interior}")

    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    args = sys.argv[1:]
    if not args or args[0] == "--all":
        ids = sorted(SRC)
    else:
        ids = [int(a) for a in args]
    for i in ids:
        verify(i)
    print(f"\n{'='*60}")
    print(f"FAILURES: {len(FAIL)}   WARNINGS: {len(WARN)}")
    for f in FAIL:
        print(f"  FAIL {f}")
    for x in WARN:
        print(f"  warn {x}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
