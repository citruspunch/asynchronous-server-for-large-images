/* UltraTile offline viewer: state (3/10).
 * Single ownership of every mutable module binding: socket, counters,
 * per-generation batches, epoch transport sets, cache, pipeline, stats.
 * Small derived views that only read this state live here too; heavier
 * pyramid/policy math lives in geometry.js and lifecycle in epoch.js.
 */

// ---- module state ----
let ws = null;
let reqAllocator = createReqAllocator();
let viewEpoch = 0;
let imageSwitchSeq = 0;
let pendingSwitch = null;
let deferredIntent = false;
let currentImage = null;
let camX = 0;
let camY = 0;
let camS = 1;
let viewW = 0;
let viewH = 0;
let batches = new Map();
let epochTokens = new Map();
let pending = new Map();
let retryNeeded = new Set();
let terminalFailed = new Set();
let receivedThisEpoch = new Set();
let serverSkippedThisEpoch = new Set();
let cache = new LruCache();
let decodePipeline = new DecodePipeline();
let avgTileBytes = AVG_TILE_SEED;
let tileSamples = 0;
let rxBytes = 0;
let decodedBytes = 0;
let reqCount = 0;
let decodeCount = 0;
let dupTiles = 0;
let droppedUnexpected = 0;
let staleTiles = 0;
let staleEnds = 0;
let tileLenMismatch = 0;
let endCountMismatch = 0;
let endIdentityFatal = 0;
let lastReqId = 0;
let infoAbort = null;
let bootPromise = null;
let intentTimer = 0;

function tileKey(imageId, z, x, y) {
  return imageId + ":" + z + ":" + x + ":" + y;
}

function parseKey(key) {
  const p = key.split(":");
  return {imageId: +p[0], z: +p[1], x: +p[2], y: +p[3]};
}

// ---- per-generation validation state (no skipped set lives here) ----
class BatchState {
  constructor({reqId, epoch, imageId, zoom, expectedKeys}) {
    this.reqId = reqId;
    this.epoch = epoch;
    this.imageId = imageId;
    this.zoom = zoom;
    this.expectedKeys = expectedKeys;
    this.receivedKeys = new Set();
    this.networkComplete = false;
    this.canceled = false;
    this.done = new Promise((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
    this.done.catch(() => {
      /* callers race cancel/close; silence unhandled rejections */
    });
  }
}

function epochCancelError() {
  const e = new Error("epoch-cancel");
  e.epochCancel = true;
  return e;
}

function wsClosedError() {
  const e = new Error("ws-closed");
  e.wsClosed = true;
  return e;
}

function epochToken(epoch) {
  const e = (epoch === undefined) ? viewEpoch : epoch;
  let t = epochTokens.get(e);
  if (!t) {
    t = {epoch: e, canceled: false, awaiters: []};
    epochTokens.set(e, t);
  }
  return t;
}

// ---- derived transport views (read-only over module state) ----
function classify(reqId) {
  const b = batches.get(reqId);
  if (!b) {
    return "stale-unknown";
  }
  return b.epoch;
}

function decodeRefs(reqId) {
  let n = 0;
  for (const item of decodePipeline.queue) {
    if (item.reqId === reqId) {
      n++;
    }
  }
  for (const item of decodePipeline.inflight.values()) {
    if (item.reqId === reqId) {
      n++;
    }
  }
  return n;
}

function switchState() {
  return {
    imageSwitchSeq,
    pendingSwitch: pendingSwitch ? {seq: pendingSwitch.seq, id: pendingSwitch.id} : null,
    deferredIntent
  };
}
