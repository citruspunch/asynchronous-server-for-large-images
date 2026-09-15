---
phase: phase-05-concurrency-sessions
goal: GOAL-005 Ordered-COMMIT sessions plus transferTile plus visibility
status: 'Planned'
parent: ./overview.md
version: 1.6
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 05 — Concurrency Sessions ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: One reader VT + one dispatcher VT per WS session; one serialized `WsWriter` on `ReentrantLock` (reader may call `writeControl` under it); `AtomicReference` active + `AtomicLong lastReqIdSeen` + `volatile` sealed/canceled + `AtomicBoolean` closed + atomic tile-channel ref + idempotent cleanup; coordinated Close; immediate I/O/EOF abort; no deadlines by design.
  - **REQ-009**: COMMIT builds the COMPLETE immutable center-first set FIRST, then publishes `sealed=true` last + signals dispatcher (empty COMMIT → sealed-empty + END 0/0); supersede marks old canceled first + END additionally requires `active.get()==state`; 3-point checks; `transferTile` WS `24+fileSize` + `writeFully` + loop; size gate pre-frame; SKIPPED pre-frame only, post-start fatal; `0x04` iff sealed && !canceled && active && empty && inFlight==0; browser owns corrupt verdict.
  - **SEC-002**: `0.0.0.0:8080`; normalized `http://` Origin vs `Host` (absent allowed); `/ws` bodyless-only; priority queue defensive backstop (accepted sets fit by `GEN_TILE_CAP`); 1 KiB cap (1009/1002/1003); version-mismatch 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
- Prior-phase deps:
  - **DEP-004**: Requires 02 (channel API, padded store, size gate) + 03 (codecs, freeze, LEN gate) + 04 (HTTP parser/router this branch extends).
- Inputs: Nio stub + sealed codec + store + strict HTTP. Outputs: ordered sealed sessions with correct framing and visibility.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `NEW WsWriter.java` + WS branch: handshake (`GET` already gated phase-04, re-assert; HTTP/1.1, one valid Host, `Connection`∋upgrade ci, `Upgrade==websocket` ci, `Version==13` else 400 WITH `Sec-WebSocket-Version: 13`, Key=Base64-16B else 400; Origin absent→allow else normalized-`http://`-authority==Host else 403; TE/any-CL≠0/conflicts→400; leftover kept only after bodyless valid upgrade) →101 + Accept. `WsFrame`: masked-required→1002; RSV≠0→1002; opcode ∈{0x0,0x1,0x2,0x8,0x9,0xA} else 1002; control FIN==1&&len≤125 else 1002; reassembly (continuation w/o open→1002; second data opcode mid-frag→1002; cumulative frag>1KiB→1009; Close len==1→1002; bad Close code/reason→1002/1007); 64-bit high-bit→1002; text(valid)→1003 downstream; Ping→Pong; server headers exactly 2/4/10B. `WsWriter` (one/session, `ReentrantLock writeLock`): `writeFully(ByteBuffer)` primitive; `writeBinary`, `writeControl`, `transferTile(TileHeader,FileChannel,size)` = WS header len `24+size` + 24B UTP + looped `transferTo`, ALL under one lock hold; reader VT may call `writeControl` under the same lock (at most one writer at a time — frozen relaxed claim, no separate control queue). Ownership: accept→reader VT; 101→spawn dispatcher VT; received Close→stop app work, lock-coordinate writer, emit reply, teardown once (`AtomicBoolean closed`, atomic open-channel ref nulled on close, idempotent); I/O/EOF→abort/close immediately. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/ws/SessionCoordinator.java` around `GenerationState{reqId,imageId,zoom,lodMode,requested:LinkedHashSet<String>,sent,skipped,sealed(volatile),canceled(volatile),inFlight}` + `TileReq{state,x,y}`; session: `AtomicReference<GenerationState> active` (nullable) + `AtomicLong lastReqIdSeen` (0; updated by reader on every structurally valid chunk/commit/abort — no-wrap history independent of whether old states are retained) + in-flight refs keep superseded states alive. `onViewportChunk(v)`: FULL-validate first (incl. `reqId>lastReqIdSeen` OR (`==active` append-case); stale `reqId≤lastReqIdSeen` with no matching active → ignore-older); pre-insert `GEN_TILE_CAP` check else reject chunk WARNING; none-or-newer → mark previous state `canceled=true` FIRST (in-flight old work now fails 3-point checks), THEN install new state (clear queue); ==active → metadata-match else invalid WARNING, `!sealed` else rejected-after-seal WARNING, append dedupe; older→ignore. `onCommit(imageId,reqId)`: matches active → BUILD complete immutable center-first ordered set from `requested`, enqueue it, THEN `sealed=true` as final release + signal dispatcher (dispatcher never observes sealed-but-unbuilt); NO active state but valid image + `reqId>lastReqIdSeen` → create sealed-EMPTY state + immediate END 0/0; else WARNING. `onAbort(id)`: state→`canceled=true` + drop queued reqs (terminal; never END). `dispatchLoop`: sealed states only; 3-point active+!canceled (before open/after open/under lock); `checkSize` pre-frame (→SKIPPED); `writer.transferTile` (post-start failure→teardown); `sent++`; `0x04` iff sealed && !canceled && `active.get()==state` (defensive: killed superseded END even if counters align) && queueEmpty && inFlight==0. | TASK-001 | `mvn -q compile` passes |  |  |
| TASK-003 | Wire `NioHttpServer` WS read-loop: reassembled binary `AA 01`→28B chunk; `AA 05`→8B commit; `AA 03`→8B abort; `AA` bad len→1002; semantic error→WARNING keep-alive; text→1003; oversize→1009. FINE logs. `sameOriginHttp` normalized helper. | TASK-002 | handshake `curl`→101 |  |  |
| TASK-004 | Create `NEW src/test/java/com/ultratile/ws/SessionTest.java` + `WsFrameTest.java`: chunk-append+dedupe, post-seal reject, mismatch invalid, validate-before-supersede, newer-marks-old-canceled (in-flight old tile fails third check; no old END even at 0/0-counts alignment — `active.get()==state` guard), older-ignored-via-`lastReqIdSeen` (active cleared simulation still rejects), empty-COMMIT END 0/0, cap-reject at 257th key, no-normal-eviction accounting, abort→canceled + 3-point fail + NO END, COMMIT-publish-order (sealed implies fully enqueued: signal observed only after queue size == requested size), `transferTo` `2,0,2` zero-retry + partial + fatal-after-start teardown, `ReentrantLock` serialization incl. reader-called control, `writeFully` partial mock, full WS matrix (frag/Close-1/bad-code/UTF-8/version-advertise/size-codes), headers ∈{2,4,10}, `0x04` rule incl. size-gate SKIPPED. | TASK-002 | `mvn -q test` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=SessionTest,WsFrameTest,UtpCodecTest,TileMathTest
mvn -o -q clean package -DskipTests
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && break || sleep 2; done
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | head -8
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 12" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | grep -i "Sec-WebSocket-Version: 13"
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Publish ordering is a correctness property (volatile `sealed` is the release): enqueue-complete-then-seal-then-signal. Sealing first and building after lets the dispatcher END a half-built generation — the v1.5 race.
- `lastReqIdSeen` decouples no-wrap history from `active` retention; supersede-cancel-first decouples END eligibility from counter coincidences.
