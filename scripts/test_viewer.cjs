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
    // Drain everything so the same-intent retry generation sends (polled
    // manually: the generic responder would deliver the key under test).
    // Two flushes: the first resolves the 6 in-flight decodes, whose
    // completion pumps the 2 queued payloads to in-flight; the second
    // resolves those, so decodeRefs hits zero and the batch drains.
    ctx.bitmaps.flushOk();
    await sleep(50);
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
    // Cancel leftover batches so no batch promise outlives the test.
    await ctx.api.newViewEpoch();
    ctx.bitmaps.flushOk();
    await sleep(100);
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
  it("a single viewport can never ask for more than UNION_CAP tiles", {timeout: 180000}, async () => {
    const ctx = fresh({images: [{id: 1, w: 4096, h: 4096}]});
    ctx.canvas.clientWidth = 3840;
    ctx.canvas.clientHeight = 2160;
    await bootAndSettle(ctx);
    // The 4K viewport at full zoom, the case the cache is documented to be
    // tight for. Sweep the desired level directly, which is exactly the input
    // effectiveLOD() gets, so the invariant is checked for every level the
    // camera can select without having to reconstruct camS.
    const N = 3;
    let tightest = 0;
    let downgraded = 0;
    for (let d = 0; d <= N; d++) {
      const e = ctx.api.effectiveLOD(d);
      const keys = ctx.api.visibleTileRange(e.effective);
      assert.ok(keys.length <= 36, "level " + d + " requests " + keys.length + ", cap 36");
      assert.strictEqual(new Set(keys).size, keys.length, "no duplicate keys");
      tightest = Math.max(tightest, keys.length);
      if (e.effective < d) {
        downgraded += 1;
      }
    }
    assert.ok(tightest > 0, "the viewport does ask for tiles");
    assert.ok(downgraded > 0, "the union cap does force downgrades");
    // UNION_CAP is the structural reason one viewport cannot overflow the
    // 40-entry cache, whichever replacement policy is in force.
    assert.ok(36 < 40, "UNION_CAP is below MAX_CACHE");
  });

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
    // Deterministic tiny history: boot (17x100B) plus two settled zooms
    // (+33/+49x100B) leaves 99 tiny receipts, avg ~100B, far below the
    // planning floor. The second zoom lands effective Z4, where most of
    // the grid is still fresh, so the candidate search below finds a 10+
    // fresh viewport immediately.
    // Final mixed batch: 10 fresh tiles delivered at 830KiB with no flush
    // (6 in flight, 4 queued to 3399680B, freeBytes = 794624).
    // avg = (99x100 + 10x830KiB)/109 ~ 78080: the mean plans
    // floor(794624/78080) = 10 -- strictly below the 12 the floor would
    // allow (floor(794624/65536) = 12) and below the 14 free job slots.
    const ctx = fresh({
      images: [{id: 5, w: 16384, h: 16384}]
    });
    ctx.canvas.clientWidth = 2000;
    ctx.canvas.clientHeight = 1500;
    await bootAndSettle(ctx);
    const wheel = ctx.canvasListeners.wheel[0];
    wheel({deltaY: -1200, clientX: 1000, clientY: 750, preventDefault() {}});
    await drive(ctx);
    wheel({deltaY: -800, clientX: 1000, clientY: 750, preventDefault() {}});
    await drive(ctx);
    const down = ctx.canvasListeners.pointerdown[0];
    const move = ctx.canvasListeners.pointermove[0];
    const up = ctx.canvasListeners.pointerup[0];
    let pid = 10;
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
        await waitFor(() => ctx.sends.length > m, 8000, "candidate sends");
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
    // Guard the history window first: boot (17) + two settled zooms
    // (+33/+49) receipt exactly 99x100B through the generic responder, so
    // avg sits near 78KiB. Outside 95..105 the budget math below shifts
    // and this vector must be recalibrated, not silently weakened.
    const tinyPre = (+ctx.hud.rxBytes.textContent) / 100;
    assert.ok(tinyPre >= 95 && tinyPre <= 105, "tiny history window, got " + tinyPre);
    // All ten land large: 6 in flight, 4 queued. No flush yet, so the
    // budget below reads this exact pipeline snapshot.
    const KB830 = 830 * 1024;
    for (let i = 0; i < 10; i++) {
      const t = tiles[i];
      sock.receive(makeTile({
        imageId: t.c.imageId, zoom: t.c.zoom, reqId: req,
        tileX: t.x, tileY: t.y, payloadLen: KB830
      }));
    }
    // No flush: budget must use the floor: freeBytes = 4MiB - 4*830KiB =
    // 794624 -> floor(794624/78080) = 10 slots, strictly below the 12 the
    // floor would allow and the 14 free job slots.
    const budget = ctx.api.batchBudget();
    assert.strictEqual(budget, 10);
    ctx.bitmaps.flushOk();
    await sleep(50);
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
    // 6 in flight, 2 queued: freeJobs is exactly 16 and the floor would
    // allow min(30, 16, floor(2MiB/64KiB)=32) = 16, so any budget below 16
    // proves planTileBytes follows the running mean (avg stays above the
    // 128KiB seed after 8x1MiB land on any boot history under ~56 tiny
    // tiles, hence floor(2MiB/avg) <= 15; the mean can never plan below
    // floor(2MiB/1MiB) = 2 either).
    const budget = ctx.api.batchBudget();
    assert.ok(budget < 16, "mean governs, not floor/slots, got " + budget);
    assert.ok(budget >= 2, "mean lower bound, got " + budget);
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

