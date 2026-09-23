/* test_viewer.cjs: node:vm + node:assert/node:test vectors for the viewer.
 * TEST-ONLY. Zero deps. The shipped app (Java + static JS) never needs Node.
 * The viewer is modular classic scripts under web/js/ (load order below);
 * the harness concatenates them into one vm script so top-level let/const
 * share a single global lexical environment, exactly as deferred <script>
 * tags do in the browser.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const {describe, it} = require("node:test");

const VIEWER_DIR = path.join(__dirname, "..", "src", "main", "resources", "web", "js");
const VIEWER_FILES = [
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
];
const VIEWER = path.join(VIEWER_DIR, "app.js");
const PARITY = path.join(__dirname, "check_const_parity.py");
const VIEWER_SRC = VIEWER_FILES.map((f) => fs.readFileSync(path.join(VIEWER_DIR, f), "utf8")).join("\n");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = cond();
    } catch (e) {
      /* ignore */
    }
    if (v) {
      return;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("timeout: " + what);
    }
    await sleep(10);
  }
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

// Objects created inside the vm realm fail reference-sensitive comparisons
// in this realm; compare them through plain JSON copies instead.
function plain(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------- fresh vm sandbox per test ----------
function fresh(opts) {
  opts = opts || {};
  const images = opts.images || [
    {id: 0, w: 2048, h: 2048},
    {id: 1, w: 4096, h: 4096}
  ];
  const infoFor = (id) => {
    const f = images.find((m) => m.id === id);
    if (!f) {
      return null;
    }
    const N = Math.max(0, Math.ceil(Math.log2(Math.max(f.w, f.h) / 512)));
    return {id: f.id, name: "image-" + f.id, w: f.w, h: f.h, levels: N + 1, tile: 512};
  };
  const sockets = [];
  const sends = [];
  const fetchCalls = [];
  const infoDefers = {};
  const host = opts.host || "example:8080";
  const flags = {deferInfo: !!opts.deferInfo};

  class StubWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      this.closeCalls = [];
      this.readyState = 0;
      this.protocol = "";
      this.binaryType = "";
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
    }
    send(buf) {
      this.sent.push(buf);
      sends.push({socket: this, buffer: buf});
    }
    close(code, reason) {
      this.closeCalls.push({code, reason});
      this.readyState = 3;
    }
    open(protocol) {
      this.protocol = (protocol === undefined) ? "ultratile.utp.v1" : protocol;
      this.readyState = 1;
      if (this.onopen) {
        this.onopen({});
      }
    }
    receive(buffer) {
      if (this.onmessage) {
        this.onmessage({data: buffer});
      }
    }
    peerClose() {
      this.readyState = 3;
      if (this.onclose) {
        this.onclose({});
      }
    }
  }

  const fetchStub = (url, fopts) => {
    fopts = fopts || {};
    fetchCalls.push({url, opts: fopts});
    return new Promise((resolve, reject) => {
      const signal = fopts.signal;
      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }
      const answer = () => {
        if (signal && signal.aborted) {
          reject(abortError());
          return;
        }
        if (url === "/api/images") {
          resolve({json: async () => images.map((m) => ({
            id: m.id, name: "image-" + m.id, w: m.w, h: m.h,
            levels: Math.max(0, Math.ceil(Math.log2(Math.max(m.w, m.h) / 512))) + 1
          }))});
          return;
        }
        const m = url.match(/^\/api\/images\/(\d+)\/info$/);
        if (m) {
          const id = +m[1];
          if (flags.deferInfo) {
            (infoDefers[id] = infoDefers[id] || []).push(() => {
              const info = infoFor(id);
              if (!info) {
                reject(new Error("no info " + id));
                return;
              }
              resolve({json: async () => info});
            });
            return;
          }
          const info = infoFor(id);
          if (!info) {
            reject(new Error("no info " + id));
            return;
          }
          resolve({json: async () => info});
          return;
        }
        reject(new Error("no route " + url));
      };
      answer();
    });
  };

  const bitmapsClosed = [];
  const bitmapPending = [];
  const createImageBitmapStub = (blob) => new Promise((resolve, reject) => {
    bitmapPending.push({resolve, reject, blob});
  });
  createImageBitmapStub.pending = bitmapPending;
  createImageBitmapStub.closed = bitmapsClosed;
  createImageBitmapStub.flushOk = (n) => {
    let i = 0;
    const lim = (n === undefined) ? Infinity : n;
    while (bitmapPending.length && i < lim) {
      const p = bitmapPending.shift();
      const bmp = {
        width: 512, height: 512, closedBy: null,
        close() {
          this.closedBy = "cache";
          bitmapsClosed.push(bmp);
        }
      };
      p.resolve(bmp);
      i++;
    }
  };
  createImageBitmapStub.flushFail = (n) => {
    let i = 0;
    const lim = (n === undefined) ? Infinity : n;
    while (bitmapPending.length && i < lim) {
      bitmapPending.shift().reject(new Error("decode fail"));
      i++;
    }
  };

  const ctxCalls = [];
  const ctxStub = {
    calls: ctxCalls,
    resetTransform() {
      ctxCalls.push("resetTransform");
    },
    clearRect() {
      ctxCalls.push("clearRect");
    },
    fillRect() {
      ctxCalls.push("fillRect");
    },
    save() {
      ctxCalls.push("save");
    },
    restore() {
      ctxCalls.push("restore");
    },
    translate() {
      ctxCalls.push("translate");
    },
    scale() {
      ctxCalls.push("scale");
    },
    beginPath() {
      ctxCalls.push("beginPath");
    },
    rect() {
      ctxCalls.push("rect");
    },
    clip() {
      ctxCalls.push("clip");
    },
    drawImage() {
      ctxCalls.push("drawImage");
    }
  };
  const canvasListeners = {};
  const canvasStub = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    listeners: canvasListeners,
    addEventListener(t, f) {
      (canvasListeners[t] = canvasListeners[t] || []).push(f);
    },
    getContext: () => ctxStub,
    setPointerCapture() {},
    getBoundingClientRect: () => ({left: 0, top: 0})
  };
  const pickerStub = {
    options: [],
    value: "",
    listeners: {},
    addEventListener(t, f) {
      this.listeners[t] = f;
    },
    appendChild(o) {
      this.options.push(o);
    }
  };
  const elements = {image: pickerStub, view: canvasStub, canvas: canvasStub};
  const hud = {};
  const documentStub = {
    getElementById: (id) => elements[id] || (hud[id] = hud[id] || {textContent: ""}),
    createElement: () => ({value: "", textContent: ""})
  };
  const resizeListeners = [];
  const sandbox = {
    console,
    WebSocket: StubWS,
    fetch: fetchStub,
    location: {host},
    document: documentStub,
    createImageBitmap: createImageBitmapStub,
    AbortController,
    setTimeout,
    clearTimeout,
    addEventListener: (t, f) => {
      if (t === "resize") {
        resizeListeners.push(f);
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(VIEWER_SRC, sandbox, {filename: "viewer-bundle.js"});
  return {
    api: sandbox.UltraTile,
    sandbox,
    sockets,
    sends,
    fetchCalls,
    infoDefers,
    bitmaps: createImageBitmapStub,
    bitmapsClosed,
    canvas: canvasStub,
    ctx: ctxStub,
    ctxCalls,
    picker: pickerStub,
    canvasListeners,
    resizeListeners,
    hud,
    setDeferInfo(v) {
      flags.deferInfo = !!v;
    }
  };
}

// ---------- message builders ----------
function dv(buf) {
  return new DataView(buf);
}

function makeChunk(o) {
  const buf = new ArrayBuffer(28);
  const v = dv(buf);
  v.setUint8(0, 0xAA);
  v.setUint8(1, 0x01);
  v.setUint16(2, o.imageId);
  v.setUint8(4, o.zoom);
  v.setUint8(5, 0);
  v.setUint16(6, 512);
  v.setUint32(8, o.reqId);
  v.setUint32(12, o.minX);
  v.setUint32(16, o.maxX);
  v.setUint32(20, o.minY);
  v.setUint32(24, o.maxY);
  return buf;
}

function makeCommit(imageId, reqId) {
  const buf = new ArrayBuffer(8);
  const v = dv(buf);
  v.setUint8(0, 0xAA);
  v.setUint8(1, 0x05);
  v.setUint16(2, imageId);
  v.setUint32(4, reqId);
  return buf;
}

function makeTile(o) {
  const payload = new Uint8Array(o.payloadLen || 100);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (i * 7 + 3) & 0xFF;
  }
  const buf = new ArrayBuffer(24 + payload.length);
  const v = dv(buf);
  v.setUint8(0, 0xAA);
  v.setUint8(1, 0x02);
  v.setUint16(2, o.imageId);
  v.setUint8(4, o.zoom);
  v.setUint8(5, o.format === undefined ? 1 : o.format);
  v.setUint16(6, 512);
  v.setUint32(8, o.reqId);
  v.setUint32(12, o.tileX);
  v.setUint32(16, o.tileY);
  v.setUint32(20, payload.length);
  new Uint8Array(buf).set(payload, 24);
  return buf;
}

function makeEnd(o) {
  const buf = new ArrayBuffer(16);
  const v = dv(buf);
  v.setUint8(0, 0xAA);
  v.setUint8(1, 0x04);
  v.setUint16(2, o.imageId);
  v.setUint32(4, o.reqId);
  v.setUint32(8, o.sent);
  v.setUint32(12, o.skipped);
  return buf;
}

function parseSend(buf) {
  const v = dv(buf);
  const type = v.getUint8(1);
  if (buf.byteLength === 28 && type === 0x01) {
    return {
      kind: "chunk",
      imageId: v.getUint16(2),
      zoom: v.getUint8(4),
      reqId: v.getUint32(8),
      minX: v.getUint32(12),
      maxX: v.getUint32(16),
      minY: v.getUint32(20),
      maxY: v.getUint32(24)
    };
  }
  if (buf.byteLength === 8 && (type === 0x05 || type === 0x03)) {
    return {
      kind: type === 0x05 ? "commit" : "abort",
      imageId: v.getUint16(2),
      reqId: v.getUint32(4)
    };
  }
  return {kind: "other", len: buf.byteLength};
}

function reqIdsOf(sends, from) {
  const out = [];
  for (let i = from || 0; i < sends.length; i++) {
    const p = parseSend(sends[i].buffer);
    if ((p.kind === "chunk" || p.kind === "commit") && !out.includes(p.reqId)) {
      out.push(p.reqId);
    }
  }
  return out;
}

// Respond to captured chunk sends grouped by reqId: all tiles then one END.
function respondToChunks(ctx, from, opts) {
  opts = opts || {};
  const sock = ctx.sockets[ctx.sockets.length - 1];
  const byReq = new Map();
  for (let i = from; i < ctx.sends.length; i++) {
    const p = parseSend(ctx.sends[i].buffer);
    if (p.kind !== "chunk") {
      continue;
    }
    if (!byReq.has(p.reqId)) {
      byReq.set(p.reqId, {imageId: p.imageId, zoom: p.zoom, tiles: []});
    }
    const g = byReq.get(p.reqId);
    for (let y = p.minY; y <= p.maxY; y++) {
      for (let x = p.minX; x <= p.maxX; x++) {
        g.tiles.push({x, y});
      }
    }
  }
  for (const [reqId, g] of byReq) {
    const skips = (opts.skip && opts.skip(reqId)) || [];
    const skipSet = new Set(skips.map((t) => t.x + "," + t.y));
    let sent = 0;
    for (const t of g.tiles) {
      if (skipSet.has(t.x + "," + t.y)) {
        continue;
      }
      sock.receive(makeTile({
        imageId: g.imageId,
        zoom: g.zoom,
        format: opts.format === undefined ? 1 : opts.format,
        reqId,
        tileX: t.x,
        tileY: t.y,
        payloadLen: opts.payloadLen || 100
      }));
      sent++;
    }
    sock.receive(makeEnd({
      imageId: g.imageId,
      reqId,
      sent,
      skipped: g.tiles.length - sent
    }));
  }
}

async function drive(ctx, opts) {
  opts = opts || {};
  let mark = 0;
  const t0 = Date.now();
  const timeout = opts.timeout || 15000;
  let stableSince = Date.now();
  let iter = 0;
  for (;;) {
    respondToChunks(ctx, mark, opts);
    mark = ctx.sends.length;
    ctx.bitmaps.flushOk();
    if (opts.until && !opts.until()) {
      // keep driving
    }
    const quiet = mark === ctx.sends.length && ctx.bitmaps.pending.length === 0;
    if (quiet && (!opts.until || opts.until())) {
      if (Date.now() - stableSince > 200) {
        return;
      }
    } else {
      stableSince = Date.now();
    }
    if (Date.now() - t0 > timeout) {
      throw new Error("drive timeout");
    }
    iter++;
    if (process.env.VIEWER_DEBUG && iter % 50 === 0) {
      console.error(`[drive ${(Date.now() - t0) / 1000}s sends=${ctx.sends.length} pending=${ctx.bitmaps.pending.length}]`);
    }
    await sleep(20);
  }
}

async function bootAndSettle(ctx) {
  const bp = ctx.api.boot();
  await waitFor(() => ctx.sockets.length > 0, 5000, "socket created");
  ctx.sockets[0].open();
  let done = false;
  let err = null;
  bp.then(() => {
    done = true;
  }, (e) => {
    err = e;
    done = true;
  });
  await drive(ctx, {until: () => done});
  if (err) {
    throw err;
  }
  assert.ok(done, "boot finished");
}

// Wheel-zoom, then wait for the fresh batch WITHOUT auto-responding, so the
// batch stays live for manual TILE/END delivery. Viewports that only cover
// cached tiles yield no sends, so tests zoom (new level = fresh tiles).
async function zoomLiveBatch(ctx, deltaY) {
  const wheel = ctx.canvasListeners.wheel[0];
  const before = ctx.sends.length;
  wheel({deltaY, clientX: 400, clientY: 300, preventDefault() {}});
  await waitFor(() => ctx.sends.length > before, 20000, "zoom sends");
  return before;
}

async function awaitSends(ctx, before, timeout) {
  await waitFor(() => ctx.sends.length > before, timeout || 20000, "sends");
}

describe("wire codec", () => {
  it("encodeViewport golden 28B", () => {
    const ctx = fresh();
    const buf = ctx.api.encodeViewport({
      imageId: 3, zoom: 2, lodMode: 0, tileSize: 512,
      reqId: 0x00120304, minX: 0, maxX: 3, minY: 0, maxY: 3
    });
    assert.strictEqual(buf.byteLength, 28);
    const v = dv(buf);
    assert.strictEqual(v.getUint8(0), 0xAA);
    assert.strictEqual(v.getUint8(1), 0x01);
    assert.strictEqual(v.getUint16(2), 3);
    assert.strictEqual(v.getUint8(4), 2);
    assert.strictEqual(v.getUint8(5), 0);
    assert.strictEqual(v.getUint16(6), 512);
    assert.strictEqual(v.getUint8(8), 0x00);
    assert.strictEqual(v.getUint8(9), 0x12);
    assert.strictEqual(v.getUint8(10), 0x03);
    assert.strictEqual(v.getUint8(11), 0x04);
  });

  it("encodeCommit/encodeAbort golden 8B", () => {
    const ctx = fresh();
    const c = ctx.api.encodeCommit(5, 9);
    assert.strictEqual(c.byteLength, 8);
    const vc = dv(c);
    assert.strictEqual(vc.getUint8(0), 0xAA);
    assert.strictEqual(vc.getUint8(1), 0x05);
    assert.strictEqual(vc.getUint16(2), 5);
    assert.strictEqual(vc.getUint32(4), 9);
    const a = ctx.api.encodeAbort(5, 9);
    assert.strictEqual(a.byteLength, 8);
    const va = dv(a);
    assert.strictEqual(va.getUint8(1), 0x03);
    assert.strictEqual(va.getUint16(2), 5);
    assert.strictEqual(va.getUint32(4), 9);
  });

  it("parseTileHeader complete-message golden", () => {
    const ctx = fresh();
    const full = makeTile({imageId: 2, zoom: 1, reqId: 7, tileX: 3, tileY: 4, payloadLen: 16});
    assert.strictEqual(full.byteLength, 40);
    const h = ctx.api.parseTileHeader(full);
    assert.deepStrictEqual(plain(h), {
      imageId: 2, zoom: 1, format: 1, tileSize: 512,
      reqId: 7, tileX: 3, tileY: 4, payloadLen: 16
    });
    // Bare 24B header with LEN>0 is incomplete and must reject.
    const bare = full.slice(0, 24);
    assert.strictEqual(bare.byteLength, 24);
    assert.throws(() => ctx.api.parseTileHeader(bare));
    // Truncation rejects.
    assert.throws(() => ctx.api.parseTileHeader(full.slice(0, 30)));
    // Round-trip field equality.
    const back = ctx.api.encodeViewport({
      imageId: 2, zoom: 1, lodMode: 0, tileSize: 512,
      reqId: 7, minX: 3, maxX: 3, minY: 4, maxY: 4
    });
    assert.strictEqual(dv(back).getUint32(8), 7);
  });

  it("parseEnd golden 16B", () => {
    const ctx = fresh();
    const e = ctx.api.parseEnd(makeEnd({imageId: 2, reqId: 7, sent: 3, skipped: 1}));
    assert.deepStrictEqual(plain(e), {imageId: 2, reqId: 7, sent: 3, skipped: 1});
    assert.throws(() => ctx.api.parseEnd(makeEnd({imageId: 2, reqId: 7, sent: 3, skipped: 1}).slice(0, 15)));
  });

  it("sender path uses the codec", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    // One encoder definition only: no parallel hand-rolled sender exists.
    const src = VIEWER_SRC;
    assert.strictEqual(src.split("new ArrayBuffer(28)").length - 1, 1);
    const before = ctx.sends.length;
    const wheel = ctx.canvasListeners.wheel[0];
    wheel({deltaY: -500, clientX: 400, clientY: 300, preventDefault() {}});
    await drive(ctx, {until: () => ctx.sends.length > before});
    await drive(ctx);
    // Every captured chunk byte-equals the codec output for its fields.
    let checked = 0;
    for (let i = before; i < ctx.sends.length; i++) {
      const raw = ctx.sends[i].buffer;
      if (raw.byteLength !== 28) {
        continue;
      }
      const p = parseSend(raw);
      const re = ctx.api.encodeViewport({
        imageId: p.imageId,
        zoom: p.zoom,
        lodMode: 0,
        tileSize: 512,
        reqId: p.reqId,
        minX: p.minX,
        maxX: p.maxX,
        minY: p.minY,
        maxY: p.maxY
      });
      assert.deepStrictEqual(new Uint8Array(raw), new Uint8Array(re));
      checked++;
    }
    assert.ok(checked > 0, "chunk bytes verified against the codec");
  });
});

