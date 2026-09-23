#!/usr/bin/env python3
"""Shared-constant parity check (stdlib, TEST-ONLY).

Framework in phase-02: pins Java<->shell constants available now, reading TWO
Java owners -- Config.java (operational tuning) and UtpMessages.java (wire
magic + UTP type codes) -- plus shell duplicates (tile-size 512 and Q=85 in
import_vips.sh, Q85 in IngestTool).

The JavaScript side cannot be pinned until the real viewer.js exists in
phase-06, so this script takes a frozen --java-shell-only flag that checks
Java+shell and exits 0 without touching viewer.js. Full JS parity is
phase-06's completion task, never this phase's green gate.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FAILURES = []


def fail(msg):
    FAILURES.append(msg)
    print(f"PARITY-FAIL: {msg}")


def read_java_consts(path):
    text = path.read_text()
    consts = {}
    for m in re.finditer(
        r"public\s+static\s+final\s+(?:String|int|long|double)\s+(\w+)\s*=\s*([^;]+);",
        text,
    ):
        name = m.group(1)
        val = m.group(2).strip()
        consts[name] = val
    return consts, text


def norm_int(expr):
    expr = expr.strip()
    # Evaluate simple arithmetic over ints (e.g. 4 * 1024 * 1024).
    if re.fullmatch(r"[0-9xXa-fA-F_+\-*/() \t]+", expr):
        try:
            return eval(expr, {"__builtins__": {}}, {})
        except Exception:
            return None
    m = re.fullmatch(r'"([^"]*)"', expr)
    if m:
        return m.group(1)
    return None


def check_config():
    p = ROOT / "src/main/java/com/ultratile/Config.java"
    if not p.exists():
        fail("Config.java missing")
        return
    consts, _ = read_java_consts(p)
    expect_ints = {
        "PORT": 8080,
        "TILE_SIZE": 512,
        "CACHE_CAP": 40,
        "DECODE_MAX": 6,
        "DECODE_QUEUE_JOBS": 24,
        "DECODE_QUEUE_BYTES": 4 * 1024 * 1024,
        "JPEG_QUALITY": 85,
        "MAX_DIM": 262144,
        "IMPORT_IMAGE_MAX_DIM": 8192,
        "IMPORT_IMAGE_MAX_PIXELS": 16777216,
        "GEN_TILE_CAP": 256,
        "BATCH_CAP": 30,
        "SPAN_CAP": 128,
        "WS_MSG_CAP": 1024,
        "MAX_TILE_BYTES": 2 * 1024 * 1024,
        "META_MAX_BYTES": 16384,
        "META_NAME_MAX": 128,
        "REJECTED_CAP": 64,
        "AVG_TILE_SEED": 131072,
    }
    for name, want in expect_ints.items():
        if name not in consts:
            fail(f"Config.java missing {name}")
            continue
        got = norm_int(consts[name])
        if got != want:
            fail(f"Config.{name}={consts[name]!r} (parsed {got!r}) != {want}")
    if consts.get("BIND") not in ('"127.0.0.1"',):
        fail(f"Config.BIND={consts.get('BIND')!r} != \"127.0.0.1\"")
    # Scale bounds are doubles.
    for name in ("SCALE_MIN", "SCALE_MAX"):
        if name not in consts:
            fail(f"Config.java missing {name}")
    # Forbid removed constants.
    text = p.read_text()
    if "QUEUE_CAP" in text:
        fail("Config.java must not contain QUEUE_CAP")


def check_wire_owner():
    p = ROOT / "src/main/java/com/ultratile/proto/UtpMessages.java"
    if not p.exists():
        # Phase-02 framework: wire owner lands in phase-03; skip loudly but green.
        print("PARITY-SKIP: UtpMessages.java not present yet (phase-03); skipping wire checks")
        return
    consts, text = read_java_consts(p)
    if 'SUBPROTOCOL' not in consts or 'ultratile.utp.v1' not in text:
        fail("UtpMessages.SUBPROTOCOL must be ultratile.utp.v1")
    for tok in ("0xAA", "0x01", "0x02", "0x03", "0x04", "0x05"):
        if tok not in text:
            fail(f"UtpMessages.java missing {tok}")


def check_shell():
    p = ROOT / "scripts/import_vips.sh"
    if not p.exists():
        fail("scripts/import_vips.sh missing")
        return
    text = p.read_text()
    if "tile-size 512" not in text:
        fail("import_vips.sh must contain 'tile-size 512'")
    if "Q=85" not in text:
        fail("import_vips.sh must contain 'Q=85'")
    if "vipsheader" not in text:
        fail("import_vips.sh missing vipsheader pre-dimension gate")
    if "vips embed" not in text or ".pad.jpg" not in text:
        fail("import_vips.sh missing post-pad pass (vips embed + .pad.jpg)")
    if '"$src"' not in text or '"$id"' not in text:
        fail('import_vips.sh must quote "$src"/"$id"')


def check_ingest():
    p = ROOT / "src/main/java/com/ultratile/tiles/IngestTool.java"
    if not p.exists():
        fail("IngestTool.java missing")
        return
    text = p.read_text()
    if "JPEG_QUALITY" not in text and "Q=85" not in text and "0.85" not in text:
        fail("IngestTool.java missing Q85 wiring")


def main(argv):
    java_shell_only = "--java-shell-only" in argv
    check_config()
    check_wire_owner()
    check_shell()
    check_ingest()
    if not java_shell_only:
        v = ROOT / "src/main/resources/web/viewer.js"
        if not v.exists():
            fail("viewer.js missing (full parity requires phase-06)")
        else:
            # Phase-02 framework: JS map completes in phase-06; placeholder hook.
            print("PARITY-INFO: viewer.js present; full JS map enforced from phase-06")
    if FAILURES:
        print(f"{len(FAILURES)} parity failure(s)")
        return 1
    print("parity-ok" + (" (java-shell-only)" if java_shell_only else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
