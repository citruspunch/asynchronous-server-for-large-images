---
phase: phase-07-protocol-doc-e2e
goal: GOAL-007 Normative protocol doc plus contract/unit-split E2E
status: 'Planned'
parent: ./overview.md
version: 1.15
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 07 — Protocol Doc E2E ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: HTTP-subset (`method=token` grammar,
    framing-gate-before-method-gate, absolute-form http-only profile, global
    bodyless, duplicate-CL always 400, multi-value headers, `jsonEscape()`)
    serves bundle; sealed UTP lifecycle documented (off-queue build → seal
    last → coalesced slot → dispatch → TILE* → END iff sealed&&!canceled&&
    active&&drained&&inflight0 — including sealed-empty via the same path;
    stale-ignored vs invalid-1002; COMMIT-liveness split; no-evict
    `rejectedReqIds`; history-before-validation; ABORT/supersede terminal
    frame-boundary, no END; seen-rule table; dispatcher-only active
    CAS-clearing; teardown/wakeup).
  - **REQ-007**: Sealed UTP: subprotocol `ultratile.utp.v1` (required +
    echoed; exactly-one request header is an UltraTile handshake-profile
    restriction, labeled as such); `0x01` 28B (LOD-0-only, freeze, post-seal
    reject, span≤128, dedupe-aware GEN_TILE_CAP, u32-shape), `0x05` 8B seal
    (three-way COMMIT — newer-empty dispatches sealed-empty END 0/0 through
    the slot; invalid-newer COMMIT → immediate 1002), `0x03` 8B cancel with
    `(imageId,reqId)` match, `0x02` 24B (FORMAT-1 JPEG, size-built, WS
    `24+size`, positional zero-fallback, gate), `0x04` 16B network
    completion with triple accounting on the client; no-wrap via the
    allocator + `lastReqIdSeen` (advance-only-on-accept) + no-reset-on-switch
    (one socket across `selectImage`); client bootstrap + ownership machine +
    epoch cleanup + `receivedKeys`/dup + `serverSkippedThisEpoch` suppression + END
    accounting + END-identity-fatal + netCov/covCov + `BatchState` lifetime +
    wire codec + headroom-budgeted batches; async note + instructor question
    (ASSUMPTION-004, transport-agnostic protocol).
  - **REQ-001**: Progressive/selective 512 tiling (canonical relative
    pathnames, dz/onetile + post-pad, clear-then-clip compositing); never
    full image.
- Prior-phase deps:
  - **DEP-006**: Requires all prior (coalesced-slot + teardown
    `GenerationState`, bootstrap/epoch-cleanup viewer + `test_viewer.cjs` +
    full parity, per-ID `.ready` + demo repair + pre-decode-capped ImageIO +
    strict meta).
- Inputs: sealed system + 2048/4096 `.ready` demos. Outputs: SOLE NORMATIVE
  protocol doc + split E2E (contract vs unit vs parser self-test) +
  async-model note + memory envelope.

## Tasks

### TASK-001 — UTP-1.0.md normative specification

- Create `NEW docs/protocol/UTP-1.0.md` — SOLE NORMATIVE specification (soft
  target ~300 lines; diagrams + state tables over squeezing — the v1.8 hard
  cap is retired because lifecycle semantics no longer fit it).
- §0 conformance note (this document is normative; `UTP_SPEC.md` is a
  non-normative pointer; "MUST" = wire/peer-observable requirement).
- §1 Nio subset (generic-method lexical grammar incl. lone-LF/token/
  obs-fold/CTL rules, framing-gate-before-method-gate with the POST trio
  pinned, lowercase-`get`→405 note, GET-only/405, multi-value headers,
  absolute-form http-only profile flagged as a DELIBERATE RFC 9112
  restriction, global bodyless incl. duplicate-CL-always-400, `jsonEscape()`,
  leftover policy).