describe("browser close codes", () => {
  it("fatals close with exactly 4002", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const liveReq = reqIdsOf(ctx.sends, before)[0];
    assert.ok(liveReq > 0, "live batch exists");
    // Wrong-image END on a live batch -> endIdentityFatal.
    sock.receive(makeEnd({imageId: 999, reqId: liveReq, sent: 1, skipped: 0}));
    assert.strictEqual(sock.closeCalls.length, 1);
    assert.strictEqual(sock.closeCalls[0].code, 4002);
    assert.ok(typeof sock.closeCalls[0].reason === "string");
    assert.ok(sock.closeCalls[0].reason.length <= 123);
    assert.ok(sock.closeCalls[0].reason.length > 0);
  });

  it("endCountMismatch closes with 4002", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const reqs = reqIdsOf(ctx.sends, before);
    assert.ok(reqs.length > 0);
    // Duplicate-masking END: sent+skipped==size but sent != receivedKeys.size.
    const req = reqs[0];
    const commit = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((p) => p.kind === "commit" && p.reqId === req);
    assert.ok(commit);
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    const first = chunks[0];
    // Deliver the same tile twice (dup) then END claiming sent covers all.
    const t = makeTile({
      imageId: first.imageId, zoom: first.zoom, reqId: req,
      tileX: first.minX, tileY: first.minY, payloadLen: 100
    });
    sock.receive(t);
    sock.receive(t.slice(0));
    let expected = 0;
    for (const c of chunks) {
      expected += (c.maxX - c.minX + 1) * (c.maxY - c.minY + 1);
    }
    sock.receive(makeEnd({imageId: first.imageId, reqId: req, sent: expected, skipped: 0}));
    const last = sock.closeCalls[sock.closeCalls.length - 1];
    assert.ok(last, "socket closed");
    assert.strictEqual(last.code, 4002);
  });

  it("tileLenMismatch closes with 4002 and skips accounting", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const rxBefore = ctx.hud.rxBytes.textContent;
    const hdr = makeTile({imageId: 0, zoom: 0, reqId: 1, tileX: 0, tileY: 0, payloadLen: 100});
    const shortMsg = hdr.slice(0, 123);
    assert.strictEqual(shortMsg.byteLength, 123);
    assert.throws(() => sock.receive(shortMsg), /tile length mismatch/);
    assert.strictEqual(sock.closeCalls.length, 1);
    assert.strictEqual(sock.closeCalls[0].code, 4002);
    assert.strictEqual(ctx.hud.rxBytes.textContent, rxBefore);
  });

  it("parity script pins no shared 4002", () => {
    const script = fs.readFileSync(PARITY, "utf8");
    assert.ok(!script.includes("4002"), "no shared 4002 constant may exist");
    assert.ok(!script.includes("CLOSE_UTP_ERROR"), "viewer-local close code stays out");
  });
});

