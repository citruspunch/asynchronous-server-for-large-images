#!/usr/bin/env python3
"""Real-image pipeline test: protocol -> registry -> tile store -> client.

TEST-ONLY, stdlib + libvips. Drives the ACTUAL UTP/1.0 wire against a RUNNING
server using the REAL imported ESO pyramids, covering what the synthetic e2e
probe cannot:

  * multiple simultaneous clients (default 10) against image 6
  * corners and centre of the pyramid, at several levels
  * exact tile-set accounting against END (sent + skipped == requested)
  * no CURRENT-generation tile outside the requested rectangle, and none
    carrying the wrong image id
  * no duplicate deliveries within a generation
  * generation supersession: a newer generation issued before the older finishes
  * image switching mid-session: exact END accounting plus current-generation
    identity. Stale TILEs from a superseded generation (possibly carrying the
    previous image) ARE tolerated by design -- UTP/1.0 section 4 allows a
    started frame to finish across the supersession boundary, and the client
    must classify and discard it rather than never see it.
  * seam continuity across the delivered mosaic (wrong-tile detection)
  * server RSS before/after, throughput and latency

Usage (server must already be running on --port):
    python3 scripts/real_pipeline_test.py [--port 8080] [--clients 10]
                                         [--images 4,5,6] [--seam]
"""
import argparse
import base64
import hashlib
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_utp import (  # noqa: E402  (reuse the pinned wire codec)
    GUID, KEY, MAGIC, OP_BIN, OP_CLOSE, OP_PING, OP_PONG, SUBPROTOCOL,
    ProtocolError, Stream, abort, chunk, commit, mask_frame, parse_end, parse_tile,
)

REPO = Path(__file__).resolve().parent.parent
VIPS = "/opt/homebrew/opt/vips/bin/vips"
TILE = 512
SPAN_CAP = 128
GEN_TILE_CAP = 256

FAIL = []
INFO = []


def fail(m):
    FAIL.append(m)
    print(f"    FAIL  {m}")


def ok(m):
    print(f"    ok    {m}")


def info(m):
    INFO.append(m)
    print(f"    info  {m}")


def rss_kb():
    """Total RSS of the java server process, in KiB (0 if not found)."""
    try:
        out = subprocess.run(["pgrep", "-f", "ultratile-1.0.jar"],
                             capture_output=True, text=True).stdout.split()
        total = 0
        for pid in out:
            r = subprocess.run(["ps", "-o", "rss=", "-p", pid],
                               capture_output=True, text=True).stdout.strip()
            if r.isdigit():
                total += int(r)
        return total
    except Exception:
        return 0


def levels_for(w, h):
    n, s = 0, TILE
    while s < max(w, h):
        s *= 2
        n += 1
    return n