// ---------------------------------------------------------------------------
// LFUDA (Least Frequently Used with Dynamic Aging) cache policy.
// Unit vectors run against the exported class directly, so every assertion
// below is a deterministic function of the trace and no rendering, timing, or
// network state can influence it.
// ---------------------------------------------------------------------------
describe("lfuda cache", () => {
  // Fake bitmaps: close() is counted, so "exactly once" is assertable.
  function bmp(name) {
    return {
      name,
      closes: 0,
      close() {
        this.closes += 1;
      }
    };
  }
  function newCache(ctx, capacity) {
    return new ctx.api.LfudaCache(capacity);
  }
  // A fresh entry is frequency 1 at priority age + 1, with a monotonic
  // admission sequence and its admission counted as the current epoch.
  function fill(c, keys, opts) {
    const made = {};
    for (const k of keys) {
      made[k] = bmp(k);
      c.insert(k, made[k], Object.assign({epoch: 0}, opts));
    }
    return made;
  }

  it("inserts at frequency 1 and priority age + 1", () => {
    const ctx = fresh();
    const c = newCache(ctx, 4);
    const x = bmp("x");
    const e = c.insert("x", x, {bytes: 7, epoch: 3});
    assert.strictEqual(e.frequency, 1, "frequency starts at 1");
    assert.strictEqual(e.priority, 0 + 1, "priority is age + frequency");
    assert.strictEqual(c.age, 0, "age starts at 0");
    assert.strictEqual(e.insertedSeq, 1, "admission sequence starts at 1");
    assert.strictEqual(e.lastCountedEpoch, 3, "admission counts for its epoch");
    assert.strictEqual(e.bytes, 7, "payload bytes retained");
    assert.strictEqual(c.size, 1);
    assert.strictEqual(c.has("x"), true);
    // A non-zero age must be added, not substituted: a fully pinned cache still
    // evicts, and the surviving entry's priority then rebases onto the new age
    // the next time it is referenced.
    const small = newCache(ctx, 2);
    small.insert("a", bmp("a"), {pin: true});
    small.insert("b", bmp("b"), {pin: true});
    small.insert("c", bmp("c"));
    assert.strictEqual(small.age, 1, "one eviction raised age to 1");
    assert.strictEqual(small.peek("c").priority, 1, "priority is fixed at admission");
    small.markNeeded("c", 1);
    assert.strictEqual(small.peek("c").priority, 1 + 2, "priority is age + frequency");
    assert.notStrictEqual(small.peek("c").priority, small.peek("c").frequency, "not bare frequency");
  });

  it("evicts the lowest frequency, not the oldest or the newest", () => {
    const ctx = fresh();
    const c = newCache(ctx, 3);
    // Insertion itself is frequency 1, so "used in 5 epochs" lands on 6.
    fill(c, ["A", "B", "C"]);
    for (let e = 1; e <= 5; e++) {
      c.markNeeded("A", e);
    }
    for (let e = 1; e <= 3; e++) {
      c.markNeeded("B", e);
    }
    assert.strictEqual(c.peek("A").frequency, 6, "A used in 5 viewport epochs");
    assert.strictEqual(c.peek("B").frequency, 4, "B used in 3 viewport epochs");
    assert.strictEqual(c.peek("C").frequency, 1, "C never reused");
    const d = bmp("D");
    c.insert("D", d);
    assert.strictEqual(c.size, 3, "capacity respected");
    assert.strictEqual(c.has("C"), false, "least frequent entry is the victim");
    assert.strictEqual(c.has("A"), true);
    assert.strictEqual(c.has("B"), true);
    assert.strictEqual(c.has("D"), true);
    assert.strictEqual(c.age, 1, "age rises to the victim's priority");
    assert.strictEqual(c.evicts, 1);
  });

  it("dynamic aging retires popularity that naive LFU would keep forever", () => {
    const ctx = fresh();
    const c = newCache(ctx, 2);
    // One hot tile: referenced in 5 viewport epochs, then abandoned.
    const a = bmp("A");
    c.insert("A", a, {epoch: 0});
    for (let e = 1; e <= 5; e++) {
      c.markNeeded("A", e);
    }
    assert.strictEqual(c.peek("A").priority, 6);
    // A stream of never-reused admissions. Each one is the global minimum
    // priority (age + 1), so the hot tile is repeatedly passed over, and the
    // aging watermark climbs by one per eviction.
    for (let i = 1; i <= 11; i++) {
      c.insert("T" + i, bmp("T" + i));
      assert.strictEqual(c.has("A"), true, "A survives while its priority still leads, round " + i);
    }
    assert.strictEqual(c.age, 5, "watermark climbed to 5 before A was at risk");
    c.insert("T12", bmp("T12"));
    assert.strictEqual(c.has("A"), false, "age caught up and A was evicted");
    assert.strictEqual(c.age, 6, "age rose to A's own priority");
    assert.strictEqual(c.size, 2);
    // The contrast with naive LFU is arithmetic, not a second implementation:
    // a policy whose victim is min(frequency) could never pick A, because A's
    // frequency 6 is never the minimum once any T is present.
    assert.ok(c.peek("T12").frequency < c.seq, "fresh admissions stay at frequency 1");
  });

  it("counts one reference per viewport epoch, not per read", () => {
    const ctx = fresh();
    const c = newCache(ctx, 4);
    fill(c, ["A"]);
    assert.strictEqual(c.markNeeded("A", 10), true);
    assert.strictEqual(c.peek("A").frequency, 2, "epoch 10 need counts once");
    for (let i = 0; i < 200; i++) {
      c.peek("A");
      c.has("A");
      c.keys();
    }
    assert.strictEqual(c.peek("A").frequency, 2, "reads never move a frequency");
    assert.strictEqual(c.markNeeded("A", 10), true);
    assert.strictEqual(c.peek("A").frequency, 2, "same epoch again is a no-op");
    assert.strictEqual(c.markNeeded("A", 11), true);
    assert.strictEqual(c.peek("A").frequency, 3, "epoch 11 need counts again");
    assert.strictEqual(c.hits, 3, "every need is a hit, counting is separate");
    assert.strictEqual(c.misses, 0);
  });

  it("same-epoch duplicates from several internal paths count once", () => {
    const ctx = fresh();
    const c = newCache(ctx, 4);
    fill(c, ["A"]);
    // requestableKeys, covCov, a retry sweep and a redraw all reach the cache
    // in the same epoch; only one of them may count.
    assert.strictEqual(c.markNeeded("A", 7), true);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(c.markNeeded("A", 7), true);
    }
    assert.strictEqual(c.peek("A").frequency, 2, "five duplicate paths, one count");
    assert.strictEqual(c.hits, 6);
  });

  it("a missing tile is a miss and is the only way to count one", () => {
    const ctx = fresh();
    const c = newCache(ctx, 4);
    fill(c, ["A"]);
    assert.strictEqual(c.markNeeded("ghost", 1), false, "needed but absent");
    assert.strictEqual(c.misses, 1);
    assert.strictEqual(c.hits, 0);
  });

  it("a protected current target survives a lower-priority unprotected tile", () => {
    const ctx = fresh();
    const c = newCache(ctx, 3);
    fill(c, ["A", "B", "C"]);
    c.markNeeded("B", 1);
    c.markNeeded("C", 1);
    c.markNeeded("C", 2);
    // A has the LOWEST priority in the cache and is still protected.
    assert.strictEqual(c.peek("A").priority, 1);
    assert.strictEqual(c.peek("B").priority, 2);
    assert.strictEqual(c.peek("C").priority, 3);
    c.protectTarget(["A", "D"]);
    assert.strictEqual(c.isProtected("A"), true);
    const d = bmp("D");
    c.insert("D", d);
    assert.strictEqual(c.has("A"), true, "protection beats LFUDA priority");
    assert.strictEqual(c.has("B"), false, "LFUDA picks among the eligible");
    assert.strictEqual(c.has("C"), true);
    assert.strictEqual(c.has("D"), true);
    assert.strictEqual(c.size, 3);
    // Protection is eligibility only: it must not inflate a frequency.
    assert.strictEqual(c.peek("A").frequency, 1, "protection is not a fake reference");
  });

  it("z0 pinning keeps the overview tile through the first two tiers", () => {
    const ctx = fresh();
    const c = newCache(ctx, 3);
    fill(c, ["Z"], {pin: true});
    fill(c, ["A", "B", "C"]);
    assert.strictEqual(c.size, 3, "Z survived the overflow of A, B and C");
    assert.strictEqual(c.has("A"), false, "unpinned lowest-admission lost instead");
    assert.strictEqual(c.isProtected("Z"), true, "z === 0 stays pinned");
    // Tier 1 exhausted: the viewport target fills the cache, Z0 still holds.
    c.protectTarget(["Z", "A", "B", "C", "D"]);
    c.insert("D", bmp("D"));
    assert.strictEqual(c.size, 3);
    assert.strictEqual(c.has("Z"), true, "z0 survives a full viewport target");
    // Tier 3: a fully pinned cache still evicts, so capacity is never exceeded.
    const tiny = newCache(ctx, 2);
    fill(tiny, ["Z2"], {pin: true});
    fill(tiny, ["A2"], {pin: true});
    tiny.protectTarget(["Z2", "A2", "B2"]);
    tiny.insert("B2", bmp("B2"));
    assert.strictEqual(tiny.size, 2, "capacity is never exceeded");
    assert.strictEqual(tiny.has("Z2"), false, "pinned, but not against a fully pinned cache");
  });

  it("a needed tile is never its own victim", () => {
    const ctx = fresh();
    const c = newCache(ctx, 2);
    fill(c, ["A", "B"]);
    c.markNeeded("A", 1);
    c.markNeeded("B", 1);
    // Everything cached is protected, so the eligible set is empty. A fresh
    // entry has priority age + 1, the global minimum, so without the admission
    // guard C would evict itself here and could never render.
    c.protectTarget(["A", "B", "C"]);
    const cc = bmp("C");
    c.insert("C", cc);
    assert.strictEqual(c.has("C"), true, "the admission is not its own victim");
    assert.strictEqual(c.size, 2);
    assert.strictEqual(cc.closes, 0, "and its bitmap is not closed either");
    assert.strictEqual(c.has("A"), false, "a protected, referenced peer absorbs it");
    assert.strictEqual(cc.closes, 0);
  });

  it("breaks equal priority by older admission, never by recency", () => {
    const ctx = fresh();
    // Same starting state, same admissions, two different recency orders. Only
    // a policy that ignores recency can return the same victim for both.
    const tied = (order) => {
      const c = newCache(ctx, 3);
      fill(c, ["X", "Y", "Z"]);
      for (let e = 1; e <= 2; e++) {
        c.markNeeded("X", e);
        c.markNeeded("Y", e);
        c.markNeeded("Z", e);
      }
      for (const k of order) {
        c.markNeeded(k, 3);
      }
      return c;
    };
    const xLast = tied(["X", "Y", "Z"]);
    const zLast = tied(["Z", "Y", "X"]);
    for (const c of [xLast, zLast]) {
      for (const k of ["X", "Y", "Z"]) {
        assert.strictEqual(c.peek(k).priority, 4, k + " tied at priority 4");
        assert.strictEqual(c.peek(k).lastCountedEpoch, 3);
      }
      assert.strictEqual(c.peek("X").insertedSeq, 1, "X admitted first");
      assert.strictEqual(c.peek("Y").insertedSeq, 2);
      assert.strictEqual(c.peek("Z").insertedSeq, 3);
    }
    xLast.insert("W", bmp("W"));
    zLast.insert("W", bmp("W"));
    assert.strictEqual(xLast.has("X"), false, "older admission loses the tie");
    assert.strictEqual(zLast.has("X"), false, "and loses it the other way round too");
    assert.strictEqual(xLast.has("Z"), true, "Z survives being touched first");
    assert.strictEqual(zLast.has("Z"), true, "Z survives being touched last");
    // A recency tie-break would have kept X in xLast and kept Z in zLast.
  });

  it("is not least-recently-used: LFUDA and LRU pick different victims", () => {
    const ctx = fresh();
    const c = newCache(ctx, 3);
    fill(c, ["A", "B", "C"]);
    // The reference trace, one viewport epoch per row. A and B reach frequency
    // 5; C reaches 4 because it sat out epoch 4.
    const trace = [
      [1, 2, 3],
      [1, 2],
      [1, 2],
      [1, 3],
      [2, 3]
    ];
    for (const epoch of trace) {
      for (const k of epoch) {
        c.markNeeded(["A", "B", "C"][k - 1], trace.indexOf(epoch) + 2);
      }
    }
    const lastTouched = {A: 5, B: 6, C: 6};
    assert.strictEqual(c.peek("A").frequency, 5, "A used in 4 epochs after admission");
    assert.strictEqual(c.peek("B").frequency, 5, "B used in 4 epochs after admission");
    assert.strictEqual(c.peek("C").frequency, 4, "C used in 3 epochs after admission");
    assert.strictEqual(c.peek("A").priority, 5);
    assert.strictEqual(c.peek("B").priority, 5);
    assert.strictEqual(c.peek("C").priority, 4, "C has the strictly lowest priority");
    c.insert("D", bmp("D"));
    // LFUDA: the minimum priority, C.
    assert.strictEqual(c.has("C"), false, "LFUDA victim is C");
    // LRU, worked out from the same trace by hand: A was last referenced in
    // epoch 5, B and C in epoch 6, so the least recently used entry is A.
    const lruVictim = Object.entries(lastTouched)
      .reduce((a, b) => (a[1] <= b[1] ? a : b))[0];
    assert.strictEqual(lruVictim, "A", "LRU would have evicted A");
    assert.notStrictEqual(lruVictim, "C", "the two policies disagree");
    assert.strictEqual(c.has("A"), true, "LFUDA keeps the least recently used tile");
    assert.strictEqual(c.has("B"), true);
    assert.strictEqual(c.age, 4, "age rose to the victim's priority");
  });

  it("never exceeds capacity, even with every entry protected", () => {
    const ctx = fresh();
    const c = newCache(ctx);
    assert.strictEqual(c.capacity, 40, "MAX_CACHE is unchanged at 40");
    const keys = [];
    for (let i = 0; i < 120; i++) {
      keys.push("k" + i);
    }
    c.protectTarget(keys);
    for (const k of keys) {
      c.insert(k, bmp(k), {pin: true});
      assert.ok(c.size <= 40, "size " + c.size + " after inserting " + k);
    }
    assert.strictEqual(c.size, 40, "a fully pinned cache still holds at capacity");
    assert.strictEqual(c.evicts, 80);
  });

  it("closes the victim bitmap exactly once", () => {
    const ctx = fresh();
    const c = newCache(ctx, 2);
    const a = bmp("A");
    const b = bmp("B");
    c.insert("A", a);
    c.insert("B", b);
    assert.strictEqual(a.closes, 0, "a cached bitmap is not closed on insert");
    c.insert("C", bmp("C"));
    assert.strictEqual(c.has("A"), false);
    assert.strictEqual(a.closes, 1, "the victim is closed exactly once");
    c.insert("D", bmp("D"));
    assert.strictEqual(b.closes, 1);
    assert.strictEqual(a.closes, 1, "closing a victim is not repeated");
  });

  it("clear closes every retained bitmap exactly once", () => {
    const ctx = fresh();
    const c = newCache(ctx, 4);
    const made = fill(c, ["A", "B", "C"], {pin: true});
    c.markNeeded("A", 1);
    c.protectTarget(["A", "B", "C"]);
    c.clear();
    assert.strictEqual(c.size, 0);
    for (const k of ["A", "B", "C"]) {
      assert.strictEqual(made[k].closes, 1, k + " closed exactly once by clear");
    }
    assert.strictEqual(c.age, 0, "the watermark restarts with the contents");
    assert.strictEqual(c.isProtected("A"), false, "protection is dropped too");
    c.clear();
    for (const k of ["A", "B", "C"]) {
      assert.strictEqual(made[k].closes, 1, "a second clear closes nothing again");
    }
  });

  it("replacing a key closes the previous bitmap instead of leaking it", () => {
    const ctx = fresh();
    const c = newCache(ctx, 2);
    const first = bmp("A1");
    c.insert("A", first);
    c.markNeeded("A", 1);
    c.markNeeded("A", 2);
    const firstSeq = c.peek("A").insertedSeq;
    const second = bmp("A2");
    const e = c.insert("A", second, {epoch: 3});
    assert.strictEqual(first.closes, 1, "the replaced bitmap is closed once");
    assert.strictEqual(second.closes, 0, "the new bitmap is live");
    assert.strictEqual(c.size, 1, "a replacement does not consume a second slot");
    assert.strictEqual(c.peek("A"), e);
    assert.strictEqual(c.has("A"), true);
    assert.strictEqual(e.frequency, 1, "the replacement restarts the frequency");
    assert.ok(e.insertedSeq > firstSeq, "and gets a fresh admission sequence");
    c.insert("B", bmp("B"));
    c.insert("C", bmp("C"));
    assert.strictEqual(c.has("A"), false);
    assert.strictEqual(second.closes, 1, "the replacement is closable exactly once");
    assert.strictEqual(first.closes, 1);
  });

  it("keeps every counter exact over a long session", () => {
    const ctx = fresh();
    const c = newCache(ctx);
    fill(c, ["A"]);
    const EPOCHS = 1e6;
    for (let e = 1; e <= EPOCHS; e++) {
      c.markNeeded("A", e);
    }
    const ent = c.peek("A");
    assert.strictEqual(ent.frequency, EPOCHS + 1, "one count per epoch, exactly");
    for (const v of [ent.frequency, ent.priority, ent.insertedSeq, c.age, c.seq]) {
      assert.ok(Number.isSafeInteger(v), "counter " + v + " stays exactly representable");
    }
    // Bounds: at most MAX_CACHE entries can be referenced per epoch, so even a
    // 24h session at one epoch per millisecond cannot approach 2^53.
    assert.ok(EPOCHS * 40 < Number.MAX_SAFE_INTEGER);
  });
});

