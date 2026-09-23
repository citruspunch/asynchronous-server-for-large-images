/* UltraTile offline viewer: render (7/10).
 * Canvas compositing (PAT-002/PAT-004) plus the full HUD shell. Render is
 * best-effort and never throws into the network pipeline.
 */

// ---- canvas ----
function canvasEl() {
  try {
    const d = globalThis.document;
    if (!d) {
      return null;
    }
    return d.getElementById("view") || d.getElementById("canvas");
  } catch (e) {
    return null;
  }
}

function resizeCanvas() {
  const canvas = canvasEl();
  if (!canvas) {
    return;
  }
  const w = canvas.clientWidth || 0;
  const h = canvas.clientHeight || 0;
  if (w > 0 && h > 0) {
    canvas.width = w;
    canvas.height = h;
    viewW = w;
    viewH = h;
  }
}

function render() {
  const canvas = canvasEl();
  if (!canvas || typeof canvas.getContext !== "function") {
    return;
  }
  let ctx = null;
  try {
    ctx = canvas.getContext("2d");
  } catch (e) {
    return;
  }
  if (!ctx) {
    return;
  }
  try {
    if (typeof ctx.resetTransform === "function") {
      ctx.resetTransform();
    }
    ctx.fillStyle = "#000";
    if (typeof ctx.clearRect === "function") {
      ctx.clearRect(0, 0, viewW, viewH);
    }
    ctx.fillRect(0, 0, viewW, viewH);
    if (!currentImage) {
      return;
    }
    const W = currentImage.w;
    const H = currentImage.h;
    const N = maxLevelFor(W, H);
    ctx.save();
    ctx.translate(viewW / 2, viewH / 2);
    ctx.scale(camS, camS);
    ctx.translate(-camX, -camY);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    const entries = [];
    for (const k of cache.keys()) {
      const p = parseKey(k);
      if (p.imageId !== currentImage.id) {
        continue;
      }
      entries.push({p, e: cache.get(k)});
    }
    entries.sort((a, b) => a.p.z - b.p.z);
    for (const {p, e} of entries) {
      if (!e || !e.bitmap) {
        continue;
      }
      const k = Math.pow(2, N - p.z);
      ctx.drawImage(e.bitmap, p.x * TILE * k, p.y * TILE * k, TILE * k, TILE * k);
    }
    ctx.restore();
  } catch (e) {
    /* render is best-effort */
  }
  updateHud();
}

function updateHud() {
  let d = null;
  try {
    d = globalThis.document;
  } catch (e) {
    return;
  }
  if (!d || typeof d.getElementById !== "function") {
    return;
  }
  const set = (id, v) => {
    try {
      const el = d.getElementById(id);
      if (el) {
        el.textContent = String(v);
      }
    } catch (e) {
      /* ignore */
    }
  };
  const desired = currentImage ? selectLevel(camS) : 0;
  const eff = currentImage ? effectiveLOD(desired).effective : 0;
  set("lod", desired);
  set("effZ", eff);
  set("rxBytes", rxBytes);
  set("decodedBytes", decodedBytes);
  set("reqs", reqCount);
  set("evicts", cache.evicts);
  set("cache", cache.size);
  set("decJobs", decodePipeline.queueJobs() + decodePipeline.inflight.size);
  set("decBytes", decodePipeline.queuedBytes);
  set("epoch", viewEpoch);
  set("gen", lastReqId);
  set("netCov", netCov());
  set("covCov", covCov().toFixed(3));
}
