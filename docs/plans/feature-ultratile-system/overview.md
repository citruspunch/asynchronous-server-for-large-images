---
goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
version: 1.15
date_created: 2026-09-15
last_updated: 2026-09-16
status: 'Planned'
tags: [feature, ultratile, java21, tiling, websocket, offline]
plan_type: split
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Build UltraTile end-to-end from empty repo (`README.md:1`, `project_instructions.md:1-94`).

- Server: JDK-only Java 21 `ServerSocketChannel`, loopback by default
  (trusted-LAN/demo scope; `--bind` opts into `0.0.0.0`).
  One reader VT + one dispatcher VT per WS session, `WsWriter` on
  `ReentrantLock` with `writeFully`, `transferTileIf` declaring `24+fileSize`
  with bounded zero-progress positional fallback, mid-frame failure fatal.
  `closeSession()` wakes BOTH threads (socket close + permit release;
  dispatcher checks `closed` on wake).
- HTTP: strict subset (generic-`method` lexical grammar per RFC 9112,
  multi-value header map, singleton WS headers, absolute-form authority MUST
  equal Host under a frozen http-only profile, body-framing gate BEFORE the
  GET-only method gate, duplicate `Content-Length` always 400).
- Tiles: padded 512x512 JPEG over sealed-generation UTP/1.0 on RFC 6455 with
  mandatory subprotocol `ultratile.utp.v1`.
- Generations: monotonic `lastReqIdSeen`, advanced ONLY on accepted new
  generations. STALE messages are ignored; ILLEGAL current-client messages
  close deterministically with 1002. A rejected reqId is never later
  accepted: every new-generation chunk/COMMIT first checks `rejectedReqIds`,
  entries are purged only once stale, and the connection closes rather than
  evict a live entry. Invalid-newer CHUNKs are recorded with the connection
  kept alive (their COMMIT will hit the rejected set and close); an
  invalid-newer COMMIT closes immediately (COMMIT is terminal — ignoring it
  would hang the waiter). Stale COMMITs stay ignored.
- COMMIT builds the immutable `work` list off-queue, attaches it, seals last,
  then publishes ONE coalesced ready slot — including empty COMMITs
  (`work=List.of()` through the same dispatcher path). The dispatcher walks
  `work` with local `nextIndex`; END iff drained.
- LOD 0 (nearest) is the only implemented mode, FORMAT 1 (JPEG) the only
  implemented format. u32 wire fields parse to `long`.
- Client: one WS per page (`connectWs()`), subprotocol bootstrap, per-image
  selection (`selectImage()`) preserving REQ_ID continuity. Ownership
  needed → pending-network → received → cached, with epoch cleanup on EVERY
  intent, `receivedKeys` network bookkeeping, epoch-level
  `receivedThisEpoch`/`serverSkippedThisEpoch`
  suppression, and `BatchState` lifetime rules. Visual coverage (`covCov`)
  is tracked separately from network done-ness (`netCov`); control flow
  awaits `networkComplete` + decode drain, never `covCov == 100%`.
  Batches are headroom-gated with dynamic sizing.
- Import: demos per-ID (0 and 1 independently ensured; corrupt ready demos
  quarantined as `.stale-invalid-*` and regenerated) via atomic `.ready`
  publish, canonical RELATIVE tile pathnames shared by all importers, a
  pre-decode-capped JDK `ImageIO` real-image fallback, strict bounded
  `meta.json`, live rescan.
- Testing, two frozen tracks: the AUTHORITATIVE track is build + JVM runtime
  + manual browser smoke ONLY (assumes nothing but a JDK — no Maven, Node,
  Python, curl, or ripgrep); the OFFLINE VALIDATION track holds every
  scripted probe (Maven/JUnit primed-cache tests, Node/Python/curl/rg).
- Whether VT-based concurrency satisfies "servidor asíncrono"
  (ASSUMPTION-004) needs instructor confirmation before implementation.

## 1. Requirements & Constraints

- **REQ-001**: Java 20/21 async server serves ultra-high-resolution images
  with progressive/selective loading via 512x512 tiling (ceiling pyramid,
  post-padded edges, clear-then-clip compositing); never serves full
  ultra-res image.
- **REQ-002**: Per WS session one reader VT + one dispatcher VT; one
  serialized `WsWriter` (`ReentrantLock`; reader may call `writeControl`
  under it); blocking-on-VT model (NOT selector async; report states
  plainly).
  - Visibility: `AtomicReference<GenerationState> active`, `AtomicLong
    lastReqIdSeen` (reader-updated ONLY on accepted new generation — first
    valid chunk OR valid empty COMMIT even with an older active present;
    same-gen chunks, matching COMMITs, ABORTs, rejects never advance;
    anything below it is stale unless the active generation's allowed
    continuation), `volatile` sealed/canceled, `AtomicBoolean` closed,
    teardown-only atomic tile-channel ref, idempotent cleanup.
  - Dispatcher owns `sent/skipped/inFlight` + local `nextIndex`; requested
    set reader-owned pre-seal.
  - Frozen teardown/wakeup: `closeSession()` atomically sets `closed`,
    closes the socket (wakes a blocked reader), AND releases the dispatcher
    permit (wakes `readyPermit.acquire()`); the dispatcher checks `closed`
    immediately after every wake and exits without emitting; a
    dispatcher-side fatal I/O closes the socket first, which wakes the
    reader.
  - Cancellation is frame-boundary/best-effort: ABORT/supersession NEVER
    close the current tile channel — an already-started TILE finishes, then
    the dispatcher observes `canceled`; a stale complete TILE may still
    arrive (client discards via `classify`).
  - Active-clearing (frozen): dispatcher CAS-clears `active` iff still its
    state after sending END — the ONLY lifecycle that clears a sealed
    generation, including sealed-empty ones; reader CAS-clears iff still the
    ABORT-matched state; supersede overwrites.
  - FROZEN closing handshake: every deterministic protocol close serializes
    an actual Close control frame (`WsWriter.writeControl()`, opcode 0x8,
    2-byte code 1002/1003/1007/1009 + optional UTF-8 reason) BEFORE
    `closeSession()` tears down the socket — cancel application work
    (marking generations canceled + a separate `closeSent` flag so at most
    one Close is emitted; the `closed` flag is owned SOLELY by
    `closeSession()` and MUST NOT be set early, or its idempotent
    CAS-and-return would skip the socket-close/permit-wakeup body) → write
    Close → then `closeSession()`; the ONLY exception is fatal underlying
    I/O where the frame cannot be written. A peer-sent Close is answered
    with a Close echo before teardown, per RFC 6455 §5.5.1: same code if
    valid (incl. private-use codes like a browser-sent 4002 — echoed, never
    interpreted), 1002 if invalid, EMPTY Close (no status code) if the peer
    sent none — the internal "1005 = no code" value MUST NEVER go on the
    wire. `onPeerClose` takes the same frame-boundary stop discipline as
    `failSession`: mark the active generation canceled FIRST (no NEW TILE
    may start once shutdown is known; an already-started TILE may finish —
    RFC 6455 permits completing the current message before the Close
    response), then CAS `closeSent`, echo, `closeSession()`.
    I/O/EOF aborts immediately. No deadlines by
    design. Transport isolated to `net/`+`ws/` — tile store, UTP packets,
    session rules, viewer survive a selector/`AsynchronousServerSocketChannel`
    swap.
