---
phase: phase-07-protocol-doc-e2e
goal: GOAL-007 Sealed-lifecycle doc plus contract/unit-split E2E
status: 'Planned'
parent: ./overview.md
version: 1.7
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 07 — Protocol Doc E2E ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: HTTP-subset (GET-only/405, multi-value headers) serves bundle; sealed UTP lifecycle documented (off-queue build → seal last → token → dispatch → TILE* → END iff sealed&&!canceled&&active&&empty&&inflight0; ABORT/supersede terminal, no END; seen-rule table).
  - **REQ-007**: Sealed UTP: `0x01` 28B (freeze, post-seal reject, span≤128, GEN_TILE_CAP, u32-shape), `0x05` 8B seal (incl. empty END 0/0), `0x03` 8B cancel with `(imageId,reqId)` match, `0x02` 24B (size-built, WS `24+size`, gate), `0x04` 16B network completion; no-wrap + `lastReqIdSeen` (advance-only-on-accept) + no-reset-on-switch; client viewEpoch/`BatchState`/capacity-aware batches/retry model; async note (blocking-on-VT).
  - **REQ-001**: Progressive/selective 512 tiling (dz/onetile + post-pad, clear-then-clip compositing); never full image.
- Prior-phase deps:
  - **DEP-006**: Requires all prior (token-gated `GenerationState`, `BatchState` viewer + `test_viewer.cjs`, `.ready` + strict-meta registry).
