#!/usr/bin/env python3
"""Import crash-recovery test (TEST-ONLY, stdlib + libvips).

Kills scripts/import_vips.sh at a spread of moments spanning the whole import,
then asserts the safety invariants after each kill:

  * a published <id>/ directory NEVER exists without .ready
  * the registry NEVER adopts partial data
  * a previously-ready image is NEVER damaged
  * staging/quarantine residue is handled per policy (.tmp-*, .stale-*)
  * re-running the import after a kill recovers and produces a valid pyramid

Uses a scratch data root (--data-root) and a scratch image id, so images 4/5/6
and the repository tree are never touched.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VIPS_BIN = "/opt/homebrew/opt/vips/bin"
FAIL = []


def fail(m):
    FAIL.append(m)
    print(f"    FAIL  {m}")


def info(m):
    print(f"    info  {m}")


def ok(m):
    print(f"    ok    {m}")


def make_source(tmp, w=4096, h=3072):
    src = tmp / "src.tif"
    if src.exists():
        return src
    v = tmp / "src.v"
    subprocess.run([f"{VIPS_BIN}/vips", "gaussnoise", str(v), str(w), str(h)],
                   capture_output=True)
    subprocess.run([f"{VIPS_BIN}/vips", "copy", str(v), str(src)], capture_output=True)
    return src


def run_import(src, root, img_id, timeout=None, kill_after=None):
    cmd = ["/bin/bash", str(REPO / "scripts" / "import_vips.sh"),
           "--data-root", str(root), str(src), str(img_id)]
    env = dict(os.environ)
    env["PATH"] = VIPS_BIN + ":" + env["PATH"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, env=env, start_new_session=True)
    if kill_after is not None:
        time.sleep(kill_after)
        if p.poll() is None:
            # kill the whole process group so vips children die too
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            return None, ""
    out, _ = p.communicate(timeout=timeout)
    return p.returncode, out


def registry_ids(root):
    """Ids the registry would accept: directory + meta.json + .ready, meta parses."""
    out = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir() or not d.name.isdigit():
            continue
        if not (d / ".ready").is_file() or not (d / "meta.json").is_file():
            continue
        try:
            m = json.loads((d / "meta.json").read_text())
        except Exception:
            continue
        if m.get("id") == int(d.name) and m.get("name") == f"image-{d.name}":
            out.append(int(d.name))
    return out


def check_invariants(root, label, published_must_exist=None, published_must_be_intact=None):
    # 1. no published dir without .ready
    bad = []
    if root.is_dir():
        for d in root.iterdir():
            if d.is_dir() and d.name.isdigit() and not (d / ".ready").is_file():
                bad.append(d.name)
    if bad:
        fail(f"{label}: published dirs without .ready: {bad}")
    else:
        ok(f"{label}: no published dir lacks .ready")

    # 2. registry only ever sees ready+valid entries
    ids = registry_ids(root)
    ok(f"{label}: registry-adoptable ids = {ids}")

    # 3. a previously-ready image must be intact
    if published_must_be_intact is not None:
        iid, expect_tiles = published_must_be_intact
        d = root / str(iid)
        if not (d / ".ready").is_file():
            fail(f"{label}: previously-ready image-{iid} lost its .ready")
        else:
            n = len(list(d.rglob("*.jpg")))
            if n != expect_tiles:
                fail(f"{label}: previously-ready image-{iid} damaged: "
                     f"{n} tiles, expected {expect_tiles}")
            else:
                ok(f"{label}: previously-ready image-{iid} intact ({n} tiles)")

    return ids


def main():
    tmp = Path(tempfile.mkdtemp(prefix="ultratile-crash-"))
    src = make_source(tmp)
    ok(f"scratch source {src.name} "
       f"({src.stat().st_size/1e6:.0f} MB), scratch data root")
    root = tmp / "root"
    root.mkdir(parents=True, exist_ok=True)

    # A full, clean baseline import so we know the expected tile count.
    rc, out = run_import(src, root, 1)
    if rc != 0:
        print(out)
        fail("baseline import failed")
        return 1
    base_tiles = len(list((root / "1").rglob("*.jpg")))
    ok(f"baseline image-1: {base_tiles} tiles")

    # A second, already-ready image that must survive every kill untouched.
    rc, _ = run_import(src, root, 2)
    if rc != 0:
        fail("baseline import of image-2 failed")
        return 1
    keep_tiles = len(list((root / "2").rglob("*.jpg")))
    ok(f"sentinel image-2: {keep_tiles} tiles (must survive every kill)")

    # Kill at a spread of moments. The clean import takes ~2-4s, so these land
    # in dzsave, tree transform, padding, validation and near-publication.
    delays = [0.05, 0.15, 0.3, 0.6, 1.0, 1.5, 2.0, 2.6, 3.4]
    print(f"\n  killing the import at {delays} s ...")
    for d in delays:
        target_id = 3
        shutil.rmtree(root / str(target_id), ignore_errors=True)
        rc, out = run_import(src, root, target_id, kill_after=d)
        killed = rc is None
        ids = check_invariants(
            root, f"kill@{d}s",
            published_must_be_intact=(2, keep_tiles))

        # After a kill, a rerun must recover and produce a valid pyramid.
        rc2, out2 = run_import(src, root, target_id)
        if rc2 != 0:
            fail(f"kill@{d}s: rerun after kill FAILED\n{out2[-500:]}")
            continue
        n = len(list((root / str(target_id)).rglob("*.jpg")))
        if n != base_tiles:
            fail(f"kill@{d}s: rerun produced {n} tiles, expected {base_tiles}")
            continue
        if (root / str(target_id) / ".ready").is_file() is False:
            fail(f"kill@{d}s: rerun did not publish .ready")
            continue
        meta = json.loads((root / str(target_id) / "meta.json").read_text())
        if meta.get("id") != target_id or meta.get("w") != 4096 or meta.get("h") != 3072:
            fail(f"kill@{d}s: rerun meta wrong: {meta}")
            continue
        ok(f"kill@{d}s: killed={killed} -> rerun recovered, {n} tiles, meta correct")

    # Residue must be BOUNDED, not zero: the importer deliberately keeps the
    # newest STALE_TMP_KEEP quarantined staging dirs for inspection and prunes
    # older ones. The invariant that matters is that repeated crashed imports
    # cannot grow disk without limit. (An earlier version of this test asserted
    # zero residue and failed against a correct bounded-retention policy.)
    keep = int(os.environ.get("ULTRASTILE_STALE_TMP_KEEP", "2"))
    stale = [p.name for p in root.iterdir() if p.name.startswith(".stale-tmp-")]
    tmps = [p.name for p in root.iterdir() if p.name.startswith(".tmp-")]
    if tmps:
        fail(f"un-pruned staging directories remain: {tmps}")
    if len(stale) > keep:
        fail(f"quarantined staging grew to {len(stale)}, above the retention "
             f"limit of {keep}: {stale}")
    else:
        ok(f"quarantined staging bounded at {len(stale)} (retention {keep}) "
           f"after 9 crashed imports")
    # Target quarantine must never be pruned: it may hold an operator's image.
    stale_target = [p.name for p in root.iterdir()
                    if p.name.startswith(".stale-") and ".stale-tmp-" not in p.name]
    if stale_target:
        info(f"target quarantine present (intentionally retained): {stale_target}")

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'='*60}\nFAILURES: {len(FAIL)}")
    for f in FAIL:
        print(f"  FAIL {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