- **REQ-003**: Strict HTTP/1.1 subset (see phase-04 for the full frozen
  grammar): request line `method SP target SP HTTP/1.1` with `method =
  token` (generic, per RFC 9112); frozen gate order lexical parse →
  header/Host validation → GLOBAL body-framing gate → method gate
  (`!=GET` → `405` + `Allow: GET`) → target routing, so bodyless POST gets
  405 but POST+body/TE gets 400; lowercase `get` is a valid token and
  reaches the method gate → 405 (NOT 400); INTENTIONAL SUBSET DECISION:
  EVERY syntactically-valid non-`GET` token maps to 405 (RFC 9110 would
  return 501 for unrecognized methods — this profile deliberately
  collapses to 405; labeled, not RFC behavior); absolute-form frozen profile
  (plain `http`, no userinfo, no fragment, normalized host/IP-literal +
  optional numeric port, authority MUST equal Host); exactly-one valid Host;
  `Map<String,List<String>>` headers; `writeFully`/`readFully`; leftover
  bytes only after bodyless valid upgrade; API JSON via one shared
  `jsonEscape()` routine; UTP/1.0 over RFC 6455 documented.
- **REQ-004**: Frontend locally served, offline; `resizeCanvas()` DPR=1
  first; drag/wheel pointer-anchored within scales + `isFinite` +
  capture/`pointercancel`; immediate cached render + debounced network intent
  (new `viewEpoch` per intent). Node (`node --check`, `test_viewer.cjs`) is
  TEST-ONLY tooling in the offline validation track; the shipped app (Java +
  static JS, no build step) never requires Node; manual no-Node validation
  paths are documented in the report.
- **REQ-005**: LOD frozen (`zFloat`, clamp, ceil/floor/frac≥0.5);
  `effectiveLOD` per-Z recompute, union ≤36; HUD desired-vs-effective;
  clear-then-clip full-bitmap compositing.
