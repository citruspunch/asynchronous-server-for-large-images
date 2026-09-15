---
goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
version: 1.8
date_created: 2026-09-15
last_updated: 2026-09-15
status: 'Planned'
tags: [feature, ultratile, java21, tiling, websocket, offline]
plan_type: split
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Build UltraTile end-to-end from empty repo (`README.md:1`, `project_instructions.md:1-94`). JDK-only Java 21 `ServerSocketChannel` server (reader VT + dispatcher VT per WS session, `WsWriter` on `ReentrantLock` with `writeFully`, `transferTile` declaring `24+fileSize`, mid-frame failure fatal) serves frontend over a strict GET-only HTTP/1.1 subset (multi-value header map, absolute-form authority MUST equal Host, globally bodyless, duplicate `Content-Length` always 400) and padded 512x512 JPEG tiles over sealed-generation UTP/1.0 on RFC 6455. Generation history is monotonic `lastReqIdSeen`, advanced ONLY on accepted new generations (first valid chunk, or valid empty COMMIT — even when an older active state still exists); same-gen chunks, matching COMMITs, ABORTs, rejects never advance it. COMMIT builds the immutable `work` list off-queue, attaches it, seals last, then publishes ONE coalesced ready slot (`AtomicReference` + ≤1 permit — supersession replaces a stale token, never an unbounded FIFO). The dispatcher walks `work` with a dispatcher-local `nextIndex`; END iff `nextIndex==work.size() && inFlight==0`. u32 wire fields parse to `long` with `min<=max`, image bounds, and `long` span math. Client owns each coordinate through needed → pending-network → received → cached, with `retryNeeded` (pending removed at receipt) and epoch-scoped `terminalFailed` branches; `BatchState{reqId,epoch,imageId,zoom,expectedKeys,…}` enforces membership on every TILE/END; batches and retries are decoder-headroom-gated with dynamic sizing. Demos via atomic `.ready` publish with stale-tmp recovery and strict bounded `meta.json` parsing (`id==dir`, canonical names); live rescan, no restart. Node is test-only tooling; the app never needs it. Offline grading. Whether VT-based concurrency satisfies the "asynchronous server" wording needs instructor confirmation (ASSUMPTION-004).

## 1. Requirements & Constraints

