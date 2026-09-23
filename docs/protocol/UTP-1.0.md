# UTP/1.0 — UltraTile Protocol (NORMATIVE)

This document is the SOLE NORMATIVE specification of the UltraTile system
wire protocol and its application semantics. If any other project document
disagrees with this file, THIS FILE WINS. A non-normative pointer file
(`UTP_SPEC.md`) may exist elsewhere; it carries no authority.

Conformance note: `MUST` / `MUST NOT` below are wire- or peer-observable
requirements. Internal names (`GenerationState`, `BatchState`, …) are cited
only to pin behavior; conformance is judged on bytes and observable effects.

## §0 Terms

- Server: the Java 21 process (`com.ultratile`), loopback `127.0.0.1:8080`
  by default, `--bind 0.0.0.0` opts into LAN. Trusted-LAN/demo scope.
- Client: the offline viewer served by the server itself (`/`,
  `/styles.css`, `/js/*.js` — ten classic deferred scripts, no CDN,
  no build step, no external reference).
- Generation: one client viewport intent, identified by `(imageId, reqId)`.
  `reqId` is a u32 with no wrap (`1..0xFFFFFFFE`); one socket serves every
  image switch (`reqId` continuity preserved; only a new socket restarts at 1).
- All multi-byte fields are big-endian. u32 fields parse to `long` and MUST
  lie in `0..0xFFFFFFFF`.

## §1 HTTP subset (strict lexical, RFC 9112-shaped)

Request line: `method SP target SP HTTP/1.1` with `method = token`
(generic per RFC 9112). Frozen gate order, enforced for EVERY request:

1. Lexical parse (no pre-colon space, no obs-fold, no bare LF, no NUL/CTL
   in values, single spaces, `HTTP/1.1` exact).
2. Header/Host validation: exactly one valid `Host`; headers kept as
   `Map<String,List<String>>` (multi-value preserved for singleton checks).
3. GLOBAL body-framing gate: any `Transfer-Encoding` → 400; `Content-Length`
   missing is fine (bodyless), but present it MUST be exactly one `0`
   (duplicates, non-digits, overflow, nonzero → 400).
4. Method gate: `!= GET` → `405` + `Allow: GET`. INTENTIONAL SUBSET
   DECISION: every syntactically-valid non-`GET` token maps to 405
   (RFC 9110 would use 501 for unrecognized methods; this profile
   deliberately collapses to 405). Lowercase `get` is a valid token → 405.
5. Target routing: absolute-form is a restricted profile — plain `http`
   only, no userinfo, no fragment, normalized host/IP-literal + optional
   numeric port, authority MUST equal `Host`; query stripped. `..` → 404.

Routes: `/` (viewer shell), `/styles.css`, `/js/*.js`
(`application/javascript`), `/healthz` (200 `OK` iff demos 0+1 ready else
503), `/api/images` (live registry JSON), `/api/images/<id>/info`
(canonical decimal `0..65535` only, else 404), `/ws` (upgrade or 400/403).
JSON strings escape via one shared `jsonEscape()` (quotes/backslash/CTL).

## §2 Tiles (ceiling pyramid, demos, import)

Tile edge is 512 px (`Config.TILE_SIZE`, viewer `TILE`, `tile-size 512`
in `import_vips.sh` — pinned by `check_const_parity.py`).
`N = max(0, ceil(log2(max(W,H)/512)))`; level dims
`W_Z = max(1, ceil(W/2^(N-Z)))`; `C_Z = ceil(W_Z/512)`. Demos: id 0 is
2048×2048 (N=2, 21 tiles), id 1 is 4096×4096 (N=3, 85 tiles), each ensured
independently; a corrupt ready demo is quarantined to
`.stale-invalid-<id>-<epoch>/` and regenerated.

Canonical tile name is a RELATIVE path owned by the store:
`tileRelativePath(z,x,y) = "level-<Z>/<X>_<Y>.jpg"`. Serving resolves
`imageRoot(id).resolve(relative)`; ingest stages under `.tmp-<id>/`,
validates, writes `meta.json` + `.ready`, then atomically renames into
`data/images/<id>/` (leftover `.tmp-<id>` recovered at start; ready target
is a no-op; non-ready numeric dirs quarantine to `.stale-<id>-<epoch>/`).