- **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6
  in-flight + queue jobs≤24 AND bytes≤4MiB (distinct names); per-intent
  `viewEpoch`; `BatchState{reqId,epoch,imageId,zoom,expectedKeys:Set,
  receivedKeys:Set,networkComplete,canceled}` — `receivedKeys` is
  PER-GENERATION validation state (END triple accounting + duplicate
  detection within that reqId). HUD/suppression history lives OUTSIDE
  batches in epoch-level `receivedThisEpoch:Set` +
  `serverSkippedThisEpoch:Set` (populated on every receipt/END, cleared
  wholesale on `newViewEpoch()` — BatchState reclamation NEVER shrinks
  displayed transport history). FROZEN lifetime (reclaim a current-epoch
  state when `networkComplete && decodeRefs==0`; retain canceled
  previous-epoch states only while that epoch is the immediate
  predecessor — a third epoch drops them). The bare name `serverSkipped`
  MUST NOT exist anywhere (epoch set or nothing).
  - Every received TILE's `(image,z,x,y)` MUST be in `expectedKeys` with
    matching image/zoom else discard+counter.
  - DUPLICATE TILE for an already-`receivedKeys` key → drop + `dupTiles++`
    (wire payload bytes still counted; no second decode).
  - FROZEN END accounting: parse → `classify(reqId)` FIRST. A STALE/old-epoch
    END (unknown reqId, or reqId from a superseded epoch) is discarded +
    `staleEnds++`, connection alive — the server may legitimately send an
    old END before processing a supersession while the browser has already
    advanced (TILEs already classify stale; END gets the same concept).
    ONLY a current-epoch END takes the strict path: its `(imageId,reqId)`
    MUST match a live batch else PROTOCOL-FATAL (`endIdentityFatal++`,
    `ws.close(4002, reason)`, fail waiters), and it MUST satisfy ALL THREE —
    `sent + skipped == expectedKeys.size()` AND
    `sent == receivedKeys.size()` AND
    `skipped == expectedKeys.size() - receivedKeys.size()`
    (totals alone let a duplicate mask a missing tile; TCP ordering means
    every preceding TILE has arrived before END). Violation is
    PROTOCOL-FATAL: `endCountMismatch++`, `ws.close(4002, reason)`, fail
    every waiter — never count-and-continue. (4002, not 1002: browsers
    forbid script-sent 1002 — only 1000/3000–4999 are legal from script;
    4002 = frozen private UTP-protocol-error code for ALL
    browser-detected violations.)
  - `receivedKeys` (per-batch) is STRICTLY network bookkeeping (receipt +
    duplicate detection + END accounting). Visual coverage is separate:
    `netCov = |receivedThisEpoch ∪ serverSkippedThisEpoch|` (cardinality of
    the UNION — never the sum: a key received, then decoder-overflowed into
    `retryNeeded`, then server-skipped in the later retry legally sits in
    BOTH sets and must count once; epoch-level network done-ness, stable
    across BatchState reclamation)
    vs `covCov = cachedTargetKeys / neededTargetKeys` (pixels on screen;
    retry/decode-pending/received-undecoded NEVER count). Control flow
    awaits `networkComplete` + decode resolution/drain; `covCov` is
    observational/HUD state, never a gate for later work.
  - On a current-epoch END, unreceived expected keys become server-skipped:
    `unreceived = expectedKeys - receivedKeys` are added to
    `serverSkippedThisEpoch` (part of suppression), and their `pending`
    entries removed. Every TILE receipt also adds its key to
    `receivedThisEpoch` (idempotent set add alongside the per-batch
    `receivedKeys.add`).
  - REQ_IDs come ONLY from the `createReqAllocator()` closure, which
    returns an explicit result — `{ok:true, reqId}` normally, or
    `{ok:false, reason:"exhausted"}` when the counter would pass
    `0xFFFFFFFE` (start at 1 per WS; NEVER wraps, NEVER throws). On
    `exhausted` the caller reconnects (new WS, fresh allocator) and retries
    the allocation exactly once — exhaustion is an API result handled at
    the call site, not prose. The counter is closure-private, never a
    mutable module global.
  - Coordinate ownership (frozen): needed → pending-network →
    received/decode-owned → cached; TILE receipt REMOVES pending
    immediately; overflow → `retryNeeded`; JPEG rejection of a VALID
    current-batch expected tile OR `format!=1` on such a tile →
    epoch-scoped `terminalFailed` in suppression; END resolves unreceived
    expected as server-skipped.
  - FROZEN receive pipeline order — structural parse (incl. exact TILE
    frame-length equality `message.byteLength === 24 + payloadLen`, checked
    BEFORE any accounting — short/long frames are PROTOCOL-FATAL via
    `tileLenMismatch++` + `ws.close(4002, reason)`, never receipt-counted) → wire-byte
    accounting → `classify(reqId)` → image/zoom/`expectedKeys` membership →
    duplicate check → `pending.delete` → THEN format/admission/decode
    interpretation (only a valid current-batch expected tile may touch
    `terminalFailed`).
  - FROZEN epoch cleanup on EVERY `newViewEpoch()`: bump epoch FIRST, cancel
    old awaiters, remove old-epoch `pending` entries, clear old epoch's
    `retryNeeded` + `terminalFailed` + `serverSkippedThisEpoch` +
    `receivedThisEpoch`, purge queued (not in-flight) decode payloads, move
    old `BatchState`s to the retained-canceled window.
    A tile that terminal-failed in E is requestable again in E+1.
  - Decode accepted iff mapped epoch === currentViewEpoch. Headroom gate +
    dynamic budget as v1.8; `avgTileBytes` uses the `rxBytes` quantity and
    RESETS to the 128 KiB seed on every image switch.
  - WebSocket bootstrap (frozen): `connectWs()` opens ONE socket per page —
    `new WebSocket(wsUrl, "ultratile.utp.v1")` with `wsUrl` derived from the
    loaded page (`ws://${location.host}/ws`, same-origin so `--bind 0.0.0.0`
    deployments pass the server's own Origin-vs-Host rule); assert
    `ws.protocol === "ultratile.utp.v1"`; `ws.binaryType = "arraybuffer"`;
    await `open` before any UTP send. `selectImage(id)` is the SOLE owner of
    the image-switch transaction, executed EXACTLY ONCE per switch —
    `sendAbort(old)` where applicable → bump BOTH counters for their
    separate jobs (`myEpoch = newViewEpoch()` invalidates viewport work;
    `mySwitch = ++imageSwitchSeq` guards `/info` liveness) → abort any
    in-flight `/info` fetch via a shared `AbortController` and start the
    new fetch under it → after EVERY `await` re-check `mySwitch ===
    imageSwitchSeq` and ABANDON silently on mismatch (a resize/pan during
    the fetch bumps `viewEpoch` but NOT `imageSwitchSeq`, so B's valid
    `/info` survives layout churn; the pin re-reads LIVE canvas dims).
    While `pendingSwitch != null`, `newViewIntent()` does local-only work
    + sets coalesced `deferredIntent` (no old-image network batches) and
    the switch runs one fresh intent after pinning. The picker `onchange`
    handler calls ONLY `selectImage(newId)`.
    Pan/zoom/resize use a SEPARATE `newViewIntent()` path (epoch bump +
    headroom-gated budgeted batches; no cache clear, no camera reset, no
    `avgTileBytes` reset). REQ_ID continuity is preserved across switches
    (imageId is on the wire precisely so one session switches images); only
    a genuine WS reconnect resets the allocator to 1.
  - `viewer.js` duplicates Java constants EXPLICITLY with
    `scripts/check_const_parity.py` pinning EVERY shared Java↔JS constant
    to its Java owner — operational tuning to `Config.java`
    (tile/cache/decode/budget/seed/scales) and wire magic/type codes to
    `UtpMessages.java` (the script reads BOTH Java files) — plus shell
    duplicates (tile size, JPEG Q) where practical.
  - `rxBytes` = UTP TILE `payloadLen` bytes received (JPEG payload only —
    NOT the 24B UTP header, NOT WS framing); `decodedBytes` = payload bytes
    that decoded (NOT bitmap footprint). Picker uses `textContent`, never
    HTML interpolation.
  - Viewer wire codec (`encodeViewport`, `encodeCommit`, `encodeAbort`,
    `parseTileHeader`, `parseEnd`) is exposed on `UltraTile` and covered by
    exact byte-vector/endian-offset tests in `test_viewer.cjs` — Java UTP
    and Python E2E tests alone cannot prove the browser writes/parses the
    same packets.
  - Frozen viewer-local `CLOSE_UTP_ERROR = 4002`: EVERY browser-detected
    UTP violation (`endIdentityFatal`, `endCountMismatch`,
    `tileLenMismatch`) closes with `ws.close(4002, shortReason)` (short
    ASCII reason, ≤123 bytes) — script CANNOT send 1002 (`ws.close(1002)`
    throws `InvalidAccessError`; only 1000/3000–4999 are legal). 4002 is
    viewer-local SEMANTICALLY: the server assigns it no UTP meaning and
    defines no `Config` constant for it — but its generic RFC 6455 Close
    parser accepts 4002 as a valid private-use peer code and echoes it
    like any valid code (phase-05 three-way echo). 4002 is therefore
    deliberately OUTSIDE the `check_const_parity.py` map (no SHARED
    constant), not outside the wire parser. Server-detected
    RFC/WebSocket violations stay 1002/1003/1007/1009 on a real Close
    frame.
- **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0` ONLY
  (1/2 reserved → reject), FORMAT `1` JPEG implemented (`2` WebP reserved:
  parsed, never emitted); subprotocol `ultratile.utp.v1` REQUIRED (exactly
  one header — an UltraTile handshake-profile restriction, labeled as such;
  echoed in 101, else 400); REQ_ID u32 no-wrap via the allocator (never
  reset on image switch, 1 only on new WS).
  - `0x01` 28B `>BBHBBHIIIII`
    (freeze/mismatch-invalid/post-seal-rejected).
  - `0x05` 8B `>BBHI` (three-way COMMIT — newer-empty installs
    sealed-empty `work=List.of()` through the SAME coalesced slot; the
    dispatcher sends its END; "immediate" means no tile work, never a
    reader-side END; empty-generation validation is imageId + reqId/session
    rules ONLY — zoom/LOD are absent on the wire and the sealed-empty state
    carries the `zoom=-1, lodMode=-1` sentinel, never a semantic value the
    client never sent).
  - `0x03` 8B `>BBHI` (cancel needs matching `(imageId,reqId)` — unknown
    ABORT ignored as stale, never advances seen; terminal, no END).
  - `0x02` 24B `>BBHBBHIIII` (LEN u32 + ≤`MAX_TILE_BYTES`).
  - `0x04` 16B `>BBHIII` (sealed/non-canceled/active/empty/inflight0 only).
  - FROZEN branch order per packet: safe structural parse → history
    relation (matching-active continuation first, then
    `reqId <= lastReqIdSeen` → STALE-ignore) → full image-specific/semantic
    validation for genuinely newer generations. History is decided BEFORE
    full validation so an old delayed packet whose old image/coordinates no
    longer validate is still correctly STALE (v1.10 validated first and
    could 1002 a packet the protocol says to ignore).
  - FROZEN stale-vs-invalid: STALE (ignore + WARNING, keep alive) =
    below-seen non-matching, unknown-ABORT, stale COMMITs, superseded
    non-active traffic, post-clear duplicates; INVALID (deterministic 1002
    Close control frame + teardown, no hang) = chunk/COMMIT violating the
    CURRENT active generation
    (metadata mismatch, post-seal chunk, duplicate COMMIT while sealed) or
    chunk/COMMIT for a reqId in `rejectedReqIds`; invalid-newer CHUNK
    (fails validation, reqId > seen, touches no active state) = ignore +
    WARNING + RECORD in `rejectedReqIds`, connection stays alive
    (anti-poisoning; its later COMMIT hits the rejected rule and closes);
    invalid-newer COMMIT = deterministic 1002 Close frame IMMEDIATELY (COMMIT is the
    terminal client message — ignoring it leaves the browser waiting for
    END/epochCancel/wsClose forever).
  - FROZEN rejected-set discipline: BEFORE accepting ANY new-generation
    chunk/COMMIT, test `rejectedReqIds.contains(reqId)` → 1002 (bad-9 can
    never resurrect as valid-9; regression: bad-9 → valid-9 → 1002, active
    never becomes 9); entries purged ONLY once `id <= lastReqIdSeen`;
    live entries NEVER FIFO-evicted (cap 64 covers bad-100→valid-2; a 65th
    live rejected ID closes the connection instead of evicting).
  - Span≤128/packet; unique set ≤`GEN_TILE_CAP=256` with dedupe-aware check
    `if (!requested.contains(key) && requested.size()==GEN_TILE_CAP)
    reject` (duplicate at cap accepted; 257th UNIQUE key rejected);
    validate-before-supersede as v1.8.
- **REQ-008**: dz/onetile import + direct n→Z + post-pad +
  tmp/validate/`.ready`/atomic-rename (immutable after); import START
  recovers leftover `.tmp-<id>`; CLI IDs decimal `0..65535` CANONICAL (no
  leading zeros except `"0"` itself — `01`/`0001` rejected; every path uses
  the canonical decimal string so `1` and `01` can never create sibling
  directories); ready target → no-op; non-ready numeric dir →
  `.stale-<id>-<epoch>/` quarantine; ignore `.tmp-*`/`.stale-*`.
  - FROZEN canonical tile naming as a RELATIVE path:
    `tileRelativePath(z,x,y) = "level-<Z>/<X>_<Y>.jpg"` — ONE naming
    algorithm owned by the store, never bound to a root. Serving resolves
    `imageRoot(id).resolve(relative)`; ingest staging resolves
    `tmpRoot.resolve(relative)` and the atomic rename publishes the tree.
    (v1.10 froze a final-root method that ingest could not legally use
    without bypassing staging.)
  - Synthetic fallback bounded O(tile-size), crop-then-downsample-then-
    pad-output; bounded JDK `ImageIO` real-image mode (`--image <file>
    <id>` — convenience fallback ONLY: dimensions inspected via
    `ImageReader.getWidth/getHeight` BEFORE `read()`; refuse unless
    `max(w,h) <= IMPORT_IMAGE_MAX_DIM=8192` AND `(long)w*h <=
    IMPORT_IMAGE_MAX_PIXELS`; honest peak O(W×H) source memory bounded by
    the pixel cap — the cap is an RGBA8 ESTIMATE of ≈64 MiB pixels, not a
    true worst case: higher-bit-depth sources and downsampling working
    images allocate beyond the raw pixel product).
  - Writers emit canonical `"name":"image-<id>"`; missing demo IDs 0 and 1
    ensured INDEPENDENTLY; startup DEMO-REPAIR policy: a demo 0/1 target
    that has `.ready` but is registry-INVALID is quarantined to
    `.stale-invalid-<id>-<epoch>/` and regenerated (normal user imports
    stay immutable/no-op); trust `.ready` only.
  - Metadata: tiny STRICT hand parser, hard-bounded BEFORE parsing
    (`META_MAX_BYTES=16KiB`, `META_NAME_MAX=128`) — oversize → ignore +
    WARNING; malformed/inconsistent → ignore + WARNING (never 500);
    `levels == levelCount(w,h)` AND `meta.id == dir id` (positional,
    never self-claimed) AND `meta.name == "image-"+id` (canonical-name
    enforcement) AND the directory name itself must equal
    `Integer.toString(parsedId)` (so `01` can never validate as 1).
- **REQ-009**: Dispatch on sealed READY SLOT (coalescing, never a FIFO;
  permit accounting `getAndSet`-paired so permits never accumulate — §phase-05)
  + teardown/wakeup + frame-boundary cancel (channel teardown-only) +
  stale-vs-invalid (1002) + no-evict `rejectedReqIds`; final frame admission
  INSIDE the writer lock (`transferTileIf`/`writeEndIf` re-check
  `!closeSent && !closed && !canceled && active==state` before the first
  byte — no data frame starts after a Close); `transferTileIf` WS
  `24+fileSize` + looped `transferTo` with BOUNDED positional zero-progress
  fallback (`src.read(dst64k, transferredOffset)` advancing an explicit
  offset — `transferTo` never moves the channel position; EOF before the
  advertised length stays fatal); FROZEN center-first work order: center =
  union bounding box of ALL chunks' tile ranges
  (`ccx=(loX+hiX)/2.0`, `ccy=(loY+hiY)/2.0` in tile-index space — the wire
  carries ranges, never a viewport center, so the center is DERIVED here);
  sort keys by (Manhattan `|x-ccx|+|y-ccy|` ascending, then `y`, then `x`);
  size gate pre-frame; SKIPPED pre-frame only; post-start fatal; `0x04`
  requires sealed && !canceled && `active.get()==state` &&
  `nextIndex==work.size()` && `inFlight==0`.
  u32 discipline everywhere as v1.8.
- **SEC-001**: Validate id/Z/coords/`TILE_SIZE==512`/LOD==0/span/
  `GEN_TILE_CAP` (dedupe-aware)/u32-shape (see REQ-009); client subtracts
  cached∪pending∪decode-queued∪in-flight∪terminalFailed∪
  serverSkippedThisEpoch
  (epoch), same-Z row-runs, dynamically-budgeted batches, COMMIT; server
  dedupes; no dispatch queue exists.
- **SEC-002**: Bind `Config.BIND` default `127.0.0.1:8080` (`--bind 0.0.0.0`
  opts into LAN; trusted-LAN/demo scope — no deadlines by design);
  normalized `http://` Origin vs `Host` (absent allowed, at most ONE Origin
  header); `/ws` bodyless-only (as are all routes); WS singleton headers
  (exactly one `Sec-WebSocket-Key`, exactly one `Sec-WebSocket-Version` —
  duplicates →400 even when equal; `Sec-WebSocket-Protocol` exactly-one is
  an UltraTile handshake-profile restriction, labeled as such; `Connection`
  aggregated as a comma-token list, case-insensitive); subprotocol
  `ultratile.utp.v1` required + echoed; 1 KiB cap (1009/1002/1003);
  version-mismatch 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8
  matrix; MINIMAL-LENGTH frame encoding enforced (`126` form decoding to
  <126 →1002; `127` form decoding to <65536 →1002).
