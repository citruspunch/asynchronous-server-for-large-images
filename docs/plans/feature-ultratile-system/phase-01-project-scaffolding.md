---
phase: phase-01-project-scaffolding
goal: GOAL-001 Maven plus build.sh skeleton, compilable Nio stub, executable JAR
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 01 — Project Scaffolding ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: Server handles concurrent clients via Java 21 virtual threads; per WS session exactly one reader/connection VT plus one dispatcher/writer VT; close lifecycle marks closed, clears queue, cancels dispatcher, closes tile channels, removes state, closes socket once.
  - **CON-001**: Java 21, Maven + `build.sh` fallback (`javac`+`jar`, JDK-only); no server deps; custom `NioHttpServer` on `ServerSocketChannel` + `Thread.ofVirtual()`.
  - **CON-002**: Constants single-sourced in `Config`: `PORT=8080`, `T=512`, `M=40`, `D=6`, `DQ=24`, `MAGIC=0xAA`, Q85, `MAX_DIM=262144`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`; demos id0 `2048x2048` N=2 (21 tiles) + id1 `4096x4096` N=3 (85 tiles).
- Prior-phase deps: none (first phase; ground truth v1.2 `overview.md:1-99`, `phase-01:1-47`).
- Inputs: empty repo. Outputs: pinned `pom.xml`, `build.sh`, single-source `Config`, compilable Nio stub, executable JAR offline.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Create `NEW pom.xml`: `maven.compiler.release=21` + pinned `maven-compiler-plugin >=3.11.0` + `maven-surefire-plugin >=2.22.2` (JUnit Platform) + `maven-jar-plugin` manifest `Main-Class=com.ultratile.Main`; JUnit `5.10.3` test-only. Create dirs `src/main/java/com/ultratile/{net,http,proto,tiles,ws}`, `src/main/resources/web`, `src/test/java/com/ultratile/{proto,tiles,ws}`, `data/images`, `docs/protocol`, `scripts`. | — | `mvn -q validate` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/Config.java` single source: `PORT=8080`, `TILE_SIZE=512`, `CACHE_MAX=40`, `DECODE_MAX=6`, `DECODE_QUEUE_MAX=24`, `MAGIC=0xAA`, `JPEG_QUALITY=0.85f`, `MAX_DIM=262144`, `QUEUE_CAP=256`, `SPAN_CAP=128`, `WS_MSG_CAP=1024`, `WEB_ROOT=/web`. Create `NEW src/main/java/com/ultratile/Main.java` with NO PORT field: `main` constructs `new NioHttpServer(Config.PORT)` + `start()`. Create `NEW .gitignore` (`target/`, `*.class`, `*.log`; do NOT ignore `data/images/0|1` demos if committed, ignore `*.tif*`). | TASK-001 | `! grep -q "PORT=" Main.java` + `grep -q DECODE_QUEUE_MAX Config.java` |  |  |
| TASK-003 | Create compilable `NEW src/main/java/com/ultratile/net/NioHttpServer.java`: `private final int port; public NioHttpServer(int port){this.port=port;}` + `start()` binds `0.0.0.0:port`, loop `accept()` + `Thread.ofVirtual().start(()->handle(ch))`; `handle` stub closes (full logic phases 02/05). Must compile (fixes v1.2 scope bug). | TASK-002 | `mvn -q compile` passes |  |  |
| TASK-004 | Create `NEW build.sh` JDK-only fallback: `javac --release 21 -d target/classes $(find src/main/java -name "*.java") && cp -r src/main/resources/* target/classes/ && jar --create --file target/ultratile-1.0.jar --main-class com.ultratile.Main -C target/classes .`; verify `mvn -o -q clean package` AND `./build.sh` both produce runnable JAR; `unzip -p ... MANIFEST.MF \| grep Main-Class`. | TASK-003 | Both builds runnable offline |  |  |

## Validation Commands

```sh
mvn -q validate
mvn -q compile
mvn -o -q clean package -DskipTests
./build.sh
unzip -p target/ultratile-1.0.jar META-INF/MANIFEST.MF | grep Main-Class
java -jar target/ultratile-1.0.jar & sleep 1; kill %1
```

## Notes for Implementer

- Fix v1.2 non-compiling stub by storing `port` field; `rg PORT= src/main/java/` shows exactly one definition (in `Config`).
- Pin plugins: `maven.compiler.release` alone is insufficient without modern compiler/surefire for JUnit5.
- `build.sh` is grading fallback when `~/.m2` lacks JUnit; developer workflow stays Maven.