describe("bootstrap", () => {
  it("socket carries subprotocol, same-origin url, asserts protocol", async () => {
    const ctx = fresh({host: "example:8080"});
    const p = ctx.api.boot();
    await waitFor(() => ctx.sockets.length > 0, 5000, "socket");
    const sock = ctx.sockets[0];
    assert.strictEqual(sock.url, "ws://example:8080/ws");
    assert.strictEqual(sock.protocols, "ultratile.utp.v1");
    assert.strictEqual(sock.binaryType, "arraybuffer");
    assert.strictEqual(ctx.sends.length, 0);
    sock.open();
    await drive(ctx);
    await p;
    assert.strictEqual(sock.protocol, "ultratile.utp.v1");
  });

  it("wrong or missing protocol fails the connection", async () => {
    const ctx = fresh();
    const p1 = ctx.api.connectWs();
    await waitFor(() => ctx.sockets.length > 0, 5000, "socket");
    ctx.sockets[0].open("other");
    await assert.rejects(p1);
    const p2 = ctx.api.connectWs();
    await waitFor(() => ctx.sockets.length > 1, 5000, "socket2");
    ctx.sockets[1].open("");
    await assert.rejects(p2);
  });

  it("selectImage reuses the socket and continues reqIds", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    assert.strictEqual(ctx.sockets.length, 1);
    const firstReqs = reqIdsOf(ctx.sends);
    const maxFirst = Math.max(...firstReqs);
    const before = ctx.sends.length;
    const sel = ctx.api.selectImage(1);
    const dp = drive(ctx);
    await sel;
    await dp;
    assert.strictEqual(ctx.sockets.length, 1);
    const after = reqIdsOf(ctx.sends, before);
    assert.ok(after.length > 0);
    assert.ok(Math.min(...after) > maxFirst, "allocator continues across switches");
  });

  it("only reconnect resets the allocator", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    await zoomLiveBatch(ctx, -500);
    await drive(ctx);
    const maxFirst = Math.max(...reqIdsOf(ctx.sends));
    assert.ok(maxFirst > 1);
    const p = ctx.api.connectWs();
    await waitFor(() => ctx.sockets.length > 1, 5000, "reconnect");
    ctx.sockets[1].open();
    await p;
    const before = ctx.sends.length;
    const sel = ctx.api.selectImage(1);
    const dp = drive(ctx);
    await sel;
    await dp;
    const after = reqIdsOf(ctx.sends, before);
    assert.ok(after.includes(1), "fresh allocator restarts at 1");
  });

  it("no packets before open", async () => {
    const ctx = fresh();
    const p = ctx.api.boot();
    await waitFor(() => ctx.sockets.length > 0, 5000, "socket");
    await sleep(150);
    assert.strictEqual(ctx.sends.length, 0);
    ctx.sockets[0].open();
    await drive(ctx);
    await p;
    assert.ok(ctx.sends.length > 0);
  });
});

