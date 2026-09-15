---
phase: phase-01-project-scaffolding
goal: GOAL-001 Exact-pin Maven plus robust build.sh plus compilable stub
status: 'Planned'
parent: ./overview.md
version: 1.6
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 01 — Project Scaffolding ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: Reader/dispatcher VT model; `WsWriter` on `ReentrantLock`; explicit visibility; coordinated teardown.
  - **CON-001**: Java 21, Maven (exact pinned plugins) + `build.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`, cleans classes, `cp -a resources/.` empty-safe, JDK-only).
  - **CON-002**: `Config` single source: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `GEN_TILE_CAP=256`, `BATCH_CAP=30`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`; demos id0 2048 (21) + id1 4096 (85).
- Prior-phase deps: none (first phase; ground truth v1.5 `overview.md:1-102`, `phase-01:1-46`).
- Inputs: empty repo. Outputs: exact pins, robust `build.sh`, compilable stub, ready convention.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW pom.xml`: `maven.compiler.release=21` with EXACT `maven-compiler-plugin 3.13.0`, `maven-surefire-plugin 3.2.5`, `maven-jar-plugin 3.3.0` (manifest `Main-Class=com.ultratile.Main`; never `>=` ranges); JUnit `5.10.3` test-only. Dirs `src/main/java/com/ultratile/{net,http,proto,tiles,ws}`, `src/main/resources/web`, `src/test/java/com/ultratile/{proto,tiles,ws}`, `data/images`, `docs/protocol`, `scripts`. | — | `mvn -q validate` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/Config.java` (every CON-002 constant incl. `GEN_TILE_CAP=256`, `BATCH_CAP=30`, `MAX_TILE_BYTES=2*1024*1024`, `DECODE_QUEUE_MAX_JOBS=24`, `DECODE_QUEUE_MAX_BYTES=4*1024*1024`, `SCALE_MIN/MAX`) + `NEW Main.java` (no PORT field; `new NioHttpServer(Config.PORT).start()`). Repo-root `.gitignore` already exists. | TASK-001 | `! grep -q PORT= Main.java` + `grep -q BATCH_CAP Config.java` |  |  |
| TASK-003 | Create compilable `NEW src/main/java/com/ultratile/net/NioHttpServer.java`: `private final int port; public NioHttpServer(int port){this.port=port;}` + `start()` binds `0.0.0.0:port`, `accept()` loop + `Thread.ofVirtual().start(()->handle(ch))`; stub `handle` closes (strict logic phase 04, WS branch phase 05). | TASK-002 | `mvn -q compile` passes |  |  |
| TASK-004 | Create `NEW build.sh`: `#!/usr/bin/env bash` (NOT `/bin/sh`) + `set -euo pipefail` + `rm -rf target/classes` + `mkdir -p target/classes` + `javac --release 21 -d target/classes $(find src/main/java -name '*.java')` + `cp -a src/main/resources/. target/classes/` (dot-form: works when `web/` is still EMPTY — bare `*` would stay literal and fail under bash) + `jar --create --file target/ultratile-1.0.jar --main-class com.ultratile.Main -C target/classes .`; verify both builds runnable; manifest grep. Ready convention comment (tmp→validate→`.ready`→rename; §phase-02). | TASK-003 | Both builds runnable offline from empty resources |  |  |

## Validation Commands

```sh
mvn -q validate
mvn -q compile
mvn -o -q clean package -DskipTests
./build.sh
unzip -p target/ultratile-1.0.jar META-INF/MANIFEST.MF | grep Main-Class
java -jar target/ultratile-1.0.jar & pid=$!
for i in $(seq 1 15); do python3 -c "import socket,sys; socket.create_connection(('localhost',8080),timeout=2).close(); print('tcp-alive'); sys.exit(0)" 2>/dev/null && break || sleep 1; done
kill "$pid"
```

## Notes for Implementer

- Stub closes connections immediately: TCP-alive ONLY here (`/healthz` arrives phase 04). Bounded TCP retry loop (no one-shot race, no fixed sleep, no `kill %1`).
- `cp -a src/main/resources/. target/classes/` is the empty-tree-safe form; never `resources/*`.