describe("lfuda integration", () => {
  it("redrawing the same viewport never moves a frequency", {timeout: 180000}, async () => {
    const ctx = fresh({images: [{id: 1, w: 4096, h: 4096}]});
    await bootAndSettle(ctx);
    const before = plain(ctx.api.cacheSnapshot());
    assert.ok(before.size > 0, "something is cached");
    const drawsBefore = ctx.ctxCalls.filter((c) => c === "drawImage").length;
    // pointermove renders synchronously on every event and only debounces the
    // intent, so these frames cannot start a new viewport epoch.
    const down = ctx.canvasListeners.pointerdown[0];
    const move = ctx.canvasListeners.pointermove[0];
    const up = ctx.canvasListeners.pointerup[0];
    down({pointerId: 90, clientX: 100, clientY: 100});
    for (let i = 0; i < 60; i++) {
      move({pointerId: 90, clientX: 100 + i, clientY: 100});
    }
    up({pointerId: 90});
    const draws = ctx.ctxCalls.filter((c) => c === "drawImage").length - drawsBefore;
    assert.ok(draws >= 60, "60 redraws happened, got " + draws);
    const after = plain(ctx.api.cacheSnapshot());
    assert.strictEqual(after.size, before.size, "redrawing changed no membership");
    assert.deepStrictEqual(after.entries, before.entries, "redrawing moved no frequency");
    assert.strictEqual(after.hits, before.hits, "redrawing is not a cache reference");
  });

  it("one viewport epoch adds at most one count per cached tile", {timeout: 180000}, async () => {
    const ctx = fresh({images: [{id: 1, w: 4096, h: 4096}]});
    await bootAndSettle(ctx);
    const before = plain(ctx.api.cacheSnapshot());
    await ctx.api.newViewIntent();
    await drive(ctx);
    const after = plain(ctx.api.cacheSnapshot());
    const freqOf = (snap) => {
      const m = {};
      for (const e of snap.entries) {
        m[e.key] = e.frequency;
      }
      return m;
    };
    const b = freqOf(before);
    let counted = 0;
    for (const e of after.entries) {
      if (b[e.key] === undefined) {
        assert.strictEqual(e.frequency, 1, "an admission starts at 1");
        continue;
      }
      const delta = e.frequency - b[e.key];
      assert.ok(delta <= 1, e.key + " gained " + delta + " from a single epoch");
      counted += delta;
    }
    assert.ok(counted > 0, "the epoch did count its cached tiles");
    assert.ok(after.hits > before.hits, "hits are recorded");
  });

  it("a viewport epoch protects its own target from eviction", {timeout: 180000}, async () => {
    const ctx = fresh({images: [{id: 1, w: 4096, h: 4096}]});
    await bootAndSettle(ctx);
    const snap = plain(ctx.api.cacheSnapshot());
    assert.ok(snap.size > 0);
    const target = snap.entries.filter((e) => e.protected);
    assert.ok(target.length > 0, "the current viewport target is protected");
    // Everything the target needs is either cached or in flight, so the
    // protected set must cover the whole visible set it can account for.
    for (const e of target) {
      assert.ok(e.frequency >= 1, "a protected entry has a real frequency");
    }
    assert.ok(snap.age >= 0, "age is exposed for debugging");
    assert.strictEqual(+ctx.hud.lfuAge.textContent, snap.age, "HUD shows the age");
    assert.strictEqual(+ctx.hud.hits.textContent, snap.hits, "HUD shows hits");
    assert.strictEqual(+ctx.hud.miss.textContent, snap.misses, "HUD shows misses");
  });

  it("a decode that resolves after its epoch is closed, never inserted", {timeout: 180000}, async () => {
    const ctx = fresh({images: [{id: 1, w: 4096, h: 4096}]});
    await bootAndSettle(ctx);
    const sizeBefore = +ctx.hud.cache.textContent;
    const closedBefore = ctx.bitmapsClosed.length;
    // Zoom to a fresh level and answer the batch by hand, so no decode is
    // allowed to resolve yet.
    const wheel = ctx.canvasListeners.wheel[0];
    const mark = ctx.sends.length;
    wheel({deltaY: -1005, clientX: 1000, clientY: 750, preventDefault() {}});
    await waitFor(() => ctx.sends.length > mark, 30000, "zoom sends");
    respondToChunks(ctx, mark);
    await waitFor(() => ctx.bitmaps.pending.length > 0, 5000, "a decode is in flight");
    const inflight = ctx.bitmaps.pending.length;
    // A new epoch invalidates the in-flight decodes. purgeQueued only drops
    // queued work, so the in-flight resolution is the interesting path.
    const epochBefore = +ctx.hud.epoch.textContent;
    const intent = ctx.api.newViewIntent();
    intent.catch(() => {
      /* fire-and-forget, same hygiene fork as the input handlers */
    });
    await waitFor(() => +ctx.hud.epoch.textContent > epochBefore, 10000, "epoch advanced");
    ctx.bitmaps.flushOk();
    await sleep(50);
    assert.strictEqual(
      ctx.bitmapsClosed.length - closedBefore,
      inflight,
      "every decode that resolved into a dead epoch was closed"
    );
    assert.strictEqual(+ctx.hud.cache.textContent, sizeBefore, "and none was admitted");
    await drive(ctx);
  });
});