Generation: `vips dzsave` (`depth onetile` pyramids down to one tile,
`skip_blanks -1` disables blank skipping) into `_files/`, transformed to
the canonical tree, then a post-pad pass (`vips embed` → `.pad.jpg`)
so edge tiles are full 512×512; output validated post-hoc, never assumed.
`--image <file> <id>` is a convenience fallback ONLY: dimensions are read
via `ImageReader.getWidth/getHeight` BEFORE `read()`, refused unless
`max(w,h) <= 8192` AND `w*h <= 16777216` (an RGBA8 ESTIMATE ≈ 64 MiB —
higher-bit-depth sources and downsampling scratch exceed the product).
CLI IDs are canonical decimal (`01` rejected); metadata is a strict
hand parser bounded BEFORE parsing (`META_MAX_BYTES=16KiB`,
`META_NAME_MAX=128`): oversize/malformed/inconsistent → ignore + WARNING,
never 500; enforced `levels == levelCount(w,h)`, `meta.id == dir id`,
`meta.name == "image-"+id`, dirname equals `Integer.toString(parsedId)`.
Registry rescans live per call; no restart.

## §3 Progressive viewing (sealed LOD, ownership, epochs)

Only LOD 0 (nearest) is implemented; values 1/2 are reserved and rejected.
Only FORMAT 1 (JPEG) is emitted; 2 (WebP) is parsed, never emitted.
The client pins ONE zoom-0 generation per image switch, then works at
`effectiveLOD(desired)`: `zFloat = N + log2(s)` clamped to `[0,N]`,
per-Z visible-tile union recomputed, first Z with union ≤ 36 wins
(`{desired, effective, downgraded}` on the HUD). Compositing is
clear-then-clip: screen-space `clearRect`/fill FIRST, then world transform
`screenX = Vw/2 + s*(worldX - camX)` (ditto Y), clip `[0,W)×[0,H)`, full
padded-512 bitmaps at `512*2^(N-z)` footprints, coarse under fine.

One socket per page (`connectWs()`: `new WebSocket(wsUrl,
"ultratile.utp.v1")`, `wsUrl = ws://<location.host>/ws` same-origin,
`binaryType = "arraybuffer"`, `ws.protocol` asserted, await `open`).
`selectImage(id)` is the SOLE image-switch owner and runs EXACTLY ONCE per
switch: abort live old generation → bump BOTH counters (`myEpoch =
newViewEpoch()` invalidates viewport work; `mySwitch = ++imageSwitchSeq`
guards `/info` liveness) → abort prior `/info` fetch, start a fresh
`AbortController` fetch → after EVERY await re-check
`mySwitch === imageSwitchSeq` (abandon silently on mismatch; pan/resize
bumps `viewEpoch`, never `imageSwitchSeq`) → clear cache (closing every
bitmap), re-read LIVE canvas dims, reset camera to `camX=W/2, camY=H/2,
s=clamp(min(Vw/W,Vh/H),1e-3,32)` and `avgTileBytes` to the 128 KiB seed →
pin ONE zoom-0 generation → await `networkComplete` + decode drain (NEVER
`covCov == 100%`) → effective-Z batches → run one deferred intent if set.
`newViewIntent()` (pan/zoom/resize) while a switch is pending does
local-only render + sets `deferredIntent` and returns with no network.
The picker handler calls ONLY `selectImage(newId)`.

Ownership: needed → pending-network (`pending: Map(key→reqId)`, removed
THE MOMENT its TILE arrives) → received/decode-owned → cached.
Admission overflow → same-epoch `retryNeeded`; JPEG rejection or
`format != 1` on a valid current-batch expected tile → epoch
`terminalFailed`. Builder suppression = cached ∪ pending ∪ decode-queued
∪ decode-in-flight ∪ `terminalFailed` ∪ `serverSkippedThisEpoch`.
Per-batch `receivedKeys` is validation ONLY (duplicate + END accounting);
epoch history is `receivedThisEpoch` + `serverSkippedThisEpoch`
(wholesale-cleared on every `newViewEpoch()`); `netCov = |union|` (a
receive→overflow→retry→skip key counts ONCE; stable across `BatchState`
reclamation) vs `covCov = cached/needed` (pixels; observational, never a
gate). `BatchState` reclaims when current-epoch `networkComplete &&
decodeRefs == 0`; previous-epoch states drop when a third epoch starts.
FROZEN cleanup order on EVERY bump: epoch++ → cancel old awaiters → drop
old pending → clear retry/terminal/epoch-sets → purge stale QUEUED (never
in-flight) decodes → retire batches. Batches send only with headroom
(`inflight<6 && queueJobs<24 && freeBytes>=2MiB`) and budget
`min(30, freeJobs, max(1, floor(freeBytes/planTileBytes)))` with
`planTileBytes = max(avgTileBytes, PLAN_FLOOR=65536)`; `avgTileBytes` is
the `rxBytes` running mean, seed 131072, reset per switch. `rxBytes`
counts UTP TILE `payloadLen` (never headers/framing; duplicates included);
`decodedBytes` counts payload bytes on cache insert (never bitmap size).