- §2 ceiling pyramid + demos (21/85, per-ID ensure + demo-repair policy) +
  canonical RELATIVE pathnames (`tileRelativePath` + serve/stage resolvers) +
  dz/onetile (`depth onetile` = down to one tile; `skip_blanks -1` = no blank
  skipping; exact frozen dzsave command + `_files/`-tree transform; suffix
  portability trade-off; generation VALIDATED post-hoc, never assumed) +
  direct n→Z + post-pad + tmp/`.ready`/rename + quarantine (incl.
  `.tmp-<id>` recovery) + bounded ImageIO fallback (pre-decode
  `IMPORT_IMAGE_MAX_DIM` + `IMPORT_IMAGE_MAX_PIXELS`, honest O(W×H) peak,
  RGBA8-estimate wording, vips stays the huge path) + idempotent no-op +
  canonical CLI IDs + canonical `image-<id>` names (registry-enforced, incl.
  canonical dirnames) + strict bounded meta (16KiB cap, 128 name,
  `levels==levelCount`, `id==dir`, `name==image-id`, hand parser,
  WARNING-ignore) + live rescan.
- §3 sealed LOD/progressive (LOD-0-only nearest + reserved statement, Z0
  pin, clear-then-clip compositing, effective LOD per-Z recompute,
  `connectWs`/epoch-guarded `selectImage` bootstrap (single-owner
  image-switch with `myEpoch` re-check after every `/info` await +
  `AbortController` cancel vs separate `newViewIntent()` pan/zoom/resize
  path; rapid A→B resolves to B only) + allocator + viewEpoch + ownership
  machine + FROZEN epoch cleanup order + per-batch `receivedKeys`
  (validation only) + epoch-level `receivedThisEpoch`/
  `serverSkippedThisEpoch` (suppression + union-cardinality `netCov`,
  reclamation-proof, no double-count) + exact TILE frame-length equality
  (`24 + payloadLen`, fatal) + stale-TILE discard with socket OPEN (valid
  stale TILEs are the frame-boundary race, never fatal) + stale-END
  discard vs current-epoch triple END accounting + END-identity-fatal +
  browser-close 4002 (script can never send 1002; server echoes 4002 as a
  generic private-use peer code, no UTP semantics) +
  netCov-vs-covCov (control awaits networkComplete+drain, never
  `covCov==100%`) + `BatchState` lifetime + `expectedKeys` TILE/END
  enforcement + FROZEN receive-pipeline order + wire-codec functions +
  headroom-gated budgeted batches + avgTileBytes seed/reset + epoch-cancel
  (never wait missing END) + `rxBytes` (UTP TILE `payloadLen` received) vs
  `decodedBytes` (payload bytes decoded — NOT bitmap footprint) + picker
  `textContent`).
