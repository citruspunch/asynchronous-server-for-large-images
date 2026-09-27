#!/usr/bin/env python3
"""Real-image import measurement harness (TEST-ONLY, stdlib only).

Runs scripts/import_vips.sh -- the production path, unmodified logic -- and
collects per-image evidence: source facts, phase timings, peak RSS, pyramid
geometry and tile-size distribution.

Phase timing is obtained from an INSTRUMENTED COPY of the production script.
The copy is byte-identical except for `echo` lines that print SECONDS markers,
so the work performed is the same; the production script is never modified and
never depends on this harness or on /usr/bin/time.
"""
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
VIPS_BIN = "/opt/homebrew/opt/vips/bin"

# (source basename, image id, expected levels, expected finest cols x rows,
#  expected total tiles) -- the task's stated values, verified not trusted.
LADDER = [
    ("eso_milky_way_248MB.tif", 4, 6, (20, 15), 409),
    ("eso_milky_way_1.65GB.tif", 5, 7, (49, 37), 2470),
    ("eso_milky_way_4.21GB.tif", 6, 8, (79, 59), 6270),
]

PHASE_MARKERS = [
    ('mkdir -p "$tmp"\nvips dzsave', 'preflight_done'),
    ('rm -f "$tmp/pyr.dzi"', 'dzsave_transform_done'),
    ('# Validate: every expected tile present exactly once', 'postpad_done'),
    ('# Size gate across every tile in one pass', 'nameset_done'),
    ('# Final edge-tile geometry assertion', 'sizegate_done'),
    ('echo "imported image-$canon', 'geometry_done'),
]


def instrument(src_text: Path, dest: Path) -> None:
    """Copy the production script, inserting absolute-SECONDS phase markers."""
    text = src_text.read_text()
    for marker, label in PHASE_MARKERS:
        needle = marker if marker in text else marker
        if needle not in text:
            raise SystemExit(f"instrumentation anchor missing: {label}")
        text = text.replace(needle, f'echo "__PHASE__{label}:${{SECONDS}}"\n{needle}', 1)
    dest.write_text(text)


def vipsheader(field: str, path: Path) -> str:
    out = subprocess.run([f"{VIPS_BIN}/vipsheader", "-f", field, str(path)],
                         capture_output=True, text=True)
    return out.stdout.strip()


def vipsheader_batch(field, paths, chunk=400):
    """One vipsheader call per chunk; one value per file, in argument order.

    Spawning vipsheader per tile costs ~63 ms each, so 6270 tiles was ~13
    minutes of pure process startup. Batched, it is a couple of seconds.
    """
    out = []
    for i in range(0, len(paths), chunk):
        part = [str(x) for x in paths[i:i + chunk]]
        r = subprocess.run([f"{VIPS_BIN}/vipsheader", "-f", field] + part,
                           capture_output=True, text=True)
        vals = r.stdout.split()
        if len(vals) != len(part):
            vals = [vipsheader(field, x) for x in paths[i:i + chunk]]
        out.extend(vals)
    return out


def rss_and_wall(cmd, env):
    """Run under /usr/bin/time; return (rc, wall_s, peak_rss_kb, stdout+stderr).

    macOS ships BSD time, which uses -l and reports maximum RSS in BYTES;
    GNU time uses -v and reports kbytes. Both are handled.
    """
    t0 = time.time()
    proc = subprocess.run(["/usr/bin/time", "-l"] + cmd, capture_output=True,
                          text=True, env=env)
    wall = time.time() - t0
    out = proc.stdout + proc.stderr
    peak = None
    # BSD (macOS): "    12345678  maximum resident set size (bytes)"
    m = re.search(r"(\d+)\s+maximum resident set size", out)
    if m:
        peak = int(m.group(1)) // 1024
    else:
        # GNU: "Maximum resident set size (kbytes): 123456"
        m = re.search(r"Maximum resident set size \(kbytes\): (\d+)", out)
        if m:
            peak = int(m.group(1))
    return proc.returncode, wall, peak, out


def phases(output: str):
    found = {}
    for line in output.splitlines():
        m = re.match(r"__PHASE__(\w+):(\d+)", line.strip())
        if m:
            found[m.group(1)] = int(m.group(2))
    return found


def tile_stats(pyr: Path):
    sizes = []
    per_level = {}
    for lvl in sorted(pyr.glob("level-*")):
        ls = []
        for t in lvl.glob("*.jpg"):
            try:
                ls.append(t.stat().st_size)
            except OSError:
                pass
        per_level[lvl.name] = len(ls)
        sizes.extend(ls)
    sizes.sort()
    if not sizes:
        return None
    n = len(sizes)

    def pct(p):
        # nearest-rank percentile
        return sizes[min(n - 1, max(0, int(round(p / 100.0 * n)) - 1))]

    return {
        "count": n,
        "bytes_total": sum(sizes),
        "avg": sum(sizes) / n,
        "min": sizes[0],
        "median": statistics.median(sizes),
        "p95": pct(95),
        "p99": pct(99),
        "max": sizes[-1],
        "per_level": per_level,
    }


