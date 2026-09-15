---
phase: phase-05-concurrency-sessions
goal: GOAL-005 GenerationState sessions plus transferTile plus visibility
status: 'Planned'
parent: ./overview.md
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 05 — Concurrency Sessions ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: One reader VT + one dispatcher VT per WS session; one serialized `WsWriter` on `ReentrantLock` (at most one writer at a time — reader VT may call `writeControl` under the same lock); explicit visibility (`AtomicReference` active, `volatile` sealed/canceled, `AtomicBoolean` closed, atomic tile-channel ref, idempotent cleanup); coordinated Close; immediate I/O/EOF abort; no deadlines by design.
  - **REQ-009**: Wait-for-COMMIT dispatch; per-`GenerationState` (no shared resets); current+!canceled 3-point checks; `transferTile` (WS len `24+fileSize`, `writeFully`, looped `transferTo`); `MAX_TILE_BYTES` pre-frame gate; SKIPPED pre-frame only, post-start fatal; `0x04` iff sealed && !canceled && empty && inFlight==0 (empty seal → END 0/0; ABORT/supersede terminal, no END); browser owns corrupt verdict.
  - **SEC-002**: `0.0.0.0:8080`; normalized `http://` Origin vs `Host` (absent allowed); `/ws` bodyless-only; priority queue defensive backstop (accepted sets fit by `GEN_TILE_CAP`); 1 KiB cap (1009/1002/1003); version-mismatch → 400 + `Sec-WebSocket-Version: 13`; frag/close/UTF-8 matrix.
- Prior-phase deps:
  - **DEP-004**: Requires phase-03 (`TileHeader`, `0x04`/`0x05`, freeze/mismatch, LEN gate) + phase-02 (channel API, `.ready` stores, size gate).
- Inputs: Nio stub + sealed codec + store. Outputs: sealed sessions with correct framing and visibility.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/ws/WsFrame.java` + `NEW WsWriter.java` + WS branch: handshake (`GET`, HTTP/1.1, one valid Host, `Connection`∋upgrade ci, `Upgrade==websocket` ci, `Version==13` else 400 WITH `Sec-WebSocket-Version: 13` advertise, Key=Base64-16B else 400; Origin absent→allow else normalized-`http://`-authority==Host else 403; TE/any-CL≠0/conflicts→400; leftover kept only after bodyless valid upgrade) →101 + Accept. `WsFrame`: masked-required→1002; RSV≠0→1002; opcode ∈{0x0,0x1,0x2,0x8,0x9,0xA} else 1002; control FIN==1&&len≤125 else 1002; reassembly (continuation w/o open→1002; second data opcode mid-frag→1002; cumulative frag>1KiB→1009; Close len==1→1002; bad Close code/reason→1002/1007); 64-bit high-bit→1002; text(valid)→1003 downstream; Ping→Pong; server headers exactly 2/4/10B. `WsWriter` (one/session, `ReentrantLock writeLock` — NOT `synchronized`, which pins VT carriers across I/O): `writeFully(ByteBuffer)` primitive (NIO partial writes legal) used by `writeBinary`, `writeControl`, `transferTile(TileHeader,FileChannel,size)` = WS header len `24+size` + 24B UTP + looped `transferTo` (`while(pos<size){n=...; if(n==0) bounded-yield else fail}`), ALL under one lock hold; reader VT may call `writeControl` under the same lock (frozen relaxed claim). Ownership: accept→reader VT; 101→spawn dispatcher VT; received Close→stop app work, lock-coordinate writer, emit reply, teardown once (`AtomicBoolean closed`, atomic channel ref, idempotent); I/O/EOF→abort/close immediately. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/ws/SessionCoordinator.java` around `GenerationState{reqId,imageId,zoom,lodMode,requested:LinkedHashSet<String>,sent,skipped,sealed(volatile),canceled(volatile),inFlight}` + `TileReq{state,x,y}`; session: `AtomicReference<GenerationState> active` (nullable), in-flight refs keep old states alive (no shared-counter resets; per-state `canceled` — no session-wide set leak). `onViewportChunk(v)`: FULL-validate first; pre-insert check `requested.size()+newKeys ≤ GEN_TILE_CAP=256` else reject chunk WARNING (no growth attack; accepted sets always fit queue — normal-path eviction eliminated); none-or-newer(`reqId>active`, no-wrap) → install state (clear queue); ==active → metadata-match else invalid WARNING, `!sealed` else rejected-after-seal WARNING, append dedupe; older→ignore. `onCommit(imageId,reqId)`: matches active → `sealed=true` + build global center-first order and start dispatch; NO matching state but valid image/REQ_ID and `reqId` newer-than-anything-seen → create sealed-EMPTY state, immediate `0x04` END 0/0 (commit-only generation); else WARNING. `onAbort(id)`: state→`canceled=true` + drop its queued reqs (terminal; never END). `dispatchLoop`: sealed active state only; 3-point active+!canceled checks (before open/after open/under lock); `checkSize` (>MAX_TILE_BYTES→SKIPPED) pre-frame; `writer.transferTile` (post-start failure→teardown, no SKIPPED/frames); `sent++`; `0x04` iff sealed && !canceled && queueEmpty && inFlight==0. | TASK-001 | `mvn -q compile` passes |  |  |
| TASK-003 | Wire `NioHttpServer` WS read-loop: reassembled binary `AA 01`→28B chunk; `AA 05`→8B commit; `AA 03`→8B abort; `AA` bad len→1002; semantic error→WARNING keep-alive; text→1003; oversize→1009. FINE logs. `sameOriginHttp` normalized helper (lowercase host, default-port 80 folding). | TASK-002 | handshake `curl`→101 |  |  |
| TASK-004 | Create `NEW src/test/java/com/ultratile/ws/SessionTest.java` + `WsFrameTest.java`: chunk-append+dedupe, post-seal reject, mismatch invalid, validate-before-supersede, newer/older, empty-COMMIT END 0/0, cap-reject (257th unique key refused, set stays 256), no-normal-eviction (accepted set == dispatched-or-skipped accounting in END), abort→canceled + 3-point fail + NO END, `transferTo` `2,0,2` zero-retry + partial + fatal-after-start teardown, `ReentrantLock` serialization (Pong-vs-TILE incl. reader-called control), `writeFully` partial-write mock, full WS matrix (frag/Close-1/bad-code/UTF-8/version-advertise/size-codes), header sizes ∈{2,4,10}, `0x04` rule incl. pre-frame missing + size-gate SKIPPED. | TASK-002 | `mvn -q test` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=SessionTest,WsFrameTest,UtpCodecTest,TileMathTest
mvn -o -q package -DskipTests && java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && break || sleep 2; done
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | head -8
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 12" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | grep -i "Sec-WebSocket-Version: 13"
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Framing fix stands: WS len `24+size`; v1.3-style split writes corrupted streams. Fatal-mid-frame stands with it.
- `synchronized` anywhere on the I/O path is a virtual-thread pinning bug — `ReentrantLock` for the writer; short in-memory `synchronized` elsewhere is acceptable.
- Visibility is part of correctness, not style: plain fields across reader/dispatcher VTs are data races even with a correct state machine.