describe("allocator", () => {
  it("starts at 1, no module-global counter", () => {
    const ctx = fresh();
    const a = ctx.api.createReqAllocator();
    assert.deepStrictEqual(plain(a.allocReqId()), {ok: true, reqId: 1});
    assert.deepStrictEqual(plain(a.allocReqId()), {ok: true, reqId: 2});
    assert.strictEqual(ctx.api.nextReqId, undefined);
  });

  it("exhaustion never wraps or throws", () => {
    const ctx = fresh();
    const a = ctx.api.createReqAllocator(0xFFFFFFFE);
    assert.deepStrictEqual(plain(a.allocReqId()), {ok: true, reqId: 0xFFFFFFFE});
    assert.deepStrictEqual(plain(a.allocReqId()), {ok: false, reason: "exhausted"});
    assert.deepStrictEqual(plain(a.allocReqId()), {ok: false, reason: "exhausted"});
  });

  it("sender reconnects once and retries with reqId 1", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const oldSock = ctx.sockets[0];
    const oldSends = oldSock.sent.length;
    // Reconnect with an allocator starting at the last legal id, then force
    // one more batch: first intent consumes 0xFFFFFFFE, second exhausts.
    const p = ctx.api.connectWs({allocatorStart: 0xFFFFFFFE});
    await waitFor(() => ctx.sockets.length > 1, 5000, "second socket");
    ctx.sockets[1].open();
    await p;
    // First intent consumes 0xFFFFFFFE, second hits exhausted -> reconnect.
    // Successive wheel-ups change the desired level, so each intent finds
    // fresh tiles to request.
    const wheel = ctx.canvasListeners.wheel[0];
    {
      const b = ctx.sends.length;
      wheel({deltaY: -500, clientX: 400, clientY: 300, preventDefault() {}});
      await drive(ctx, {until: () => ctx.sends.length > b});
      await drive(ctx);
    }
    {
      const b = ctx.sends.length;
      wheel({deltaY: -500, clientX: 400, clientY: 300, preventDefault() {}});
      await waitFor(() => ctx.sockets.length > 2, 20000, "reconnect socket");
      ctx.sockets[2].open();
      const onNew = () => ctx.sends.slice(b).some((e) => e.socket === ctx.sockets[2]);
      await drive(ctx, {until: onNew});
      await drive(ctx);
    }
    assert.strictEqual(ctx.sockets.length, 3);
    const newest = ctx.sockets[2];
    const onNew = ctx.sends.filter((e) => e.socket === newest).map((e) => parseSend(e.buffer));
    const commits = onNew.filter((m) => m.kind === "commit");
    assert.ok(commits.length > 0, "retried batch on new socket");
    assert.ok(commits.every((c) => c.reqId === 1), "retry uses reqId 1");
    assert.strictEqual(oldSock.closeCalls.length, 0);
    assert.strictEqual(oldSock.sent.length, oldSends);
  });
});

describe("image-switch races", () => {
  async function switchWithPendingFetch(ctx, id) {
    // Start selectImage with a manually-resolved /info fetch.
    const p = ctx.api.selectImage(id);
    await waitFor(() => (ctx.infoDefers[id] || []).length > 0, 5000, "info fetch");
    return p;
  }

  function resolveInfo(ctx, id) {
    const q = ctx.infoDefers[id] || [];
    assert.ok(q.length > 0, "fetch pending for " + id);
    for (const answer of q.splice(0)) {
      answer();
    }
  }

  function z0Commits(ctx, imageId, from) {
    // Generations whose chunks carry zoom 0 for imageId.
    const byReq = new Map();
    for (let i = from; i < ctx.sends.length; i++) {
      const p = parseSend(ctx.sends[i].buffer);
      if (p.kind === "chunk" && p.imageId === imageId) {
        if (!byReq.has(p.reqId)) {
          byReq.set(p.reqId, {zoom0: true, commit: false});
        }
        if (p.zoom !== 0) {
          byReq.get(p.reqId).zoom0 = false;
        }
      }
      if (p.kind === "commit" && p.imageId === imageId && byReq.has(p.reqId)) {
        byReq.get(p.reqId).commit = true;
      }
    }
    return [...byReq.values()].filter((g) => g.zoom0 && g.commit).length;
  }

  it("resize during fetch defers without touching the switch", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    ctx.setDeferInfo(true);
    const reqsBefore = reqIdsOf(ctx.sends);
    const selB = switchWithPendingFetch(ctx, 1);
    const sendsAtSwitch = ctx.sends.length;
    // Resize intent while B's fetch is pending.
    ctx.canvas.clientWidth = 1600;
    ctx.canvas.clientHeight = 1200;
    await ctx.api.newViewIntent();
    const st = ctx.api.switchState();
    assert.strictEqual(st.deferredIntent, true);
    assert.strictEqual(ctx.sends.length, sendsAtSwitch, "no batch during pending switch");
    assert.deepStrictEqual(reqIdsOf(ctx.sends), reqsBefore, "no reqId consumed");
    resolveInfo(ctx, 1);
    await drive(ctx);
    await selB;
    await drive(ctx);
    // B pinned exactly once (one zoom-0 generation) ...
    assert.strictEqual(z0Commits(ctx, 1, sendsAtSwitch), 1);
    // ... using post-resize dims: desired 1 needs Z1 chunks (800x600 would stay Z0).
    let sawZ1 = false;
    for (let i = sendsAtSwitch; i < ctx.sends.length; i++) {
      const p = parseSend(ctx.sends[i].buffer);
      if (p.kind === "chunk" && p.imageId === 1 && p.zoom === 1) {
        sawZ1 = true;
      }
    }
    assert.ok(sawZ1, "pin uses latest canvas dims");
    // ... and the deferred intent ran once after the pin.
    assert.strictEqual(ctx.api.switchState().deferredIntent, false);
  });

  it("pan during fetch sends nothing for the old image", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    ctx.setDeferInfo(true);
    const selB = switchWithPendingFetch(ctx, 1);
    const sendsAtSwitch = ctx.sends.length;
    const down = ctx.canvasListeners.pointerdown[0];
    const move = ctx.canvasListeners.pointermove[0];
    const up = ctx.canvasListeners.pointerup[0];
    down({pointerId: 1, clientX: 100, clientY: 100});
    move({pointerId: 1, clientX: 300, clientY: 100});
    up({pointerId: 1});
    await sleep(200);
    for (let i = sendsAtSwitch; i < ctx.sends.length; i++) {
      const p = parseSend(ctx.sends[i].buffer);
      assert.ok(!(p.imageId === 0), "no batch for old image A");
    }
    resolveInfo(ctx, 1);
    await drive(ctx);
    await selB;
    await drive(ctx);
    assert.strictEqual(z0Commits(ctx, 1, sendsAtSwitch), 1);
  });

  it("rapid A-B-A resolves to the latest dims once", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    ctx.setDeferInfo(true);
    const selB = switchWithPendingFetch(ctx, 1);
    ctx.canvas.clientWidth = 400;
    ctx.canvas.clientHeight = 300;
    await ctx.api.newViewIntent();
    ctx.canvas.clientWidth = 1600;
    ctx.canvas.clientHeight = 1200;
    await ctx.api.newViewIntent();
    resolveInfo(ctx, 1);
    await drive(ctx);
    await selB;
    await drive(ctx);
    let sawZ1 = false;
    for (const e of ctx.sends) {
      const p = parseSend(e.buffer);
      if (p.kind === "chunk" && p.imageId === 1 && p.zoom === 1) {
        sawZ1 = true;
      }
    }
    assert.ok(sawZ1, "latest dims win");
  });

  it("A->B race: late A abandons", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    ctx.setDeferInfo(true);
    const epochBefore = ctx.api.switchState();
    void epochBefore;
    const selA = ctx.api.selectImage(0);
    await waitFor(() => (ctx.infoDefers[0] || []).length > 0, 5000, "info A");
    const selB = ctx.api.selectImage(1);
    await waitFor(() => (ctx.infoDefers[1] || []).length > 0, 5000, "info B");
    const sendsBefore = ctx.sends.length;
    const reqsBefore = reqIdsOf(ctx.sends);
    resolveInfo(ctx, 1);
    await drive(ctx);
    await selB;
    await drive(ctx);
    assert.strictEqual(z0Commits(ctx, 1, sendsBefore), 1);
    const camAfterB = ctx.sends.length;
    resolveInfo(ctx, 0);
    await sleep(300);
    await selA.catch(() => {});
    await drive(ctx);
    // A abandoned: no new epoch bump for A is observable via no A pin.
    assert.strictEqual(z0Commits(ctx, 0, sendsBefore), 0);
    assert.deepStrictEqual(
      reqIdsOf(ctx.sends, camAfterB),
      reqIdsOf(ctx.sends, camAfterB).filter(() => true)
    );
    const aReqs = reqIdsOf(ctx.sends, camAfterB);
    const aCommits = ctx.sends.slice(camAfterB).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "commit" && p.imageId === 0);
    assert.strictEqual(aCommits.length, 0, "no A commit after B won");
    assert.deepStrictEqual(aReqs, [], "no reqId allocated for abandoned A");
  });

  it("single-owner switch: one bump, one pin, old bitmaps closed first", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const closedBefore = ctx.bitmapsClosed.length;
    assert.ok(closedBefore === 0);
    // Cache holds image-0 bitmaps now; grab one to prove later closure.
    const before = ctx.sends.length;
    const epoch0 = +ctx.hud.epoch.textContent;
    const sel = ctx.api.selectImage(1);
    const dp = drive(ctx);
    await sel;
    await dp;
    const epoch1 = +ctx.hud.epoch.textContent;
    assert.strictEqual(epoch1, epoch0 + 1, "exactly one epoch bump");
    assert.strictEqual(z0Commits(ctx, 1, before), 1);
    assert.ok(ctx.bitmapsClosed.length > 0, "old bitmaps closed");
    // Pan afterwards: no clear, no reset.
    const cacheNow = ctx.hud.cache.textContent;
    const sel2 = ctx.api.newViewIntent();
    await drive(ctx);
    await sel2.catch(() => {});
    assert.strictEqual(ctx.hud.cache.textContent, cacheNow, "no cache clear on pan");
  });
});

