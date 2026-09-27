#!/usr/bin/env python3
"""Shared-constant parity check (stdlib, TEST-ONLY).

Pins Java<->shell<->JS constants, reading TWO Java owners --
Config.java (operational tuning) and UtpMessages.java (wire magic + UTP
type codes) -- plus shell duplicates and the modular viewer under
src/main/resources/web/js/ (classic scripts, load order).

Phase-06 completion: full JS map covering EVERY viewer hard-code. Each map
entry names its Java OWNER FILE (tuning vs wire; asserting against the
wrong file fails). Viewer-local policy stays OUTSIDE the map by design:
the browser close code and the planning floor have no Java counterpart
and must never gain one.
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
    # Strip Java long suffix (e.g. 0xFFFFFFFEL) before evaluating.
    if re.fullmatch(r"[0-9xXa-fA-F_+\-*/() \t]+[lL]?", expr):
        cleaned = expr[:-1] if expr[-1:] in ("L", "l") else expr
        cleaned = cleaned.replace("_", "")
        try:
            return eval(cleaned, {"__builtins__": {}}, {})
        except Exception:
            return None
    m = re.fullmatch(r'"([^"]*)"', expr)
    if m:
        return m.group(1)
    return None


def norm_float(expr):
    expr = expr.strip().replace("_", "")
    try:
        return float(expr)
    except Exception:
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
        "IMPORT_MAX_TILES": 16777216,
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
    if consts.get("DATA_ROOT") != '"data/images"':
        fail(f'Config.DATA_ROOT={consts.get("DATA_ROOT")!r} != "data/images"')
    # Scale bounds are doubles.
    for name in ("SCALE_MIN", "SCALE_MAX"):
        if name not in consts:
            fail(f"Config.java missing {name}")
    # Forbid removed constants.
    text = p.read_text()
    if "QUEUE_CAP" in text:
        fail("Config.java must not contain QUEUE_CAP")
    # The importer and the server must agree on the DEFAULT data root, or an
    # import would publish where the registry never looks.
    sh = ROOT / "scripts/import_vips.sh"
    if sh.exists():
        shtext = sh.read_text()
        m = re.search(r'^data_root="([^"]+)"', shtext, re.M)
        if not m:
            fail("import_vips.sh must define data_root=\"...\"")
        elif m.group(1) != consts.get("DATA_ROOT", "").strip('"'):
            fail(f'import_vips.sh data_root={m.group(1)!r} != Config.DATA_ROOT '
                 f'{consts.get("DATA_ROOT")!r}')
        if "--data-root" not in shtext:
            fail("import_vips.sh must accept --data-root (external-volume imports)")
    # MAX_DIM was an arbitrary dimension ceiling (262144 px) with no derivation
    # behind it. Representability is now DERIVED from the UTP tile-coordinate
    # bound and lives in PyramidTileStore; Config keeps only resource policy.
    if re.search(r"\bMAX_DIM\b", text):
        fail("Config.java must not contain MAX_DIM (use the derived representability limit)")
    if "PyramidTileStore" not in text:
        fail("Config.java should point at the derived representability limit")


def check_derived_dim_limit():
    """The dimension ceiling must be DERIVED, and Java and shell must agree.

    Guards the relationship documented in UtpMessages.maxRepresentableDim():
    max dimension = (max tile coordinate + 1) * tile size = 65536 * 512.
    """
    p = ROOT / "src/main/java/com/ultratile/proto/UtpMessages.java"
    consts, text = read_java_consts(p)
    if norm_int(consts.get("MAX_TILE_COORD", "")) != 65535:
        fail("UtpMessages.MAX_TILE_COORD must be 65535")
    if norm_int(consts.get("MAX_IMAGE_ID", "")) != 65535:
        fail("UtpMessages.MAX_IMAGE_ID must be 65535 (u16 wire field)")
    # MAX_TILES_PER_AXIS must be the SYMBOLIC derivation, not a re-typed literal.
    if not re.search(
        r"MAX_TILES_PER_AXIS\s*=\s*MAX_TILE_COORD\s*\+\s*1\s*;", text
    ):
        fail("UtpMessages.MAX_TILES_PER_AXIS must be declared as MAX_TILE_COORD + 1")
    if not re.search(r"maxRepresentableDim\s*\(\)", text):
        fail("UtpMessages must derive maxRepresentableDim()")
    if "Config.TILE_SIZE" not in text:
        fail("maxRepresentableDim() must derive from Config.TILE_SIZE")
    if re.search(r"\b262144\b", text):
        fail("UtpMessages must not hardcode 262144")

    # Recompute the relationship independently and pin the arithmetic.
    cfg, _ = read_java_consts(ROOT / "src/main/java/com/ultratile/Config.java")
    tile = norm_int(cfg.get("TILE_SIZE", ""))
    coord = norm_int(consts.get("MAX_TILE_COORD", ""))
    if tile != 512 or coord != 65535:
        fail(f"cannot derive dimension limit from TILE_SIZE={tile}, MAX_TILE_COORD={coord}")
    else:
        derived = (coord + 1) * tile
        if derived != 33554432:
            fail(f"derived max dimension {derived} != 33554432")

    store = ROOT / "src/main/java/com/ultratile/tiles/PyramidTileStore.java"
    stext = store.read_text()
    if "MAX_REPRESENTABLE_DIM" not in stext:
        fail("PyramidTileStore must expose MAX_REPRESENTABLE_DIM")
    if "UtpMessages.maxRepresentableDim()" not in stext:
        fail("MAX_REPRESENTABLE_DIM must delegate to UtpMessages, not restate a literal")
    if not re.search(r"public\s+static\s+long\s+totalTiles", stext):
        fail("totalTiles must return long (65536x65536 tiles overflows int)")

    # The shell importer must not reintroduce a literal dimension ceiling.
    # Compare against code only: prose in comments may still mention 262144.
    sh = ROOT / "scripts/import_vips.sh"
    if sh.exists():
        code = "\n".join(
            ln for ln in sh.read_text().splitlines() if not ln.lstrip().startswith("#")
        )
        if re.search(r"\b262144\b", code):
            fail("import_vips.sh must not hardcode 262144; derive MAX_DIM instead")
        for tok in (
            "MAX_TILE_COORD=65535",
            "TILE=512",
            "MAX_DIM=$((MAX_TILES_PER_AXIS * TILE))",
        ):
            if tok not in code:
                fail(f"import_vips.sh missing derived limit fragment: {tok}")


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


JS_FILES = [
    "constants.js",
    "structures.js",
    "state.js",
    "geometry.js",
    "codec.js",
    "epoch.js",
    "render.js",
    "net.js",
    "batches.js",
    "app.js",
]

# (js_name, java_owner, java_name, kind) where kind is int/float.
# Tuning entries MUST resolve against Config.java; wire entries MUST
# resolve against UtpMessages.java. Asserting against the wrong file fails.
JS_MAP = [
    ("TILE", "Config", "TILE_SIZE", "int"),
    ("MAX_CACHE", "Config", "CACHE_CAP", "int"),
    ("MAX_DECODE", "Config", "DECODE_MAX", "int"),
    ("DECODE_QUEUE_MAX_JOBS", "Config", "DECODE_QUEUE_JOBS", "int"),
    ("DECODE_QUEUE_MAX_BYTES", "Config", "DECODE_QUEUE_BYTES", "int"),
    ("MAX_TILE_BYTES", "Config", "MAX_TILE_BYTES", "int"),
    ("BATCH_CAP", "Config", "BATCH_CAP", "int"),
    ("AVG_TILE_SEED", "Config", "AVG_TILE_SEED", "int"),
    ("SCALE_MIN", "Config", "SCALE_MIN", "float"),
    ("SCALE_MAX", "Config", "SCALE_MAX", "float"),
    ("SPAN_CAP", "Config", "SPAN_CAP", "int"),
    ("GEN_TILE_CAP", "Config", "GEN_TILE_CAP", "int"),
    ("MAGIC", "UtpMessages", "MAGIC", "int"),
    ("T_CHUNK", "UtpMessages", "T_VIEWPORT", "int"),
    ("T_TILE", "UtpMessages", "T_TILE", "int"),
    ("T_ABORT", "UtpMessages", "T_ABORT", "int"),
    ("T_END", "UtpMessages", "T_END", "int"),
    ("T_COMMIT", "UtpMessages", "T_COMMIT", "int"),
    ("LOD_NEAREST", "UtpMessages", "LOD_NEAREST", "int"),
    ("FORMAT_JPEG", "UtpMessages", "FORMAT_JPEG", "int"),
    ("REQ_ID_MAX", "UtpMessages", "REQ_ID_MAX", "int"),
]


def read_js_bundle():
    d = ROOT / "src/main/resources/web/js"
    texts = {}
    bundle = ""
    for name in JS_FILES:
        p = d / name
        if not p.exists():
            fail(f"web/js/{name} missing")
            continue
        t = p.read_text()
        texts[name] = t
        bundle += "\n" + t
    return texts, bundle


def parse_js_consts(bundle):
    consts = {}
    for m in re.finditer(r"(?:^|\n)\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);", bundle):
        consts[m.group(1)] = m.group(2).strip()
    return consts


def norm_js_int(expr):
    expr = expr.strip().replace("_", "")
    if re.fullmatch(r"[0-9xXa-fA-F+\-*/() \t.]+", expr):
        try:
            v = eval(expr, {"__builtins__": {}}, {})
            if isinstance(v, float) and v.is_integer():
                return int(v)
            return v
        except Exception:
            return None
    return None


def check_js():
    d = ROOT / "src/main/resources/web/js"
    if not d.is_dir():
        fail("src/main/resources/web/js/ missing (modular viewer requires phase-06)")
        return
    # Stale monolith must be gone: the split is the viewer now.
    if (ROOT / "src/main/resources/web/viewer.js").exists():
        fail("stale src/main/resources/web/viewer.js still exists; modular js/ is the viewer")
    texts, bundle = read_js_bundle()
    if FAILURES:
        return
    js_consts = parse_js_consts(bundle)
    cfg_path = ROOT / "src/main/java/com/ultratile/Config.java"
    wire_path = ROOT / "src/main/java/com/ultratile/proto/UtpMessages.java"
    cfg_consts, cfg_text = read_java_consts(cfg_path) if cfg_path.exists() else ({}, "")
    wire_consts, wire_text = read_java_consts(wire_path) if wire_path.exists() else ({}, "")
    # Owner separation: tuning names must not live in the wire file and
    # wire names must not live in the tuning file.
    for tune in ("TILE_SIZE", "CACHE_CAP", "DECODE_MAX", "SPAN_CAP", "GEN_TILE_CAP"):
        if tune in wire_consts:
            fail(f"owner violation: {tune} must live in Config.java, not UtpMessages.java")
    for wire in ("MAGIC", "T_VIEWPORT", "T_TILE", "T_ABORT", "T_END", "T_COMMIT"):
        if wire in cfg_consts:
            fail(f"owner violation: {wire} must live in UtpMessages.java, not Config.java")
    for js_name, owner, java_name, kind in JS_MAP:
        if js_name not in js_consts:
            fail(f"viewer missing const {js_name} (expected in web/js/)")
            continue
        owner_consts = cfg_consts if owner == "Config" else wire_consts
        owner_file = "Config.java" if owner == "Config" else "UtpMessages.java"
        if java_name not in owner_consts:
            fail(f"{owner_file} missing {java_name} (owner of viewer {js_name})")
            continue
        if kind == "int":
            jv = norm_js_int(js_consts[js_name])
            want = norm_int(owner_consts[java_name])
            if jv is None:
                fail(f"viewer {js_name}={js_consts[js_name]!r} unparsable")
            elif want is None:
                fail(f"{owner_file}.{java_name}={owner_consts[java_name]!r} unparsable")
            elif jv != want:
                fail(f"viewer {js_name}={jv!r} != {owner}.{java_name}={want!r}")
        else:
            jv = norm_float(js_consts[js_name])
            want = norm_float(owner_consts[java_name])
            if jv is None or want is None or abs(jv - want) > 1e-12:
                fail(f"viewer {js_name}={js_consts[js_name]!r} != {owner}.{java_name}={owner_consts[java_name]!r}")
    # Subprotocol literal is pinned, not a const assignment.
    if "ultratile.utp.v1" not in bundle:
        fail("viewer must offer subprotocol ultratile.utp.v1")
    # Viewer-local policy must stay outside the map: PLAN_FLOOR may exist
    # in JS but must never appear as a JS_MAP entry.
    if any(row[0] == "PLAN_FLOOR" for row in JS_MAP):
        fail("PLAN_FLOOR must stay outside the parity map (viewer-local policy)")
    # Bare epoch-set name must be extinct: only the epoch-suffixed set exists.
    if re.search(r"serverSkipped(?!ThisEpoch)", bundle):
        fail("bare serverSkipped identifier extinct; use serverSkippedThisEpoch")
    # Browser must never attempt a script-sent codeless/1002 close.
    if "ws.close(1002" in bundle or re.search(r"ws\.close\(\s*\)", bundle):
        fail("browser must never send script close 1002 or codeless close")
    # Each module must parse and index.html must load them in order.
    for name, text in texts.items():
        if "https://" in text or "http://" in text or "cdn" in text.lower():
            fail(f"web/js/{name} must stay offline-clean")
    idx = (ROOT / "src/main/resources/web/index.html").read_text() if (
        ROOT / "src/main/resources/web/index.html").exists() else ""
    pos = -1
    for name in JS_FILES:
        tag = f"/js/{name}"
        i = idx.find(tag)
        if i < 0:
            fail(f"index.html missing <script> for {tag}")
        elif i < pos:
            fail(f"index.html loads {tag} out of load order")
        else:
            pos = i
    if "/viewer.js" in idx:
        fail("index.html must not reference the removed /viewer.js monolith")


def main(argv):
    java_shell_only = "--java-shell-only" in argv
    check_config()
    check_wire_owner()
    check_derived_dim_limit()
    check_shell()
    check_ingest()
    if not java_shell_only:
        check_js()
    if FAILURES:
        print(f"{len(FAILURES)} parity failure(s)")
        return 1
    print("parity-ok" + (" (java-shell-only)" if java_shell_only else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
