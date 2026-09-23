/* UltraTile offline viewer: geometry (4/10).
 * Pyramid math (PAT-001/PAT-003), LOD selection, headroom/budget policy,
 * coverage counters, and chunk row-run helpers. Pure over module state;
 * never touches the socket.
 */

// ---- pyramid math ----
function maxLevelFor(W, H) {
  return Math.max(0, Math.ceil(Math.log2(Math.max(W, H) / TILE)));
}

function levelW(W, N, Z) {
  return Math.max(1, Math.ceil(W / Math.pow(2, N - Z)));
}

function levelH(H, N, Z) {
  return Math.max(1, Math.ceil(H / Math.pow(2, N - Z)));
}

function colsFor(W, N, Z) {
  return Math.ceil(levelW(W, N, Z) / TILE);
}

function rowsFor(H, N, Z) {
  return Math.ceil(levelH(H, N, Z) / TILE);
}

function selectLevel(s, W, H) {
  const w = (W === undefined) ? (currentImage ? currentImage.w : TILE) : W;
  const h = (H === undefined) ? (currentImage ? currentImage.h : TILE) : H;
  const N = maxLevelFor(w, h);
  const zFloat = Math.min(N, Math.max(0, N + Math.log2(s)));
  return Math.min(N, Math.max(0, Math.floor(zFloat + 0.5)));
}

function visibleTileRange(Z) {
  if (!currentImage) {
    return [];
  }
  const W = currentImage.w;
  const H = currentImage.h;
  const N = maxLevelFor(W, H);
  if (Z < 0 || Z > N || !(camS > 0)) {
    return [];
  }
  const x0w = camX - viewW / (2 * camS);
  const x1w = camX + viewW / (2 * camS);
  const y0w = camY - viewH / (2 * camS);
  const y1w = camY + viewH / (2 * camS);
  const ix0 = Math.max(0, x0w);
  const ix1 = Math.min(W, x1w);
  const iy0 = Math.max(0, y0w);
  const iy1 = Math.min(H, y1w);
  if (!(ix0 < ix1 && iy0 < iy1)) {
    return [];
  }
  const k = Math.pow(2, Z - N);
  const C = colsFor(W, N, Z);
  const R = rowsFor(H, N, Z);
  const tx0 = Math.max(0, Math.floor(ix0 * k / TILE));
  const tx1 = Math.min(C - 1, Math.ceil(ix1 * k / TILE) - 1);
  const ty0 = Math.max(0, Math.floor(iy0 * k / TILE));
  const ty1 = Math.min(R - 1, Math.ceil(iy1 * k / TILE) - 1);
  if (tx0 > tx1 || ty0 > ty1) {
    return [];
  }
  const out = [];
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x <= tx1; x++) {
      out.push(tileKey(currentImage.id, Z, x, y));
    }
  }
  return out;
}

function effectiveLOD(desiredZ) {
  if (!currentImage) {
    return {desired: 0, effective: 0, downgraded: false};
  }
  const N = maxLevelFor(currentImage.w, currentImage.h);
  const d = Math.min(N, Math.max(0, desiredZ | 0));
  for (let E = d; E >= 0; E--) {
    const union = new Set();
    for (let Z = 0; Z <= E; Z++) {
      for (const k of visibleTileRange(Z)) {
        union.add(k);
      }
    }
    if (union.size <= UNION_CAP) {
      return {desired: d, effective: E, downgraded: E < d};
    }
  }
  return {desired: d, effective: 0, downgraded: d > 0};
}

function initialCamera(W, H, Vw, Vh) {
  const fit = Math.min(Vw / W, Vh / H);
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, fit));
  return {x: W / 2, y: H / 2, s: clamped};
}

function splitIntoBatches(keys, budget) {
  const per = Math.max(1, budget | 0);
  const byZ = new Map();
  for (const key of keys) {
    const p = parseKey(key);
    if (!byZ.has(p.z)) {
      byZ.set(p.z, []);
    }
    byZ.get(p.z).push(p);
  }
  const zs = [...byZ.keys()].sort((a, b) => b - a);
  const runs = [];
  for (const z of zs) {
    const pts = byZ.get(z).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let i = 0;
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length && pts[j + 1].y === pts[i].y
        && pts[j + 1].x === pts[j].x + 1) {
        j++;
      }
      runs.push({z, y: pts[i].y, x0: pts[i].x, x1: pts[j].x});
      i = j + 1;
    }
  }
  const batchesOut = [];
  let cur = [];
  let curCount = 0;
  const flush = () => {
    if (cur.length) {
      batchesOut.push(cur);
      cur = [];
      curCount = 0;
    }
  };
  for (const r of runs) {
    let x = r.x0;
    while (x <= r.x1) {
      const room = per - curCount;
      const take = Math.min(room, r.x1 - x + 1);
      for (let k = 0; k < take; k++) {
        cur.push(tileKey(currentImage ? currentImage.id : 0, r.z, x + k, r.y));
      }
      curCount += take;
      x += take;
      if (curCount >= per) {
        flush();
      }
    }
  }
  flush();
  return batchesOut;
}

// ---- derived transport views: headroom, budget, coverage ----
function headroomOk() {
  return decodePipeline.inflight.size < MAX_DECODE
    && decodePipeline.queueJobs() < DECODE_QUEUE_MAX_JOBS
    && (DECODE_QUEUE_MAX_BYTES - decodePipeline.queuedBytes) >= MAX_TILE_BYTES;
}

function batchBudget() {
  const freeJobs = DECODE_QUEUE_MAX_JOBS
    - (decodePipeline.queueJobs() + decodePipeline.inflight.size);
  const freeBytes = DECODE_QUEUE_MAX_BYTES - decodePipeline.queuedBytes;
  const planTileBytes = Math.max(avgTileBytes, PLAN_FLOOR);
  return Math.min(BATCH_CAP, freeJobs, Math.max(1, Math.floor(freeBytes / planTileBytes)));
}

function netCov() {
  return new Set([...receivedThisEpoch, ...serverSkippedThisEpoch]).size;
}

function covCov() {
  if (!currentImage) {
    return 1;
  }
  const N = maxLevelFor(currentImage.w, currentImage.h);
  const want = new Set();
  for (let Z = 0; Z <= N; Z++) {
    for (const k of visibleTileRange(Z)) {
      want.add(k);
    }
  }
  if (!want.size) {
    return 1;
  }
  let hit = 0;
  for (const k of want) {
    if (cache.has(k)) {
      hit++;
    }
  }
  return hit / want.size;
}

function chunkRuns(keys) {
  const byRow = new Map();
  for (const key of keys) {
    const p = parseKey(key);
    const rk = p.z + ":" + p.y;
    if (!byRow.has(rk)) {
      byRow.set(rk, {z: p.z, y: p.y, xs: []});
    }
    byRow.get(rk).xs.push(p.x);
  }
  const runs = [];
  for (const [, r] of byRow) {
    r.xs.sort((a, b) => a - b);
    let i = 0;
    while (i < r.xs.length) {
      let j = i;
      while (j + 1 < r.xs.length && r.xs[j + 1] === r.xs[j] + 1) {
        j++;
      }
      runs.push({z: r.z, y: r.y, x0: r.xs[i], x1: r.xs[j]});
      i = j + 1;
    }
  }
  return runs;
}