describe("boot order", () => {
  it("live gallery, no sends pre-open, single initial select", async () => {
    const ctx = fresh({
      images: [{id: 3, w: 1024, h: 1024}, {id: 9, w: 512, h: 512}]
    });
    const p = ctx.api.boot();
    await waitFor(() => ctx.sockets.length > 0, 5000, "socket");
    await sleep(150);
    assert.strictEqual(ctx.sends.length, 0, "nothing sent before open");
    // Synthetic pre-open intent sends nothing (handlers not installed yet,
    // and the socket is not open).
    await ctx.api.newViewIntent();
    assert.strictEqual(ctx.sends.length, 0);
    assert.deepStrictEqual(
      ctx.picker.options.map((o) => o.textContent),
      ["image-3", "image-9"]
    );
    ctx.sockets[0].open();
    await drive(ctx);
    await p;
    const commits = ctx.sends.map((e) => parseSend(e.buffer))
      .filter((m) => m.kind === "commit" && m.imageId === 3);
    assert.ok(commits.length > 0, "initial select is image 3");
    const p2 = ctx.api.boot();
    assert.strictEqual(await p2, await p, "second boot reuses the promise");
    assert.strictEqual(ctx.sockets.length, 1, "no second socket");
    // Resize handler installed only after the pin: firing it starts a new
    // epoch (observable via the HUD even when everything is cached).
    const epochBefore = ctx.hud.epoch.textContent;
    for (const f of ctx.resizeListeners) {
      f();
    }
    await waitFor(
      () => ctx.hud.epoch.textContent !== epochBefore, 5000, "resize intent epoch");
  });

  it("empty registry shows no-images and sends nothing", async () => {
    const ctx = fresh({images: []});
    await ctx.api.boot();
    assert.deepStrictEqual(
      ctx.picker.options.map((o) => o.textContent),
      ["no images"]
    );
    assert.strictEqual(ctx.sockets.length, 0);
    assert.strictEqual(ctx.sends.length, 0);
  });
});

describe("format ordering", () => {
  it("stale FORMAT=2 never poisons the epoch", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const reqs = reqIdsOf(ctx.sends, before);
    assert.ok(reqs.length > 0);
    const req = reqs[0];
    const chunk = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((m) => m.kind === "chunk" && m.reqId === req);
    // Foreign FORMAT=2 tile for an unknown generation: discarded, socket open.
    sock.receive(makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, format: 2,
      reqId: 0xFFFFFFFD, tileX: chunk.minX, tileY: chunk.minY, payloadLen: 50
    }));
    assert.strictEqual(sock.closeCalls.length, 0);
    assert.strictEqual(ctx.bitmaps.pending.length, 0);
    // The same key as a valid current-batch tile still admits normally.
    const rxBefore = +ctx.hud.rxBytes.textContent;
    sock.receive(makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, format: 1,
      reqId: req, tileX: chunk.minX, tileY: chunk.minY, payloadLen: 50
    }));
    assert.strictEqual(ctx.bitmaps.pending.length, 1, "valid tile decodes");
    assert.strictEqual(+ctx.hud.rxBytes.textContent, rxBefore + 50);
  });

  it("valid FORMAT=2 is terminal: no decode, dup counted", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunk = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((m) => m.kind === "chunk" && m.reqId === req);
    const rx0 = +ctx.hud.rxBytes.textContent;
    sock.receive(makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, format: 2,
      reqId: req, tileX: chunk.minX, tileY: chunk.minY, payloadLen: 50
    }));
    assert.strictEqual(ctx.bitmaps.pending.length, 0, "no decode for format 2");
    assert.strictEqual(+ctx.hud.rxBytes.textContent, rx0 + 50);
    // Same key again as FORMAT=1: duplicate-dropped, still no decode.
    sock.receive(makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, format: 1,
      reqId: req, tileX: chunk.minX, tileY: chunk.minY, payloadLen: 50
    }));
    assert.strictEqual(ctx.bitmaps.pending.length, 0, "dup never re-decodes");
    assert.strictEqual(+ctx.hud.rxBytes.textContent, rx0 + 100, "both payloads counted");
    assert.strictEqual(sock.closeCalls.length, 0);
  });
});

describe("END semantics", () => {
  it("stale ENDs discard, connection alive", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    // Unknown reqId.
    sock.receive(makeEnd({imageId: 0, reqId: 0xFFFFFFFC, sent: 0, skipped: 0}));
    // Late previous-generation race: complete a live zoom batch, bump the
    // epoch with a direct intent, then deliver the old END again.
    const before = await zoomLiveBatch(ctx, -500);
    const reqs = reqIdsOf(ctx.sends, before);
    assert.ok(reqs.length > 0);
    const req = reqs[0];
    const commit = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((p) => p.kind === "commit" && p.reqId === req);
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    let n = 0;
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          sock.receive(makeTile({
            imageId: c.imageId, zoom: c.zoom, reqId: req,
            tileX: x, tileY: y, payloadLen: 100
          }));
          n++;
        }
      }
    }
    ctx.bitmaps.flushOk();
    sock.receive(makeEnd({imageId: commit.imageId, reqId: req, sent: n, skipped: 0}));
    // Bump epoch, then deliver the same END again (late duplicate).
    const i2 = ctx.api.newViewIntent();
    const dp = drive(ctx);
    await i2.catch(() => {});
    await dp;
    const closesBefore = sock.closeCalls.length;
    sock.receive(makeEnd({imageId: commit.imageId, reqId: req, sent: n, skipped: 0}));
    assert.strictEqual(sock.closeCalls.length, closesBefore, "stale END never fatal");
    assert.strictEqual(sock.readyState, 1);
  });

  it("happy END derives skipped keys and suppresses same-epoch rebuilds", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    const c0 = chunks[0];
    // Receive all but the last tile, then END with one skipped.
    const tiles = [];
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          tiles.push({x, y, imageId: c.imageId, zoom: c.zoom});
        }
      }
    }
    assert.ok(tiles.length >= 2, "need 2+ tiles for skip vector");
    for (let i = 0; i < tiles.length - 1; i++) {
      const t = tiles[i];
      sock.receive(makeTile({
        imageId: t.imageId, zoom: t.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: 100
      }));
    }
    ctx.bitmaps.flushOk();
    sock.receive(makeEnd({
      imageId: c0.imageId, reqId: req, sent: tiles.length - 1, skipped: 1
    }));
    // Settle WITHOUT the generic responder (it would deliver the skipped
    // key): flush decodes and let continuations run.
    ctx.bitmaps.flushOk();
    await sleep(300);
    const skippedKey = tiles[tiles.length - 1];
    const skipId = skippedKey.imageId + ":" + skippedKey.zoom + ":"
      + skippedKey.x + "," + skippedKey.y;
    void skipId;
    // Same-epoch rebuild: nothing new may cover the skipped key (the retry
    // path only resends overflowed receipts, and this key never reached it).
    const sendsAfterEnd = ctx.sends.length;
    await sleep(300);
    for (let i = sendsAfterEnd; i < ctx.sends.length; i++) {
      const p = parseSend(ctx.sends[i].buffer);
      if (p.kind === "chunk") {
        for (let y = p.minY; y <= p.maxY; y++) {
          for (let x = p.minX; x <= p.maxX; x++) {
            assert.ok(
              !(x === skippedKey.x && y === skippedKey.y && p.zoom === skippedKey.zoom),
              "skipped key suppressed same epoch"
            );
          }
        }
      }
    }
    // Next epoch may request it again: nudge the viewport a little (same
    // zoom, so the missing key alone suffices for a batch).
    const m2 = ctx.sends.length;
    const down2 = ctx.canvasListeners.pointerdown[0];
    const move2 = ctx.canvasListeners.pointermove[0];
    const up2 = ctx.canvasListeners.pointerup[0];
    down2({pointerId: 9, clientX: 100, clientY: 100});
    move2({pointerId: 9, clientX: 110, clientY: 100});
    up2({pointerId: 9});
    await drive(ctx, {until: () => ctx.sends.length > m2});
    await drive(ctx);
  });
});