## §4 Packets and offsets

| Type | Len | Layout (big-endian) | Direction |
| ---- | --: | ------------------- | --------- |
| `0x01` chunk | 28B | `>BBHBBHIIIII`: MAGIC, type, imageId u16, zoom u8, lodMode u8 (=0), tileSize u16 (=512), reqId u32, minX/maxX/minY/maxY u32 | C→S |
| `0x05` COMMIT | 8B | `>BBHI`: MAGIC, type, imageId u16, reqId u32 | C→S |
| `0x03` ABORT | 8B | `>BBHI`: MAGIC, type, imageId u16, abortReqId u32 | C→S |
| `0x02` TILE | 24B + payload | `>BBHBBHIIII`: MAGIC, type, imageId, zoom, format, tileSize (=512), reqId, tileX, tileY, payloadLen u32 (1..2MiB) | S→C |
| `0x04` END | 16B | `>BBHIII`: MAGIC, type, imageId, reqId, sent u32, skipped u32 | S→C |

Subprotocol `ultratile.utp.v1` is REQUIRED and echoed; the exactly-one
`Sec-WebSocket-Protocol` line rule is an UltraTile handshake-profile
restriction (labeled as such in every 400, NOT an RFC 6455 claim).
Chunks freeze per generation (post-seal chunk → 1002), span ≤ 128/axis,
unique set ≤ 256 dedupe-aware (duplicate at cap admitted; 257th UNIQUE
key rejected), u32 shape enforced, validate-before-supersede. COMMIT is
three-way: matching seal (immutable center-first `work` built off-queue,
sealed last, ONE coalesced ready slot — including EMPTY commits with
`work=List.of()` and sentinel `zoom=-1, lodMode=-1` through the SAME
dispatcher path, whose END carries `sent=0, skipped=0`); newer-empty
COMMIT installs a sealed-empty generation; invalid-newer COMMIT closes
immediately (terminal — ignoring it would hang the waiter forever).
ABORT needs matching `(imageId,reqId)` (unknown → stale-ignored, never
advances `lastReqIdSeen`; terminal, no END). History-before-validation:
matching-active continuation first, then `reqId <= lastReqIdSeen` →
STALE-ignore, and only then full validation — so a delayed old packet is
STALE even if its old image no longer validates. Seen advances ONLY on
accepted new generations (first valid chunk, or valid empty COMMIT).
Invalid-newer CHUNK → ignore + WARNING + record in `rejectedReqIds`
(its COMMIT will hit the rejected rule and close); entries purge once
`id <= lastReqIdSeen` and live entries are NEVER FIFO-evicted (cap 64;
a 65th live rejected ID closes instead of evicting — bad-9 can never
resurrect as valid-9). TILE frames declare WS `24+fileSize`, size-gated
pre-frame, SKIPPED pre-frame only, post-start fatal, looped `transferTo`
with bounded positional zero-progress fallback. END requires sealed AND
!canceled AND `active==state` AND `nextIndex==work.size()` AND
`inFlight==0`. Client END accounting is exact: `sent+skipped ==
expectedKeys.size()` AND `sent == receivedKeys.size()` AND
`skipped == expectedKeys.size()-receivedKeys.size()` (totals alone let a
duplicate mask a missing tile); stale/old-epoch END → discard +
`staleEnds++`, connection alive; current-epoch mismatch → PROTOCOL-FATAL
(`ws.close(4002, reason)`, fail waiters — browsers forbid script-sent
1002; the server's generic Close parser accepts/echoes 4002 as a
private-use peer code with NO UTP semantics). Structurally VALID stale
TILEs are the frame-boundary race (server sent before the supersession)
→ discard + `staleTiles++`, socket OPEN; only MALFORMED frames
(`byteLength !== 24+payloadLen`, caught inside the parser BEFORE any
accounting) are fatal. Client TILE receipt adds to BOTH the batch's
`receivedKeys` and `receivedThisEpoch`; END adds unreceived expected keys
to `serverSkippedThisEpoch` and drops their `pending` entries.