- **CON-001**: Java 21, Maven (exact pins, DEVELOPMENT-ONLY — primed cache)
  + `build.sh` (AUTHORITATIVE clean-machine build: bash, `set -euo
  pipefail`, cleans classes, empty-safe copy, JDK + standard userland; committed
  executable).
- **CON-002**: `Config` single source for OPERATIONAL TUNING:
  `BIND=127.0.0.1`, `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`,
  `DQ_BYTES=4MiB`, Q85, `MAX_DIM=262144`, `IMPORT_IMAGE_MAX_DIM=8192`,
  `IMPORT_IMAGE_MAX_PIXELS=16777216`, `GEN_TILE_CAP=256`, `BATCH_CAP=30`,
  `SPAN_CAP=128`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`,
  `META_MAX_BYTES=16384`, `META_NAME_MAX=128`, `REJECTED_CAP=64`,
  `AVG_TILE_SEED=131072`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`. Wire magic and
  UTP type codes are single-sourced in `UtpMessages.java` (protocol
  constants class — NOT `Config`); the parity script reads both files.
  Demos id0 2048 (21) + id1 4096 (85), each ensured independently; live
  rescan per call, no restart. Node is NOT a runtime dep (test-only).
- **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
- **GUD-001**: `Cache-Control` split; FINE logs (redirectable); HUD/E2E
  bytes (active-Z/reqs/evicts/decodes, `rxBytes` vs `decodedBytes` split)
  prove transfer+eviction.
