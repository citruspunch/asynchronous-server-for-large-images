/* cache_workload_benchmark.cjs: drive the real UltraTile viewer bundle against
 * a real server on deterministic viewport workloads and report LFUDA cache
 * metrics plus a deterministic decision signature.
 *
 * VALIDATION TOOLING ONLY. Zero dependencies, offline-safe, and never needed to
 * build or run UltraTile. The production cache is LFUDA and there is no runtime
 * cache-policy switch: this script measures the one policy that ships.
 *
 * What it deliberately does NOT do:
 *   - it does not reimplement visibleTileRange, effectiveLOD, requestableKeys,
 *     the epoch machinery, batch planning or LfudaCache. It loads the shipped
 *     modules into a node:vm exactly as scripts/test_viewer.cjs does and calls
 *     them;
 *   - it does not reimplement LRU. The pre-migration LRU numbers live in
 *     scripts/cache-baseline-lru.json as historical data;
 *   - it does not reimplement the input path. Every pan and zoom is a real DOM
 *     event delivered to the handler installHandlers() installed;
 *   - it hardcodes no viewer constant. MAX_CACHE, UNION_CAP and
 *     INTENT_DEBOUNCE_MS are read out of the running bundle.
 *
 * The only production addition this tool needed is one read-only observer,
 * UltraTile.cameraState(), because the camera is module-private and a
 * viewport-operator benchmark has to know where the camera is to decide the
 * next operation. Re-deriving it from visibleTileRange() would quantise to a
 * tile; re-implementing the pointer and wheel arithmetic here would be a second
 * copy of production behaviour. It moves nothing and no control flow reads it.
 *
 * Usage:  node scripts/cache_workload_benchmark.cjs [options]
 *   --all                 run every canonical workload (default)
 *   --image N             only workloads on image N
 *   --viewport WxH        only workloads at this viewport size
 *   --no-compare-baseline do not diff against the historical LRU fixture
 *   --json                emit the JSON report only, on stdout
 *   --out FILE            also write the JSON report to FILE
 *   --base URL            use an already-running server (implies --no-spawn)
 *   --no-spawn            never start a server; fail if none is reachable
 *   --keep-server         leave a spawned server running afterwards
 *   --list                print the canonical workload ids and exit
 *   --quiet               suppress per-workload progress lines
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {spawn} = require("child_process");

const REPO = path.join(__dirname, "..");
const WEB = path.join(REPO, "src", "main", "resources", "web");
const BASELINE_PATH = path.join(__dirname, "cache-baseline-lru.json");

// The viewer module list is not copied here. Load order is read out of
// index.html, which is what a browser actually executes, so this tool cannot
// drift from the shipped page. (The list is otherwise held in test_viewer.cjs
// and check_const_parity.py; a fourth copy would be a fourth thing to forget.)
function viewerFiles() {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const re = /<script[^>]*\ssrc="[^"]*\/([^/"]+\.js)"[^>]*>/g;
  const out = [];
  let m = re.exec(html);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(html);
  }
  if (!out.length) {
    throw new Error("no <script src=...js> tags found in web/index.html");
  }
  for (const f of out) {
    if (!fs.existsSync(path.join(WEB, "js", f))) {
      throw new Error("index.html loads js/" + f + " but that file does not exist");
    }
  }
  return out;
}

const VIEWER_SRC = viewerFiles()
  .map((f) => fs.readFileSync(path.join(WEB, "js", f), "utf8"))
  .join("\n");

// ---- CLI (deliberately minimal) ----
const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf("--" + name) >= 0;
function opt(name, dflt) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

const OPTS = {
  image: opt("image", null),
  viewport: opt("viewport", null),
  compare: !flag("no-compare-baseline"),
  json: flag("json"),
  out: opt("out", ""),
  base: opt("base", "http://127.0.0.1:8080"),
  spawn: !flag("no-spawn") && opt("base", null) === null,
  list: flag("list"),
  quiet: flag("quiet"),
  keep: flag("keep-server")
};
const BASE = new URL(OPTS.base);
const HOST = BASE.host;

// ---- the canonical workload set ----
// Dimensions are pinned so a demo image can never be silently substituted for a
// ladder rung: a workload whose published image is the wrong size is a
// failure, not a substitution.
const CANONICAL = [
  {id: "image-4-1080p", image: 4, dims: "10000x7533", viewport: [1920, 1080]},
  {id: "image-5-1080p", image: 5, dims: "25000x18832", viewport: [1920, 1080]},
  {id: "image-6-1080p", image: 6, dims: "40000x30131", viewport: [1920, 1080]},
  {id: "image-6-4k", image: 6, dims: "40000x30131", viewport: [3840, 2160]}
];

// One viewport step is this many tiles of world travel, in tiles of the level
// the viewport is currently serving. Unchanged from the pre-migration run, so
// the workloads are the same family of workload.
const STEP_TILES = 2;
// Edge-reversal thresholds as fractions of the image. Also unchanged.
const EDGE_HI = 0.75;
const EDGE_LO = 0.25;
const SERPENTINE_HI = 0.8;
const SERPENTINE_LO = 0.2;

// The trace program. Operation names and counts match the pre-migration run so
// the two are comparable workload-for-workload.
const PROGRAM = [
  {
    name: "pan left x3 then right x3",
    ops: [["sweep", 3, -1, 0], ["sweep", 3, 1, 0], ["recenter"]]
  },
  {
    name: "pan right x3 then left x3",
    ops: [["sweep", 3, 1, 0], ["sweep", 3, -1, 0], ["recenter"]]
  },
  {name: "small back-and-forth x10", ops: [["jitter", 10, 1, 0]]},
  {
    name: "zoom ladder x2, pan, back, revisit",
    ops: [["zoom", 4], ["sweep", 4, 1, 0], ["zoom", 2], ["sweep", 3, 1, 1],
      ["zoom", 1], ["sweep", 4, 1, 0], ["recenter"]]
  },
  {name: "serpentine 6 cols x 5 rows", ops: [["serpentine", 6, 5]]},
  {name: "wide sweep 20 steps", ops: [["sweep", 20, 1, 0], ["recenter"]]},
  {name: "vertical sweep 14 steps", ops: [["sweep", 14, 0, 1], ["recenter"]]},
  {
    name: "deep zoom revisit ladder",
    ops: [["ladder", [8, 4, 2, 1]], ["ladder", [1, 2, 4, 8]], ["recenter"]]
  },
  {name: "image switch out and back", ops: [["switch", 4]]}
];

const QUIET_MS = 400;            // no new TILE frame for this long => settled
const OP_TIMEOUT_MS = 120000;    // ceiling on one viewport operation
const SETTLE_TIMEOUT_MS = 300000;

// ---- small helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseViewport(s) {
  const m = /^(\d+)[xX](\d+)$/.exec(String(s || ""));
  if (!m) {
    throw new Fail("bad --viewport " + s + " (want WxH, e.g. 1920x1080)");
  }
  return Number(m[1]) + "x" + Number(m[2]);
}

// FNV-1a over a canonical string. Signature only; never a correctness check.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

// Fail carries a message meant for a person; anything else is a bug in this
// script and gets a stack.
class Fail extends Error {}

// ---- the sandbox: real WebSocket, real fetch, stub DOM and stub decode ----
function makeSession(viewport) {
  const W = viewport[0];
  const H = viewport[1];

  const listeners = {};
  const hud = {};
  const elements = {};
  const ctx2d = {
    resetTransform() {}, clearRect() {}, fillRect() {}, save() {},
    restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {},
    clip() {}, drawImage() {}
  };
  const canvas = {
    clientWidth: W,
    clientHeight: H,
    width: W,
    height: H,
    addEventListener(t, f) {
      (listeners[t] = listeners[t] || []).push(f);
    },
    getContext: () => ctx2d,
    setPointerCapture() {},
    getBoundingClientRect: () => ({left: 0, top: 0})
  };
  const picker = {value: "", options: [], addEventListener() {}, appendChild() {}};
  elements.view = canvas;
  elements.image = picker;
  const documentStub = {
    getElementById(id) {
      if (elements[id]) {
        return elements[id];
      }
      return (hud[id] = hud[id] || {textContent: ""});
    },
    createElement: () => ({value: "", textContent: ""})
  };

  // Instrumentation that lives entirely outside the viewer, so nothing in the
  // production path is aware of it.
  const wire = {
    sockets: 0,
    bytesSent: 0,
    tileFrames: 0,
    tilePayloadBytes: 0,
    seenAll: new Set(),        // keys ever transferred; never reset
    seenSinceSwitch: new Set(),
    log: [],
    decodes: 0,
    closes: 0,
    doubleClose: 0,
    openBitmaps: new Set()
  };

  // Re-fetches come from here, not from the cache: a cache miss is a viewport
  // need the cache did not satisfy, which is not the same thing as a network
  // fetch, because a miss can correspond to a key already in flight.
  function observeFrame(buf) {
    if (!buf || typeof buf.byteLength !== "number" || buf.byteLength < 24) {
      return;
    }
    const v = new DataView(buf);
    if (v.getUint8(0) !== 0xAA || v.getUint8(1) !== 0x02) {
      return;
    }
    const payloadLen = v.getUint32(20);
    if (buf.byteLength !== 24 + payloadLen) {
      return;                   // not a well-formed TILE; the viewer will reject it
    }
    const key = v.getUint16(2) + ":" + v.getUint8(4) + ":"
      + v.getUint32(12) + ":" + v.getUint32(16);
    wire.tileFrames += 1;
    wire.tilePayloadBytes += payloadLen;
    const isRefetch = wire.seenAll.has(key);
    const isRefetchExclSwitch = wire.seenSinceSwitch.has(key);
    wire.seenAll.add(key);
    wire.seenSinceSwitch.add(key);
    wire.log.push({key, len: payloadLen, refetch: isRefetch, refetchExclSwitch: isRefetchExclSwitch});
  }

  // Installed before the viewer's own onmessage, so frames are observed
  // independently of anything the viewer reports.
  const RealWS = globalThis.WebSocket;
  class CountingWS extends RealWS {
    constructor(url, protocols) {
      super(url, protocols);
      wire.sockets += 1;
    }
    send(buf) {
      wire.bytesSent += buf.byteLength;
      return super.send(buf);
    }
    get onmessage() {
      return this.__wrapped;
    }
    set onmessage(fn) {
      const wrapped = (ev) => {
        observeFrame(ev && ev.data);
        return fn(ev);
      };
      this.__wrapped = wrapped;
      super.onmessage = wrapped;
    }
  }

  // Decode stub. The cache policy depends on object identity and close(), not on
  // decode speed, and a real decode of tens of gigabytes of JPEG would measure
  // the host rather than the policy. Resolving in call order keeps completion
  // order equal to submit order, which is what makes the admission sequence
  // reproducible.
  const createImageBitmap = () => new Promise((resolve) => {
    setTimeout(() => {
      const bmp = {
        width: 512,
        height: 512,
        closed: false,
        close() {
          if (bmp.closed) {
            wire.doubleClose += 1;
            return;
          }
          bmp.closed = true;
          wire.closes += 1;
          wire.openBitmaps.delete(bmp);
        }
      };
      wire.decodes += 1;
      wire.openBitmaps.add(bmp);
      resolve(bmp);
    }, 1);
  });

  const wrapFetch = (u, o) =>
    fetch(String(u).startsWith("http") ? String(u) : OPTS.base + String(u), o);

  const sandbox = {
    console: {log() {}, warn: (...a) => process.stderr.write(a.join(" ") + "\n"),
      error: (...a) => process.stderr.write(a.join(" ") + "\n")},
    WebSocket: CountingWS,
    fetch: wrapFetch,
    location: {host: HOST, protocol: BASE.protocol, href: OPTS.base},
    document: documentStub,
    Blob,
    createImageBitmap,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    queueMicrotask
  };
  vm.createContext(sandbox);
  vm.runInContext(VIEWER_SRC, sandbox, {filename: "ultratile-viewer-bundle.js"});

  // Read the policy constants out of the bundle rather than restating them.
  const consts = vm.runInContext(
    "({MAX_CACHE: MAX_CACHE, UNION_CAP: UNION_CAP,"
    + " INTENT_DEBOUNCE_MS: INTENT_DEBOUNCE_MS, TILE: TILE})", sandbox);

  return {
    api: sandbox.UltraTile,
    wire,
    hud,
    listeners,
    canvas,
    W,
    H,
    consts
  };
}

// ---- reading the viewer's own instrumentation ----
function hudNum(hud, id) {
  const el = hud[id];
  const v = el === undefined ? undefined : Number(el.textContent);
  return Number.isFinite(v) ? v : 0;
}

function readCounters(s) {
  const h = s.hud;
  return {
    hits: hudNum(h, "hits"),
    misses: hudNum(h, "miss"),
    evictions: hudNum(h, "evicts"),
    cacheSize: hudNum(h, "cache"),
    lfudaAge: hudNum(h, "lfuAge"),
    rxBytes: hudNum(h, "rxBytes"),
    decodedBytes: hudNum(h, "decodedBytes"),
    requests: hudNum(h, "reqs"),
    epoch: hudNum(h, "epoch"),
    decodeJobs: hudNum(h, "decJobs")
  };
}

// ---- invariant checking ----
class Invariants {
  constructor(capacity) {
    this.capacity = capacity;
    this.failures = [];
    this.peakSize = 0;
    this.peakAge = 0;
    this.ageDips = 0;
    this.maxAgeDip = 0;
    this.prev = null;
    this.prevEpoch = 0;
    this.ageFloor = 0;
  }
  fail(msg) {
    if (this.failures.indexOf(msg) < 0) {
      this.failures.push(msg);
    }
  }
  // The cache is cleared on an image switch, which restarts age and every
  // frequency, so the per-generation bookkeeping is both per-generation.
  noteClear() {
    this.ageFloor = 0;
    this.prev = null;
  }
  // One sample: a production snapshot plus the checks that are only observable
  // from outside the cache.
  sample(s, api) {
    const snap = api.cacheSnapshot();
    const c = readCounters(s);
    this.check(snap, c);
    if (snap.size > this.peakSize) {
      this.peakSize = snap.size;
    }
    if (snap.age > this.peakAge) {
      this.peakAge = snap.age;
    }
    return {snap, c};
  }
  check(snap, c) {
    if (!(snap.size <= this.capacity)) {
      this.fail("cache size " + snap.size + " exceeds capacity " + this.capacity);
    }
    if (snap.size !== c.cacheSize) {
      this.fail("cacheSnapshot().size " + snap.size
        + " disagrees with the HUD cache counter " + c.cacheSize);
    }
    if (snap.hits !== c.hits || snap.misses !== c.misses) {
      this.fail("cacheSnapshot hits/misses " + snap.hits + "/" + snap.misses
        + " disagree with the HUD " + c.hits + "/" + c.misses);
    }
    if (snap.evicts !== c.evictions) {
      this.fail("cacheSnapshot evicts " + snap.evicts
        + " disagrees with the HUD evicts counter " + c.evictions);
    }
    if (!Number.isInteger(snap.age) || snap.age < 0) {
      this.fail("lfuda age is not a non-negative integer: " + snap.age);
    }
    if (snap.age > this.peakAge) {
      this.peakAge = snap.age;
    }
    // The watermark is not monotone, and the benchmark does not pretend
    // otherwise. `age` is assigned the priority of each victim, and viewport
    // protection can hold an entry below the current watermark: a key protected
    // while the watermark rose past it keeps its old priority, and when the
    // target moves on, that key becomes the lowest-priority candidate and the
    // assignment lowers age again. The trend is strongly upward and each dip is
    // immediately re-climbed, so this is counted and reported rather than
    // treated as a fault. See viewer.md, "The LFUDA-40 decoded-bitmap cache".
    if (snap.age < this.ageFloor) {
      this.ageDips += 1;
      const dip = this.ageFloor - snap.age;
      if (dip > this.maxAgeDip) {
        this.maxAgeDip = dip;
      }
    }
    this.ageFloor = snap.age;
    let lastSeq = -1;
    for (const e of snap.entries) {
      if (!Number.isInteger(e.frequency) || e.frequency < 1) {
        this.fail("frequency < 1 on " + e.key + ": " + e.frequency);
      }
      if (!Number.isInteger(e.priority) || e.priority < e.frequency) {
        this.fail("priority " + e.priority + " is below frequency " + e.frequency
          + " on " + e.key + "; the rule is priority = age-at-update + frequency");
      }
      // priority - frequency is the watermark as it stood when this entry was
      // last written, so it must be a value the watermark can actually take: a
      // non-negative integer. It cannot be compared against the age sampled at
      // this instant, because the watermark can rise and fall several times
      // inside one epoch, between two samples.
      if (e.priority - e.frequency < 0) {
        this.fail("the age at last update is negative (" + (e.priority - e.frequency)
          + ") on " + e.key);
      }
      if (!(e.lastCountedEpoch <= c.epoch)) {
        this.fail("lastCountedEpoch " + e.lastCountedEpoch + " is ahead of the"
          + " current epoch " + c.epoch + " on " + e.key);
      }
      if (e.insertedSeq <= lastSeq) {
        this.fail("insertedSeq is not strictly increasing along the Map"
          + " (admission) order: " + lastSeq + " -> " + e.insertedSeq + " on " + e.key);
      }
      lastSeq = e.insertedSeq;
    }
    // At most one reference per viewport epoch: a key cannot gain more
    // frequencies than the number of epochs that elapsed.
    if (this.prev) {
      const elapsed = c.epoch - this.prevEpoch;
      const now = new Map(snap.entries.map((e) => [e.key, e]));
      for (const [key, before] of this.prev) {
        const after = now.get(key);
        if (after === undefined) {
          continue;
        }
        const gained = after.frequency - before.frequency;
        if (gained > elapsed) {
          this.fail("key " + key + " gained " + gained + " references across "
            + elapsed + " epoch(s); at most one per viewport epoch is allowed");
        }
      }
    }
    this.prev = new Map(snap.entries.map((e) => [e.key, e]));
    this.prevEpoch = c.epoch;
  }
}

// ---- driving the shipped input path ----
function fire(s, type, ev) {
  const fns = s.listeners[type];
  if (!fns || !fns.length) {
    throw new Fail("the viewer installed no '" + type + "' listener; boot() did"
      + " not run or installHandlers() did not fire");
  }
  for (const f of fns) {
    f(ev);
  }
}

// The handler reads camX -= dx / camS, so a world-space delta of `wx` is a
// screen-space delta of `-wx * camS`.
function panWorld(s, wx, wy) {
  const cam = s.api.cameraState();
  const dxPx = -wx * cam.s;
  const dyPx = -wy * cam.s;
  // Delivered as pointer gestures, each no wider than the canvas, so a long pan
  // is several gestures rather than one impossible event. The handler reads
  // only the deltas, so the resulting camera is identical.
  const segs = Math.max(1, Math.ceil(Math.max(Math.abs(dxPx), Math.abs(dyPx)) / (s.W * 0.7)));
  const x0 = s.W / 2;
  const y0 = s.H / 2;
  let pid = 1000;
  for (let i = 0; i < segs; i++) {
    const id = ++pid;
    fire(s, "pointerdown", {pointerId: id, clientX: x0, clientY: y0});
    fire(s, "pointermove", {
      pointerId: id,
      clientX: x0 + dxPx / segs,
      clientY: y0 + dyPx / segs
    });
    fire(s, "pointerup", {pointerId: id});
  }
}

// The handler computes s2 = clamp(camS * exp(-deltaY * 0.001)), so this delta
// lands on the target scale exactly. Zooming about the viewport centre leaves
// the camera centre where it was.
function wheelTo(s, targetScale) {
  const cam = s.api.cameraState();
  const clamped = Math.min(32, Math.max(1e-3, targetScale));
  fire(s, "wheel", {
    deltaY: -1000 * Math.log(clamped / cam.s),
    clientX: s.W / 2,
    clientY: s.H / 2,
    preventDefault() {}
  });
  return clamped;
}

// ---- idle detection ----
async function settle(s, opts) {
  opts = opts || {};
  const quietMs = opts.quietMs === undefined ? QUIET_MS : opts.quietMs;
  const timeoutMs = opts.timeoutMs === undefined ? SETTLE_TIMEOUT_MS : opts.timeoutMs;
  const startEpoch = readCounters(s).epoch;
  const t0 = Date.now();
  let lastFrames = s.wire.tileFrames;
  let quietSince = Date.now();
  // The debounce is a real timer, so an intent cannot exist before it elapses.
  await sleep(s.consts.INTENT_DEBOUNCE_MS * 3);
  for (;;) {
    await sleep(20);
    const c = readCounters(s);
    if (s.wire.tileFrames !== lastFrames) {
      lastFrames = s.wire.tileFrames;
      quietSince = Date.now();
    }
    const quiet = Date.now() - quietSince > quietMs;
    if (quiet && c.decodeJobs === 0 && (opts.waitEpoch === false || c.epoch > startEpoch)) {
      return c;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Fail("viewport operation did not settle within " + timeoutMs
        + " ms (epoch " + startEpoch + " -> " + c.epoch + ", decodeJobs "
        + c.decodeJobs + ", tile frames seen " + lastFrames + ")");
    }
  }
}

// ---- one benchmark session ----
async function runWorkload(wl, baseline) {
  const say = (m) => {
    if (!OPTS.quiet && !OPTS.json) {
      process.stderr.write(m + "\n");
    }
  };
  const [W, H] = wl.viewport;
  say("CACHE-WORKLOAD " + wl.id + ": image-" + wl.image + " " + wl.dims
    + " at " + W + "x" + H);

  const s = makeSession(wl.viewport);
  const api = s.api;
  const inv = new Invariants(s.consts.MAX_CACHE);

  // ---- boot, select, verify the published dimensions ----
  const boot = api.boot();
  const t0 = Date.now();
  while (s.wire.sockets === 0) {
    if (Date.now() - t0 > 30000) {
      throw new Fail("the viewer never opened a WebSocket. Is a server up at "
        + OPTS.base + "?");
    }
    await sleep(20);
  }
  await boot;
  await settle(s, {waitEpoch: false});
  await api.selectImage(wl.image);
  await settle(s, {waitEpoch: false});
  const cam = api.cameraState();
  if (cam.image !== wl.image) {
    throw new Fail("selectImage(" + wl.image + ") left image " + cam.image + " selected");
  }
  if (cam.w + "x" + cam.h !== wl.dims) {
    throw new Fail("image-" + wl.image + " is published as " + cam.w + "x" + cam.h
      + " but workload " + wl.id + " is defined against " + wl.dims
      + "; refusing to run it against a different image");
  }
  inv.noteClear();
  inv.sample(s, api);

  // ---- calibration: the most cache-stressed operating point, chosen purely
  // from geometry, through the real wheel handler ----
  // Zooming about the viewport centre leaves the camera centre unchanged, so
  // this sweep needs no settle per sample: the handlers are synchronous and the
  // debounce coalesces every wheel into one intent. It is also a free check that
  // rendering never moves a frequency, because every sample redraws.
  //
  // The grid is the pre-migration grid, unchanged, because the chosen scale
  // decides which level every later step pans at. A different grid is a
  // different workload, and the historical numbers would stop being comparable
  // for reasons that have nothing to do with the cache.
  let best = null;
  for (let i = 0; i <= 90; i++) {
    const probe = Math.pow(2, -7 + i * 0.2);
    wheelTo(s, probe);
    const lod = api.effectiveLOD(api.selectLevel(probe));
    if (lod.effective !== lod.desired) {
      continue;
    }
    const keys = api.visibleTileRange(lod.effective).length;
    if (best === null || keys > best.keys) {
      best = {s: probe, keys, desired: lod.desired, effective: lod.effective};
    }
  }
  wheelTo(s, best.s);
  await settle(s, {waitEpoch: false});
  const cal = inv.sample(s, api);
  const calibration = {
    chosen_scale: Number(best.s.toPrecision(8)),
    desired_level: best.desired,
    effective_level: best.effective,
    requested_keys_per_viewport: best.keys,
    rationale: "the scale whose effective LOD asks for the most tiles at this"
      + " viewport, i.e. the operating point that stresses the cache hardest"
  };
  say("  calibrated scale " + calibration.chosen_scale + " -> level "
    + best.effective + ", " + best.keys + " keys per viewport, cache holds "
    + cal.snap.size);

  // The measured section starts here, after calibration has settled.
  const baseScale = api.cameraState().s;
  const cam0 = api.cameraState();
  const anchor = {x: cam0.w / 2, y: cam0.h / 2};
  const start = {
    counters: readCounters(s),
    frames: s.wire.tileFrames,
    wireBytes: s.wire.tilePayloadBytes,
    logLen: s.wire.log.length
  };

  // ---- geometry, read from the production functions ----
  function tileStep() {
    const c = api.cameraState();
    const N = Math.max(0, Math.ceil(Math.log2(Math.max(c.w, c.h) / s.consts.TILE)));
    const z = api.effectiveLOD(api.selectLevel(c.s)).effective;
    return s.consts.TILE * Math.pow(2, N - z);
  }

  // The union runViewportBatches() hands to protectTarget() for the current
  // epoch: the visible tiles at every level the epoch will work on, which is
  // 0..effective, read from visibleTileRange(). Not 0..N: the epoch works on the
  // effective level only, so a tile visible only at some finer level than that
  // is neither protected nor requested, and must not be counted as either.
  function targetUnion() {
    const c = api.cameraState();
    const set = new Set();
    const E = api.effectiveLOD(api.selectLevel(c.s)).effective;
    for (let Z = 0; Z <= E; Z++) {
      for (const k of api.visibleTileRange(Z)) {
        set.add(k);
      }
    }
    return set;
  }

  function requestedKeysNow() {
    const c = api.cameraState();
    return api.visibleTileRange(api.effectiveLOD(api.selectLevel(c.s)).effective).length;
  }

  const ops = [];
  let receivedTotal = 0;
  let receivedCached = 0;
  let peakTargetSize = 0;

  // One semantic viewport operation: dispatch its input as production DOM
  // events, then wait for exactly one debounced intent and for the pipeline to
  // drain.
  async function op(kind, detail) {
    const before = readCounters(s);
    const logFrom = s.wire.log.length;
    switch (kind) {
      case "pan": {
        const t = tileStep() * STEP_TILES;
        panWorld(s, detail[0] * t, detail[1] * t);
        break;
      }
      case "zoom":
        wheelTo(s, baseScale * detail[0]);
        break;
      case "recenter": {
        const c = api.cameraState();
        panWorld(s, anchor.x - c.x, anchor.y - c.y);
        break;
      }
      default:
        throw new Fail("unknown viewport operation " + kind);
    }
    const c = await settle(s, {timeoutMs: OP_TIMEOUT_MS});
    if (c.epoch !== before.epoch + 1) {
      throw new Fail("viewport operation '" + kind + "' moved the epoch by "
        + (c.epoch - before.epoch) + ", expected exactly 1. The workload is not"
        + " deterministic, so its numbers would not be reproducible.");
    }
    // The eligibility contract, observed end to end, with no new seam.
    //
    // Every key the epoch received is a key the epoch requested; the requested
    // set is visibleTileRange(effective); and that is a subset of the protected
    // target. So such a key is protected at the moment it is admitted, and
    // while the target is smaller than the cache, tier 1 of the documented
    // fallback always has an unprotected candidate, so a protected key cannot
    // lose. Therefore everything this epoch received must still be cached once
    // the epoch settles, and a key that does not survive is a protection
    // failure.
    const {snap} = inv.sample(s, api);
    const present = new Set(snap.entries.map((e) => e.key));
    const lost = [];
    for (let i = logFrom; i < s.wire.log.length; i++) {
      const k = s.wire.log[i].key;
      receivedTotal += 1;
      if (present.has(k)) {
        receivedCached += 1;
      } else if (lost.indexOf(k) < 0) {
        lost.push(k);
      }
    }
    if (lost.length) {
      inv.fail(lost.length + " key(s) received during this epoch were not cached"
        + " when it settled (first: " + lost[0] + "); viewport protection did not hold");
    }
    // The structural precondition for that argument. If the protected target
    // ever reached capacity, tier 1 could run dry and a protected key could
    // legitimately lose in tier 2, which is why this is asserted rather than
    // assumed.
    const target = targetUnion();
    if (target.size > peakTargetSize) {
      peakTargetSize = target.size;
    }
    if (target.size > s.consts.MAX_CACHE) {
      inv.fail("the protected target held " + target.size
        + " keys, which is not below the capacity " + s.consts.MAX_CACHE);
    }
    ops.push({
      kind,
      epoch: c.epoch,
      requested: requestedKeysNow(),
      hits: c.hits - before.hits,
      misses: c.misses - before.misses,
      evictions: c.evictions - before.evictions,
      size: snap.size,
      age: snap.age
    });
  }

  async function step(dx, dy) {
    const before = api.cameraState();
    await op("pan", [dx, dy]);
    const after = api.cameraState();
    return Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
  }

  // A sweep that reverses at the image bounds, so it keeps finding new ground
  // instead of grinding against an edge.
  async function sweep(n, dx, dy) {
    let dir = 1;
    for (let i = 0; i < n; i++) {
      const c = api.cameraState();
      const nearEdge = (dx !== 0 && (dir > 0 ? c.x > c.w * EDGE_HI : c.x < c.w * EDGE_LO))
        || (dy !== 0 && (dir > 0 ? c.y > c.h * EDGE_HI : c.y < c.h * EDGE_LO));
      if (nearEdge) {
        dir = -dir;
      }
      const moved = await step(dir * dx, dir * dy);
      if (moved < 1) {
        dir = -dir;
        await step(dir * dx, dir * dy);
      }
    }
  }

  async function jitter(n, dx, dy) {
    for (let i = 0; i < n; i++) {
      await step(dx, dy);
      await step(-dx, -dy);
    }
  }

  async function serpentine(cols, rows) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const dir = col % 2 === 0 ? 1 : -1;
        const c = api.cameraState();
        const atEdge = dir > 0 ? c.x > c.w * SERPENTINE_HI : c.x < c.w * SERPENTINE_LO;
        await step(atEdge ? -dir : dir, 0);
      }
      if (row < rows - 1) {
        await step(0, 1);
      }
    }
  }

  async function ladder(multipliers) {
    for (const m of multipliers) {
      wheelTo(s, baseScale * m);
      await settle(s, {timeoutMs: OP_TIMEOUT_MS});
      await step(1, 0);
    }
  }

  // The re-fetch history for the switch-excluded metric restarts at every
  // selectImage(). The strict metric keeps the whole session, which is what the
  // historical fixture counts.
  async function switchTo(id) {
    s.wire.seenSinceSwitch = new Set();
    const before = readCounters(s);
    await api.selectImage(id);
    const c = await settle(s, {waitEpoch: false});
    inv.noteClear();
    const {snap} = inv.sample(s, api);
    ops.push({
      kind: "switch",
      epoch: c.epoch,
      requested: 0,
      hits: c.hits - before.hits,
      misses: c.misses - before.misses,
      evictions: c.evictions - before.evictions,
      size: snap.size,
      age: snap.age
    });
  }

  // ---- run the program, one trace at a time, recording wire deltas ----
  const traces = [];
  for (const trace of PROGRAM) {
    const iw = {logLen: s.wire.log.length, bytes: s.wire.tilePayloadBytes,
      frames: s.wire.tileFrames};
    const ic = readCounters(s);
    const opStart = ops.length;

    for (const spec of trace.ops) {
      const kind = spec[0];
      if (kind === "sweep") {
        await sweep(spec[1], spec[2], spec[3]);
      } else if (kind === "jitter") {
        await jitter(spec[1], spec[2], spec[3]);
      } else if (kind === "serpentine") {
        await serpentine(spec[1], spec[2]);
      } else if (kind === "ladder") {
        await ladder(spec[1]);
      } else if (kind === "switch") {
        await switchTo(spec[1]);
        await switchTo(wl.image);
      } else {
        await op(kind, spec.slice(1));
      }
    }

    const rf = tally(s.wire.log, iw.logLen);
    const fc = readCounters(s);
    const d = (k) => fc[k] - ic[k];
    traces.push({
      trace: trace.name,
      viewport_operations: ops.length - opStart,
      cache_hits: d("hits"),
      cache_misses: d("misses"),
      evictions: d("evictions"),
      re_fetches: rf.reFetches,
      re_fetch_bytes: rf.reFetchBytes,
      re_fetches_excl_image_switch: rf.reFetchesExclSwitch,
      rx_bytes: d("rxBytes"),
      decoded_bytes: d("decodedBytes")
    });
    say("  " + trace.name + ": ops=" + (ops.length - opStart) + " hits=" + d("hits")
      + " miss=" + d("misses") + " evict=" + d("evictions")
      + " refetch=" + rf.reFetches);
  }

  // ---- totals over the measured section ----
  const end = readCounters(s);
  const delta = (k) => end[k] - start.counters[k];
  const rf = tally(s.wire.log, start.logLen);
  const wireBytes = s.wire.tilePayloadBytes - start.wireBytes;
  const wireFrames = s.wire.tileFrames - start.frames;
  const epochs = delta("epoch");
  const openNow = s.wire.openBitmaps.size;

  // ---- hard invariants ----
  if (wireBytes !== delta("rxBytes")) {
    inv.fail("rxBytes observed on the wire (" + wireBytes + ") disagrees with"
      + " the viewer's own counter (" + delta("rxBytes") + ")");
  }
  if (s.wire.doubleClose !== 0) {
    inv.fail(s.wire.doubleClose + " bitmaps were close()d more than once");
  }
  // Every decoded bitmap is either still cached or was closed exactly once. The
  // second term is the leak check: a lost bitmap shows as an imbalance.
  if (s.wire.decodes !== openNow + s.wire.closes) {
    inv.fail("decode/close accounting does not balance: " + s.wire.decodes
      + " decoded, " + openNow + " still open, " + s.wire.closes + " closed");
  }
  if (peakTargetSize > s.consts.MAX_CACHE) {
    inv.fail("the protected target peaked at " + peakTargetSize
      + " keys, which is not below the capacity " + s.consts.MAX_CACHE);
  }

  // ---- the deterministic decision signature ----
  // Only fields that are a function of the workload and the policy. No timing,
  // no byte totals, no wall clock: byte totals depend on the JPEG encoder that
  // built the pyramid and must never be signature material.
  const signature = fnv1a(ops
    .map((o) => [o.epoch, o.requested, o.hits, o.misses, o.evictions, o.size, o.age].join(","))
    .join(";"));

  const m = {
    viewport_needs: delta("hits") + delta("misses"),
    cache_hits: delta("hits"),
    cache_misses: delta("misses"),
    evictions: delta("evictions"),
    re_fetches: rf.reFetches,
    re_fetch_bytes: rf.reFetchBytes,
    re_fetches_excl_image_switch: rf.reFetchesExclSwitch,
    rx_bytes: delta("rxBytes"),
    decoded_bytes: delta("decodedBytes"),
    requests: delta("requests"),
    wire_tile_frames: wireFrames,
    peak_cache_entries: inv.peakSize,
    final_cache_entries: end.cacheSize,
    lfuda_age_final: end.lfudaAge,
    lfuda_age_peak_at_epoch_boundary: inv.peakAge,
    lfuda_age_peak_note: "sampled once per epoch; the watermark also moves"
      + " between samples, so this is a lower bound on the true peak",
    lfuda_age_dips: inv.ageDips,
    lfuda_age_largest_dip: inv.maxAgeDip,
    decodes: s.wire.decodes,
    bitmaps_closed: s.wire.closes,
    bitmaps_still_open: openNow,
    peak_protected_target_size: peakTargetSize,
    keys_received_during_epochs: receivedTotal,
    keys_received_still_cached: receivedCached
  };

  const result = {
    id: wl.id,
    image_id: wl.image,
    image_dims: wl.dims,
    viewport: W + "x" + H,
    cache_policy: "LFUDA-40",
    cache_capacity: s.consts.MAX_CACHE,
    union_cap: s.consts.UNION_CAP,
    calibration,
    epochs,
    viewport_operations: ops.length,
    traces,
    metrics: m,
    signature,
    signature_inputs: "per viewport operation:"
      + " epoch,requested,hits,misses,evictions,size,age",
    op_log: ops,
    invariants: {
      capacity_never_exceeded: inv.peakSize <= s.consts.MAX_CACHE,
      age_is_non_negative_integer: inv.failures.every((f) => f.indexOf("non-negative integer") < 0),
      priority_never_below_frequency: inv.failures.every((f) => f.indexOf("below frequency") < 0),
      age_at_update_non_negative: inv.failures.every((f) => f.indexOf("age at last update is negative") < 0),
      at_most_one_reference_per_epoch: !inv.failures.some((f) => f.indexOf("gained") >= 0),
      inserted_seq_strictly_increasing: inv.failures.every((f) => f.indexOf("insertedSeq") < 0),
      snapshot_agrees_with_hud: !inv.failures.some((f) => f.indexOf("disagrees with the HUD") >= 0),
      wire_rx_bytes_agrees_with_viewer: wireBytes === delta("rxBytes"),
      no_bitmap_closed_twice: s.wire.doubleClose === 0,
      decode_close_balance: s.wire.decodes === openNow + s.wire.closes,
      protected_target_survived_its_epoch: receivedCached === receivedTotal,
      union_cap_below_capacity: s.consts.UNION_CAP <= s.consts.MAX_CACHE,
      aging_was_engaged: inv.peakAge > 0
    },
    failures: inv.failures
  };

  // ---- historical baseline comparison, labelled as historical ----
  if (OPTS.compare && baseline) {
    const b = (baseline.workloads || []).find((x) => x.id === wl.id);
    if (b) {
      // The two sessions are NOT the same workload, so the numbers are printed
      // side by side and never differenced into a verdict. The reason travels
      // with the data: see comparison_caveat in the fixture.
      result.historical_baseline = {
        source: path.relative(REPO, BASELINE_PATH),
        kind: baseline.kind,
        workload_comparable: false,
        why_not_comparable: baseline.comparison_caveat,
        internally_valid: baseline.internal_validity,
        cache_misses: b.misses,
        evictions: b.evictions,
        re_fetches: b.re_fetches,
        re_fetch_bytes: b.re_fetch_bytes,
        rx_bytes: b.rx_bytes,
        decoded_bytes: b.decoded_bytes,
        degenerate_traces: b.degenerate_traces,
        epochs_at_end_absolute: b.epochs
      };
    } else {
      result.historical_baseline = null;
    }
  }
  return result;
}

function tally(log, from) {
  let reFetches = 0;
  let reFetchBytes = 0;
  let reFetchesExclSwitch = 0;
  for (let i = from; i < log.length; i++) {
    const e = log[i];
    if (e.refetch) {
      reFetches += 1;
      reFetchBytes += e.len;
    }
    if (e.refetchExclSwitch) {
      reFetchesExclSwitch += 1;
    }
  }
  return {reFetches, reFetchBytes, reFetchesExclSwitch};
}

// ---- server lifecycle ----
async function serverImages() {
  try {
    const r = await fetch(OPTS.base + "/api/images",
      {signal: AbortSignal.timeout(3000)});
    if (!r.ok) {
      return null;
    }
    const list = await r.json();
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

async function ensureServer() {
  const already = await serverImages();
  if (already) {
    return {child: null, images: already, spawned: false};
  }
  if (!OPTS.spawn) {
    throw new Fail("no server answering at " + OPTS.base + ", and starting one"
      + " was not allowed. Start one with:\n  java -jar target/ultratile-1.0.jar");
  }
  const jar = path.join(REPO, "target", "ultratile-1.0.jar");
  if (!fs.existsSync(jar)) {
    throw new Fail("no server at " + OPTS.base + " and no " + jar + " to start."
      + " Build it first:\n  ./build.sh");
  }
  const child = spawn("java", ["-jar", jar], {cwd: REPO, stdio: ["ignore", "ignore", "pipe"]});
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + String(d)).slice(-8192);
  });
  const t0 = Date.now();
  for (;;) {
    await sleep(250);
    const imgs = await serverImages();
    if (imgs) {
      return {child, images: imgs, spawned: true};
    }
    if (child.exitCode !== null) {
      throw new Fail("the server exited with code " + child.exitCode + ".\n" + stderr);
    }
    if (Date.now() - t0 > 120000) {
      child.kill("SIGKILL");
      throw new Fail("the server did not come up within 120 s.\n" + stderr);
    }
  }
}

function stopServer(child) {
  if (!child) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!done) {
        child.kill("SIGKILL");
        setTimeout(finish, 500);
      }
    }, 4000).unref();
  });
}

// ---- output ----
function printText(results, skipped) {
  const out = [];
  for (const r of results) {
    const m = r.metrics;
    out.push("CACHE-WORKLOAD " + r.id);
    out.push("image=" + r.image_id + " (" + r.image_dims + ") viewport=" + r.viewport
      + " policy=" + r.cache_policy + " capacity=" + r.cache_capacity
      + " union_cap=" + r.union_cap);
    out.push("epochs=" + r.epochs + " viewport_operations=" + r.viewport_operations
      + " viewport_needs=" + m.viewport_needs);
    out.push("hits=" + m.cache_hits + " misses=" + m.cache_misses
      + " evictions=" + m.evictions);
    out.push("refetches=" + m.re_fetches + " refetch_bytes=" + m.re_fetch_bytes
      + " refetches_excl_image_switch=" + m.re_fetches_excl_image_switch);
    out.push("rx_bytes=" + m.rx_bytes + " decoded_bytes=" + m.decoded_bytes
      + " requests=" + m.requests);
    out.push("peak_cache=" + m.peak_cache_entries
      + " final_cache=" + m.final_cache_entries
      + " lfuda_age=" + m.lfuda_age_final
      + " lfuda_age_peak>=" + m.lfuda_age_peak_at_epoch_boundary
      + " lfuda_age_dips=" + m.lfuda_age_dips
      + " largest_dip=" + m.lfuda_age_largest_dip);
    out.push("decodes=" + m.decodes + " bitmaps_closed=" + m.bitmaps_closed
      + " bitmaps_open=" + m.bitmaps_still_open);
    out.push("signature=" + r.signature + "  (" + r.signature_inputs + ")");
    if (r.historical_baseline) {
      const h = r.historical_baseline;
      out.push("historical-baseline Lru-40 workload_comparable=false"
        + " misses=" + h.cache_misses
        + " evictions=" + h.evictions
        + " re_fetches=" + h.re_fetches
        + " re_fetch_bytes=" + h.re_fetch_bytes
        + " rx_bytes=" + h.rx_bytes);
      out.push("historical-degenerate-traces=" + h.degenerate_traces.length
        + " (" + h.degenerate_traces.join(", ") + ")"
        + "  -- side-by-side only, NOT a delta; see docs/implementation/cache-benchmark.md");
    } else if (OPTS.compare) {
      out.push("historical-baseline=none (no entry for this workload id)");
    }
    const bools = Object.keys(r.invariants).filter((k) => typeof r.invariants[k] === "boolean");
    out.push("invariants " + bools.map((k) => k + "=" + r.invariants[k]).join(" "));
    for (const f of r.failures) {
      out.push("invariant-failure: " + f);
    }
    out.push(r.failures.length === 0 ? "PASS" : "FAIL");
    out.push("");
  }
  for (const sk of skipped) {
    out.push("SKIP " + sk.id + ": " + sk.reason);
  }
  if (skipped.length) {
    out.push("");
  }
  const bad = results.filter((r) => r.failures.length).length;
  out.push(bad === 0
    ? "CACHE-BENCH-OK " + results.length + " workload(s), 0 invariant failures"
    : "CACHE-BENCH-FAIL " + bad + " of " + results.length + " workload(s)"
      + " with invariant failures");
  return out.join("\n");
}

// ---- main ----
async function main() {
  if (OPTS.list) {
    for (const w of CANONICAL) {
      process.stdout.write(w.id + "\timage-" + w.image + " " + w.dims
        + "\t" + w.viewport.join("x") + "\n");
    }
    return 0;
  }

  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
    : null;
  if (OPTS.compare && !baseline) {
    throw new Fail("baseline comparison was requested but "
      + path.relative(REPO, BASELINE_PATH) + " is missing");
  }

  let selected = CANONICAL.slice();
  if (OPTS.image !== null) {
    const want = Number(OPTS.image);
    if (!Number.isInteger(want)) {
      throw new Fail("--image must be an integer image id");
    }
    selected = selected.filter((w) => w.image === want);
    if (!selected.length) {
      throw new Fail("no canonical workload uses image " + want + ". Ids: "
        + CANONICAL.map((w) => w.id).join(", "));
    }
  }
  if (OPTS.viewport !== null) {
    const want = parseViewport(OPTS.viewport);
    selected = selected.filter((w) => w.viewport.join("x") === want);
    if (!selected.length) {
      throw new Fail("no canonical workload uses viewport " + want + ". Sizes: "
        + [...new Set(CANONICAL.map((w) => w.viewport.join("x")))].join(", "));
    }
  }

  const srv = await ensureServer();
  const say = (m) => {
    if (!OPTS.json) {
      process.stderr.write(m + "\n");
    }
  };
  say("server " + (srv.spawned ? "started from target/ultratile-1.0.jar" : "already running")
    + " at " + OPTS.base + "; " + selected.length + " workload(s) selected");

  const results = [];
  const skipped = [];
  try {
    for (const wl of selected) {
      const published = srv.images.find((i) => i.id === wl.image);
      if (!published) {
        skipped.push({id: wl.id, reason: "image-" + wl.image + " is not published"
          + " on this server. Import it with scripts/import_vips.sh first. A demo"
          + " image is not a substitute for a ladder rung."});
        say("SKIP " + wl.id + ": image-" + wl.image + " not published");
        continue;
      }
      if (published.w + "x" + published.h !== wl.dims) {
        throw new Fail("image-" + wl.image + " is published as " + published.w + "x"
          + published.h + " but workload " + wl.id + " is defined against " + wl.dims
          + ". Refusing to run: a differently sized image is a different workload.");
      }
      results.push(await runWorkload(wl, baseline));
    }
  } finally {
    if (srv.child && !OPTS.keep) {
      await stopServer(srv.child);
    }
  }

  if (!results.length) {
    process.stderr.write("CACHE-BENCH-FAIL every selected workload was skipped:\n  "
      + skipped.map((x) => x.id + ": " + x.reason).join("\n  ") + "\n");
    return 1;
  }

  const report = {
    schema: "ultratile.cache-benchmark/1",
    generated_by: "scripts/cache_workload_benchmark.cjs",
    policy_under_test: "LFUDA-40",
    note: "LFUDA is the only production cache and there is no runtime"
      + " cache-policy switch. The historical LRU numbers in "
      + path.basename(BASELINE_PATH) + " are data, not a code path.",
    base: OPTS.base,
    node: process.version,
    step_tiles: STEP_TILES,
    results,
    skipped
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (OPTS.out) {
    fs.writeFileSync(OPTS.out, text);
  }
  if (OPTS.json) {
    process.stdout.write(text);
  } else {
    process.stdout.write(printText(results, skipped) + "\n");
  }
  return results.some((r) => r.failures.length) ? 1 : 0;
}

main().then(async (code) => {
  process.exitCode = code;
  // A spawned server is a child handle; do not let it hold the process open.
  await sleep(0);
  process.exit(code);
}).catch((e) => {
  if (e instanceof Fail) {
    process.stderr.write("CACHE-BENCH-FAIL " + e.message + "\n");
  } else {
    process.stderr.write("CACHE-BENCH-FAIL (internal error) "
      + (e && e.stack ? e.stack : String(e)) + "\n");
  }
  process.exit(1);
});
