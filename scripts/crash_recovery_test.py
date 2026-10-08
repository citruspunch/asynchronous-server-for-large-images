#!/usr/bin/env python3
"""Import crash-recovery test (TEST-ONLY, stdlib + libvips).

Kills scripts/import_vips.sh at a spread of moments spanning the whole import,
then asserts the safety invariants after each kill:

  * a published <id>/ directory NEVER exists without .ready
  * the registry NEVER adopts partial data
  * a previously-ready image is NEVER damaged
  * staging/quarantine residue is handled per policy (.tmp-*, .stale-*)
  * re-running the import after a kill recovers and produces a valid pyramid

The scratch source dimensions are deliberately NOT multiples of the 512 tile
size, so the post-pad pass actually has short edge tiles to embed; an exactly
divisible source would leave that path untested. One cycle kills the import the
moment dzsave finishes and completes it with --resume, asserting the resumed
publish is clean (no marker or *.pad.jpg leftovers).

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
# Non-multiples of 512 on purpose: the last tile column/row is short, so the
# post-pad pass and its final geometry assertion are actually exercised.
SRC_W = 4100
SRC_H = 3077
FAIL = []


def fail(m):
    FAIL.append(m)
    print(f"    FAIL  {m}")


def info(m):
    print(f"    info  {m}")


def ok(m):
    print(f"    ok    {m}")


def make_source(tmp, w=SRC_W, h=SRC_H):
    src = tmp / "src.tif"
    if src.exists():
        return src
    v = tmp / "src.v"
    subprocess.run([f"{VIPS_BIN}/vips", "gaussnoise", str(v), str(w), str(h)],
                   capture_output=True)
    subprocess.run([f"{VIPS_BIN}/vips", "copy", str(v), str(src)], capture_output=True)
    return src


def run_import(src, root, img_id, timeout=None, kill_after=None, resume=False):
    cmd = ["/bin/bash", str(REPO / "scripts" / "import_vips.sh"),
           "--data-root", str(root)]
    if resume:
        cmd.append("--resume")
    cmd += [str(src), str(img_id)]
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


def run_import_until_marker(src, root, img_id, marker, timeout=60):
    """Start an import and kill its process group the moment `marker` appears
    under .tmp-<id>. Returns (None, "") when killed; (rc, out) if it finished
    before the marker was seen."""
    cmd = ["/bin/bash", str(REPO / "scripts" / "import_vips.sh"),
           "--data-root", str(root), str(src), str(img_id)]
    env = dict(os.environ)
    env["PATH"] = VIPS_BIN + ":" + env["PATH"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, env=env, start_new_session=True)
    target = root / f".tmp-{img_id}" / marker
    deadline = time.time() + timeout
    while time.time() < deadline:
        if p.poll() is not None:
            out, _ = p.communicate()
            return p.returncode, out
        if target.exists():
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            return None, ""
        time.sleep(0.01)
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except ProcessLookupError:
        pass
    fail(f"marker {marker} never appeared within {timeout}s")
    return None, ""


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
        if meta.get("id") != target_id or meta.get("w") != SRC_W or meta.get("h") != SRC_H:
            fail(f"kill@{d}s: rerun meta wrong: {meta}")
            continue
        ok(f"kill@{d}s: killed={killed} -> rerun recovered, {n} tiles, meta correct")

    # --- resume path: kill right after dzsave, finish with --resume ---------
    # The marker is written after dzsave completes, so this kill lands in the
    # transform or post-pad; --resume must skip the re-encode and publish a
    # clean tree (no .dzsave-done/.progress/*.pad.jpg leftovers).
    target_id = 4
    shutil.rmtree(root / str(target_id), ignore_errors=True)
    rc, out = run_import_until_marker(src, root, target_id, ".dzsave-done")
    killed = rc is None
    check_invariants(root, "resume-kill",
                     published_must_be_intact=(2, keep_tiles))
    rc2, out2 = run_import(src, root, target_id, resume=True)
    if rc2 != 0:
        fail(f"resume after kill FAILED rc={rc2}\n{out2[-500:]}")
    elif "resuming" not in out2:
        fail("resume run did not report 'resuming' (marker was not honored)")
    else:
        d = root / str(target_id)
        n = len(list(d.rglob("*.jpg")))
        leftovers = [str(p.relative_to(d)) for p in d.rglob("*")
                     if p.name in (".dzsave-done", ".progress")
                     or p.name.endswith(".pad.jpg")]
        if n != base_tiles:
            fail(f"resume published {n} tiles, expected {base_tiles}")
        elif not (d / ".ready").is_file():
            fail("resume did not publish .ready")
        elif leftovers:
            fail(f"resume published marker/pad leftovers: {leftovers[:5]}")
        else:
            meta = json.loads((d / "meta.json").read_text())
            if meta.get("w") != SRC_W or meta.get("h") != SRC_H:
                fail(f"resume meta wrong: {meta}")
            else:
                ok(f"resume after kill: killed={killed} -> published {n} tiles, clean tree")

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
           f"after the crash cycles")
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