- §4 packets/offsets (28/8COMMIT/8ABORT/24/16, subprotocol
  `ultratile.utp.v1` + handshake-profile note, freeze/mismatch-invalid,
  three-way COMMIT via the unified dispatcher path (empty validation =
  imageId + session rules only; sealed-empty sentinel `zoom=-1,
  lodMode=-1`),
  validate-before-supersede + old-cancel-first + active-guard,
  history-before-validation ordering, seen-advancement table (advance:
  first-valid-chunk, valid-newer-empty-COMMIT; record-or-close:
  invalid-newer CHUNK; immediate-close: invalid-newer COMMIT; never:
  same-chunk/matching-COMMIT/ABORT/reject/stale) + no-evict `rejectedReqIds`
  + resurrection regression + stale-vs-invalid split (stale→ignore;
  invalid→deterministic 1002 Close frame + teardown — the frame IS the
  error signal, no UTP ERROR packet (1003 valid-text /
  1007 bad-UTF-8 / 1009 oversize on the same `failSession` path; peer
  Close → cancel-first + three-way echo — same (incl. private-use 4002,
  echoed with no UTP semantics) / 1002 / EMPTY, never 1005 — per §5.5.1;
  in-flight TILE may finish, no new TILE starts) + ABORT-match rule + frame-boundary cancel + active CAS-clearing
  (dispatcher-only for sealed generations), GEN_TILE_CAP dedupe-aware,
  u32-shape rules, no-wrap/no-reset, FORMAT-1-implemented/2-reserved).
- §5 session SERVER STATE DIAGRAM + SUPERSESSION SEQUENCE (GenerationState +
  work/nextIndex + Atomic/volatile/ReentrantLock/writeFully table, coalesced
  ready slot + supersede-replaces-stale + sealed-empty uniformity, 3-point
  checks, `transferTileIf` (lock-admission) + positional zero-fallback + loop + fatal-mid-frame,
  pre-frame gates incl. size, `0x04` rule + no-END-on-cancel, `closeSession`
  teardown/wakeup (socket + permit in the `closed`-CAS winner ONLY —
  `failSession` never pre-sets `closed`; dispatcher `closed`-check),
  frozen `failSession` Close-frame sequence + cancel-first three-way
  peer-Close echo (in-flight TILE finishes, no new TILE starts; Close
  coordination), no-deadline scope; NO queue/`queueEmpty` language anywhere).
- §6 client OWNERSHIP DIAGRAM + pipelines (bootstrap, one-socket image
  switching, LRU-40+Z0, decode 6/24jobs/4MiB + purge + retry + skipped
  suppression + in-flight suppression + headroom/budget).
- §7 limits (128+split same-REQ_ID, 1KiB cap, codes 1002/1003/1007/1009 +
  Close-frame freeze + browser 4002 +
  version advertise + `--version` override + singletons + minimal-length
  126/127 + 2/4/10, unmasked-server-frames rule,
  normalized `http://` origin ≤1, fresh `os.urandom(4)` mask note, exact
  Accept derivation, no full-image).
- §8 concurrency-model note (blocking `SocketChannel` on virtual threads;
  explicitly NOT non-blocking-selector async; JEP 444 terminology cited
  honestly) + OPEN instructor question (does VT-level concurrency satisfy
  "asynchronous server"? if `AsynchronousServerSocketChannel`/selector is
  required, transport revisits — everything above is transport-agnostic) +
  trusted-LAN/demo scope (loopback default, `--bind` opt-in, no-deadline
  limitation stated).
- §9 MEMORY ENVELOPE — two ledgers, never conflated. APPLICATION-MANAGED
  RETAINED memory (worst case: 40×512×512×4 B = 41,943,040 B = 40 MiB raw
  RGBA-equivalent bitmap pixels, plus browser/GPU overhead; + up to 12 MiB
  in-flight compressed (6×2 MiB) + 4 MiB queued compressed + per-tile
  overhead noted; `decodedBytes` measures payload bytes decoded, bitmap
  footprint is the envelope above). BROWSER/SOCKET TRANSIENT buffering
  (NOT application-managed): the JS decode queue only rejects excess work
  AFTER each WebSocket message is received, so a pathological LEGAL batch
  (30 planned tiles × 2 MiB max TILE) can transiently push up to 60 MiB
  compressed through the WS receive path (typical traffic is ~45–95 KiB /
  tile — the 60 MiB figure is the adversarial bound, stated honestly, not
  the operating point). Planning leans conservative to shrink that window
  (`planTileBytes = max(avgTileBytes, PLAN_FLOOR=65536)`) but the protocol
  does NOT bound UA socket buffering — §9 says so plainly instead of
  claiming "12 + 4 MiB compressed" as a system total.
- §10 refs (6455 incl. minimal-length rule, 9110/9112 incl. generic method,
  dzsave incl. `_files/` tree, transferTo position-invariance, ImageReader
  pre-decode dimensions, SocketChannel R/W, VT pinning, JEP 444, 101 thread).
  Verbatim dz-`onetile` cmd + `6455` + `9110`.
- Done when: has COMMIT + epoch + seen-rule + state diagram + no
  `queueEmpty`.

### TASK-002 — e2e_utp.py public-contract client

- Create `NEW scripts/e2e_utp.py` PUBLIC-CONTRACT ONLY (stdlib; TWO frame
  parsers with a direction split — `parse_server_frame(buf)` for the live
  path: REJECTS MASK=1 per RFC 6455 (server→client MUST be unmasked) +
  parses 2/4/10B incl. 64-bit + REJECTS non-minimal lengths (126-form <126,
  127-form <65536 → protocol error surfaced as exception), and a generic
  `parse_any_frame(buf)` kept for unit vectors; both importable by
  `test_e2e_parser.py`.
- Client send path: `os.urandom(4)` FRESH mask per frame — first `0x82`,
  second `0x80|len` (≤28B single-byte; no 126/127-send), 4B key, XOR; same
  for Ping/ABORT/COMMIT.
- Handshake offers `Sec-WebSocket-Protocol: ultratile.utp.v1` + fixed test
  key, then VERIFIES status 101 AND `Upgrade: websocket` AND `Connection:
  Upgrade` AND `Sec-WebSocket-Protocol` echo AND exact
  `Sec-WebSocket-Accept == base64(sha1(key + GUID))` computed locally (a 101
  without the correct Accept FAILS — v1.8 never checked).
- Send gen=1 as TWO same-REQ_ID 28B chunks (`>BBHBBHIIIII` with `lodMode=0`,
  len 28) + COMMIT 8B (`>BBHI`); read exactly ONE gen=1 TILE (24B: 512,
  `format==1`, reqId echo, `FFD8`) — then WITHOUT waiting for gen1 END
  switch local currentGen, send gen=2 chunks + COMMIT (+optional ABORT gen=1
  with CORRECT `(imageId,reqId)` pair, masked 8B); collect 5s: require gen2
  TILE + `0x04 gen=2`, require simulated-client accepts 0 gen=1 post-switch
  (buffered gen1 TCP bytes explicitly allowed/discarded), require Ping→Pong
  healthy. NEVER assert gen1 END, internal counters, or missing-file
  behavior.
- Done when: `python3 scripts/e2e_utp.py` prints
  `E2E-OK sealed superseded completed`.

### TASK-003 — Parser self-test with minimal-length vectors

- Create `NEW scripts/test_e2e_parser.py` (stdlib only, TEST-ONLY, offline —
  no server): import BOTH parsers from `e2e_utp.py`; `parse_server_frame`:
  126-form (200B) + 127-form (70000B, high-bit-clear) synthetic frames →
  exact payload recovery; MINIMAL-LENGTH vectors: 126-form encoding length
  124 → rejection; 127-form encoding length 1000 (<65536) → rejection;
  minimal-boundary 126-form length 126 + 127-form length 65536 → accepted
  HERE ONLY (this is the server→client parser, where large TILEs are
  legal — the client→server `WsFrameTest` MUST map well-formed-65536 to
  1009 per the phase-05 precedence rule; the v1.9 suite never pinned the
  RFC 6455 minimal-bytes rule); MASKED
  server-style frame → assert REJECTION; 64-bit high-bit-set length →
  rejection; truncated stream → clean need-more/exception (documented, no
  hang). `parse_any_frame`: masked client-style frame → unmasked recovery.
  Accept-derivation vector: fixed key → exact expected Accept string.
- Done when: `python3 scripts/test_e2e_parser.py` green offline.

### TASK-004 — Unit-side proofs + E2E-REPORT.md

- Unit-side proofs (no Python): `SessionTest` — v1.10 suite +
  COMMIT-liveness split + history-before-validation + no-evict/purge-on-stale
  + bad-9-resurrection + empty-sentinel + Close-frame codes
  (1002/1003/1007/1009) + three-way peer-Close echo incl. 4002-echo (no
  UTP semantics) and empty (never 1005) + cancel-first no-new-TILE
  during-transfer + closeSent/closed-split under throwing writer +
  positional-`2,0,0,0,0` + dedupe-at-cap + minimal-length +
  unified-empty-COMMIT (phase-05 TASK-004);
  `test_viewer.cjs` green (boot-order/no-packets-before-open/live-gallery/
  epoch-guarded-`selectImage`/imageSwitchSeq-races (resize/pan-during-fetch,
  latest-dims-pin-once)/A→B-race/
  no-double-bump/`newViewIntent`+deferred-intent/allocator-result-API
  (exhausted→reconnect-once)/4002-browser-close/
  wire-codec-vectors/complete-message-golden/TILE-length-equality/
  stale-TILE-discard-socket-OPEN/FORMAT-ordering/stale-END-discard/
  END-triple/END-identity-fatal/epoch-sets-suppression/retry→skip-union/
  netCov-stability/netCov-covCov/payloadLen-semantics/avg-reset/PLAN_FLOOR/
  conservative-budget +
  epoch-cleanup/requestable-again/rapid-double-bump, duplicate-TILE,
  BatchState-lifetime, `format=2`-as-unsupported, initial-camera,
  ownership/pending/retry/terminal/END-skipped/headroom/budget/
  expectedKeys/parity-consumed, pan+zoom eviction — phase-06);
  `check_const_parity.py` green (full map incl. JS, phase-06 TASK-004).
- Tracks: AUTHORITATIVE `./build.sh` (labeled; authoritative track has ZERO
  `mvn`, ZERO Python/Node/curl/rg) + OFFLINE VALIDATION `mvn -o` (labeled),
  readiness loop (loud-fail tails), live registry, 10x parallel E2E with
  PER-CHILD waits under `server_pid`/`child_pid` naming (TASK-005 block),
  `rg` (no hijack/byte[]-hot-path/
  single-shot-transferTo-without-fallback/`synchronized.*[Ww]rite`/
  `queueEmpty`/`QUEUE_CAP`/`PriorityQueue`/stale `kill %1`/
  `pid in \$pids` shadowing/`resources/\*`/hand-built `level-` paths outside
  the store), deterministic 4096 pan + zoom eviction + desired-vs-effective,
  2048 smoke-only.
- Write `NEW docs/protocol/E2E-REPORT.md` (<80 lines: verdict table, memory
  envelope §9 summary (40 MiB RGBA pixels + overhead + 12 MiB in-flight +
  4 MiB queued RETAINED vs up-to-60 MiB pathological TRANSIENT — the two
  ledgers, never a single total), manual-browser path on the authoritative
  track, zoom scenario, per-child 10x note, forbidden patterns: vacuous
  END-wait, internal-counter asserts, bare-`wait`, `pid`-shadowing,
  `head -N`-on-upgrade, `localhost`-connect-as-bind-proof).
- Done when: 10x green + all unit greens + report.

### TASK-005 — Two-track rehearsal

- Rehearsal, TWO TRACKS with the frozen names and memberships:
  - AUTHORITATIVE track (empty cache, JDK + standard Unix userland — the
    ONLY grader-assumable path): `./build.sh` + `java -cp` demos +
    `java -jar` start/stop + MANUAL browser smoke (open the page served by
    the JAR, pick images 0/1, pan/zoom; tiles + HUD update; no console
    errors). ZERO `mvn`, ZERO Python/Node/curl/rg (coreutils/`find`/
    `unzip`/`grep`/`seq`/`sleep`/`/dev/tcp` allowed — userland, not
    downloads).
  - OFFLINE VALIDATION track (primed cache + test tooling): `mvn -o -q test`
    + `node scripts/test_viewer.cjs` + `python3 scripts/test_e2e_parser.py`
    + `python3 scripts/check_const_parity.py` + live-server block green
    (routes + 101 via `ws_handshake_check.py` + `e2e_utp.py` + 10x parallel
    with per-child waits + `wait "$server_pid"` before the port-8080-free
    proof).
- Doc cites 6455/9110/9112-deviation/dz-onetile + 28B assert + async note +
  open instructor question + memory envelope; report PASS (pan `evicts>0`;
  zoom `effZ 3→1 → rxBytes↑ → close()d↑`; JVM `wait`ed before the
  port-8080-free proof after cleanup).
- Done when: all PASS on both tracks.

## Validation Commands

Offline validation track:

```sh
mvn -o -q test
node scripts/test_viewer.cjs
python3 scripts/test_e2e_parser.py
python3 scripts/check_const_parity.py
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,0,2,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,5,0,1))==8; assert len(struct.pack('>BBHI',0xAA,3,0,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,0,3,1,512,1,0,0,4))==24; assert len(struct.pack('>BBHIII',0xAA,4,0,1,4,0))==16; print('struct-ok')"
./build.sh
java -jar target/ultratile-1.0.jar & server_pid=$!; trap 'kill "$server_pid" 2>/dev/null || true' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$server_pid" 2>/dev/null || true; exit 1; }
python3 scripts/e2e_utp.py
child_pids=""; for i in 1 2 3 4 5 6 7 8 9 10; do python3 scripts/e2e_utp.py & child_pids="$child_pids $!"; done; rc=0; for child_pid in $child_pids; do wait "$child_pid" || rc=1; done; [ "$rc" = "0" ] || { echo "parallel E2E failed rc=$rc" >&2; kill "$server_pid" 2>/dev/null || true; exit 1; }
kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; trap - EXIT
python3 -c "import socket,sys; s=socket.socket(); s.settimeout(3); rc=s.connect_ex(('localhost',8080)); s.close(); sys.exit(0 if rc!=0 else 1)" || { echo "port 8080 still bound — server leaked" >&2; exit 1; }
```

Authoritative track (JDK + standard Unix userland + manual browser ONLY):

```sh
./build.sh
java -cp target/classes com.ultratile.tiles.IngestTool 0 2048 2048
java -cp target/classes com.ultratile.tiles.IngestTool 1 4096 4096
java -jar target/ultratile-1.0.jar & server_pid=$!; trap 'kill "$server_pid" 2>/dev/null || true' EXIT
```

(Open `http://localhost:8080/` in a browser: pick images, pan/zoom, confirm tiles + HUD.)

```sh
kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; trap - EXIT
```

## Notes for Implementer

- Split discipline enforced: Python = observable wire (subprotocol + exact
  Accept, fresh-masked, chunked+COMMIT, one-tile-then-switch, gen2 TILE+END,
  healthy conn, masked-server + non-minimal-length rejection live); 127-form
  = offline synthetic parser test (never compressibility luck); Java +
  `test_viewer.cjs` + parity = internal state (seen-poisoning, three-way
  COMMIT via the unified dispatcher path, empty-sentinel, COMMIT-liveness,
  history-before-validation, coalescing (getAndSet permits + newest-only),
  lock-admission (no-TILE-after-Close), teardown/wakeup,
  failSession-Close-codes(1002/1003/1007/1009 + reason-cap),
  explicit Close validator, three-way peer-Close echo
  (incl. 4002/no-semantics/empty/no-new-TILE), closeSent/closed-split,
  incremental-1KiB-cap, stale-vs-invalid,
  no-evict rejected set, boot/no-packets-before-open/imageSwitchSeq/
  deferred-intent/epoch-guarded-`selectImage`/A→B-race/
  no-double-bump/4002-browser-close/allocator-result/`newViewIntent`/
  ownership/epoch-cleanup/epoch-sets/union-netCov/PLAN_FLOOR/
  headroom/BatchState/expectedKeys/receivedKeys/
  TILE-length-equality/complete-message-golden/
  stale-TILE-discard-OPEN/stale-END-discard/netCov-stability/netCov-covCov/
  wire-codec, pan+zoom eviction). Forbidden
  patterns stay named in the report.
- Self-containedness graded: build (`./build.sh`), start (`server_pid=$!`
  own line + idempotent trap), wait (loud readiness, short sleeps between
  probes only — polling, never blind startup timing), test,
  per-child parallel accounting under `child_pid` (the v1.8
  `for pid in $pids` SHADOWED the server PID and `kill "$pid"` murdered a
  Python child instead of the server — never reuse `pid`), `wait` for JVM
  termination BEFORE the port-free proof (the v1.9 immediate probe raced a
  dying server), port-free proof, clean up.
- Track honesty is load-bearing for grading: the authoritative track is what
  a disconnected grader with only a JDK can run. Every scripted assertion
  (curl/Python/Node/Maven/rg) lives in the offline validation track by
  construction — grep the rehearsal for `python3|node |curl|mvn |rg ` and
  every hit must be under an "Offline validation track" heading.
- 512 JPEGs routinely exceed 65535B → receive path MUST implement 127-form;
  send path stays single-byte (max 28B client frame). The parser test pins
  the 127-branch even when demo JPEGs stay small.
- The protocol document is 35% of the grade: diagrams and state tables over
  line-count squeezing. `UTP-1.0.md` is normative; `UTP_SPEC.md` is a
  pointer. If they ever disagree, `UTP-1.0.md` wins — say so in both files.