## §5 Session state

```text
           chunk(new)              COMMIT(match)            ABORT(match)
 requested ─────────▶ SEALED ──────────────────▶ DISPATCH ───▶ END
    │  ▲                 │  ▲                          │  (iff §4 rule)
    │  │ supersede       │  │ newer COMMIT             │  ABORT/supersede/
    │  │ (cancel old)    │  │ (cancel old, seal new)   │  supersede ─▶ cancel
    ▼  │                 ▼  │                          ▼  (frame-boundary:
 STALE │               STALE│                        no END, in-flight
 ignore│               ignore                         TILE may finish)
```

`GenerationState{reqId,imageId,zoom,lodMode,requested,bbox,work,sealed,
canceled,sent,skipped,inFlight}`; visibility: `AtomicReference active`
(reader-seals/publishes), `AtomicLong lastReqIdSeen` (reader, accept-only),
`volatile sealed/canceled`, `AtomicBoolean closed` (owned SOLELY by
`closeSession()`), teardown-only tile-channel ref, idempotent cleanup.
Dispatcher owns `sent/skipped/inFlight` + local `nextIndex`; requested set
is reader-owned pre-seal. Dispatch walks ONE coalesced ready slot
(`getAndSet`-paired permits never accumulate; supersede replaces stale —
never a FIFO). Center-first work order: center = union bbox of ALL chunks
(`ccx=(loX+hiX)/2`, tile-index space — the wire never carries a center),
sort by (Manhattan, y, x). Final admission INSIDE the writer lock
(`transferTileIf`/`writeEndIf` re-check
`!closeSent && !closed && !canceled && active==state` before the first
byte). Teardown/wakeup: `closeSession()` CAS-sets `closed`, closes the
socket (wakes a blocked reader) AND releases the dispatcher permit (wakes
`readyPermit.acquire()`); the dispatcher checks `closed` after every wake.
Deterministic violations serialize an actual Close control frame
(opcode 0x8, code 1002/1003/1007/1009 + optional UTF-8 reason) BEFORE
teardown — cancel work, CAS `closeSent`, write Close, then `closeSession()`
(the ONLY exception is fatal I/O where the frame cannot be written).
Peer Close: cancel FIRST (no NEW TILE starts; an in-flight TILE may finish
per RFC 6455 §5.5.1), then the three-way echo (valid code incl. private-use
4002 → same code, no semantics; invalid → 1002; none → EMPTY — the internal
1005 NEVER goes on the wire), then teardown. No deadlines by design. Dispatch staging structures (FIFO or
priority) exist nowhere in this path.

## §6 Client ownership diagram

```text
 boot → connectWs → selectImage ──▶ Z0 pin ──▶ effective-Z batches
                        │                    ▲
                        │ pendingSwitch      │ newViewIntent
                        ▼                    │ (epoch bump + budgeted
 pan/zoom/resize ──▶ deferredIntent ─────────┘  batches; no clear/reset)

 needed ─▶ pending ─▶ received/decode-owned ─▶ cached(LRU-40, Z0 pinned)
              │              │ overflow→retryNeeded ─▶ later same-epoch gen
              │              │ reject/format→terminalFailed (epoch)
              └── END unreceived → serverSkippedThisEpoch (epoch, suppressed)
```

Decode ≤ 6 in flight, queue ≤ 24 jobs AND ≤ 4 MiB; `has(key)` covers queued
AND in-flight; stale-epoch QUEUED payloads purge per bump; decodes resolve
into cache iff their epoch is still current (`decodedBytes += payloadLen`;
rejections → `terminalFailed`). UDP-style loss does not exist here (TCP
ordering): every TILE before END arrived; END mismatch is a peer bug.

## §7 Limits