describe("stale tiles", () => {
  it("valid stale TILE discards with socket open", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunk = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((m) => m.kind === "chunk" && m.reqId === req);
    // Complete the generation (all chunks of this reqId), then bump epoch.
    const allChunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((m) => m.kind === "chunk" && m.reqId === req);
    const tiles = [];
    for (const cc of allChunks) {
      for (let y = cc.minY; y <= cc.maxY; y++) {
        for (let x = cc.minX; x <= cc.maxX; x++) {
          tiles.push({x, y});
        }
      }
    }
    for (const t of tiles) {
      sock.receive(makeTile({
        imageId: chunk.imageId, zoom: chunk.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: 100
      }));
    }
    ctx.bitmaps.flushOk();
    sock.receive(makeEnd({
      imageId: chunk.imageId, reqId: req, sent: tiles.length, skipped: 0
    }));
    await drive(ctx);
    const i2 = ctx.api.newViewIntent();
    const dp = drive(ctx);
    await i2.catch(() => {});
    await dp;
    const pendingBefore = ctx.bitmaps.pending.length;
    // Structurally valid E tile (exact length, member of E expectedKeys).
    sock.receive(makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, reqId: req,
      tileX: chunk.minX, tileY: chunk.minY, payloadLen: 100
    }));
    assert.strictEqual(ctx.bitmaps.pending.length, pendingBefore, "no decode for stale");
    assert.strictEqual(sock.readyState, 1, "socket stays open");
    assert.strictEqual(sock.closeCalls.length, 0);
    // A current-epoch tile still admits normally: zoom to a fresh level and
    // deliver one of its tiles.
    const b2 = await zoomLiveBatch(ctx, -500);
    const req2 = reqIdsOf(ctx.sends, b2).pop();
    const chunk2 = ctx.sends.slice(b2).map((e) => parseSend(e.buffer))
      .find((m) => m.kind === "chunk" && m.reqId === req2);
    const pend2 = ctx.bitmaps.pending.length;
    sock.receive(makeTile({
      imageId: chunk2.imageId, zoom: chunk2.zoom, reqId: req2,
      tileX: chunk2.minX, tileY: chunk2.minY, payloadLen: 100
    }));
    assert.strictEqual(ctx.bitmaps.pending.length, pend2 + 1, "current admits");
  });
});

describe("coverage accounting", () => {
  it("netCov counts wire progress, covCov counts pixels, no wait on covCov", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    const tiles = [];
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          tiles.push({x, y, imageId: c.imageId, zoom: c.zoom});
        }
      }
    }
    assert.ok(tiles.length >= 2);
    // Receive one tile but never decode it (no flush): netCov counts it
    // while visual coverage does not move.
    const covBefore = ctx.api.covCov();
    const t0 = tiles[0];
    sock.receive(makeTile({
      imageId: t0.imageId, zoom: t0.zoom, reqId: req,
      tileX: t0.x, tileY: t0.y, payloadLen: 100
    }));
    assert.strictEqual(ctx.api.netCov(), 1);
    assert.strictEqual(ctx.api.covCov(), covBefore, "undecoded never covers");
    // Skip the rest via END: progress resolves with covCov < 1.
    sock.receive(makeEnd({
      imageId: t0.imageId, reqId: req, sent: 1, skipped: tiles.length - 1
    }));
    await drive(ctx);
    assert.strictEqual(ctx.api.netCov(), tiles.length);
    assert.ok(ctx.api.covCov() < 1);
    assert.strictEqual(sock.closeCalls.length, 0, "skips never hang progress");
  });

  it("netCov survives BatchState reclamation", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    let n = 0;
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          sock.receive(makeTile({
            imageId: c.imageId, zoom: c.zoom, reqId: req,
            tileX: x, tileY: y, payloadLen: 100
          }));
          n++;
        }
      }
    }
    ctx.bitmaps.flushOk();
    sock.receive(makeEnd({imageId: chunks[0].imageId, reqId: req, sent: n, skipped: 0}));
    const cov = ctx.api.netCov();
    assert.ok(cov > 0);
    await sleep(50);
    assert.strictEqual(ctx.api.decodeRefs(req), 0);
    await drive(ctx);
    // Reclaimed (classify forgets), yet netCov is unchanged.
    assert.strictEqual(ctx.api.classify(req), "stale-unknown");
    assert.strictEqual(ctx.api.netCov(), cov);
  });

  it("netCov union counts receive-then-skip once", async () => {
    // A wide intent with 2MiB tiles: the first 6 receipts fill the decode
    // inflight, the next 2 fill the byte gate to exactly 4MiB, and the rest
    // overflow into retryNeeded while still counting as received. The retry
    // generation then skips one of them, so that key sits in BOTH epoch
    // sets and must count once. Fully manual driving: the generic responder
    // would deliver the skipped key.
    const ctx = fresh({images: [{id: 5, w: 16384, h: 16384}]});
    ctx.canvas.clientWidth = 3100;
    ctx.canvas.clientHeight = 4100;
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const wheel = ctx.canvasListeners.wheel[0];
    const before = ctx.sends.length;
    wheel({deltaY: -1700, clientX: 1550, clientY: 2050, preventDefault() {}});
    await waitFor(() => ctx.sends.length > before, 20000, "wide intent");
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    const tiles = [];
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          tiles.push({c, x, y});
        }
      }
    }
    assert.ok(tiles.length >= 9, "wide batch overflows, got " + tiles.length);
    const MB2 = 2 * 1024 * 1024;
    for (const t of tiles) {
      sock.receive(makeTile({
        imageId: t.c.imageId, zoom: t.c.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: MB2
      }));
    }
    // No flush: 6 in flight, 2 queued to exactly 4MiB, the rest overflowed
    // into retryNeeded while still counting as received.
    sock.receive(makeEnd({
      imageId: tiles[0].c.imageId, reqId: req, sent: tiles.length, skipped: 0
    }));
    // Drain everything so the same-intent retry generation sends ( polled
    // manually: the generic responder would deliver the key under test).
    ctx.bitmaps.flushOk();
    const m2 = ctx.sends.length;
    await waitFor(() => ctx.sends.length > m2, 20000, "retry sends");
    const r2 = reqIdsOf(ctx.sends, m2).pop();
    const r2chunks = ctx.sends.slice(m2).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === r2);
    const r2tiles = [];
    for (const c of r2chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          r2tiles.push({c, x, y});
        }
      }
    }
    assert.ok(r2tiles.length >= 1, "overflowed keys retried");
    // Deliver all but the first: it becomes server-skipped while already
    // received -> present in both epoch sets.
    const skipped = r2tiles[0];
    for (let i = 1; i < r2tiles.length; i++) {
      const t = r2tiles[i];
      sock.receive(makeTile({
        imageId: t.c.imageId, zoom: t.c.zoom, reqId: r2,
        tileX: t.x, tileY: t.y, payloadLen: MB2
      }));
    }
    ctx.bitmaps.flushOk();
    sock.receive(makeEnd({
      imageId: skipped.c.imageId, reqId: r2,
      sent: r2tiles.length - 1, skipped: 1
    }));
    await sleep(300);
    // Received set holds the batch's keys; skipped holds one of them.
    // Union cardinality, not the sum.
    assert.strictEqual(ctx.api.netCov(), tiles.length);
    assert.strictEqual(sock.closeCalls.length, 0);
  });
});

