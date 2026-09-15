---
phase: phase-07-protocol-doc-e2e
goal: GOAL-007 Sealed-lifecycle doc plus contract/unit-split E2E
status: 'Planned'
parent: ./overview.md
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 07 — Protocol Doc E2E ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: HTTP-subset serves bundle; sealed UTP lifecycle documented (chunks→COMMIT incl. empty→dispatch→TILE*→END iff sealed&&!canceled&&empty&&inflight0; ABORT/supersede terminal, no END).
  - **REQ-007**: Sealed UTP: `0x01` 28B (freeze, post-seal reject, span≤128, GEN_TILE_CAP pre-insert), `0x05` 8B seal, `0x03` 8B cancel, `0x02` 24B (size-built, WS `24+size`, MAX_TILE_BYTES gate), `0x04` 16B network completion; no-wrap, no-reset-on-switch; async-terminology note (blocking-on-VT, not selector async).
  - **REQ-001**: Progressive/selective 512 tiling (dz/onetile + post-pad, full-bitmap compositing clipped); never full image.
- Prior-phase deps:
  - **DEP-006**: Requires all prior (`GenerationState`+`ReentrantLock` writer, Z0 pin + effective LOD + batches, `.ready` + rescan registry).
- Inputs: sealed system + 2048/4096 `.ready` demos. Outputs: sealed doc + split E2E (contract vs unit) + async-model note.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW docs/protocol/UTP-1.0.md` (≤260 lines): 1 Nio subset + honest scope, 2 ceiling pyramid + demos (21/85) + dz/onetile + direct n→Z + post-pad + tmp/`.ready`/rename + quarantine + live rescan, 3 sealed LOD/progressive (Z0 pin, full-bitmap compositing + `[0,W)` clip, effective LOD per-Z recompute desired-vs-effective, ≤30 sequential batches, network vs coverage), 4 packets/offsets (28/8COMMIT/8ABORT/24/16, freeze/mismatch-invalid, empty-COMMIT END 0/0, validate-before-supersede, newer/==+dedupe/older, GEN_TILE_CAP, no-wrap/no-reset, FORMAT map), 5 session (GenerationState fields + Atomic/volatile/ReentrantLock/writeFully table, 3-point checks, `transferTile` len + loop + fatal-mid-frame, pre-frame gates incl. size, `0x04` rule + no-END-on-cancel, Close coordination, no-deadline scope), 6 pipelines (priority backstop, 256 queue, LRU-40+Z0, decode 6/24jobs/4MiB + purge, gen-scoped pending), 7 limits (128+split same-REQ_ID, 1KiB cap, codes + version advertise + 2/4/10, normalized `http://` origin, no full-image), 8 concurrency-model note (blocking `SocketChannel` on virtual threads; explicitly NOT non-blocking-selector async), 9 refs (6455, 9110/9112, dzsave, transferTo, SocketChannel R/W, VT pinning, 101 thread). Verbatim dz-`onetile` cmd + `6455` + `9110`. | — | `wc -l` ≤270 + has COMMIT + empty-gen + ReentrantLock |  |  |
| TASK-002 | Create `NEW scripts/e2e_utp.py` PUBLIC-CONTRACT ONLY (stdlib; PRECISE masked sends: first byte `0x82`, second `0x80|len` (all client UTP ≤28B, single-byte form only — no 126/127-send path), 4B mask key, XOR payload; parse server 2/4/10B incl. 64-bit for >65535B tiles): handshake no-Origin; send gen=1 as TWO same-REQ_ID 28B chunks (`>BBHBBHIIIII`, len 28) + COMMIT 8B (`>BBHI`); read exactly ONE gen=1 TILE (24B: 512, reqId echo, `FFD8`) — then WITHOUT waiting for gen1 END switch local currentGen, send gen=2 chunks + COMMIT (+optional ABORT gen=1, masked 8B); collect 5s: require gen2 TILE + `0x04 gen=2`, require simulated-client accepts 0 gen=1 post-switch (buffered gen1 TCP bytes explicitly allowed/discarded), require Ping→Pong healthy. NEVER assert gen1 END (aborted/superseded gens get none), internal counters, or missing-file behavior here. Print `E2E-OK sealed superseded completed`. | TASK-001 | `python3 scripts/e2e_utp.py` prints `E2E-OK` |  |  |
| TASK-003 | Unit-side proofs (no Python): `SessionTest` — queued-cancel on supersede, empty-COMMIT END 0/0, cap-reject at 257th key, no-normal-eviction accounting (END sent+skipped == accepted uniques), abort→no-END, in-range missing file moved out SERIALY with `finally` restore → `0x04 SKIPPED>0` + alive (never parallel), out-of-range → validation reject (no queue, no END, alive); `WsFrameTest` — frag matrix (open-less continuation, second-data-opcode, cumulative>1KiB), Close-1, bad code/reason, UTF-8, version-advertise, size codes, header sizes; harness log section via redirected-log grep OPTIONAL. Offline/concurrency: `mvn -o` + `./build.sh`, readiness loop, live registry, 10x parallel E2E, `rg` (no hijack/byte[]-hot-path/single-shot-transferTo/`synchronized.*[Ww]rite`), 4096 fixed-path eviction + desired-vs-effective, 2048 smoke-only. Write `NEW docs/protocol/E2E-REPORT.md` (<80 lines). | TASK-002 | 10x green + unit greens + report |  |  |
| TASK-004 | Rehearsal: `mvn -o -q test` + `./build.sh` green; routes + 101; offline reload; doc cites 6455/9110/dz-onetile + 28B assert + async note; report PASS (`LOD→effZ→bytes↑→evicts↑` fixed-path on 4096). | TASK-003 | All PASS |  |  |

## Validation Commands

```sh
mvn -o -q test
python3 -c "import struct; assert len(struct.pack('>BBHBBHIIIII',0xAA,1,1,3,0,512,1,0,3,0,3))==28; assert len(struct.pack('>BBHI',0xAA,5,1,1))==8; assert len(struct.pack('>BBHI',0xAA,3,1,1))==8; assert len(struct.pack('>BBHBBHIIII',0xAA,2,1,3,1,512,1,0,0,4))==24; assert len(struct.pack('>BBHIII',0xAA,4,1,1,4,0))==16; print('struct-ok')"
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && break || sleep 2; done
python3 scripts/e2e_utp.py
for i in 1 2 3 4 5 6 7 8 9 10; do python3 scripts/e2e_utp.py & done; wait
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Split discipline enforced: Python asserts ONLY observable wire behavior (masked, chunked+COMMIT, one-tile-then-switch supersede-use, gen2 TILE+END, healthy conn); Java asserts ONLY internal state (cancel/cap/empty-END/missing-vs-invalid/frag matrix). The v1.4 vacuous test (wait gen1 END, then supersede) and internal-counter asserts are explicitly forbidden patterns — name them in the report.
- Send path never needs 126/127 (max client frame 28B); receive path MUST implement 127-form (tiles routinely >65535B).