def level_dims(w, h, z):
    n = levels_for(w, h)
    div = 1 << (n - z)
    return max(1, -(-w // div)), max(1, -(-h // div))


def grid(w, h, z):
    lw, lh = level_dims(w, h, z)
    return (lw + TILE - 1) // TILE, (lh + TILE - 1) // TILE


def handshake(host, port):
    s = socket.create_connection((host, port), timeout=10)
    s.settimeout(10)
    req = [
        "GET /ws HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {KEY}",
        "Sec-WebSocket-Version: 13",
        f"Sec-WebSocket-Protocol: {SUBPROTOCOL}",
        "", "",
    ]
    s.sendall("\r\n".join(req).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = s.recv(4096)
        if not d:
            raise ConnectionError("closed during handshake")
        buf += d
    head, rest = buf.split(b"\r\n\r\n", 1)
    text = head.decode("iso-8859-1")
    if "101" not in text.split("\r\n")[0]:
        raise ProtocolError("no 101: " + text.split("\r\n")[0])
    st = Stream(s)
    st.buf = bytearray(rest)
    return s, st


def collect(st, image, req, expect_keys, deadline_s=30.0, abort_check=None):
    """Collect TILEs until END for `req`. Returns (tiles, end, stray)."""
    tiles = {}
    stray = []
    stale_tiles = []
    end = None
    deadline = time.monotonic() + deadline_s
    while end is None:
        if abort_check and abort_check():
            return tiles, end, stray, stale_tiles
        try:
            ev = st.next_event(deadline)
        except (TimeoutError, ConnectionError) as e:
            return tiles, end, stray + [f"stream ended without END: {e}"], stale_tiles
        # Stream events are tuples: ("binary", payload) | ("ping", p) |
        # ("pong", b"") | ("close", code, reason)
        kind = ev[0]
        if kind == "close":
            return tiles, end, stray + [f"server CLOSE code={ev[1]} reason={ev[2]!r}"], stale_tiles
        if kind == "ping":
            continue
        if kind != "binary":
            continue
        p = ev[1]
        if not p:
            continue
        typ = p[1]
        if typ == 0x02:
            t = parse_tile(p)
            # CLASSIFY BY GENERATION FIRST. UTP/1.0 section 4 allows a
            # structurally valid TILE whose frame already started before a
            # supersession or ABORT to finish arriving, and the connection must
            # stay open. Such a stale TILE may also carry the previous image id,
            # for the same reason: the server cannot retract bytes already on
            # the wire. The CLIENT's obligation is to classify and discard by
            # generation, which is what the viewer does. So identity is checked
            # only for CURRENT-generation tiles; a current-generation tile for
            # the wrong image really is a defect.
            if t["req"] != req:
                stale_tiles.append(t)
                continue
            if t["image"] != image:
                stray.append(f"CURRENT-gen tile for image {t['image']} while viewing {image}")
            k = (t["x"], t["y"])
            if k not in expect_keys:
                stray.append(f"CURRENT-gen tile {k} outside requested set")
            if k in tiles:
                stray.append(f"duplicate tile {k}")
            tiles[k] = t
        elif typ == 0x04:
            end = parse_end(p)
    return tiles, end, stray, stale_tiles


def run_viewport(host, port, image, w, h, z, x0, x1, y0, y1, req, label):
    cols, rows = grid(w, h, z)
    x0 = max(0, min(x0, cols - 1))
    x1 = max(x0, min(x1, cols - 1))
    y0 = max(0, min(y0, rows - 1))
    y1 = max(y0, min(y1, rows - 1))
    span_x, span_y = x1 - x0 + 1, y1 - y0 + 1
    if span_x > SPAN_CAP or span_y > SPAN_CAP:
        fail(f"{label}: span {span_x}x{span_y} exceeds protocol SPAN_CAP {SPAN_CAP}")
        return None
    expect = {(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)}
    if len(expect) > GEN_TILE_CAP:
        fail(f"{label}: {len(expect)} unique tiles exceeds GEN_TILE_CAP {GEN_TILE_CAP}")
        return None

    s, st = handshake(host, port)
    try:
        s.sendall(mask_frame(OP_BIN, chunk(image, z, req, x0, x1, y0, y1)))
        s.sendall(mask_frame(OP_BIN, commit(image, req)))
        t0 = time.monotonic()
        tiles, end, stray, stale = collect(st, image, req, expect)
        dt = time.monotonic() - t0
        if stale:
            info(f"{label}: discarded {len(stale)} stale-generation TILEs "
                 f"(frame-boundary race, connection stayed open)")
        for m in stray:
            fail(f"{label}: {m}")
        if end is None:
            fail(f"{label}: no END received")
            return None
        if end["image"] != image or end["req"] != req:
            fail(f"{label}: END identity mismatch {end}")
            return None
        if end["sent"] + end["skipped"] != len(expect):
            fail(f"{label}: END accounting {end['sent']}+{end['skipped']} != "
                 f"requested {len(expect)}")
            return None
        if end["sent"] != len(tiles):
            fail(f"{label}: END sent={end['sent']} but received {len(tiles)} TILEs")
            return None
        missing = expect - set(tiles)
        if missing:
            fail(f"{label}: {len(missing)} expected tiles never arrived "
                 f"(e.g. {sorted(missing)[:3]})")
            return None
        info(f"{label}: {len(tiles)} tiles, sent={end['sent']} skipped={end['skipped']}, "
             f"{dt*1000:.0f} ms, {sum(len(t['body']) for t in tiles.values())/1e6:.2f} MB")
        return {"tiles": tiles, "dt": dt, "bytes": sum(len(t["body"]) for t in tiles.values()),
                "x0": x0, "y0": y0, "grid": (cols, rows)}
    finally:
        s.close()


def seam_check(port_result, image, label, tmpdir, samples=8):
    """Decode neighbouring delivered tiles and compare the boundary columns.

    A one-pixel gap, a duplicated tile, or a wrong tile served at a coordinate
    all show up as a boundary gradient far larger than the local interior one.
    """
    import random
    tiles = port_result["tiles"]
    keys = sorted(tiles)
    if len(keys) < 4:
        return
    rng = random.Random(99)
    pairs = []
    for (x, y) in keys:
        if (x + 1, y) in tiles:
            pairs.append(((x, y), (x + 1, y)))
    if not pairs:
        return
    rng.shuffle(pairs)
    ratios = []
    tmp = Path(tmpdir)

    def decode(t):
        p = tmp / f"{t['x']}_{t['y']}_{image}.jpg"
        p.write_bytes(t["body"])
        out = tmp / (p.stem + ".raw")
        r = subprocess.run([VIPS, "copy", str(p), str(out)], capture_output=True)
        if r.returncode != 0:
            return None
        d = out.read_bytes()
        out.unlink(missing_ok=True)
        p.unlink(missing_ok=True)
        return d if len(d) == TILE * TILE * 3 else None

    for ka, kb in pairs[:samples]:
        da, db = decode(tiles[ka]), decode(tiles[kb])
        if not da or not db:
            continue

        def px(d, x, y):
            i = (y * TILE + x) * 3
            return (d[i] + d[i + 1] + d[i + 2]) / 3.0
        y = rng.randrange(0, TILE)
        seam = abs(px(da, TILE - 1, y) - px(db, 0, y))
        inner = abs(px(da, TILE - 3, y) - px(da, TILE - 2, y))
        if inner > 1.0:
            ratios.append(seam / inner)
    if ratios:
        ratios.sort()
        med = ratios[len(ratios) // 2]
        worst = ratios[-1]
        if med > 12.0:
            fail(f"{label}: seam discontinuity, median ratio {med:.1f} worst {worst:.1f}")
        else:
            ok(f"{label}: seam continuity median {med:.2f} worst {worst:.2f} "
               f"over {len(ratios)} seams")


def test_supersede(host, port, image, w, h, z, cols, rows):
    """Issue gen 2 while gen 1 is still in flight; gen 2 must win cleanly."""
    s, st = handshake(host, port)
    try:
        # gen 1: a large window, deliberately not awaited
        s.sendall(mask_frame(OP_BIN, chunk(image, z, 1, 0, min(15, cols - 1),
                                           0, min(15, rows - 1))))
        s.sendall(mask_frame(OP_BIN, commit(image, 1)))
        time.sleep(0.02)
        # gen 2 supersedes it almost immediately. The window MUST be clamped to
        # the real grid: an out-of-range maxX fails the server's viewport check,
        # which records the chunk in rejectedReqIds and then closes on its
        # COMMIT. On a 2048x2048 demo the finest level is only 4x4, so a fixed
        # 4x4 window would ask for column 4 and 5.
        gx, gy = min(2, cols - 1), min(2, rows - 1)
        gx1 = min(gx + 3, cols - 1)
        gy1 = min(gy + 3, rows - 1)
        s.sendall(mask_frame(OP_BIN, chunk(image, z, 2, gx, gx1, gy, gy1)))
        s.sendall(mask_frame(OP_BIN, commit(image, 2)))
        expect2 = {(x, y) for y in range(gy, gy1 + 1) for x in range(gx, gx1 + 1)}
        tiles, end, stray, stale1 = collect(st, image, 2, expect2, deadline_s=30)
        for m in stray:
            fail(f"supersede: {m}")
        # The superseded generation's in-flight TILEs are legal (frame-boundary
        # race) but they MUST NOT be counted against gen 2, and gen 2's own
        # accounting must be exact.
        if stale1:
            info(f"supersession: {len(stale1)} stale gen-1 TILEs discarded, "
                 f"socket open (documented frame-boundary race)")
        if end is None:
            fail("supersede: no END for gen 2")
            return
        if end["req"] != 2:
            fail(f"supersede: END req {end['req']} != 2")
            return
        if end["sent"] + end["skipped"] != len(expect2):
            fail(f"supersede: gen2 accounting {end['sent']}+{end['skipped']} != {len(expect2)}")
            return
        if end["sent"] != len(tiles):
            fail(f"supersede: gen2 sent={end['sent']} received={len(tiles)}")
            return
        ok(f"supersession: gen 2 sealed and completed, {end['sent']} tiles, "
           f"gen 1 discarded without corrupting the view")
    finally:
        s.close()


def test_switch(host, port, a, wa, ha, b, wb, hb):
    """Switch images mid-session.

    Invariant asserted: no tile belonging to the CURRENT (image b) generation
    ever carries image a's identity, and the b generation completes with exact
    END accounting.

    Invariant deliberately NOT asserted: that no image-a TILE frame is ever
    observed after the switch. UTP/1.0 section 4 permits a TILE whose frame
    already started before the supersession to finish arriving, and such a frame
    may carry image a. Requiring it to be unobservable would be requiring the
    server to retract bytes already on the wire. The viewer discards such tiles
    by generation, and the viewer suite covers that classification.
    """
    s, st = handshake(host, port)
    try:
        za = levels_for(wa, ha)
        ca, ra = grid(wa, ha, za)
        s.sendall(mask_frame(OP_BIN, chunk(a, za, 1, 0, min(7, ca - 1),
                                           0, min(7, ra - 1))))
        s.sendall(mask_frame(OP_BIN, commit(a, 1)))
        ea = {(x, y) for y in range(0, min(7, ra - 1) + 1) for x in range(0, min(7, ca - 1) + 1)}
        ta, enda, stra, _s1 = collect(st, a, 1, ea)
        for m in stra:
            fail(f"switch/pre: {m}")
        if enda is None or enda["sent"] != len(ea):
            fail(f"switch/pre: gen on image {a} incomplete")
            return
        # now switch to image b, back to back with no pause
        zb = levels_for(wb, hb)
        cb, rb = grid(wb, hb, zb)
        s.sendall(mask_frame(OP_BIN, chunk(b, zb, 2, 0, min(7, cb - 1),
                                           0, min(7, rb - 1))))
        s.sendall(mask_frame(OP_BIN, commit(b, 2)))
        eb = {(x, y) for y in range(0, min(7, rb - 1) + 1) for x in range(0, min(7, cb - 1) + 1)}
        tb, endb, strb, stale2 = collect(st, b, 2, eb)
        for m in strb:
            fail(f"switch/post: {m}")
        if endb is None:
            fail("switch: no END after image switch")
            return
        if endb["image"] != b or endb["req"] != 2:
            fail(f"switch: END identity {endb}")
            return
        if endb["sent"] != len(eb):
            fail(f"switch: sent={endb['sent']} expected={len(eb)}")
            return
        if any(t["image"] == b for t in stale2):
            fail("switch: a stale-generation TILE carried the NEW image id, so "
                 "generation and image identity are inconsistent")
        if stale2:
            info(f"switch: discarded {len(stale2)} stale image-{a} TILEs "
                 f"(allowed frame-boundary race, socket open)")
        ok(f"image switch {a}->{b}: {enda['sent']} then {endb['sent']} tiles; "
           f"no current-generation tile carried the old image id")
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--clients", type=int, default=10)
    ap.add_argument("--images", default="6")
    ap.add_argument("--seam", action="store_true")
    args = ap.parse_args()

    ids = [int(x) for x in args.images.split(",") if x.strip()]
    dims = {}
    for i in ids:
        import urllib.request
        with urllib.request.urlopen(f"http://{args.host}:{args.port}/api/images/{i}/info") as r:
            d = json.loads(r.read())
        dims[i] = (d["w"], d["h"], d["levels"])
        print(f"  image-{i}: {d['w']}x{d['h']} levels={d['levels']} "
              f"(from the running server's registry)")

    tmpdir = tempfile.mkdtemp(prefix="ultratile-pipeline-")
    rss0 = rss_kb()
    print(f"\n  server RSS before: {rss0/1024:.0f} MiB")

    # ---- single-client coverage: corners + centre at several levels ----
    for i in ids:
        w, h, lv = dims[i]
        print(f"\n=== image-{i} coverage ({w}x{h}, {lv} levels) ===")
        for z in sorted({0, max(0, lv // 2), lv - 1}):
            cols, rows = grid(w, h, z)
            side = 15  # 16x16 = 256 tiles == GEN_TILE_CAP
            spots = [
                ("top-left", 0, 0),
                ("top-right", max(0, cols - 1 - side), 0),
                ("bottom-left", 0, max(0, rows - 1 - side)),
                ("bottom-right", max(0, cols - 1 - side), max(0, rows - 1 - side)),
                ("centre", max(0, (cols - 1) // 2 - side // 2),
                 max(0, (rows - 1) // 2 - side // 2)),
            ]
            for label, x0, y0 in spots:
                if cols <= 1 and rows <= 1:
                    r = run_viewport(args.host, args.port, i, w, h, z, 0, 0, 0, 0, 1,
                                     f"i{i} z{z} {label}")
                    if r and args.seam:
                        seam_check(r, i, f"i{i} z{z} {label}", tmpdir, samples=2)
                    continue
                req = 1
                r = run_viewport(args.host, args.port, i, w, h, z, x0, x0 + side,
                                 y0, y0 + side, req, f"i{i} z{z} {label}")
                if r and args.seam and z == lv - 1:
                    seam_check(r, i, f"i{i} z{z} {label}", tmpdir)

    # ---- supersession + switching ----
    if len(ids) >= 1:
        i = ids[-1]
        w, h, lv = dims[i]
        finest = lv - 1          # lv is the LEVEL COUNT; index is count-1
        cols, rows = grid(w, h, finest)
        print(f"\n=== generation supersession on image-{i} (finest level z={finest}) ===")
        test_supersede(args.host, args.port, i, w, h, finest, cols, rows)
    if len(ids) >= 2:
        a, b = ids[0], ids[-1]
        print(f"\n=== image switch {a} -> {b} ===")
        test_switch(args.host, args.port, a, dims[a][0], dims[a][1],
                    b, dims[b][0], dims[b][1])

    # ---- multi-client load ----
    i = ids[-1]
    w, h, lv = dims[i]
    finest = lv - 1
    cols, rows = grid(w, h, finest)
    print(f"\n=== {args.clients} concurrent clients on image-{i} "
          f"(finest level z={finest}, grid {cols}x{rows}) ===")
    results = []
    errors = []
    lock = threading.Lock()
    barrier = threading.Barrier(args.clients)

    def client(idx):
        try:
            barrier.wait(timeout=30)
            # each client picks a different region: distinct + overlapping mix
            ox = (idx * 3) % max(1, max(1, cols - 8))
            oy = (idx * 2) % max(1, max(1, rows - 8))
            r = run_viewport(args.host, args.port, i, w, h, finest,
                             ox, ox + 7, oy, oy + 7, 1, f"client{idx}")
            with lock:
                if r:
                    results.append(r)
                else:
                    errors.append(f"client{idx} failed")
        except Exception as e:
            with lock:
                errors.append(f"client{idx}: {type(e).__name__}: {e}")

    t0 = time.monotonic()
    threads = [threading.Thread(target=client, args=(k,)) for k in range(args.clients)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=180)
    wall = time.monotonic() - t0
    for e in errors:
        fail(f"concurrency: {e}")
    if results:
        total_tiles = sum(len(r["tiles"]) for r in results)
        total_bytes = sum(r["bytes"] for r in results)
        ok(f"{len(results)}/{args.clients} clients completed in {wall:.2f}s")
        info(f"aggregate {total_tiles} tiles, {total_bytes/1e6:.1f} MB, "
             f"{total_bytes/1e6/wall:.1f} MB/s")
    rss1 = rss_kb()
    print(f"  server RSS after:  {rss1/1024:.0f} MiB (delta {(rss1-rss0)/1024:+.0f} MiB)")

    subprocess.run(["rm", "-rf", tmpdir])
    print(f"\n{'='*60}")
    print(f"FAILURES: {len(FAIL)}")
    for f in FAIL:
        print(f"  FAIL {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    import json  # noqa: E402
    sys.exit(main())