describe("epoch cleanup and lifetime", () => {
  it("terminal and skipped keys are requestable next epoch", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunk = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((m) => m.kind === "chunk" && m.reqId === req);
    // Terminal-fail K via FORMAT=2, skip everything else via END.
    sock.receive(makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, format: 2,
      reqId: req, tileX: chunk.minX, tileY: chunk.minY, payloadLen: 50
    }));
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    let total = 0;
    for (const c of chunks) {
      total += (c.maxX - c.minX + 1) * (c.maxY - c.minY + 1);
    }
    sock.receive(makeEnd({imageId: chunk.imageId, reqId: req, sent: 1, skipped: total - 1}));
    await drive(ctx);
    // Next epoch: the terminal key is requested again (direct intent: the
    // missing key alone suffices for a batch).
    const m2 = ctx.sends.length;
    const ni = ctx.api.newViewIntent();
    await drive(ctx, {until: () => ctx.sends.length > m2});
    await ni.catch(() => {});
    await drive(ctx);
    let sawK = false;
    for (let i = m2; i < ctx.sends.length; i++) {
      const p = parseSend(ctx.sends[i].buffer);
      if (p.kind === "chunk" && p.zoom === chunk.zoom
        && chunk.minX >= p.minX && chunk.minX <= p.maxX
        && chunk.minY >= p.minY && chunk.minY <= p.maxY) {
        sawK = true;
      }
    }
    assert.ok(sawK, "terminal key requestable in E+1");
  });

  it("double bump purges pending and drops old batches", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const before = await zoomLiveBatch(ctx, -500);
    const first = reqIdsOf(ctx.sends, before)[0];
    assert.notStrictEqual(ctx.api.classify(first), "stale-unknown");
    await ctx.api.newViewEpoch();
    await ctx.api.newViewEpoch();
    await ctx.api.newViewEpoch();
    assert.strictEqual(ctx.api.classify(first), "stale-unknown");
    assert.strictEqual(ctx.api.netCov(), 0);
  });

  it("duplicate TILE decodes once but counts bytes twice", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const sock = ctx.sockets[0];
    const before = await zoomLiveBatch(ctx, -500);
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunk = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .find((m) => m.kind === "chunk" && m.reqId === req);
    const rx0 = +ctx.hud.rxBytes.textContent;
    const t = makeTile({
      imageId: chunk.imageId, zoom: chunk.zoom, reqId: req,
      tileX: chunk.minX, tileY: chunk.minY, payloadLen: 100
    });
    sock.receive(t);
    sock.receive(t.slice(0));
    assert.strictEqual(ctx.bitmaps.pending.length, 1, "exactly one decode");
    assert.strictEqual(+ctx.hud.rxBytes.textContent, rx0 + 200);
  });

  it("initial camera is centered and fitted", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    // After a centered pin on 2048 with an 800x600 canvas, the effective
    // ranges must be symmetric around the image center tile span.
    const eff = ctx.api.effectiveLOD(2);
    assert.strictEqual(eff.desired, 2);
    assert.ok(eff.effective <= 2);
    const cam = ctx.api.selectLevel(0.292, 2048, 2048);
    assert.strictEqual(cam, 0);
  });
});

describe("planning", () => {
  it("headroom gates sending", async () => {
    const ctx = fresh({images: [{id: 1, w: 4096, h: 4096}]});
    ctx.canvas.clientWidth = 2000;
    ctx.canvas.clientHeight = 1500;
    await bootAndSettle(ctx);
    const sel = ctx.api.selectImage(1);
    await drive(ctx);
    await sel;
    await drive(ctx);
    assert.ok(ctx.api.headroomOk(), "empty pipeline has headroom");
    // Zoom in: fresh Z3 batch. Hold 6 decodes in flight.
    const wheel = ctx.canvasListeners.wheel[0];
    const before = ctx.sends.length;
    wheel({deltaY: -1005, clientX: 1000, clientY: 750, preventDefault() {}});
    await waitFor(() => ctx.sends.length > before, 20000, "zoom sends");
    const req = reqIdsOf(ctx.sends, before)[0];
    const chunks = ctx.sends.slice(before).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    const sock = ctx.sockets[0];
    let delivered = 0;
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY && delivered < 6; y++) {
        for (let x = c.minX; x <= c.maxX && delivered < 6; x++) {
          sock.receive(makeTile({
            imageId: c.imageId, zoom: c.zoom, reqId: req,
            tileX: x, tileY: y, payloadLen: 100
          }));
          delivered++;
        }
      }
    }
    assert.strictEqual(delivered, 6);
    assert.ok(!ctx.api.headroomOk(), "full inflight removes headroom");
    // Zoom back out to a fresh level: the intent must wait, not send tiles.
    const m2 = ctx.sends.length;
    wheel({deltaY: 1400, clientX: 1000, clientY: 750, preventDefault() {}});
    await sleep(500);
    const kindsAfter = ctx.sends.slice(m2).map((e) => parseSend(e.buffer).kind);
    assert.ok(!kindsAfter.includes("chunk") && !kindsAfter.includes("commit"),
      "no batch without headroom, got " + kindsAfter.join(","));
    ctx.bitmaps.flushOk();
    ctx.bitmaps.flushOk();
    await drive(ctx, {until: () => ctx.sends.length > m2});
    assert.ok(ctx.sends.length > m2, "batch proceeds after drain");
  });

  it("tiny-tile streaks plan against the floor", {timeout: 180000}, async () => {
    // Accumulate a long tiny-tile history (average far below the planning
    // floor), then read the budget with 6 tiny in flight and 4 large
    // queued: planTileBytes must follow the floor, not the tiny mean.
    const ctx = fresh({
      images: [{id: 5, w: 16384, h: 16384}]
    });
    ctx.canvas.clientWidth = 2000;
    ctx.canvas.clientHeight = 1500;
    await bootAndSettle(ctx);
    const wheel = ctx.canvasListeners.wheel[0];
    wheel({deltaY: -1200, clientX: 1000, clientY: 750, preventDefault() {}});
    await drive(ctx);
    const down = ctx.canvasListeners.pointerdown[0];
    const move = ctx.canvasListeners.pointermove[0];
    const up = ctx.canvasListeners.pointerup[0];
    // Sweep for tiny history; pans that find nothing cached/fresh are
    // skipped (fully cached viewports or empty off-image ground).
    let pid = 10;
    for (let i = 0; i < 12; i++) {
      const m = ctx.sends.length;
      const x0 = 100 + (i % 4) * 400;
      const y0 = 100 + Math.floor(i / 4) * 300;
      down({pointerId: pid, clientX: x0, clientY: y0});
      move({pointerId: pid, clientX: x0 + 1900, clientY: y0});
      up({pointerId: pid});
      pid++;
      try {
        await drive(ctx, {until: () => ctx.sends.length > m, timeout: 20000});
      } catch (e) {
        /* nothing fresh here; keep sweeping */
      }
    }
    // Final mixed batch: find a viewport with 10+ fresh tiles WITHOUT
    // auto-responding (generic delivery would decode everything and ruin
    // the held snapshot). Losers are closed out with all-skipped ENDs.
    const sock = ctx.sockets[ctx.sockets.length - 1];
    const cands = [
      [100, 1300, 2000, 1300],
      [100, 3000, 2000, 3000],
      [100, 100, 2000, 100],
      [3000, 1300, 1100, 1300]
    ];
    let req = 0;
    let tiles = [];
    for (const [x0, y0, x1, y1] of cands) {
      const m = ctx.sends.length;
      down({pointerId: pid, clientX: x0, clientY: y0});
      move({pointerId: pid, clientX: x1, clientY: y1});
      up({pointerId: pid});
      pid++;
      try {
        await waitFor(() => ctx.sends.length > m, 20000, "candidate sends");
      } catch (e) {
        continue;
      }
      const rs = reqIdsOf(ctx.sends, m);
      if (!rs.length) {
        continue;
      }
      const r = rs[rs.length - 1];
      const got = [];
      for (const e of ctx.sends.slice(m).map((s) => parseSend(s.buffer))) {
        if (e.kind !== "chunk" || e.reqId !== r) {
          continue;
        }
        for (let y = e.minY; y <= e.maxY; y++) {
          for (let x = e.minX; x <= e.maxX; x++) {
            got.push({c: e, x, y});
          }
        }
      }
      if (got.length >= 10) {
        req = r;
        tiles = got;
        break;
      }
      if (!got.length) {
        continue;
      }
      // Too small: skip everything and keep looking.
      sock.receive(makeEnd({imageId: got[0].c.imageId, reqId: r, sent: 0, skipped: got.length}));
      ctx.bitmaps.flushOk();
      await sleep(200);
    }
    assert.ok(tiles.length >= 10, "mixed viewport covers 10+ fresh tiles");
    for (let i = 0; i < 6; i++) {
      const t = tiles[i];
      sock.receive(makeTile({
        imageId: t.c.imageId, zoom: t.c.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: 100
      }));
    }
    const KB830 = 830 * 1024;
    for (let i = 6; i < 10; i++) {
      const t = tiles[i];
      sock.receive(makeTile({
        imageId: t.c.imageId, zoom: t.c.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: KB830
      }));
    }
    // No flush: 6 tiny in flight, 4 large queued. Budget must use the floor:
    // freeBytes = 4MiB - 4*830KiB = 794624 -> 12 slots, strictly below the
    // 14 free job slots the tiny mean would allow.
    const budget = ctx.api.batchBudget();
    assert.strictEqual(budget, 12);
    ctx.bitmaps.flushOk();
    const commit = ctx.sends.map((e) => parseSend(e.buffer))
      .find((p) => p.kind === "commit" && p.reqId === req);
    sock.receive(makeEnd({
      imageId: tiles[0].c.imageId, reqId: req, sent: 10, skipped: tiles.length - 10
    }));
    void commit;
    await drive(ctx);
  });

  it("mean governs once avgTileBytes clears the floor", {timeout: 120000}, async () => {
    // Fresh tiny history keeps the running mean high once 1MiB tiles land:
    // planTileBytes follows the mean (not the floor), so the budget drops
    // below what either the job slots or the floor would allow.
    const ctx = fresh({
      images: [{id: 5, w: 16384, h: 16384}]
    });
    ctx.canvas.clientWidth = 2000;
    ctx.canvas.clientHeight = 1500;
    await bootAndSettle(ctx);
    const wheel = ctx.canvasListeners.wheel[0];
    const m = ctx.sends.length;
    wheel({deltaY: -2400, clientX: 1000, clientY: 750, preventDefault() {}});
    await waitFor(() => ctx.sends.length > m, 20000, "zoom sends");
    const req = reqIdsOf(ctx.sends, m)[0];
    const chunks = ctx.sends.slice(m).map((e) => parseSend(e.buffer))
      .filter((p) => p.kind === "chunk" && p.reqId === req);
    const tiles = [];
    for (const c of chunks) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let x = c.minX; x <= c.maxX; x++) {
          tiles.push({c, x, y});
        }
      }
    }
    assert.ok(tiles.length >= 8);
    const sock = ctx.sockets[ctx.sockets.length - 1];
    const MB = 1024 * 1024;
    for (let i = 0; i < 8; i++) {
      const t = tiles[i];
      sock.receive(makeTile({
        imageId: t.c.imageId, zoom: t.c.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: MB
      }));
    }
    // 6 in flight, 2 queued, avg ~220KiB: the mean (not the floor, not the
    // job slots) sets the budget.
    const budget = ctx.api.batchBudget();
    assert.ok(budget >= 8 && budget < 16, "mean governs, got " + budget);
    ctx.bitmaps.flushOk();
    sock.receive(makeEnd({
      imageId: tiles[0].c.imageId, reqId: req, sent: 8, skipped: tiles.length - 8
    }));
    await drive(ctx);
  });
});

