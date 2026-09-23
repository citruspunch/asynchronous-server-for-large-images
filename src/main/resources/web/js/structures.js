/* UltraTile offline viewer: structures (2/10).
 * Ownership primitives with no module-state dependencies: request-id
 * allocator closure, LRU tile cache, bounded decode pipeline.
 */

// ---- request-id allocator: closure-private counter, explicit results ----
function createReqAllocator(startReqId) {
  let next = (startReqId === undefined) ? 1 : startReqId;
  return {
    allocReqId() {
      if (next > REQ_ID_MAX) {
        return {ok:false, reason:"exhausted"};
      }
      const reqId = next;
      next += 1;
      return {ok:true, reqId};
    }
  };
}

// ---- LRU tile cache: capacity 40, zoom-0 pinned, close-on-evict ----
class LruCache {
  constructor(capacity, onEvict) {
    this.capacity = (capacity === undefined) ? MAX_CACHE : capacity;
    this.onEvict = onEvict || null;
    this.map = new Map();
    this.pinned = new Set();
    this.evicts = 0;
  }
  static closeValue(v) {
    const bmp = (v && typeof v.close === "function") ? v : (v && v.bitmap);
    if (bmp && typeof bmp.close === "function") {
      try {
        bmp.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
  get size() {
    return this.map.size;
  }
  has(key) {
    return this.map.has(key);
  }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, value, opts) {
    const pin = !!(opts && opts.pin);
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (pin) {
      this.pinned.add(key);
    }
    while (this.map.size > this.capacity) {
      let victim = null;
      for (const k of this.map.keys()) {
        if (!this.pinned.has(k)) {
          victim = k;
          break;
        }
      }
      if (victim === null) {
        victim = this.map.keys().next().value;
      }
      const old = this.map.get(victim);
      this.map.delete(victim);
      this.pinned.delete(victim);
      this.evicts += 1;
      LruCache.closeValue(old);
      if (this.onEvict) {
        try {
          this.onEvict(victim, old);
        } catch (e) {
          /* ignore */
        }
      }
    }
    return value;
  }
  delete(key) {
    this.pinned.delete(key);
    return this.map.delete(key);
  }
  clear() {
    for (const [, v] of this.map) {
      LruCache.closeValue(v);
    }
    this.map.clear();
    this.pinned.clear();
  }
  keys() {
    return [...this.map.keys()];
  }
}

// ---- decode pipeline: bounded queue + bounded inflight, epoch-filtered ----
class DecodePipeline {
  constructor(maxInflight, maxJobs, maxBytes, decodeFn) {
    this.maxInflight = (maxInflight === undefined) ? MAX_DECODE : maxInflight;
    this.maxJobs = (maxJobs === undefined) ? DECODE_QUEUE_MAX_JOBS : maxJobs;
    this.maxBytes = (maxBytes === undefined) ? DECODE_QUEUE_MAX_BYTES : maxBytes;
    this.decodeFn = decodeFn || defaultDecode;
    this.inflight = new Map();
    this.queue = [];
    this.queuedBytes = 0;
    this.drainWaiters = [];
  }
  queueJobs() {
    return this.queue.length;
  }
  has(key) {
    if (this.inflight.has(key)) {
      return true;
    }
    for (const item of this.queue) {
      if (item.key === key) {
        return true;
      }
    }
    return false;
  }
  submit(item) {
    this.queue.push(item);
    this.queuedBytes += item.len;
    this.pump();
  }
  pump() {
    while (this.inflight.size < this.maxInflight && this.queue.length > 0) {
      const item = this.queue.shift();
      this.queuedBytes -= item.len;
      this.inflight.set(item.key, item);
      let p = null;
      try {
        p = this.decodeFn(item.bytes);
      } catch (e) {
        this.finishReject(item);
        continue;
      }
      Promise.resolve(p).then(
        (bmp) => this.finishOk(item, bmp),
        () => this.finishReject(item)
      );
    }
  }
  finishOk(item, bmp) {
    this.inflight.delete(item.key);
    try {
      onDecodeResolved(item, bmp);
    } finally {
      this.pump();
      this.fireDrain();
    }
  }
  finishReject(item) {
    this.inflight.delete(item.key);
    try {
      onDecodeRejected(item);
    } finally {
      this.pump();
      this.fireDrain();
    }
  }
  purgeQueued(pred) {
    const kept = [];
    for (const item of this.queue) {
      if (pred(item)) {
        this.queuedBytes -= item.len;
      } else {
        kept.push(item);
      }
    }
    this.queue = kept;
    this.fireDrain();
  }
  onDrain(fn) {
    this.drainWaiters.push(fn);
  }
  fireDrain() {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) {
      try {
        w();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function defaultDecode(bytes) {
  const blob = (typeof Blob !== "undefined")
    ? new Blob([bytes], {type:"image/jpeg"})
    : bytes;
  return globalThis.createImageBitmap(blob);
}