- **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min
  1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches; n=0 smallest direct map.
  (2048 → N=2; 4096 → N=3.)
- **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y); cam = viewport-center
  world point.
- **PAT-003**: Half-open + empty-range: intersect native
  `[cam-Vw/2s,cam+Vw/2s)` with `[0,W)`, empty→no request; then multiply
  native coords by `2^(Z-N)` FIRST and only then quantize to tiles
  (`minTile=floor(scaledMin/512)`,
  `maxTile=min(C-1,ceil(scaledMax/512)-1)`) — dividing NATIVE coords by
  512 before scaling is wrong for every Z<N.
- **PAT-004**: Screen-space clear FIRST, then world transform, clip
  `[0,W)×[0,H)`, full padded 512 bitmaps at `512*2^(N-z)` footprints (never
  crop-stretch); fine overlays coarse.

## 2. Phase Index

| Phase | File | Goal | Status |
| ----- | ---- | ---- | ------ |
| 01 | ./phase-01-project-scaffolding.md | GOAL-001: Exact-pin Maven + robust build.sh + compilable stub | Planned |
| 02 | ./phase-02-tile-engine.md | GOAL-002: Ceiling store + validated import + strict meta + 106-tile demos | Planned |
| 03 | ./phase-03-utp-codec.md | GOAL-003: Sealed-generation codec 28B/8B/8B/24B/16B round-trips | Planned |
| 04 | ./phase-04-http-bootstrap.md | GOAL-004: Strict lexical HTTP + live metadata | Planned |
| 05 | ./phase-05-concurrency-sessions.md | GOAL-005: Coalesced-slot sessions + teardown + stale-vs-invalid | Planned |
| 06 | ./phase-06-viewer-frontend.md | GOAL-006: Epoch-cleanup viewer + receivedKeys + unit tests | Planned |
| 07 | ./phase-07-protocol-doc-e2e.md | GOAL-007: Normative protocol doc + contract/unit-split E2E | Planned |

