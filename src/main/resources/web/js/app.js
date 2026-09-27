/* UltraTile offline viewer: app (10/10).
 * Frozen image-switch transaction (sole owner: selectImage), viewport-intent
 * path, frozen production boot, input handlers, and the public UltraTile
 * seam. Picker onchange calls ONLY selectImage; every pan/zoom/resize calls
 * newViewIntent.
 */

// ---- frozen image-switch transaction: sole owner is selectImage ----
async function selectImage(id) {
  const live = latestLiveReqId();
  if (live) {
    sendAbort(live);
  }
  const mySwitch = ++imageSwitchSeq;
  pendingSwitch = {seq: mySwitch, id};
  const myEpoch = newViewEpoch();
  if (infoAbort) {
    try {
      infoAbort.abort();
    } catch (e) {
      /* ignore */
    }
  }
  infoAbort = new AbortController();
  const signal = infoAbort.signal;
  let info;
  try {
    const res = await globalThis.fetch("/api/images/" + id + "/info", {signal});
    info = await res.json();
  } catch (e) {
    if (mySwitch !== imageSwitchSeq) {
      return;
    }
    throw e;
  }
  if (mySwitch !== imageSwitchSeq) {
    return;
  }
  currentImage = {id: info.id, w: info.w, h: info.h, levels: info.levels};
  cache.clear();
  decodePipeline.purgeQueued(() => true);
  resizeCanvas();
  const cam = initialCamera(info.w, info.h, viewW, viewH);
  camX = cam.x;
  camY = cam.y;
  camS = cam.s;
  avgTileBytes = AVG_TILE_SEED;
  tileSamples = 0;
  if (pendingSwitch && pendingSwitch.seq === mySwitch) {
    pendingSwitch = null;
  }
  if (mySwitch !== imageSwitchSeq) {
    return;
  }
  const z0keys = visibleTileRange(0);
  cache.protectTarget(z0keys);
  const z0batch = await sendGeneration(currentImage, 0, z0keys, myEpoch);
  await drainBatch(z0batch, myEpoch);
  const {effective} = effectiveLOD(selectLevel(camS));
  updateHud();
  await runViewportBatches(currentImage, myEpoch, [effective]);
  if (deferredIntent) {
    deferredIntent = false;
    await newViewIntent();
  }
  render();
}

// ---- viewport-intent path (pan/zoom/resize): never switches images ----
function scheduleIntent() {
  if (intentTimer) {
    clearTimeout(intentTimer);
    intentTimer = 0;
  }
  const p = new Promise((resolve) => {
    intentTimer = setTimeout(() => {
      intentTimer = 0;
      resolve(newViewIntent());
    }, INTENT_DEBOUNCE_MS);
  });
  // Hygiene fork: input/resize handlers fire-and-forget this promise, and a
  // protocol-fatal rejection (already surfaced via HUD counters +
  // failAllBatches) must never become an unhandled rejection. Awaiting
  // callers still observe the rejection through p itself.
  p.catch(() => {
    /* handled above; failure already surfaced */
  });
  return p;
}

async function newViewIntent() {
  render();
  if (pendingSwitch !== null) {
    resizeCanvas();
    render();
    deferredIntent = true;
    return;
  }
  if (!socketOpen() || !currentImage) {
    resizeCanvas();
    render();
    return;
  }
  if (intentTimer) {
    clearTimeout(intentTimer);
    intentTimer = 0;
  }
  await new Promise((resolve) => {
    intentTimer = setTimeout(() => {
      intentTimer = 0;
      resolve();
    }, INTENT_DEBOUNCE_MS);
  });
  if (pendingSwitch !== null || !socketOpen() || !currentImage) {
    return;
  }
  const live = latestLiveReqId();
  if (live) {
    sendAbort(live);
  }
  const myEpoch = newViewEpoch();
  resizeCanvas();
  await runViewportBatches(currentImage, myEpoch);
  render();
}

