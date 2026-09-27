/* UltraTile offline viewer: structures (2/10).
 * Ownership primitives with no module-state dependencies: request-id
 * allocator closure, LFUDA tile cache, bounded decode pipeline.
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

// ---- LFUDA tile cache: Least Frequently Used with Dynamic Aging ----
//
// LFUDA is the LRFU-family replacement policy that subsumes plain LFU: every
// entry carries a frequency and a priority, and the global `age` watermark is
// raised to the priority of each victim, so popularity earned long ago loses
// influence as the cache keeps evolving. Selection is a min over
// (priority, insertedSeq) and nothing else.
//
// Access recency is never stored, never ordered, and never consulted: there is
// deliberately no recency list in this file, and the insertion-ordered Map is
// admission order, not recency order. `markNeeded()` never reorders anything.
//
// Two concerns are kept deliberately apart:
//   viewport policy (the protection sets) -> which keys MAY be evicted
//   LFUDA (frequency, priority, age)      -> which eligible key DOES lose
//
// A frequency is one viewport epoch, not one render: see markNeeded().
// The scan is O(size) over at most MAX_CACHE entries; no heap, no tree.
class LfudaCache {
  constructor(capacity, onEvict) {
    this.capacity = (capacity === undefined) ? MAX_CACHE : capacity;
    this.onEvict = onEvict || null;
    // key -> entry. Map order is admission order and therefore insertedSeq
    // order. It is not recency, and selection never walks it for ordering.
    this.map = new Map();
    this.pinned = new Set();  // z === 0 overview: protected for the session
    this.target = new Set();  // current epoch's viewport target, replaced whole
    this.age = 0;             // LFUDA aging watermark, starts at 0
    this.seq = 0;             // monotonic admission counter, never reset
    this.evicts = 0;
    this.hits = 0;
    this.misses = 0;
  }
  static closeEntry(entry) {
    const bmp = entry && entry.bitmap;
    if (bmp && typeof bmp.close === "function") {
      try {
        bmp.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
  // Strictly "lower LFUDA priority, then older admission". Recency is absent
  // from this comparison on purpose, so equal priorities are decided by
  // insertion sequence alone.
  static lower(e, best) {
    if (e.priority !== best.priority) {
      return e.priority < best.priority;
    }
    return e.insertedSeq < best.insertedSeq;
  }
  get size() {
    return this.map.size;
  }
  // Viewport policy: a protected key is not an eviction candidate while any
  // unprotected candidate exists.
  isProtected(key) {
    return this.pinned.has(key) || this.target.has(key);
  }
  protectTarget(keys) {
    this.target = new Set(keys);
  }
  clearTarget() {
    this.target = new Set();
  }
  has(key) {
    return this.map.has(key);
  }
  // Non-accounting read. Drawing goes through this, so rendering can never
  // move a frequency.
  peek(key) {
    return this.map.get(key);
  }
  // One meaningful reference: this cached tile satisfies the need of a new
  // viewport epoch. Repeated calls inside the same epoch, from any number of
  // internal paths, count once. Returns whether the tile was cached, which
  // makes the hit/miss counters the natural product of the same call.
  markNeeded(key, epoch) {
    const e = this.map.get(key);
    if (e === undefined) {
      this.misses += 1;
      return false;
    }
    this.hits += 1;
    if (e.lastCountedEpoch === epoch) {
      return true;
    }
    e.lastCountedEpoch = epoch;
    e.frequency += 1;
    e.priority = this.age + e.frequency;
    return true;
  }
  // Admit a freshly decoded bitmap. frequency starts at 1 and the admission
  // itself is that epoch's first reference, so the tile is not counted twice.
  insert(key, bitmap, opts) {
    opts = opts || {};
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.map.delete(key);
      LfudaCache.closeEntry(prev);
    }
    const entry = {
      bitmap,
      bytes: (opts.bytes === undefined) ? 0 : opts.bytes,
      frequency: 1,
      priority: this.age + 1,
      insertedSeq: ++this.seq,
      lastCountedEpoch: (opts.epoch === undefined) ? -1 : opts.epoch
    };
    this.map.set(key, entry);
    if (opts.pin) {
      this.pinned.add(key);
    }
    this.evictDown(key);
    return entry;
  }
  // Bounded three-tier fallback, all three tiers using the same LFUDA order.
  // Tier 1 is the normal path: unprotected keys only. Tier 2 is the case where
  // the viewport target has filled the cache, so target protection yields and
  // z === 0 pinning still holds. Tier 3 is the fully pinned cache. Every tier
  // excludes `admitted`, so a cache can always admit what it just admitted and
  // a needed tile can never be its own permanent victim.
  selectVictim(admitted) {
    const tiers = [
      (k) => k !== admitted && !this.pinned.has(k) && !this.target.has(k),
      (k) => k !== admitted && !this.pinned.has(k),
      (k) => k !== admitted
    ];
    for (const eligible of tiers) {
      let best = null;
      for (const [k, e] of this.map) {
        if (eligible(k) && (best === null || LfudaCache.lower(e, best.e))) {
          best = {k, e};
        }
      }
      if (best !== null) {
        return best;
      }
    }
    const only = this.map.get(admitted);
    return only === undefined ? null : {k: admitted, e: only};
  }
  evictDown(admitted) {
    while (this.map.size > this.capacity) {
      const v = this.selectVictim(admitted);
      if (v === null) {
        break;
      }
      this.age = v.e.priority;  // dynamic aging: the floor rises to the victim
      this.map.delete(v.k);
      this.pinned.delete(v.k);
      this.target.delete(v.k);
      this.evicts += 1;
      LfudaCache.closeEntry(v.e);
      if (this.onEvict) {
        try {
          this.onEvict(v.k, v.e);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
  clear() {
    for (const [, e] of this.map) {
      LfudaCache.closeEntry(e);
    }
    this.map.clear();
    this.pinned.clear();
    this.target.clear();
    // age is a watermark over what the cache has held, and the cache now holds
    // nothing, so it restarts. evicts/hits/misses are deliberately NOT reset:
    // the HUD and the tests read them across an image switch.
    this.age = 0;
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
