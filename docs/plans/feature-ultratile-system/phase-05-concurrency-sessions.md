---
phase: phase-05-concurrency-sessions
goal: GOAL-005 Serialized Nio WS with canceled-set plus transferTo loop
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 05 — Concurrency Sessions ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: Server handles concurrent clients via Java 21 virtual threads; per WS session exactly one reader/connection VT plus one dispatcher/writer VT; close lifecycle marks closed, clears queue, cancels dispatcher, closes tile channels, removes state, closes socket once.
  - **REQ-009**: Raw `ServerSocketChannel` dispatcher, center-first priority, generation + canceled-set checks before/after open and before transmit, `transferTo`-loop sendfile-style path (loop until done, no tile `byte[]` copy; not claimed as guaranteed kernel zero-copy) with single serialized writer holding output lock across WS header + UTP header + file bytes; missing/unreadable files skipped with WARNING + counted SKIPPED and closed by `0x04`; browser decode failure handles corrupt JPEG (server optionally SOI-checks only).
  - **SEC-002**: Bind `0.0.0.0:8080`; Origin must equal `http://<Host>` exactly (HTTP-only server; `https://` rejected; absent allowed for raw E2E); queue cap 256 drop-oldest; WS client messages cap 1 KiB (oversize→1009, malformed framing→1002, valid-text-but-binary-only→1003, 64-bit high-bit set→1002).
- Prior-phase deps:
  - **DEP-004**: Requires phase-03 `TileHeader` + `0x04` codec and phase-04 channel API + padded store.
- Inputs: Nio + codec + store. Outputs: serialized generational WS sessions with `0x04` completion.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW src/main/java/com/ultratile/ws/WsFrame.java` + WS branch: handshake requires `GET` + `HTTP/1.1` + single `Host` + `Connection` tokens contain `upgrade` (ci) + `Upgrade==websocket` (ci) + `Version==13` + Key valid Base64 16B else 400; Origin absent→allow, else must equal `http://<Host>` exactly else 403; reply 101 + `Sec-WebSocket-Accept`; preserve leftover post-header bytes. Frame rules: masked-required else 1002; RSV≠0→1002; opcode must be 0x0/0x1/0x2/0x8/0x9/0xA else 1002; control FIN==1+len≤125 else 1002; reassemble FIN=0+continuations; enforce `WS_MSG_CAP=1024` before alloc (oversize valid framing→1009); 64-bit high-bit→1002 (protocol violation, not size); text (0x1) valid framing but unsupported type→1003; Ping→Pong same bytes; Close→echo + close exactly once; server headers exactly 2/4/10B (not 2-8B), unmasked FIN=1. Create ONE `WsWriter` per session with `synchronized writeLock` across entire message (header+payload+transferTo); all Ping/Pong/Close/TILE/`0x04` route through it; reader never writes directly. Ownership: accepted socket → reader VT `runSession`; on 101 upgrade spawn dispatcher/writer VT `dispatchLoop`; on Close/EOF/error mark `closed=true`, clear queue, interrupt dispatcher, close open `FileChannel`s, remove session, close socket once. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/ws/SessionCoordinator.java`: `Session{id,currentGen,canceled:Set<Long>,queue< TileReq{imageId,z,x,y,gen}>(256),sent/skipped counters per gen,closed}`; `onViewport`: if `reqId<currentGen` (no-wrap monotonic) ignore-as-older; else if `==currentGen` append range deduping `imageId:z:x:y` keys; else (`>current`) `currentGen=reqId`, `canceled.remove(reqId)`, `queue.clear()`, reset per-gen counters, enqueue center-first deduped (drop-oldest on full); validate TILE_SIZE==512 + span≤128 else WARNING skip; `onAbort(abortReqId)`: `queue.removeIf(gen==id)` + `canceled.add(id)` (if `id==currentGen`, generation becomes inactive — dequeued tiles fail checks during 80ms window); `dispatchLoop(SocketChannel,WsWriter,store)`: `take()` → check `gen==current && !canceled.contains(gen)` else continue+count; open channel+size → re-check → build `TileHeader` from size (no bytes) → re-check under `writeLock` → `writer.writeBinary(utpHeader)` + `transferToLoop(channel,0,size,sock)` (`while(pos<size){n=transferTo(...); if(n==0) spin-yield with cap then fail→SKIPPED}`) → `sent++`; missing/unreadable → WARNING + `skipped++` continue; after queue drains for gen (empty + no in-flight for gen) send `0x04 GENERATION_END(reqId,sent,skipped)` via same writer. | TASK-001 | `mvn -q compile` passes |  |  |
| TASK-003 | Wire `NioHttpServer` WS read-loop: reassembled binary payload `AA 01`→28B viewport→`onViewport`; `AA 03`→8B abort→`onAbort`; `AA` bad len→1002; valid-UTP range error→WARNING skip (session lives); text opcode→1003; oversize→1009. FINE logs. SPAN>128→WARNING + expect same-REQ_ID chunks. | TASK-002 | `curl -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -i http://localhost:8080/ws` →101 |  |  |
| TASK-004 | Create `NEW src/test/java/com/ultratile/ws/SessionTest.java` + `WsFrameTest.java`: same-REQ_ID chunks append+dedupe (gen1a 4 tiles + gen1b overlapping 4 → 6 queued, no clear); newer clears; older ignored; abort marks canceled + in-flight check fails; `transferTo` loop mock transfers partial (2+2+0→done); serialized writer test (concurrent Pong + TILE never interleave); WS codes: unmasked→1002, RSV→1002, frag-ping→1002, high-bit→1002, oversize 2 KiB→1009, text→1003, server header sizes ∈{2,4,10}, Ping→Pong, Close echo; `0x04` sent/skipped counts incl. missing-tile case. | TASK-002 | `mvn -q test` green |  |  |

## Validation Commands

```sh
mvn -q test -Dtest=SessionTest,WsFrameTest,UtpCodecTest,TileMathTest
mvn -o -q package -DskipTests && java -jar target/ultratile-1.0.jar &
sleep 2
curl --include --no-buffer -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8080/ws | head -8
kill %1
```

## Notes for Implementer

- Single writer invariant: `WsWriter.writeBinary` + `writeControl` + `transferTile` all `synchronized(writeLock)`; tile = WS header + UTP 24B + file loop atomically; RFC allows control-while-fragmented on receipt, but our transmits never interleave.
- `transferTo` loop required by javadoc (may send fewer); document as sendfile-style (no `byte[]`), not guaranteed kernel zero-copy.
- Canceled-set fixes 80ms abort-then-viewport window; checks test `current && !canceled` at all three points.