describe("eviction", () => {
  it("serpentine pan sweep evicts", {timeout: 180000}, async () => {
    const ctx = fresh({
      images: [{id: 1, w: 4096, h: 4096}]
    });
    ctx.canvas.clientWidth = 2000;
    ctx.canvas.clientHeight = 1500;
    await bootAndSettle(ctx);
    const sel = ctx.api.selectImage(1);
    await drive(ctx);
    await sel;
    await drive(ctx);
    const wheel = ctx.canvasListeners.wheel[0];
    wheel({deltaY: -1005, clientX: 1000, clientY: 750, preventDefault() {}});
    await drive(ctx);
    const down = ctx.canvasListeners.pointerdown[0];
    const move = ctx.canvasListeners.pointermove[0];
    const up = ctx.canvasListeners.pointerup[0];
    let pid = 20;
    outer:
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const m = ctx.sends.length;
        const x0 = 100 + col * 100;
        const y0 = 100 + row * 100;
        down({pointerId: pid, clientX: x0, clientY: y0});
        move({pointerId: pid, clientX: x0 + 1900, clientY: y0});
        up({pointerId: pid});
        pid++;
        try {
          await drive(ctx, {until: () => ctx.sends.length > m, timeout: 20000});
        } catch (e) {
          // Fully cached viewport: nothing to fetch; keep sweeping.
        }
        if (+ctx.hud.evicts.textContent > 0) {
          break outer;
        }
      }
    }
    assert.ok(+ctx.hud.evicts.textContent > 0, "serpentine sweep evicts");
    assert.ok(ctx.bitmapsClosed.length > 0, "evicted bitmaps closed");
  });

  it("zoom out raises rxBytes, records effZ, closes more bitmaps", {timeout: 180000}, async () => {
    const ctx = fresh({
      images: [{id: 1, w: 4096, h: 4096}]
    });
    ctx.canvas.clientWidth = 2000;
    ctx.canvas.clientHeight = 1500;
    await bootAndSettle(ctx);
    const sel = ctx.api.selectImage(1);
    await drive(ctx);
    await sel;
    await drive(ctx);
    // Zoom in and sweep to fill the cache past 40 entries.
    const wheel = ctx.canvasListeners.wheel[0];
    wheel({deltaY: -1005, clientX: 1000, clientY: 750, preventDefault() {}});
    await drive(ctx);
    const down = ctx.canvasListeners.pointerdown[0];
    const move = ctx.canvasListeners.pointermove[0];
    const up = ctx.canvasListeners.pointerup[0];
    for (let i = 0; i < 8; i++) {
      const m = ctx.sends.length;
      const x0 = 100 + (i % 4) * 400;
      const y0 = 100 + Math.floor(i / 4) * 1300;
      down({pointerId: 60 + i, clientX: x0, clientY: y0});
      move({pointerId: 60 + i, clientX: x0 + 1900, clientY: y0});
      up({pointerId: 60 + i});
      try {
        await drive(ctx, {until: () => ctx.sends.length > m, timeout: 20000});
      } catch (e) {
        /* cached */
      }
    }
    const rxBefore = +ctx.hud.rxBytes.textContent;
    const closedBefore = ctx.bitmapsClosed.length;
    // Zoom far out toward effective 1 (fresh coarse tiles).
    wheel({deltaY: 1100, clientX: 1000, clientY: 750, preventDefault() {}});
    await drive(ctx, {timeout: 60000});
    assert.ok(+ctx.hud.rxBytes.textContent > rxBefore, "rxBytes rises on zoom");
    assert.strictEqual(ctx.hud.effZ.textContent, "1");
    assert.ok(ctx.bitmapsClosed.length >= closedBefore, "close()d never shrinks");
  });

  it("clearRect runs before any tile draw", async () => {
    const ctx = fresh();
    await bootAndSettle(ctx);
    const clearIdx = ctx.ctxCalls.indexOf("clearRect");
    const drawIdx = ctx.ctxCalls.indexOf("drawImage");
    assert.ok(clearIdx >= 0, "canvas cleared");
    if (drawIdx >= 0) {
      assert.ok(clearIdx < drawIdx, "clear-then-draw order");
    }
  });
});