## 3. Alternatives

- **ALT-001**: `HttpServer` hijack — rejected BLOCKER, no 101/raw-socket API
  in Java 21.
- **ALT-002**: IIIF-only — rejected, no custom protocol.
- **ALT-003**: CDN framework — rejected, offline violation.
- **ALT-004**: 256px/120-cache — rejected, 4x index + dispatch cost.
- **ALT-005**: Jetty/Netty — rejected, hides handler + offline risk.
- **ALT-006**: google-layout vips source — rejected BLOCKER: pre-expands
  canvas; dz + post-pad preserves PAT-001.
- **ALT-007**: Paging oversized viewports through M=40 — rejected: 77-tile
  frame cannot co-reside in 40; effective-LOD downgrade instead.
- **ALT-008**: `ImageIO` as the huge-image path — rejected:
  decode-allocates-full-raster; ImageIO is a pre-decode-capped convenience
  fallback only, vips stays the scalable path.

## 4. Dependencies

- **DEP-001**: Phase 02 requires phase 01 pins + `Config` + stub + `build.sh`
  + ready convention.
- **DEP-002**: Phase 03 requires phase 01 layout only.
- **DEP-003**: Phase 04 requires phases 01 + 02 (`ImageRegistry`, `.ready`
  demos).
- **DEP-004**: Phase 05 requires 02 (channel API, padded store) + 03
  (codecs) + 04 (HTTP parser/router it extends).
- **DEP-005**: Phase 06 requires 03 (sealed layouts) + 04 (picker/info
  routes) + 05 (mandatory subprotocol, close-on-invalid semantics, session
  lifecycle the viewer depends on).
- **DEP-006**: Phase 07 requires all prior.

## 5. Files

- **FILE-001**: `NEW pom.xml` — exact plugin versions + manifest
  (development-only; primed cache).
- **FILE-002**: `NEW build.sh` — AUTHORITATIVE build: bash, `set -euo
  pipefail`, cleans classes, empty-safe copy, executable bit committed.
- **FILE-003**: `NEW src/main/java/com/ultratile/net/NioHttpServer.java` —
  strict lexical HTTP (`method=token` grammar, frozen gate order) +
  multi-value headers + absolute-form profile + global body-framing gate +
  method gate + `jsonEscape()` + `getBindAddress()` for the bind test.
- **FILE-004**: `NEW src/main/java/com/ultratile/proto/UtpCodec.java` —
  `TileHeader` (gated LEN) + `ViewportCommit` + `0x04` + u32 discipline +
  LOD-0-only.
- **FILE-005**: `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java`
  — ceiling + `tileRelativePath` naming + serve/stage resolvers + channel
  API + size gate.
- **FILE-006**: `NEW scripts/import_vips.sh` — validated canonical IDs,
  exact dzsave + output-tree transform + post-pad + atomic publish +
  idempotent no-op + tmp recovery, executable bit committed.
- **FILE-007**: `NEW src/main/java/com/ultratile/ws/WsFrame.java` +
  `WsWriter.java` (`ReentrantLock` + `writeFully` + positional zero-progress
  fallback) + `SessionCoordinator.java` (`GenerationState` + work list,
  `lastReqIdSeen`, no-evict `rejectedReqIds`, COMMIT-liveness split,
  history-before-validation, coalesced ready slot, `closeSession` wakeup,
  unified dispatcher END path).
