---
phase: phase-01-project-scaffolding
goal: GOAL-001 Exact-pin Maven plus clean build.sh plus compilable stub
status: 'Planned'
parent: ./overview.md
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 01 — Project Scaffolding ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: Reader VT + dispatcher VT model; one serialized `WsWriter` on `ReentrantLock` (never a monitor across I/O); explicit `Atomic`/`volatile` visibility; coordinated teardown.
  - **CON-001**: Java 21, Maven (exact pinned plugins) + `build.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`, cleans classes, JDK-only).
  - **CON-002**: `Config` single source: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ_JOBS=24`, `DQ_BYTES=4MiB`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `GEN_TILE_CAP=256`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`, `MAX_TILE_BYTES=2MiB`, `SCALE_MIN=1e-3`, `SCALE_MAX=32`; demos id0 2048 (21) + id1 4096 (85).
- Prior-phase deps: none (first phase; ground truth v1.4 `overview.md:1-101`, `phase-01:1-47`).
- Inputs: empty repo. Outputs: exact pins, clean `build.sh`, compilable stub, ready convention.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW pom.xml`: `maven.compiler.release=21` with EXACT `maven-compiler-plugin 3.13.0`, `maven-surefire-plugin 3.2.5`, `maven-jar-plugin 3.3.0` (manifest `Main-Class=com.ultratile.Main`; never `>=` ranges); JUnit `5.10.3` test-only. Dirs `src/main/java/com/ultratile/{net,http,proto,tiles,ws}`, `src/main/resources/web`, `src/test/java/com/ultratile/{proto,tiles,ws}`, `data/images`, `docs/protocol`, `scripts`. | — | `mvn -q validate` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/Config.java` (single source for every CON-002 constant incl. `GEN_TILE_CAP=256`, `MAX_TILE_BYTES=2*1024*1024`, `DECODE_QUEUE_MAX_JOBS=24`, `DECODE_QUEUE_MAX_BYTES=4*1024*1024`, `SCALE_MIN=1e-3`, `SCALE_MAX=32.0`) + `NEW Main.java` (no PORT field; `new NioHttpServer(Config.PORT).start()`). Repo-root `.gitignore` already exists (keeps `.opencode/`, `target/`, `*.class`, `*.tif*`, logs; demos committable). | TASK-001 | `! grep -q PORT= Main.java` + `grep -q GEN_TILE_CAP Config.java` |  |  |
| TASK-003 | Create compilable `NEW src/main/java/com/ultratile/net/NioHttpServer.java`: `private final int port; public NioHttpServer(int port){this.port=port;}` + `start()` binds `0.0.0.0:port`, `accept()` loop + `Thread.ofVirtual().start(()->handle(ch))`; stub `handle` closes (strict logic phase 04, WS branch phase 05). | TASK-002 | `mvn -q compile` passes |  |  |
| TASK-004 | Create `NEW build.sh` with `#!/usr/bin/env bash` (NOT `/bin/sh`: `pipefail` is not POSIX) + `set -euo pipefail` + `rm -rf target/classes` + `mkdir -p` + `javac --release 21` + resource copy + `jar --create --file target/ultratile-1.0.jar --main-class com.ultratile.Main`; verify `mvn -o -q clean package` AND `./build.sh` both runnable; manifest grep. Ready convention comment: published store = `<id>/` with `meta.json` + `.ready` + full 512 tiles (importer §phase-02; registry §phase-02). | TASK-003 | Both builds runnable offline |  |  |

## Validation Commands

```sh
mvn -q validate
mvn -q compile
mvn -o -q clean package -DskipTests
./build.sh
unzip -p target/ultratile-1.0.jar META-INF/MANIFEST.MF | grep Main-Class
java -jar target/ultratile-1.0.jar & pid=$!; python3 -c "import socket; s=socket.create_connection(('localhost',8080),timeout=10); print('tcp-alive'); s.close()"; kill "$pid"
```

## Notes for Implementer

- Phase-01 stub closes connections immediately, so validation asserts TCP-alive ONLY (`/healthz` does not exist until phase 04 — polling it here was the v1.4 bug). `pid=$!` (the v1.4 `IFS= read -r pid` captured nothing). `kill "$pid"`, never `kill %1`.
- Exact versions, never ranges; `build.sh` always cleans first.
