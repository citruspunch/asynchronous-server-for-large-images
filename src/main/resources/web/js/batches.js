/* UltraTile offline viewer: batches (9/10).
 * Network batch loop: headroom-gated, budgeted, epoch-bound. Control flow
 * awaits networkComplete + decode drain, never covCov == 100%.
 */

// ---- network batch loop: headroom-gated, budgeted, epoch-bound ----
function epochAlive(epoch) {
  return epoch === viewEpoch;
}

function waitHeadroom(epoch) {
  if (headroomOk()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const tok = epochToken(epoch);
    const waiter = (err) => {
      if (err) {
        reject(err);
      } else if (!epochAlive(epoch)) {
        reject(epochCancelError());
      } else if (headroomOk()) {
        resolve();
      } else {
        tok.awaiters.push(waiter);
        decodePipeline.onDrain(check);
      }
    };
    const check = () => {
      const i = tok.awaiters.indexOf(waiter);
      if (i >= 0) {
        tok.awaiters.splice(i, 1);
      }
      waiter();
    };
    tok.awaiters.push(waiter);
    decodePipeline.onDrain(check);
  });
}

function requestableKeys(needed, epoch) {
  const out = [];
  for (const key of needed) {
    const p = parseKey(key);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      continue;
    }
    // A cached tile that this new epoch needs is exactly one LFUDA reference.
    // markNeeded() is the only path that raises a frequency, and the epoch
    // guard inside it makes every other call in this epoch a no-op.
    if (cache.markNeeded(key, epoch)) {
      continue;
    }
    if (pending.has(key)) {
      continue;
    }
    if (decodePipeline.has(key)) {
      continue;
    }
    if (terminalFailed.has(key)) {
      continue;
    }
    if (serverSkippedThisEpoch.has(key)) {
      continue;
    }
    out.push(key);
  }
  return out;
}

async function sendGeneration(info, zoom, keys, epoch) {
  const reqId = await allocReqId();
  if (!epochAlive(epoch)) {
    throw epochCancelError();
  }
  const expectedKeys = new Set(keys);
  const batch = new BatchState({reqId, epoch, imageId: info.id, zoom, expectedKeys});
  batches.set(reqId, batch);
  const tok = epochToken(epoch);
  const cancelWaiter = (err) => {
    if (err && err.epochCancel) {
      try {
        batch.doneReject(err);
      } catch (e) {
        /* ignore */
      }
    }
  };
  tok.awaiters.push(cancelWaiter);
  for (const key of keys) {
    pending.set(key, reqId);
  }
  try {
    for (const r of chunkRuns(keys)) {
      ws.send(encodeViewport({
        imageId: info.id,
        zoom,
        lodMode: LOD_NEAREST,
        tileSize: TILE,
        reqId,
        minX: r.x0,
        maxX: r.x1,
        minY: r.y,
        maxY: r.y
      }));
    }
    ws.send(encodeCommit(info.id, reqId));
  } catch (e) {
    batches.delete(reqId);
    for (const key of keys) {
      pending.delete(key);
    }
    throw wsClosedError();
  }
  render();
  return batch;
}

async function drainBatch(batch, epoch) {
  try {
    await batch.done;
  } catch (e) {
    throw e;
  }
  while (decodeRefs(batch.reqId) > 0) {
    if (!epochAlive(epoch)) {
      throw epochCancelError();
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 20);
      decodePipeline.onDrain(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  maybeReclaim(batch);
}

async function runViewportBatches(info, epoch, zs) {
  if (!socketOpen()) {
    return;
  }
  const levels = zs || [effectiveLOD(selectLevel(camS)).effective];
  // Viewport policy, stated once for the whole epoch intent: the union of the
  // visible tiles at every level this epoch will work on. It decides only
  // eligibility; LFUDA still decides which eligible tile loses.
  const target = [];
  for (const z of levels) {
    for (const k of visibleTileRange(z)) {
      target.push(k);
    }
  }
  cache.protectTarget(target);
  for (const z of levels) {
    if (!epochAlive(epoch)) {
      return;
    }
    const needed = requestableKeys(visibleTileRange(z), epoch);
    if (!needed.length) {
      continue;
    }
    for (const group of splitIntoBatches(needed, batchBudget())) {
      if (!epochAlive(epoch)) {
        return;
      }
      await waitHeadroom(epoch);
      if (!epochAlive(epoch)) {
        return;
      }
      const budget = batchBudget();
      for (const piece of splitIntoBatches(group, budget)) {
        if (!epochAlive(epoch)) {
          return;
        }
        const batch = await sendGeneration(info, z, piece, epoch);
        try {
          await drainBatch(batch, epoch);
        } catch (e) {
          if (e && (e.epochCancel || e.wsClosed)) {
            return;
          }
          throw e;
        }
      }
    }
  }
  let guard = 0;
  while (retryNeeded.size > 0 && guard++ < 8) {
    if (!epochAlive(epoch) || !socketOpen()) {
      return;
    }
    const keys = [...retryNeeded].filter((k) => {
      const p = parseKey(k);
      return p.imageId === info.id && !cache.has(k)
        && !pending.has(k) && !decodePipeline.has(k)
        && !terminalFailed.has(k) && !serverSkippedThisEpoch.has(k);
    });
    retryNeeded.clear();
    if (!keys.length) {
      continue;
    }
    await waitHeadroom(epoch);
    if (!epochAlive(epoch)) {
      return;
    }
    const byZoom = new Map();
    for (const k of keys) {
      const z = parseKey(k).z;
      if (!byZoom.has(z)) {
        byZoom.set(z, []);
      }
      byZoom.get(z).push(k);
    }
    for (const [, zk] of byZoom) {
      const z = parseKey(zk[0]).z;
      const batch = await sendGeneration(info, z, zk, epoch);
      try {
        await drainBatch(batch, epoch);
      } catch (e) {
        if (e && (e.epochCancel || e.wsClosed)) {
          return;
        }
        throw e;
      }
    }
  }
}
