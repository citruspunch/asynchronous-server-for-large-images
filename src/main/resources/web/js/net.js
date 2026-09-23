/* UltraTile offline viewer: net (8/10).
 * Connection model (one socket per page) plus the frozen receive pipeline.
 * Structural parse first, then accounting, classify, membership, duplicate,
 * pending removal, and only then format/admission/decode interpretation.
 */

// ---- connection model: one socket per page ----
function wsUrl() {
  const loc = (typeof window !== "undefined" && window.location)
    ? window.location
    : globalThis.location;
  return "ws://" + loc.host + "/ws";
}

function failAllBatches(err) {
  for (const [, b] of batches) {
    if (!b.canceled) {
      b.canceled = true;
    }
    try {
      b.doneReject(err);
    } catch (e) {
      /* ignore */
    }
  }
  batches.clear();
  decodePipeline.purgeQueued(() => true);
  decodePipeline.fireDrain();
}

function connectWs(opts) {
  const start = (opts && opts.allocatorStart !== undefined) ? opts.allocatorStart : 1;
  failAllBatches(wsClosedError());
  reqAllocator = createReqAllocator(start);
  const WSClass = (typeof window !== "undefined" && window.WebSocket)
    ? window.WebSocket
    : globalThis.WebSocket;
  const socket = new WSClass(wsUrl(), "ultratile.utp.v1");
  return new Promise((resolve, reject) => {
    let settled = false;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (socket.protocol !== "ultratile.utp.v1") {
        ws = null;
        reject(new Error("protocol mismatch"));
        return;
      }
      socket.onmessage = onWsMessage;
      socket.onclose = onWsClose;
      ws = socket;
      resolve();
    };
    socket.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("ws error"));
    };
    socket.onclose = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("ws closed before open"));
    };
  });
}

function onWsClose() {
  ws = null;
  failAllBatches(wsClosedError());
}

function socketOpen() {
  return !!ws && ws.readyState === 1;
}

// ---- allocator result API: reconnect + retry exactly once ----
async function allocReqId() {
  const r = reqAllocator.allocReqId();
  if (r.ok) {
    reqCount += 1;
    lastReqId = r.reqId;
    return r.reqId;
  }
  await connectWs();
  const r2 = reqAllocator.allocReqId();
  if (!r2.ok) {
    throw new Error("exhausted");
  }
  reqCount += 1;
  lastReqId = r2.reqId;
  return r2.reqId;
}

function latestLiveReqId() {
  let best = 0;
  for (const [reqId, b] of batches) {
    if (!b.canceled && !b.networkComplete && reqId > best) {
      best = reqId;
    }
  }
  return best;
}

function sendAbort(reqId) {
  const b = batches.get(reqId);
  if (!b || b.canceled || !socketOpen()) {
    return;
  }
  try {
    ws.send(encodeAbort(b.imageId, reqId));
  } catch (e) {
    /* ignore */
  }
}

function protocolFatal(reason) {
  const shortReason = String(reason).slice(0, 123);
  try {
    if (ws) {
      ws.close(CLOSE_UTP_ERROR, shortReason);
    }
  } catch (e) {
    /* script-sent 1002 would throw; 4002 is always legal */
  }
  failAllBatches(new Error(shortReason));
}

// ---- frozen receive pipeline ----
function onWsMessage(ev) {
  const buffer = ev && ev.data;
  if (!buffer || typeof buffer.byteLength !== "number") {
    return;
  }
  if (buffer.byteLength === 16) {
    onEndMessage(buffer);
    return;
  }
  onTileMessage(buffer);
}

function onTileMessage(buffer) {
  const h = parseTileHeader(buffer);
  rxBytes += h.payloadLen;
  tileSamples += 1;
  avgTileBytes += (h.payloadLen - avgTileBytes) / tileSamples;
  const mapped = classify(h.reqId);
  if (mapped === "stale-unknown") {
    droppedUnexpected += 1;
    updateHud();
    return;
  }
  if (mapped !== viewEpoch) {
    staleTiles += 1;
    updateHud();
    return;
  }
  const b = batches.get(h.reqId);
  const key = tileKey(h.imageId, h.zoom, h.tileX, h.tileY);
  if (!b || b.canceled || !b.expectedKeys.has(key)
    || b.imageId !== h.imageId || b.zoom !== h.zoom) {
    droppedUnexpected += 1;
    updateHud();
    return;
  }
  if (b.receivedKeys.has(key)) {
    dupTiles += 1;
    updateHud();
    return;
  }
  b.receivedKeys.add(key);
  receivedThisEpoch.add(key);
  pending.delete(key);
  if (h.format !== FORMAT_JPEG) {
    terminalFailed.add(key);
    updateHud();
    return;
  }
  // Admission overflow is about QUEUE room (jobs and bytes): a full
  // in-flight set is normal pipeline pressure absorbed by the queue, not
  // a reason to retry.
  if (decodePipeline.queueJobs() >= DECODE_QUEUE_MAX_JOBS
    || decodePipeline.queuedBytes + h.payloadLen > DECODE_QUEUE_MAX_BYTES) {
    retryNeeded.add(key);
    updateHud();
    return;
  }
  const bytes = buffer.slice(24);
  decodePipeline.submit({
    key,
    epoch: b.epoch,
    reqId: h.reqId,
    z: h.zoom,
    bytes,
    len: h.payloadLen
  });
  updateHud();
}

function onEndMessage(buffer) {
  const e = parseEnd(buffer);
  const mapped = classify(e.reqId);
  if (mapped === "stale-unknown" || mapped !== viewEpoch) {
    staleEnds += 1;
    updateHud();
    return;
  }
  const b = batches.get(e.reqId);
  if (!b || b.canceled || b.imageId !== e.imageId) {
    endIdentityFatal += 1;
    protocolFatal("end identity");
    return;
  }
  const expected = b.expectedKeys.size;
  const received = b.receivedKeys.size;
  if (!(e.sent + e.skipped === expected
    && e.sent === received
    && e.skipped === expected - received)) {
    endCountMismatch += 1;
    protocolFatal("end count");
    return;
  }
  b.networkComplete = true;
  for (const key of b.expectedKeys) {
    if (!b.receivedKeys.has(key)) {
      serverSkippedThisEpoch.add(key);
      pending.delete(key);
    }
  }
  try {
    b.doneResolve();
  } catch (err) {
    /* ignore */
  }
  maybeReclaim(b);
  updateHud();
}