// ---- frozen production boot: the only startup flow ----
async function boot() {
  if (bootPromise) {
    return bootPromise;
  }
  bootPromise = (async () => {
    resizeCanvas();
    const res = await globalThis.fetch("/api/images");
    const list = await res.json();
    const d = globalThis.document;
    const picker = d ? d.getElementById("image") : null;
    if (!list || !list.length) {
      if (picker) {
        const opt = d.createElement("option");
        opt.textContent = "no images";
        picker.appendChild(opt);
      }
      return;
    }
    if (picker) {
      for (const item of list) {
        const opt = d.createElement("option");
        opt.value = String(item.id);
        opt.textContent = "image-" + item.id;
        picker.appendChild(opt);
      }
      picker.value = String(list[0].id);
    }
    await connectWs();
    await selectImage(list[0].id);
    installHandlers();
    render();
  })();
  return bootPromise;
}

function installHandlers() {
  let d = null;
  try {
    d = globalThis.document;
  } catch (e) {
    return;
  }
  if (!d) {
    return;
  }
  const canvas = canvasEl();
  const picker = null;
  let pick = null;
  try {
    pick = d.getElementById("image");
  } catch (e) {
    pick = null;
  }
  if (pick && typeof pick.addEventListener === "function") {
    pick.addEventListener("change", async () => {
      try {
        await selectImage(+pick.value);
      } catch (e) {
        /* ignore */
      }
    });
  }
  if (canvas && typeof canvas.addEventListener === "function") {
    const drag = {active: false, id: 0, lx: 0, ly: 0};
    canvas.addEventListener("pointerdown", (e) => {
      drag.active = true;
      drag.id = e.pointerId;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      try {
        if (typeof canvas.setPointerCapture === "function") {
          canvas.setPointerCapture(e.pointerId);
        }
      } catch (err) {
        /* ignore */
      }
    });
    const endDrag = (e) => {
      if (drag.active && (e.pointerId === undefined || e.pointerId === drag.id)) {
        drag.active = false;
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointermove", (e) => {
      if (!drag.active) {
        return;
      }
      if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) {
        return;
      }
      const dx = e.clientX - drag.lx;
      const dy = e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      if (camS > 0) {
        camX -= dx / camS;
        camY -= dy / camS;
      }
      if (currentImage) {
        camX = Math.min(currentImage.w, Math.max(0, camX));
        camY = Math.min(currentImage.h, Math.max(0, camY));
      }
      render();
      scheduleIntent();
    });
    canvas.addEventListener("wheel", (e) => {
      if (typeof e.preventDefault === "function") {
        e.preventDefault();
      }
      if (!Number.isFinite(e.deltaY) || !Number.isFinite(e.clientX)
        || !Number.isFinite(e.clientY)) {
        return;
      }
      const rect = {left: 0, top: 0};
      try {
        const r = canvas.getBoundingClientRect();
        if (r) {
          rect.left = r.left;
          rect.top = r.top;
        }
      } catch (err) {
        /* ignore */
      }
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.001);
      if (!Number.isFinite(factor) || factor <= 0) {
        return;
      }
      const s2 = Math.min(SCALE_MAX, Math.max(SCALE_MIN, camS * factor));
      if (camS > 0 && s2 > 0) {
        const wx = camX + (mx - viewW / 2) / camS;
        const wy = camY + (my - viewH / 2) / camS;
        camS = s2;
        camX = wx - (mx - viewW / 2) / s2;
        camY = wy - (my - viewH / 2) / s2;
      }
      if (currentImage) {
        camX = Math.min(currentImage.w, Math.max(0, camX));
        camY = Math.min(currentImage.h, Math.max(0, camY));
      }
      render();
      scheduleIntent();
    }, {passive: false});
  }
  const win = (typeof window !== "undefined") ? window : null;
  const target = win || globalThis;
  if (target && typeof target.addEventListener === "function") {
    target.addEventListener("resize", () => {
      scheduleIntent();
    });
  }
  void picker;
  void TAU;
}

globalThis.UltraTile = {
  createReqAllocator,
  connectWs,
  selectImage,
  boot,
  newViewIntent,
  encodeViewport,
  encodeCommit,
  encodeAbort,
  parseTileHeader,
  parseEnd,
  selectLevel,
  visibleTileRange,
  effectiveLOD,
  splitIntoBatches,
  DecodePipeline,
  LfudaCache,
  epochToken,
  BatchState,
  classify,
  headroomOk,
  batchBudget,
  newViewEpoch,
  decodeRefs,
  netCov,
  covCov,
  switchState,
  cameraState,
  cacheSnapshot
};
