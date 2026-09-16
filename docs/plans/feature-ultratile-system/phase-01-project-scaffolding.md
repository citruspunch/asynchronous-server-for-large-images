---
phase: phase-01-project-scaffolding
goal: GOAL-001 Exact-pin Maven plus robust build.sh plus compilable stub
status: 'Planned'
parent: ./overview.md
version: 1.10
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 01 — Project Scaffolding ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: Reader/dispatcher VT model; `WsWriter` on `ReentrantLock`; explicit visibility (`AtomicReference`, `AtomicLong`, `volatile`, `AtomicBoolean`); coordinated teardown with BOTH-thread wakeup (`closeSession`); transport isolated to `net/`+`ws/` (ASSUMPTION-004: a mandated async transport swaps these files only).
  - **CON-001**: Java 21, Maven exact pins (DEVELOPMENT-ONLY — primed cache; never the clean-machine path) + `build.sh` (AUTHORITATIVE: `#!/usr/bin/env bash`, `set -euo pipefail`, cleans classes, `cp -a resources/.` empty-safe, JDK-only, committed executable bit).
  - **CON-002**: `Config` single source: `BIND=127.0.0.1`, `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `IMPORT_IMAGE_MAX_DIM=8192`, `IMPORT_IMAGE_MAX_PIXELS=16777216`, `GEN_TILE_CAP=256`, `BATCH_CAP=30`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `META_MAX_BYTES=16384`, `META_NAME_MAX=128`, `REJECTED_CAP=64`, `AVG_TILE_SEED=131072`, `SCALE_MIN/MAX`; demos id0 2048 (21) + id1 4096 (85), each ensured independently. No `QUEUE_CAP` (no dispatch queue exists). Node is test-only, never a runtime dep.
- Prior-phase deps: none (first phase; ground truth v1.9 `overview.md:1-108`, `phase-01:1-48`).
- Inputs: empty repo. Outputs: exact pins, authoritative `build.sh`, compilable stub, ready convention, two-track test story.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW pom.xml`: `maven.compiler.release=21` with EXACT `maven-compiler-plugin 3.13.0`, `maven-surefire-plugin 3.2.5`, `maven-jar-plugin 3.3.0` (manifest `Main-Class=com.ultratile.Main`; never `>=` ranges); JUnit `5.10.3` test-only. Header comment: DEVELOPMENT-ONLY — requires a primed Maven cache; clean-machine grading uses `build.sh` (authoritative track). Dirs `src/main/java/com/ultratile/{net,http,proto,tiles,ws}`, `src/main/resources/web`, `src/test/java/com/ultratile/{proto,tiles,ws}`, `data/images`, `docs/protocol`, `scripts`. | — | `mvn -q validate` passes (dev track) |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/Config.java` (every CON-002 constant incl. `BIND="127.0.0.1"`, `IMPORT_IMAGE_MAX_DIM=8192`, `IMPORT_IMAGE_MAX_PIXELS=16777216` (16 MP ≈ 64 MiB RGBA worst case — the grading-JVM-safe bound; long-thin 8192px images admitted, huge-area images refused), `META_MAX_BYTES=16384`, `META_NAME_MAX=128`, `REJECTED_CAP=64`, `AVG_TILE_SEED=131072`; NO `QUEUE_CAP`, NO bare `IMPORT_IMAGE_MAX`) + `NEW Main.java` (no PORT/BIND fields; parse optional `--bind <addr>` into a LOCAL `bind` — default `Config.BIND`, explicit `0.0.0.0` opts into LAN, anything unparseable → exit 2; `new NioHttpServer(bind, Config.PORT).start()` — the parsed variable, never `Config.BIND` directly). Repo-root `.gitignore` already exists. | TASK-001 | `! grep -q PORT= Main.java` + `grep -q BIND Config.java` + `! grep -q QUEUE_CAP Config.java` + `grep -q "NioHttpServer(bind," Main.java` |  |  |
| TASK-003 | Create compilable `NEW src/main/java/com/ultratile/net/NioHttpServer.java`: `private final String bind; private final int port; public NioHttpServer(String bind,int port){...}` + `start()` binds `bind:port` (loopback default), `accept()` loop + `Thread.ofVirtual().start(()->handle(ch))`; stub `handle` closes (strict lexical logic phase 04, WS branch phase 05). Comment: transport lives here + `ws/` only — a mandated async transport (ASSUMPTION-004) swaps these files, not the protocol. | TASK-002 | `mvn -q compile` passes (dev track) |  |  |
| TASK-004 | Create `NEW build.sh`: `#!/usr/bin/env bash` + `set -euo pipefail` + `rm -rf target/classes` + `mkdir -p target/classes` + `javac --release 21 -d target/classes $(find src/main/java -name '*.java')` + `cp -a src/main/resources/. target/classes/` (dot-form: empty-tree-safe; never `resources/*`) + `jar --create --file target/ultratile-1.0.jar --main-class com.ultratile.Main -C target/classes .`; `git add --chmod=+x build.sh`; header comment: AUTHORITATIVE clean-machine build/runtime path — the ONLY build the grader may be assumed to run (Maven/Node/Python are offline-validation-path tooling, never assumed); verify via the authoritative track below (no `mvn` anywhere in it); manifest grep. Ready convention comment (tmp→validate→`.ready`→rename; §phase-02). | TASK-003 | Authoritative track green from an EMPTY Maven cache + `[ -x build.sh ]` |  |  |

## Validation Commands

```sh
[ -x build.sh ] || { echo "build.sh not executable" >&2; exit 1; }
./build.sh
unzip -p target/ultratile-1.0.jar META-INF/MANIFEST.MF | grep Main-Class
java -jar target/ultratile-1.0.jar & pid=$!
ready=0; for i in $(seq 1 15); do python3 -c "import socket,sys; socket.create_connection(('localhost',8080),timeout=2).close(); sys.exit(0)" 2>/dev/null && { ready=1; echo tcp-alive; break; } || sleep 1; done; [ "$ready" = "1" ] || { echo "TCP never came up" >&2; kill "$pid"; exit 1; }
kill "$pid"
java -jar target/ultratile-1.0.jar --bind 0.0.0.0 & pid=$!; sleep 1; python3 -c "import socket,sys; socket.create_connection(('localhost',8080),timeout=2).close(); sys.exit(0)" || { echo "--bind 0.0.0.0 regressed" >&2; kill "$pid"; exit 1; }; kill "$pid"
```

## Notes for Implementer

- TWO TRACKS from here on, named exactly: the AUTHORITATIVE track (JDK-only build/runtime; safe on a disconnected grader — it MUST NOT assume Maven, Node, or Python) and the OFFLINE VALIDATION track (primed Maven cache + optional Node/Python test tooling). The block above is the authoritative track. Phase-07's rehearsal runs both tracks explicitly labeled.
- Stub closes connections immediately: TCP-alive ONLY here (`/healthz` arrives phase 04). The `ready` flag makes budget exhaustion FAIL LOUD — frozen pattern for every retry loop in later phases.
- `cp -a src/main/resources/. target/classes/` is the empty-tree-safe form; never `resources/*`.
- Executable bits are part of the deliverable: `build.sh` here, `scripts/import_vips.sh` in phase-02. Every block invoking `./...` asserts `[ -x ... ]` first.
- The `--bind` probe pins TASK-002's parsed-variable construction: `new NioHttpServer(Config.BIND, ...)` after parsing would silently ignore the flag and this probe would catch it.