- **REQ-001**: Java 20/21 async server serves ultra-high-resolution images with progressive/selective loading via 512x512 tiling (ceiling pyramid, post-padded edges, clear-then-clip compositing); never serves full ultra-res image.
- **REQ-002**: Per WS session one reader VT + one dispatcher VT; one serialized `WsWriter` (`ReentrantLock`; reader may call `writeControl` under it); blocking-on-VT model (NOT selector async; report states plainly). Visibility: `AtomicReference<GenerationState> active`, `AtomicLong lastReqIdSeen` (reader-updated ONLY on accepted new generation: first valid chunk of a newer REQ_ID, or valid empty COMMIT even with an older active present — same-gen chunks, matching COMMITs, ABORTs, rejects never advance; anything below it is stale unless the active generation's allowed continuation), `volatile` sealed/canceled, `AtomicBoolean` closed, atomic tile-channel ref, idempotent cleanup; dispatcher owns `sent/skipped/inFlight` + local `nextIndex`; requested set reader-owned pre-seal. Active-clearing (frozen): dispatcher CAS-clears `active` iff still its state after sending END; reader CAS-clears iff still the ABORT-matched state; supersede overwrites. Close coordination as v1.6; I/O/EOF aborts immediately. No deadlines by design.
- **REQ-003**: Strict HTTP/1.1 subset: GET-only (`405` + `Allow: GET`), origin-form + absolute-form (normalized authority MUST equal the single Host value else 400 — no silent discard, no RFC replacement), exactly-one valid Host, headers stored as `Map<String,List<String>>` (multiplicity preserved; duplicates detected before collapsing — never a lossy single-value map), globally bodyless (any `Transfer-Encoding` →400 on ALL routes; any `Content-Length` ≠0 →400; DUPLICATE `Content-Length` →400 even when values agree; single `Content-Length: 0` allowed, no body follows), `writeFully`/`readFully`, leftover bytes only after bodyless valid upgrade (else close+discard — no pipelining); UTP/1.0 over RFC 6455 documented.
- **REQ-004**: Frontend locally served, offline; `resizeCanvas()` DPR=1 first; drag/wheel pointer-anchored within scales + `isFinite` + capture/`pointercancel`; immediate cached render + debounced network intent (new `viewEpoch` per intent). Node (`node --check`, `test_viewer.cjs`) is TEST-ONLY tooling: the shipped app (Java + static JS, no build step) never requires Node; E2E/manual validation paths without Node are documented in the report.
- **REQ-005**: LOD frozen (`zFloat`, clamp, ceil/floor/frac≥0.5); `effectiveLOD` per-Z recompute, union ≤36; HUD desired-vs-effective; clear-then-clip full-bitmap compositing.
- **REQ-006**: LRU-40; Z0 pinned; intermediates opportunistic; decode ≤6 in-flight + queue jobs≤24 AND bytes≤4MiB (distinct names); per-intent `viewEpoch`: ≤30-tile batches share one epoch; wire→visual bridge is explicit `BatchState{reqId,epoch,imageId,zoom,expectedKeys:Set,networkComplete,canceled}` retained for the active epoch PLUS recently canceled REQ_IDs (bounded: current intent's batches + last superseded intent) so buffered stale frames classify deterministically; every received TILE's `(image,z,x,y)` MUST be a member of its `BatchState.expectedKeys` with matching image/zoom else discard+counter; END's imageId must match the batch. Coordinate ownership (frozen): needed → pending-network (sent, in expectedKeys) → received/decode-owned → cached; TILE receipt REMOVES the pending marker immediately; capacity-overflow at admission → `retryNeeded` (reschedule clears the marker, key returns to pending under a later same-epoch gen); JPEG decode rejection → epoch-scoped `terminalFailed`, INCLUDED in suppression for that epoch (never re-requested); network END resolves never-received expected keys as server-skipped (pending removed, never retried). Decode accepted iff mapped epoch === currentViewEpoch. No network batch (fresh or retry) is sent without real headroom: `inflight<MAX_DECODE && queueJobs<DQ_JOBS && freeBytes>=MAX_TILE_BYTES`; batch size is dynamically budgeted `min(BATCH_CAP, freeJobSlots, max(1,floor(freeBytes/avgTileBytes)))` with `avgTileBytes` = running mean of received TILE lens (seed 128KiB) — `0x04` END means network done, never decoder-ready. `rxBytes` increments on every valid TILE receipt (transfer proof); `decodedBytes`/`usefulBytes` track post-decode value separately. `networkComplete` vs `coverageComplete` split stands.
- **REQ-007**: UTP/1.0 big-endian MAGIC `0xAA`, TILE_SIZE `512`, LOD `0/1/2`, FORMAT jpeg/webp; REQ_ID u32 no-wrap (reconnect before max; never reset on image switch, 1 only on new WS): `0x01` 28B `>BBHBBHIIIII` (freeze/mismatch-invalid/post-seal-rejected); `0x05` 8B `>BBHI` (seal; three-way COMMIT: matches-active → seal normally; else valid strictly-newer REQ_ID with no chunks → cancel/supersede previous if present, install sealed-EMPTY as active, advance seen, END 0/0 — REGARDLESS of any older active object incl. post-ABORT canceled states; else stale/invalid); `0x03` 8B `>BBHI` (cancel needs matching `(imageId,reqId)` — wrong-image ABORT ignored/rejected and never touches `lastReqIdSeen`; terminal, no END); `0x02` 24B `>BBHBBHIIII` (LEN u32 + ≤`MAX_TILE_BYTES`); `0x04` 16B `>BBHIII` (sealed/non-canceled/active/empty/inflight0 only). Span≤128/packet; unique set ≤`GEN_TILE_CAP=256` pre-insert reject; validate-before-supersede (newer→mark-old-canceled-then-supersede + advance `lastReqIdSeen` ONLY on acceptance; ==→append+dedupe; older→ignore).
- **REQ-008**: dz/onetile import + direct n→Z + post-pad + tmp/validate/`.ready`/atomic-rename (immutable after); import START handles a leftover `.tmp-<id>` (crash recovery: quarantine to `.stale-tmp-<id>-<unique>/` or remove after logging — never reuse blindly, never block forever); CLI IDs decimal `0..65535` pre-path, all args quoted; ready target → no-op; non-ready numeric dir → `.stale-<id>-<epoch>/` quarantine; ignore `.tmp-*`/`.stale-*`. Synthetic fallback bounded O(tile-size), crop-then-downsample-then-pad-output; writers emit canonical `"name":"image-<id>"` (never interpolate source paths into JSON). Metadata: tiny STRICT hand parser for the exact generated `meta.json` schema, bounded by `META_MAX_BYTES=16KiB` pre-read + `META_NAME_MAX=128` (oversize → ignore + WARNING before parsing; JDK has no general JSON parser); a `.ready` dir with malformed/inconsistent metadata is ignored with WARNING (never 500); `levels` must equal PAT-001 `levelCount(w,h)` AND `meta.id` must equal the numeric directory id. Startup auto-generates demos if no `.ready`; trust `.ready` only.
- **REQ-009**: Dispatch on sealed READY SLOT (coalescing, never a FIFO): COMMIT builds/sorts the complete immutable `work: List<TileReq>` OFF-queue, attaches it to the state, publishes `sealed=true` last, then `readySlot.set(state)` + release the single permit iff none outstanding (a newer COMMIT replaces a stale not-yet-consumed token — at most one retained generation; dispatcher `permit.acquire()` → `getAndSet(null)` → skip-null → dispatch; a consumed-but-superseded state fails its per-tile 3-point checks and emits nothing); per-`GenerationState` 3-point checks; `transferTile` WS `24+fileSize` + `writeFully` + loop; size gate pre-frame; SKIPPED pre-frame only; post-start fatal; `0x04` additionally requires `active.get()==state` AND dispatcher-local `nextIndex==work.size()` AND `inFlight==0` (no `queueEmpty` concept — there is no tile queue). u32 discipline everywhere: `Integer.toUnsignedLong(...)` on receipt, explicit `min<=max`, image-specific coordinate bounds, widths/spans in `long` (vectors: `0xffffffff`, reversed min/max, span-product overflow).
- **SEC-001**: Validate id/Z/coords/`TILE_SIZE==512`/LOD/span/`GEN_TILE_CAP`/u32-shape (see REQ-009); client subtracts cached∪pending∪decode-queued∪in-flight∪terminalFailed(epoch), same-Z row-runs, dynamically-budgeted batches, COMMIT; server dedupes; no dispatch queue exists (immutable work list + coalesced ready slot — the old priority-queue backstop is removed).
- **SEC-002**: `0.0.0.0:8080`; normalized `http://` Origin vs `Host` (absent allowed); `/ws` bodyless-only (as are all routes); 1 KiB cap (1009/1002/1003); version-mismatch 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
- **CON-001**: Java 21, Maven (exact pins) + `build.sh` (bash, `set -euo pipefail`, cleans classes, empty-safe copy, JDK-only; committed executable).
- **CON-002**: `Config` single source: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `GEN_TILE_CAP=256`, `SPAN_CAP=128`, `BATCH_CAP=30`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `META_MAX_BYTES=16384`, `META_NAME_MAX=128`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`; demos id0 2048 (21) + id1 4096 (85); live rescan per call, no restart. Node is NOT a runtime dep (test-only). (`QUEUE_CAP` removed v1.8 — no queue exists.)
- **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
- **GUD-001**: `Cache-Control` split; FINE logs (redirectable); HUD/E2E bytes(active-Z/reqs/evicts/decodes, with `rxBytes` vs `decodedBytes` split) prove transfer+eviction.
- **PAT-001**: `N=max(0,ceil(log2(max/512)))`, `W_Z=ceildiv(W,2^(N-Z))` min 1, `C_Z=ceildiv(W_Z,512)`; dz/onetile matches; n=0 smallest direct map.
- **PAT-002**: `screenX=Vw/2+s*(worldX-camX)` (+Y); cam = viewport-center world point.
- **PAT-003**: Half-open + empty-range: intersect native `[cam-Vw/2s,cam+Vw/2s)` with `[0,W)`, empty→no request; scale `2^(Z-N)`; `minTile=floor(min/512)`, `maxTile=min(C-1,ceil(max/512)-1)`.
- **PAT-004**: Screen-space clear FIRST, then world transform, clip `[0,W)×[0,H)`, full padded 512 bitmaps at `512*2^(N-z)` footprints (never crop-stretch); fine overlays coarse.

## 2. Phase Index

| Phase | File | Goal | Status |
| ----- | ---- | ---- | ------ |
| 01 | ./phase-01-project-scaffolding.md | GOAL-001: Exact-pin Maven + robust build.sh + compilable stub | Planned |
| 02 | ./phase-02-tile-engine.md | GOAL-002: Ceiling store + validated import + strict meta + 106-tile demos | Planned |
| 03 | ./phase-03-utp-codec.md | GOAL-003: Sealed-generation codec 28B/8B/8B/24B/16B round-trips | Planned |
| 04 | ./phase-04-http-bootstrap.md | GOAL-004: Strict GET-only multi-value-header HTTP + live metadata | Planned |
| 05 | ./phase-05-concurrency-sessions.md | GOAL-005: Coalesced-slot sessions + u32 discipline + seen-rule | Planned |
| 06 | ./phase-06-viewer-frontend.md | GOAL-006: Ownership-machine viewer + headroom batches + unit tests | Planned |
| 07 | ./phase-07-protocol-doc-e2e.md | GOAL-007: Sealed-lifecycle doc + contract/unit-split E2E | Planned |

## 3. Alternatives

- **ALT-001**: `HttpServer` hijack — rejected BLOCKER, no 101/raw-socket API in Java 21.
- **ALT-002**: IIIF-only — rejected, no custom protocol.
- **ALT-003**: CDN framework — rejected, offline violation.
- **ALT-004**: 256px/120-cache — rejected, 4x index + dispatch cost.
- **ALT-005**: Jetty/Netty — rejected, hides handler + offline risk.
- **ALT-006**: google-layout vips source — rejected BLOCKER: pre-expands canvas; dz + post-pad preserves PAT-001.
- **ALT-007**: Paging oversized viewports through M=40 — rejected: 77-tile frame cannot co-reside in 40; effective-LOD downgrade instead.

## 4. Dependencies

- **DEP-001**: Phase 02 requires phase 01 pins + `Config` + stub + `build.sh` + ready convention.
- **DEP-002**: Phase 03 requires phase 01 layout only.
- **DEP-003**: Phase 04 requires phases 01 + 02 (`ImageRegistry`, `.ready` demos).
- **DEP-004**: Phase 05 requires 02 (channel API, padded store) + 03 (codecs) + 04 (HTTP parser/router it extends).
- **DEP-005**: Phase 06 requires 04 (picker/info routes) + 03 (sealed layouts).
- **DEP-006**: Phase 07 requires all prior.

## 5. Files

- **FILE-001**: `NEW pom.xml` — exact plugin versions + manifest.
- **FILE-002**: `NEW build.sh` — bash, `set -euo pipefail`, cleans classes, empty-safe copy, executable bit committed.
- **FILE-003**: `NEW src/main/java/com/ultratile/net/NioHttpServer.java` — multi-value headers + GET-only + absolute-authority==Host + global bodyless + leftover policy.
- **FILE-004**: `NEW src/main/java/com/ultratile/proto/UtpCodec.java` — `TileHeader` (gated LEN) + `ViewportCommit` + `0x04` + u32 discipline.
- **FILE-005**: `NEW src/main/java/com/ultratile/tiles/PyramidTileStore.java` — ceiling + channel API + size gate.
- **FILE-006**: `NEW scripts/import_vips.sh` — validated IDs, dz/onetile + post-pad + atomic publish + idempotent no-op + tmp recovery, executable bit committed.
- **FILE-007**: `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `WsWriter.java` (`ReentrantLock` + `writeFully`) + `SessionCoordinator.java` (`GenerationState` + work list, `lastReqIdSeen`, coalesced ready slot).
- **FILE-008**: `NEW src/main/resources/web/viewer.js` — viewEpoch + `BatchState` + ownership machine + headroom-budgeted batches + compositing (exposes `globalThis.UltraTile`).
- **FILE-009**: `NEW docs/protocol/UTP-1.0.md` — sealed-lifecycle doc.
- **FILE-010**: `NEW scripts/test_viewer.cjs` — `node:vm` unit tests (test-only; app Node-free).
- **FILE-011**: `NEW scripts/test_e2e_parser.py` — stdlib synthetic 126/127-form WS parser self-test (test-only).
- Verified ground truth: v1.7 plans (`overview.md:1-104`, `phase-01:1-48`, `phase-02:1-49`, `phase-03:1-41`, `phase-04:1-52`, `phase-05:1-48`, `phase-06:1-52`, `phase-07:1-51`); impl files `NEW`.

## 6. Testing

- **TEST-001**: `mvn -o -q test` + `./build.sh` + `node scripts/test_viewer.cjs` + `python3 scripts/test_e2e_parser.py` green (codec incl. `0x05`/LEN-gate/LOD/u32 vectors, ceiling, GenerationState seal-slot/empty-newer-after-active/after-ABORT/active-clear/duplicate-COMMIT-stale/mismatch/cap/seen-rule/poisoning/supersede-cancel/no-END/coalescing, writer serialization + `writeFully`, transferTo `2,0,2` + partial + fatal-after-start, WS matrix incl. version-advertise, half-open/empty, no-wrap, viewer ownership/pending/retry/terminal/END-skipped/headroom/budget/expectedKeys/epoch/BatchState/rxBytes, meta id-equality/bounds).
- **TEST-002**: `curl` static/info (+405 non-GET); live registry; readiness loops FAIL LOUD on budget exhaustion (`ready` flag / nonzero helper — no silent fall-through to `kill`); absolute-form match→200 AND authority≠Host→400 AND duplicate-Host→400 AND TE/CL:1→400 probes, every raw probe piped to an asserting `grep` (printing is not proving); split-line lifecycle (no AND-list backgrounding, no fixed sleeps).
- **TEST-003**: E2E contract only — fresh `os.urandom(4)` mask per frame (`0x82`, `0x80|len`, XOR; no 126/127-send), chunks + COMMIT, one gen1 tile THEN switch (never wait gen1 END), buffered gen1 tolerated, gen2 TILE + `0x04`, Ping→Pong, 2/4/10 + 64-bit parse (127-form proven by the offline parser self-test, not by JPEG compressibility); cancel/missing/validation in unit tests.
- **TEST-004**: Offline; LRU≤40, inflight≤6, decodeQ jobs≤24 + bytes≤4MiB; deterministic 4096 scenarios: (a) serpentine Z3 sweep (1024x768 DPR=1, 8x5 centers step 512 → 64 unique keys >40) asserts `evicts>0`; (b) zoom transition 3→1 at cam (2048,2048) asserts effZ change + `rxBytes↑` + old-bitmap `close()`d/`evicts↑`; desired-vs-effective shown; 2048 smoke-only. Node absence must not block app use: report documents the no-Node manual/E2E path. 10x parallel E2E waits EACH pid (`wait "$pid" || rc=1`) and asserts `rc==0` — bare `wait` is not proof.

## 7. Risks & Assumptions

- **RISK-001**: Custom Nio subset; mitigation: multi-value headers + strict validation + golden vectors + single `ReentrantLock` writer + caps, isolate `net/`.
- **RISK-002**: No gigapixel asset; mitigation: auto 2048/4096 + `import_vips.sh` dz/onetile + post-pad.
- **RISK-003**: WS state machine; mitigation: frag/close/size/code/version matrix tests.
- **RISK-004**: 512px ~45-95 KB (64-bit WS form common), 4K HQ ~77; mitigation: 128 cap + GEN_TILE_CAP + sealed chunks + center-first + effective LOD + Z0 fallback + headroom-budgeted epoch batches + retryable overflow + in-flight suppression.
- **RISK-005**: No send/header/deadline handling by design; mitigation: documented scope limitation (local grading harness, `0.0.0.0` noted).
- **ASSUMPTION-001**: `build.sh` is the clean-machine JDK-only build; Maven offline works only after plugins/deps are primed — needs confirmation whether the grader mandates Maven from a fresh cache, and of port 8080.
- **ASSUMPTION-002**: `libvips` absent on grader — needs confirmation; default needs no vips.
- **ASSUMPTION-003**: Node available for JS tests — TEST-ONLY; needs confirmation, else the documented no-Node path applies (app itself never needs Node).
- **ASSUMPTION-004**: Java-21-virtual-thread concurrency (blocking `SocketChannel` I/O on VTs) satisfies the assignment's "asynchronous server" wording at application level — needs instructor confirmation; if `AsynchronousServerSocketChannel`/selector async is explicitly required, the transport architecture needs revisiting (protocol + plans above are transport-agnostic and survive).

## 8. Related Specifications / Further Reading

- RFC 6455 (fresh mask per frame, frag/control, 2/4/10 headers, codes 1002/1003/1009, version advertise); RFC 9110/9112 (GET/405, Host multiplicity, absolute-form authority, body rules); libvips dzsave (`dz` vs google, `onetile` vs `one`, n=0 smallest, `--skip-blanks -1`); `FileChannel.transferTo` short-transfer + loop; `SocketChannel` one-reader/one-writer + partial writes; Java 21 virtual-thread pinning (`ReentrantLock` over monitors for I/O).