- Inputs: sealed system + 2048/4096 `.ready` demos. Outputs: sealed doc + split E2E (contract vs unit) + async-model note.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW docs/protocol/UTP-1.0.md` (≤260 lines): 1 Nio subset (GET-only/405, multi-value headers, absolute-form, Host, bodyless-`/ws`, leftover policy), 2 ceiling pyramid + demos (21/85) + dz/onetile + direct n→Z + post-pad + tmp/`.ready`/rename + quarantine (incl. `.tmp-<id>` recovery) + idempotent no-op + CLI validation + strict meta (hand parser, WARNING-ignore, levels==levelCount) + live rescan, 3 sealed LOD/progressive (Z0 pin, clear-then-clip compositing, effective LOD per-Z recompute, viewEpoch + `BatchState` retention + ≤30 capacity-aware batches + epoch-cancel (never wait missing END) + retryNeeded vs terminal-reject + `rxBytes` vs `decodedBytes` + network vs coverage), 4 packets/offsets (28/8COMMIT/8ABORT/24/16, freeze/mismatch-invalid, empty-COMMIT END 0/0, validate-before-supersede + old-cancel-first + active-guard + seen-advancement table + ABORT-match rule, GEN_TILE_CAP, u32-shape rules, no-wrap/no-reset), 5 session (GenerationState + Atomic/volatile/ReentrantLock/writeFully table, token-gated ordered-COMMIT, 3-point checks, `transferTile` + loop + fatal-mid-frame, pre-frame gates incl. size, `0x04` rule + no-END-on-cancel, Close coordination, no-deadline scope), 6 pipelines (priority backstop, 256 queue, LRU-40+Z0, decode 6/24jobs/4MiB + purge + retry + in-flight suppression, gen-scoped pending), 7 limits (128+split same-REQ_ID, 1KiB cap, codes + version advertise + 2/4/10, normalized `http://` origin, fresh `os.urandom(4)` mask note, no full-image), 8 concurrency-model note (blocking `SocketChannel` on virtual threads; explicitly NOT non-blocking-selector async), 9 refs (6455, 9110/9112, dzsave, transferTo, SocketChannel R/W, VT pinning, 101 thread). Verbatim dz-`onetile` cmd + `6455` + `9110`. | — | `wc -l` ≤270 + has COMMIT + epoch + seen-rule |  |  |
| TASK-002 | Create `NEW scripts/e2e_utp.py` PUBLIC-CONTRACT ONLY (stdlib + `os.urandom(4)` FRESH mask per frame — first `0x82`, second `0x80|len` (≤28B single-byte; no 126/127-send), 4B key, XOR; same for Ping/ABORT/COMMIT; parse server 2/4/10B incl. 64-bit): handshake no-Origin; send gen=1 as TWO same-REQ_ID 28B chunks (`>BBHBBHIIIII`, len 28) + COMMIT 8B (`>BBHI`); read exactly ONE gen=1 TILE (24B: 512, reqId echo, `FFD8`) — then WITHOUT waiting for gen1 END switch local currentGen, send gen=2 chunks + COMMIT (+optional ABORT gen=1 with CORRECT `(imageId,reqId)` pair, masked 8B); collect 5s: require gen2 TILE + `0x04 gen=2`, require simulated-client accepts 0 gen=1 post-switch (buffered gen1 TCP bytes explicitly allowed/discarded), require Ping→Pong healthy. NEVER assert gen1 END, internal counters, or missing-file behavior. Print `E2E-OK sealed superseded completed`. | TASK-001 | `python3 scripts/e2e_utp.py` prints `E2E-OK` |  |  |
| TASK-003 | Unit-side proofs (no Python): `SessionTest` — seen-rule suite (invalid-newer never advances: bad-coords `reqId=100` then valid `reqId=2` accepted; future-ABORT never advances: ABORT `reqId=99` then valid `reqId=3` accepted; same-chunk/COMMIT/ABORT/reject never advance; below-seen without active continuation ignored), queued-cancel on supersede (old canceled FIRST + active-guard, no old END), empty-COMMIT END 0/0, cap-reject at 257th key, no-normal-eviction accounting, abort(image-mismatch)→ignored + seen untouched, abort→canceled + 3-point fail + NO END, token-gating (ZERO tile bytes before COMMIT token even with queued chunks; sealed ⇒ fully-enqueued), `transferTo` `2,0,2` zero-retry + partial + fatal-after-start teardown, `ReentrantLock` serialization incl. reader-called control, `writeFully` partial mock, u32 vectors (`0xffffffff`/reversed/overflow), full WS matrix (frag/Close-1/bad-code/UTF-8/version-advertise/size-codes/duplicate-`Host`→400), headers ∈{2,4,10}, `0x04` rule incl. size-gate SKIPPED; `test_viewer.cjs` green (epoch/BatchState/classify/capacity/retry/cancel/LOD/ranges/rxBytes — phase-06). Offline/concurrency: `mvn -o` + `./build.sh`, readiness loop (loud-fail tails), live registry, 10x parallel E2E, `rg` (no hijack/byte[]-hot-path/single-shot-transferTo/`synchronized.*[Ww]rite`/stale `kill %1`/`resources/\*`), 4096 fixed-path eviction + desired-vs-effective, 2048 smoke-only. Write `NEW docs/protocol/E2E-REPORT.md` (<80 lines, incl. no-Node manual path section). | TASK-002 | 10x green + all unit greens + report |  |  |
| TASK-004 | Rehearsal: `mvn -o -q test` + `node scripts/test_viewer.cjs` + `./build.sh` green; routes + 101; offline reload incl. no-Node app check (app serves/works with Node absent — only `test_viewer.cjs` is skipped, documented); doc cites 6455/9110/dz-onetile + 28B assert + async note; report PASS (`LOD→effZ→bytes↑→evicts↑` fixed-path on 4096; forbidden patterns named: vacuous END-wait, internal-counter asserts). | TASK-003 | All PASS |  |  |

## Validation Commands

```sh
mvn -o -q test
node scripts/test_viewer.cjs
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,1,3,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,5,1,1))==8; assert len(struct.pack('>BBHI',0xAA,3,1,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,1,3,1,512,1,0,0,4))==24; assert len(struct.pack('>BBHIII',0xAA,4,1,1,4,0))==16; print('struct-ok')"
./build.sh
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$pid"; exit 1; }
python3 scripts/e2e_utp.py
for i in 1 2 3 4 5 6 7 8 9 10; do python3 scripts/e2e_utp.py & done; wait
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Split discipline enforced: Python = observable wire (fresh-masked, chunked+COMMIT, one-tile-then-switch, gen2 TILE+END, healthy conn); Java + `test_viewer.cjs` = internal state (seen-poisoning, token-gating, BatchState/classify, capacity/retry). Forbidden patterns stay named in the report.
- Self-containedness graded: build (`./build.sh` — v1.6 started a never-built JAR), start (`pid=$!` own line + trap), wait (loud readiness, no sleeps), test, clean up.
- 512 JPEGs routinely exceed 65535B → receive path MUST implement 127-form; send path stays single-byte (max 28B client frame).