- **FILE-008**: `NEW src/main/resources/web/viewer.js` — `connectWs()` +
  frozen `boot()` (canvas → live gallery → open → initial select →
  handlers) + `selectImage()` (sole image-switch owner, `imageSwitchSeq` +
  deferred intents) + `newViewIntent()` + allocator result-API + wire
  codec (incl. exact TILE frame-length check) + viewEpoch + `BatchState` (per-generation, no skipped set) + epoch-level
  `receivedThisEpoch`/`serverSkippedThisEpoch` + stale-END discard +
  ownership machine + epoch cleanup + netCov/covCov split +
  headroom-budgeted batches + compositing (exposes
  `globalThis.UltraTile`).
- **FILE-009**: `NEW docs/protocol/UTP-1.0.md` — SOLE NORMATIVE protocol
  specification (soft target ~300 lines; content over squeezing).
- **FILE-010**: `NEW scripts/test_viewer.cjs` — `node:vm` unit tests
  (test-only; app Node-free).
- **FILE-011**: `NEW scripts/test_e2e_parser.py` — stdlib synthetic WS parser
  self-test with direction split + minimal-length vectors (test-only).
- **FILE-012**: `NEW scripts/check_const_parity.py` — stdlib
  Java/JS/shell shared-constant parity check (test-only; created in
  phase-02 as a Java+shell framework, completed in phase-06 with the JS
  map — full green required phase-06, never phase-02).
- **FILE-013**: `NEW scripts/ws_handshake_check.py` — stdlib raw-socket
  upgrade probe reading exactly through `\r\n\r\n` (test-only).
- Verified ground truth: v1.14 plans (8 files, all `version: 1.14`, zero
  placeholders, zero lines >1000 chars); impl files `NEW`.

## 6. Testing

- **TEST-001 (two tracks)**:
  - AUTHORITATIVE track (empty cache; assumes a JDK + standard Unix
    userland ONLY — bash, coreutils (incl. `mktemp`), `find`, `grep`,
    `mkdir`, `jar`, and the bash `/dev/tcp` probe; NO downloaded
    dependencies: no Maven, Node, Python, curl, ripgrep, `unzip`, or
    `seq` — manifest checks use `jar`, loops use bash arithmetic):
    `./build.sh` + `java -cp`
    demo generation + `java -jar` start/stop + manual browser smoke (open
    the page, pan/zoom, observe tiles + HUD). All scripted assertions live
    in the other track.
  - OFFLINE VALIDATION track (primed Maven cache + Node/Python/curl/rg test
    tooling, all usable disconnected): `mvn -o -q test` green (codec incl.
    LOD-0-only, ceiling, relative-path resolvers, GenerationState
    seal-slot/three-way/unified-empty/empty-sentinel/active-clear/
    duplicate-stale/history-before-validation/stale-vs-invalid/
    COMMIT-liveness/rejectedReqIds-no-evict/bad-9-resurrection/
    minimal-length/dedupe-aware-cap/mismatch/seen-rule/poisoning/
    supersede-cancel/no-END/coalescing(getAndSet-paired permits + newest-only
    stress)/teardown-wakeup/
    close-frame-codes(1002/1003/1007/1009 + reason-cap)/peer-close-echo incl.
    4002-no-semantics/empty-echo/no-new-TILE-during-transfer/
    closeSent-vs-closed/lock-admission-race/frame-boundary-cancel/
    positional-fallback, center-first-ordering, ID canonicalization, demo repair,
    vipsheader-pre-dim-gate + vips-post-pad-black + 513x777-vips-proof,
    writer serialization + `writeFully`, explicit Close-code validator
    (invalid 1005/1006/1015, valid 1000/1012/4002), incremental-1KiB-cap
    (well-formed-65536→1009 unbounded-allocation-free),
    transferTo `2,0,2` + `2,0,0,0,0`-then-positional-fallback + partial +
    persistent-zero-fallback + fatal-after-start, WS matrix incl.
    singletons/subprotocol-restriction/version-advertise/version-override,
    half-open/empty, allocator result-API (exhausted→reconnect-once, never
    wrap/throw), viewer boot-order/no-packets-before-open/live-gallery +
    imageSwitchSeq-races (resize/pan-during-fetch, latest-dims-pin-once) +
    bootstrap/
    single-owner-selectImage/epoch-guard-A→B/no-double-bump/4002-browser-close/
    ownership/epoch-cleanup/
    pending/retry/terminal/epoch-sets/END-skipped/stale-END-discard/
    receivedKeys/dup/stale-TILE-discard-socket-OPEN/TILE-length-equality/
    complete-message-golden/END-exact-accounting/
    END-identity-fatal/netCov-union-stability/netCov-covCov/BatchState-lifetime/
    headroom/budget(conservative-floor)/expectedKeys/FORMAT-ordering/wire-codec-vectors/
    parity-full (Config-tuning + UtpMessages-wire + shell), meta id-equality/
    canonical-name/canonical-dirname/canonical-info-IDs/bounds,
    ImageIO pre-decode caps incl. the 4097×4097 pixel-cap-only vector).
- **TEST-002**: HTTP probes (OFFLINE VALIDATION track only): `curl`
  static/info (+405 bodyless-POST with `Allow: GET`; 400 for
  POST+`Content-Length: 1` and POST+`Transfer-Encoding: chunked` — framing
  gate precedes method gate; lowercase `get` →405 as a valid-token unknown
  method — intentional 405-for-every-valid-token subset, RFC 9110 would use
  501 for unrecognized); live registry; readiness loops FAIL LOUD; absolute-form
  match→200 AND authority≠Host→400 AND non-http-scheme/userinfo/fragment→400
  AND duplicate-Host→400 AND TE/CL-probes→400 AND lexical probes
  (pre-colon-space/obs-fold/bare-LF/NUL-value/bad-version/double-space→400),
  every raw probe piped to an asserting `grep`; split-line lifecycle (no
  AND-list backgrounding, no blind fixed startup sleeps — short sleeps
  between readiness probes are polling, not startup timing).
