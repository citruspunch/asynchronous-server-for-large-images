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

// ---- debug tile overlay (opt-in; never touches the protocol path) ----
// Green marks a tile admitted to the cache, red one the LFUDA policy evicted.
// Events are recorded only while the toolbar toggle is on; render() fades and
// expires them, and a short timer chain drives the fade while any are active.
function debugTileEvent(key, kind) {
  if (!debugTiles) {
    return;
  }
  let p = null;
  try {
    p = parseKey(key);
  } catch (e) {
    return;
  }
  if (!p || !Number.isFinite(p.imageId)) {
    return;
  }
  const now = Date.now();
  for (let i = 0; i < tileFlashes.length; i += 1) {
    const f = tileFlashes[i];
    if (f.imageId === p.imageId && f.z === p.z && f.x === p.x && f.y === p.y) {
      tileFlashes[i] = {imageId: p.imageId, z: p.z, x: p.x, y: p.y, kind, at: now};
      scheduleFlashRender();
      return;
    }
  }
  tileFlashes.push({imageId: p.imageId, z: p.z, x: p.x, y: p.y, kind, at: now});
  if (tileFlashes.length > TILE_FLASH_MAX) {
    tileFlashes.splice(0, tileFlashes.length - TILE_FLASH_MAX);
  }
  scheduleFlashRender();
}

function scheduleFlashRender() {
  if (flashTimer) {
    return;
  }
  flashTimer = setTimeout(() => {
    flashTimer = 0;
    const now = Date.now();
    tileFlashes = tileFlashes.filter((f) => now - f.at < TILE_FLASH_MS);
    render();
    if (debugTiles && tileFlashes.length > 0) {
      scheduleFlashRender();
    }
  }, 110);
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
      // peek(), never an accounting lookup: how many times a frame draws a
      // tile is a redraw count, not cache reuse, and must not move a frequency.
      entries.push({p, e: cache.peek(k)});
    }
    entries.sort((a, b) => a.p.z - b.p.z);
    for (const {p, e} of entries) {
      if (!e || !e.bitmap) {
        continue;
      }
      const k = Math.pow(2, N - p.z);
      ctx.drawImage(e.bitmap, p.x * TILE * k, p.y * TILE * k, TILE * k, TILE * k);
    }
    if (debugTiles && tileFlashes.length > 0) {
      const now = Date.now();
      for (const f of tileFlashes) {
        if (f.imageId !== currentImage.id) {
          continue;
        }
        const age = now - f.at;
        if (age < 0 || age >= TILE_FLASH_MS) {
          continue;
        }
        const fk = Math.pow(2, N - f.z);
        const fx = f.x * TILE * fk;
        const fy = f.y * TILE * fk;
        const fs = TILE * fk;
        const alpha = 0.5 * (1 - age / TILE_FLASH_MS);
        ctx.save();
        ctx.globalAlpha = Math.max(0.08, alpha);
        ctx.fillStyle = (f.kind === "new") ? "#22c55e" : "#ef4444";
        ctx.fillRect(fx, fy, fs, fs);
        if (typeof ctx.strokeRect === "function") {
          ctx.globalAlpha = Math.min(1, 0.4 + alpha);
          ctx.lineWidth = 2 / Math.max(camS, 1e-6);
          ctx.strokeStyle = ctx.fillStyle;
          ctx.strokeRect(fx + ctx.lineWidth / 2, fy + ctx.lineWidth / 2,
            fs - ctx.lineWidth, fs - ctx.lineWidth);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  } catch (e) {
    /* render is best-effort */
  }
  updateHud();
}

// Human-readable formatting for the status bar. The raw counters in the
// Statistics panel stay numeric on purpose: the harness reads them.
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) {
    return "—";
  }
  if (n < 1024) {
    return n + " B";
  }
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (v >= 100 ? String(Math.round(v)) : v.toFixed(1)) + " " + units[i];
}

function fmtZoom(s) {
  const pct = s * 100;
  return (pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1)) + "%";
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
  set("hits", cache.hits);
  set("miss", cache.misses);
  set("lfuAge", cache.age);
  set("decJobs", decodePipeline.queueJobs() + decodePipeline.inflight.size);
  set("decBytes", decodePipeline.queuedBytes);
  set("epoch", viewEpoch);
  set("gen", lastReqId);
  set("netCov", netCov());
  set("covCov", covCov().toFixed(3));
  if (currentImage) {
    const maxZ = maxLevelFor(currentImage.w, currentImage.h);
    set("hrImage", "image-" + currentImage.id + " · " + currentImage.w
      + " × " + currentImage.h);
    let detail = "detail " + desired + "/" + maxZ;
    if (eff !== desired) {
      detail += " (shown at " + eff + ")";
    }
    set("hrDetail", detail);
  }
  set("hrCache", cache.size + "/" + MAX_CACHE);
  const needs = cache.hits + cache.misses;
  set("hrHits", needs > 0 ? Math.round((100 * cache.hits) / needs) + "%" : "—");
  set("hrRx", fmtBytes(rxBytes));
  set("hrReqs", reqCount);
  if (currentImage && Number.isFinite(camS) && camS > 0) {
    set("zoomZ", "z" + desired);
    set("zoomPct", fmtZoom(camS));
  }
}
