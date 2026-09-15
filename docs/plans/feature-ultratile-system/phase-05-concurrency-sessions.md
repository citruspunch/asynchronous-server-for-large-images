---
phase: phase-05-concurrency-sessions
goal: GOAL-005 Token-gated sessions plus u32 discipline plus seen-rule
status: 'Planned'
parent: ./overview.md
version: 1.7
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 05 — Concurrency Sessions ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: One reader VT + one dispatcher VT per WS session; one serialized `WsWriter` on `ReentrantLock` (reader may call `writeControl` under it); `AtomicReference` active + `AtomicLong lastReqIdSeen` (advances ONLY on accepted new generation) + `volatile` sealed/canceled + `AtomicBoolean` closed + atomic tile-channel ref + idempotent cleanup; coordinated Close; immediate I/O/EOF abort; no deadlines by design.
  - **REQ-009**: COMMIT builds the COMPLETE immutable center-first set OFF-queue FIRST, attaches it, publishes `sealed=true` last, then enqueues ONE ready token + signals (dispatcher dequeues tokens, never scans; empty COMMIT → sealed-empty + END 0/0); supersede marks old canceled first + END requires `active.get()==state`; 3-point checks; `transferTile` WS `24+fileSize` + `writeFully` + loop; size gate pre-frame; SKIPPED pre-frame only, post-start fatal; `0x04` iff sealed && !canceled && active && empty && inFlight==0; browser owns corrupt verdict.
  - **SEC-002**: `0.0.0.0:8080`; normalized `http://` Origin vs `Host` (absent allowed); `/ws` bodyless-only; priority queue defensive backstop (accepted sets fit by `GEN_TILE_CAP`); 1 KiB cap (1009/1002/1003); version-mismatch 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
- Prior-phase deps:
  - **DEP-004**: Requires 02 (channel API, padded store, size gate, strict meta) + 03 (codecs, u32 discipline, freeze) + 04 (multi-value-header HTTP parser/router this branch extends).