Chunk span ≤ 128/axis; generation unique set ≤ 256; client batch ≤ 30;
1 KiB WS control/message cap (well-formed oversize → 1009, unbounded-
allocation-free); Close codes 1002/1003/1007/1009 + reason cap 123 on real
Close frames; browser violations use private-use 4002 (never script-sent
1002); version `13` required (mismatch → 400 + `Sec-WebSocket-Version: 13`,
`--version` is NOT offered); singleton `Sec-WebSocket-Key`/`Version`
(duplicates → 400 even when equal); `Connection` aggregated as a
comma-token list (split lines allowed); `Upgrade` exactly `websocket`;
MINIMAL-LENGTH enforced (`126`-form < 126 → 1002, `127`-form < 65536 →
1002); server frames unmasked (masked → 1002), client frames masked with a
FRESH `os.urandom(4)` key per frame; opcodes `0/1/2/8/9/A` only, RSV=0,
control ≤ 125 unfragmented; `Origin` at most one, normalized `http://`
authority MUST equal `Host` (absent allowed); exact `Sec-WebSocket-Accept
= base64(sha1(key + GUID))` verified; full ultra-res images are NEVER
served (512-px JPEG tiles only; `MAX_DIM=262144`).

## §8 Concurrency model (honest note + open question)

Transport is blocking `SocketChannel` I/O on Java 21 virtual threads: one
reader VT + one dispatcher VT per WS session, one serialized `WsWriter`
(`ReentrantLock`, NOT monitors — pinning-aware). This is VT
thread-per-request programming and is explicitly NOT non-blocking-selector
async (JEP 444 distinguishes the two; this report states plainly which one
ships). Transport is isolated to `net/` + `ws/` — tile store, UTP packets,
session rules, viewer, and metadata survive a selector or
`AsynchronousServerSocketChannel` swap.

OPEN INSTRUCTOR QUESTION (ASSUMPTION-004, implementation gate): does
application-level VT concurrency satisfy the assignment's "servidor
asíncrono" wording? If explicit selector/`AsynchronousServerSocketChannel`
async is required, phases 01/04/05 change transport now, not late — the
protocol above is transport-agnostic and does not change. Trusted-LAN/demo
scope: loopback default, `--bind 0.0.0.0` opts into LAN, no deadlines by
design, hostile-peer FD exhaustion out of scope.

## §9 Memory envelope (two ledgers, never conflated)

APPLICATION-MANAGED RETAINED: worst case 40 × 512 × 512 × 4 B =
41,943,040 B = 40 MiB raw RGBA-equivalent bitmap pixels, plus browser/GPU
overhead; + up to 12 MiB in-flight compressed (6 × 2 MiB) + 4 MiB queued
compressed + per-tile overhead. `decodedBytes` measures payload bytes
decoded — bitmap footprint is the envelope above, NOT that counter.
BROWSER/SOCKET TRANSIENT (not application-managed): the JS decode queue
rejects excess work only AFTER each WebSocket message arrives, so one
pathological LEGAL batch (30 planned tiles × 2 MiB max TILE) can
transiently push up to 60 MiB compressed through the WS receive path.
Typical traffic is ~45–95 KiB/tile — 60 MiB is the adversarial bound,
stated honestly, not the operating point. Planning shrinks that window
(`planTileBytes = max(avgTileBytes, PLAN_FLOOR=65536)`) but the protocol
does NOT bound UA socket buffering — this section says so instead of
claiming "12 + 4 MiB" as a system total.

## §10 References

RFC 6455 (subprotocol, unmasked server frames, fresh mask per frame,
frag/control, 2/4/10 headers, MINIMAL-LENGTH rule, codes
1002/1003/1007/1009, §5.5.1 Close echo, version advertise, exact Accept);
RFC 9110/9112 (generic-method request line, token, OWS, obs-fold rejection,
absolute-form authority, GET/405, Host multiplicity, body rules);
libvips dzsave (`depth onetile` = pyramid down to one tile, `onetile` vs
`one`, `skip_blanks -1` disables blank skipping, `_files/` output tree,
exact frozen command in `import_vips.sh`); `FileChannel.transferTo`
short/zero-transfer + position-invariance (positional-read fallback);
`ImageReader` dimension-before-decode; `SocketChannel` one-reader/
one-writer + partial writes; virtual-thread pinning (`ReentrantLock` over
monitors); JEP 444 (VT vs async terminology); 101 thread.
