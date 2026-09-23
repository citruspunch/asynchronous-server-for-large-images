/* UltraTile offline viewer: epoch (6/10).
 * Frozen epoch cleanup order plus decode-completion ownership. Epoch cleanup
 * runs on EVERY newViewEpoch() (pan/zoom/resize/switch alike).
 */

// ---- frozen epoch cleanup order ----
function newViewEpoch() {
  viewEpoch += 1;
  const cur = viewEpoch;
  for (const [, tok] of epochTokens) {
    if (tok.epoch < cur && !tok.canceled) {
      tok.canceled = true;
      for (const w of tok.awaiters) {
        try {
          w(epochCancelError());
        } catch (e) {
          /* ignore */
        }
      }
      tok.awaiters = [];
    }
  }
  const tok = epochToken(cur);
  for (const [reqId, b] of batches) {
    if (b.epoch < cur && !b.canceled) {
      b.canceled = true;
      try {
        b.doneReject(epochCancelError());
      } catch (e) {
        /* ignore */
      }
    }
    if (b.epoch <= cur - 2) {
      batches.delete(reqId);
    }
  }
  for (const [key, reqId] of pending) {
    if (classify(reqId) !== cur) {
      pending.delete(key);
    }
  }
  retryNeeded.clear();
  terminalFailed.clear();
  serverSkippedThisEpoch.clear();
  receivedThisEpoch.clear();
  decodePipeline.purgeQueued((item) => item.epoch !== cur);
  updateHud();
  return cur;
}

function maybeReclaim(batch) {
  if (batch.epoch === viewEpoch && batch.networkComplete && decodeRefs(batch.reqId) === 0) {
    batches.delete(batch.reqId);
  }
}

// ---- decode completion (accepted iff mapped epoch is current) ----
function onDecodeResolved(item, bmp) {
  decodeCount += 1;
  if (item.epoch === viewEpoch) {
    const pin = item.z === 0;
    cache.set(item.key, {bitmap: bmp, bytes: item.len}, {pin});
    decodedBytes += item.len;
    const b = batches.get(item.reqId);
    if (b) {
      maybeReclaim(b);
    }
  } else if (bmp && typeof bmp.close === "function") {
    try {
      bmp.close();
    } catch (e) {
      /* ignore */
    }
  }
  updateHud();
}

function onDecodeRejected(item) {
  if (item.epoch === viewEpoch) {
    terminalFailed.add(item.key);
    const b = batches.get(item.reqId);
    if (b) {
      maybeReclaim(b);
    }
  }
  updateHud();
}