- **TEST-003**: E2E contract only (OFFLINE VALIDATION track) — subprotocol
  `ultratile.utp.v1` offered + echoed (exact `Sec-WebSocket-Accept` verified
  against the key); fresh `os.urandom(4)` mask per frame; chunks + COMMIT,
  one gen1 tile THEN switch (never wait gen1 END), buffered gen1 tolerated,
  gen2 TILE + `0x04`, Ping→Pong, live server-frame parser REJECTS masked
  frames and non-minimal lengths; 2/4/10 + 64-bit parse (127-form proven
  offline, not by JPEG compressibility); cancel/missing/validation in unit
  tests.
- **TEST-004**: Offline (validation track for scripted parts; manual browser
  smoke on the authoritative track); LRU≤40, inflight≤6, decodeQ jobs≤24 +
  bytes≤4MiB; deterministic 4096 scenarios: (a) serpentine Z3 sweep (64
  unique keys >40) asserts `evicts>0`; (b) zoom transition 3→1 asserts effZ
  change + `rxBytes↑` + old-bitmap `close()`d/`evicts↑`; desired-vs-effective
  shown; 2048 smoke-only. Node absence must not block app use. 10x parallel
  E2E with per-child waits (`server_pid`/`child_pid` naming — NEVER reuse
  `pid`; idempotent trap) asserts `rc==0`; `wait "$server_pid"` for JVM
  termination BEFORE asserting port 8080 refuses connection (no leaked
  server, no race).

## 7. Risks & Assumptions

- **RISK-001**: Custom Nio subset; mitigation: strict lexical grammar +
  frozen gate order + multi-value headers + golden vectors + single
  `ReentrantLock` writer + caps, isolate `net/`.
- **RISK-002**: No gigapixel asset; mitigation: auto 2048/4096 +
  `import_vips.sh` dz/onetile + post-pad + pre-decode-capped ImageIO
  fallback for ordinary images.
- **RISK-003**: WS state machine; mitigation: frag/close/size/code/version/
  singleton/minimal-length/subprotocol matrix tests + stale-vs-invalid
  discipline + COMMIT-liveness split.
- **RISK-004**: 512px ~45-95 KB (64-bit WS form common), 4K HQ ~77;
  mitigation: 128 cap + GEN_TILE_CAP + sealed chunks + center-first +
  effective LOD + Z0 fallback + headroom-budgeted epoch batches + retryable
  overflow + in-flight suppression.
- **RISK-005**: Trusted-LAN/demo scope: loopback default, no
  send/header/deadline handling by design; mitigation: documented scope
  limitation + `--bind` opt-in for LAN (FD exhaustion by hostile peers out
  of scope, stated plainly).
- **ASSUMPTION-001**: `build.sh` + `java` is THE grader-assumable path
  (JDK + standard Unix userland — authoritative blocks freely use bash,
  coreutils (incl. `mktemp`), `find`, `grep`, `mkdir`, `jar`, and
  `/dev/tcp`; they MUST NOT use Maven, Node, Python, curl, ripgrep,
  `unzip`, or `seq`).
  Maven, Node, Python, curl, and ripgrep are offline-validation-path
  tooling that MUST NOT appear in any authoritative block; needs
  confirmation of port 8080.
- **ASSUMPTION-002**: `libvips` absent on grader — needs confirmation;
  default needs no vips (synthetic + ImageIO fallback cover the demo).
- **ASSUMPTION-003**: Node available for JS tests — TEST-ONLY; needs
  confirmation, else the documented manual-browser path applies (app itself
  never needs Node).
- **ASSUMPTION-004**: Java-21-virtual-thread concurrency (blocking
  `SocketChannel` I/O on VTs) satisfies the assignment's "asynchronous
  server" wording at application level — needs instructor confirmation
  BEFORE implementation; if `AsynchronousServerSocketChannel`/selector async
  is explicitly required, phases 01/04/05 change transport now, not late
  (tile store, UTP packets, session rules, viewer, metadata survive —
  §REQ-002). IMPLEMENTATION GATE (BLOCKER): Phase 01 MUST NOT start until
  this is confirmed. JEP 444 itself distinguishes asynchronous-programming
  style from VT thread-per-request programming — this is a real transport
  decision, not wording.

## 8. Related Specifications / Further Reading

- RFC 6455 (subprotocol negotiation — single-vs-list occurrence, unmasked
  server frames, fresh mask per frame, frag/control, 2/4/10 headers,
  MINIMAL-LENGTH encoding rule, codes 1002/1003/1007/1009, §5.5.1 Close handshake
  incl. the Close-echo rule and the no-code (1005-internal, never on wire)
  condition, version advertise, exact Accept); RFC 9110/9112 (generic-method request line, token, OWS,
  obs-fold rejection, no pre-colon whitespace, absolute-form authority,
  GET/405, Host multiplicity, body rules); libvips dzsave (`depth onetile`
  = pyramid down to one tile, `onetile` vs `one`, n=0 smallest,
  `skip_blanks -1` disables blank skipping, `_files/` output tree, `.jpg[Q]`
  suffix portability, `vipsheader` pre-dimension gate); `FileChannel.transferTo` short/zero-transfer +
  position-invariance (positional-read fallback); `ImageReader`
  dimension-before-decode + complete-image `read()` semantics;
  `SocketChannel` one-reader/one-writer + partial writes; Java 21
  virtual-thread pinning (`ReentrantLock` over monitors for I/O); JEP 444
  (VTs vs async programming terminology — the honest basis of
  ASSUMPTION-004).