def dir_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def main():
    only = [int(a) for a in sys.argv[1:] if a.isdigit()]
    ladder = [x for x in LADDER if not only or x[1] in only]
    tmpdir = Path(tempfile.mkdtemp(prefix="ultratile-measure-"))
    instrumented = tmpdir / "import_measured.sh"
    instrument(REPO / "scripts" / "import_vips.sh", instrumented)
    instrumented.chmod(0o755)

    env = dict(os.environ)
    env["PATH"] = VIPS_BIN + ":" + env["PATH"]

    results = []
    for name, img_id, exp_levels, exp_finest, exp_tiles in ladder:
        src = REPO / "data" / "sources" / name
        if not src.is_file():
            raise SystemExit(f"missing source: {src}")
        target = REPO / "data" / "images" / str(img_id)
        if target.exists():
            shutil.rmtree(target)

        w = int(vipsheader("width", src))
        h = int(vipsheader("height", src))
        loader = vipsheader("vips-loader", src)
        bands = vipsheader("bands", src)
        src_bytes = src.stat().st_size

        rc, wall, peak, out = rss_and_wall(
            ["/bin/bash", str(instrumented), str(src), str(img_id)], env)
        ph = phases(out)
        if rc != 0:
            print(f"IMPORT FAILED for image-{img_id} rc={rc}\n{out}", file=sys.stderr)
            results.append({"id": img_id, "rc": rc, "output": out})
            continue

        pyr = target
        st = tile_stats(pyr)
        meta = json.loads((pyr / "meta.json").read_text())
        du = dir_bytes(pyr)

        # derive phase deltas
        d = {}
        order = ["preflight_done", "dzsave_transform_done", "postpad_done",
                 "nameset_done", "sizegate_done", "geometry_done"]
        present = [k for k in order if k in ph]
        for a, b in zip(present, present[1:]):
            d[f"{a}->{b}"] = ph[b] - ph[a]
        dz = d.get("preflight_done->dzsave_transform_done")
        pad = d.get("dzsave_transform_done->postpad_done")
        val = d.get("postpad_done->nameset_done") or 0
        val2 = d.get("nameset_done->sizegate_done") or 0
        val3 = d.get("sizegate_done->geometry_done") or 0

        # count short (needing pad) tiles straight from the published tree,
        # using batched header reads
        short = 0
        for lvl in sorted(pyr.glob("level-*")):
            tf = sorted(lvl.glob("*.jpg"))
            if not tf:
                continue
            ws = vipsheader_batch("width", tf)
            hs = vipsheader_batch("height", tf)
            for ww, hh in zip(ws, hs):
                if ww != "512" or hh != "512":
                    short += 1

        rec = {
            "id": img_id, "rc": rc, "source": name,
            "src_bytes": src_bytes, "w": w, "h": h, "loader": loader,
            "bands": bands,
            "pixels": w * h, "raw_rgb_bytes": w * h * 3,
            "meta": meta,
            "levels": meta["levels"], "expected_levels": exp_levels,
            "finest": f'{st["per_level"] and max(st["per_level"], key=lambda k: int(k.split("-")[1]))}',
            "actual_tiles": st["count"], "expected_tiles": exp_tiles,
            "finest_cols": max((int(k.split("-")[1]) for k in st["per_level"]), default=0),
            "wall_s": round(wall, 2), "peak_rss_kb": peak,
            "pyramid_bytes": du,
            "avg_tile": round(st["avg"], 1), "min_tile": st["min"],
            "median_tile": st["median"], "p95_tile": st["p95"],
            "p99_tile": st["p99"], "max_tile": st["max"],
            "short_tiles_after": short,
            "phase_dzsave_transform_s": dz, "phase_postpad_s": pad,
            "phase_validation_s": (val or 0) + (val2 or 0) + (val3 or 0),
            "phase_detail": d,
            "per_level_counts": st["per_level"],
            "feasibility_line": next((l for l in out.splitlines()
                                      if l.startswith("feasibility:")), ""),
        }
        results.append(rec)
        print(f"image-{img_id}: rc={rc} {w}x{h} levels={meta['levels']} "
              f"tiles={st['count']} wall={wall:.1f}s peakRSS={peak}KB "
              f"pyramid={du/1e6:.0f}MB avg_tile={st['avg']/1024:.0f}KB")

    # MERGE with any previous run, keyed by image id, so measuring one rung of
    # the ladder does not discard the others.
    (REPO / "target").mkdir(exist_ok=True)
    outp = REPO / "target" / "real_image_metrics.json"
    merged = {}
    if outp.exists():
        try:
            for r in json.loads(outp.read_text()):
                merged[r.get("id")] = r
        except Exception:
            pass
    for r in results:
        merged[r["id"]] = r
    outp.write_text(json.dumps([merged[k] for k in sorted(merged, key=lambda x: (x is None, x))],
                              indent=2))
    print(f"\nwrote {outp}")
    shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