- Inputs: Nio stub + sealed codec + store + strict HTTP. Outputs: token-gated sealed sessions with poisoning-proof history.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `NEW WsWriter.java` + WS branch: handshake (`GET` re-asserted; HTTP/1.1, one valid Host from `Map<String,List<String>>`, `Connection`∋upgrade ci, `Upgrade==websocket` ci, `Version==13` else 400 WITH `Sec-WebSocket-Version: 13`, Key=Base64-16B else 400; Origin absent→allow else normalized-`http://`-authority==Host else 403; TE/any-CL≠0/conflicts→400; leftover kept only after bodyless valid upgrade) →101 + Accept. `WsFrame`: masked-required→1002; RSV≠0→1002; opcode ∈{0x0,0x1,0x2,0x8,0x9,0xA} else 1002; control FIN==1&&len≤125 else 1002; reassembly (continuation w/o open→1002; second data opcode mid-frag→1002; cumulative frag>1KiB→1009; Close len==1→1002; bad Close code/reason→1002/1007); 64-bit high-bit→1002; text(valid)→1003 downstream; Ping→Pong; server headers exactly 2/4/10B. `WsWriter` (one/session, `ReentrantLock writeLock`): `writeFully(ByteBuffer)` primitive; `writeBinary`, `writeControl`, `transferTile(TileHeader,FileChannel,size)` = WS header len `24+size` + 24B UTP + looped `transferTo`, ALL under one lock hold; reader VT may call `writeControl` under the same lock (at most one writer at a time). Ownership: accept→reader VT; 101→spawn dispatcher VT dequeuing READY TOKENS (never scanning states); received Close→stop app work, lock-coordinate writer, emit reply, teardown once (`AtomicBoolean closed`, atomic open-channel ref nulled on close, idempotent); I/O/EOF→abort/close immediately. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/ws/SessionCoordinator.java` around `GenerationState{reqId,imageId,zoom,lodMode,requested:LinkedHashSet<String>,sent,skipped,sealed(volatile),canceled(volatile),inFlight}` + `TileReq{state,x,y}`; session: `AtomicReference<GenerationState> active` (nullable) + `AtomicLong lastReqIdSeen` (0) + ready-token queue (dispatcher blocks on it). FROZEN seen-rule (anti-poisoning): advance `lastReqIdSeen` to `reqId` ONLY when (a) the first valid chunk of a strictly newer generation is ACCEPTED (fully validated, state installed), or (b) a valid empty COMMIT is ACCEPTED (sealed-empty installed); same-generation chunks, matching COMMITs, ABORTs (any `ABORT_REQ_ID`, incl. future), and ALL rejects/invalids NEVER advance it; `reqId≤lastReqIdSeen` with no matching active continuation → ignore-stale. `onViewportChunk(v)`: parse u32→`long` (`toUnsignedLong`), FULL-validate (incl. `min≤max`, image bounds, span in `long`, GEN_TILE_CAP pre-insert); `reqId==active` append-case (metadata-match else invalid WARNING; `!sealed` else rejected-after-seal; dedupe) does NOT advance seen; `reqId>lastReqIdSeen` newer-case validates completely THEN marks previous `canceled=true` FIRST, installs state, advances seen, clears queue; else ignore. `onCommit(imageId,reqId)`: matches active → BUILD complete immutable ordered set OFF-queue, attach, `sealed=true` LAST, enqueue ONE ready token + signal (dispatcher cannot observe sealed-but-unbuilt — v1.6 `BlockingQueue`-wakeup race fixed by construction); NO active state but valid image + `reqId>lastReqIdSeen` → sealed-EMPTY + immediate END 0/0 + advance seen; else WARNING (never advances). `onAbort(imageId,abortReqId)`: require `(imageId,abortReqId)` to match a KNOWN state (active or in-flight-referenced) else ignore WARNING (wrong-image ABORT never advances seen, never touches active); match → `canceled=true` + drop its queued reqs (terminal; never END). `dispatchLoop`: take READY TOKEN → resolve state → transmit its immutable set center-first with 3-point active+!canceled checks; pre-frame gates (missing/unreadable/size/marker →SKIPPED); `writer.transferTile` (post-start→teardown); `sent++`; `0x04` iff sealed && !canceled && `active.get()==state` && queueEmpty && inFlight==0. | TASK-001 | `mvn -q compile` passes |  |  |
| TASK-003 | Wire `NioHttpServer` WS read-loop: reassembled binary `AA 01`→28B chunk; `AA 05`→8B commit; `AA 03`→8B abort; `AA` bad len→1002; semantic error→WARNING keep-alive; text→1003; oversize→1009. FINE logs. `sameOriginHttp` normalized helper. | TASK-002 | handshake `curl`→101 |  |  |
| TASK-004 | Create `NEW src/test/java/com/ultratile/ws/SessionTest.java` + `WsFrameTest.java`: chunk-append+dedupe, post-seal reject, mismatch invalid, validate-before-supersede, newer-marks-old-canceled + active-guard (no old END at aligned counts), seen-rule suite (invalid-newer `reqId=100` bad-coords does NOT advance: later valid `reqId=2` still accepted; future-ABORT `reqId=99` does NOT advance: valid `reqId=3` accepted; same-gen chunks/COMMIT do not advance; active-cleared simulation still rejects below-seen), empty-COMMIT END 0/0, cap-reject at 257th key, no-normal-eviction accounting, abort(image-mismatch)→ignored + seen untouched, abort→canceled + 3-point fail + NO END, token-gating (dispatch emits NOTHING before COMMIT token even with queued chunks; sealed ⇒ fully-enqueued: token observed only with queue size == requested size), `transferTo` `2,0,2` zero-retry + partial + fatal-after-start teardown, `ReentrantLock` serialization incl. reader-called control, `writeFully` partial mock, full WS matrix (frag/Close-1/bad-code/UTF-8/version-advertise/size-codes incl. duplicate-`Host`→400 via multi-value map), headers ∈{2,4,10}, `0x04` rule incl. size-gate SKIPPED. | TASK-002 | `mvn -q test` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=SessionTest,WsFrameTest,UtpCodecTest,TileMathTest
mvn -o -q clean package -DskipTests
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$pid"; exit 1; }
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | head -8
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 12" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | grep -i "Sec-WebSocket-Version: 13"
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Token-gating replaces occupancy-scanning: the ONLY dispatch trigger is a ready token for a fully-built sealed set. `sealed=true` ordering still holds AND is now insufficient-by-itself by design (belt and suspenders, tested).
- Seen-rule summary: accept-new-generation advances; everything else never does. ABORT is history-neutral.
