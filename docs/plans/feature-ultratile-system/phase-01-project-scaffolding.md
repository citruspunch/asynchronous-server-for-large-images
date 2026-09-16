---
phase: phase-01-project-scaffolding
goal: GOAL-001 Exact-pin Maven plus robust build.sh plus compilable stub
status: 'Planned'
parent: ./overview.md
version: 1.14
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 01 — Project Scaffolding ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-002**: Reader/dispatcher VT model; `WsWriter` on `ReentrantLock`;
    explicit visibility (`AtomicReference`, `AtomicLong`, `volatile`,
    `AtomicBoolean`); coordinated teardown with BOTH-thread wakeup
    (`closeSession`); transport isolated to `net/`+`ws/` (ASSUMPTION-004: a
    mandated async transport swaps these files only).
  - **CON-001**: Java 21, Maven exact pins (DEVELOPMENT-ONLY — primed cache;
    never the clean-machine path) + `build.sh` (AUTHORITATIVE:
    `#!/usr/bin/env bash`, `set -euo pipefail`, cleans classes, `cp -a
    resources/.` empty-safe, JDK + standard userland, committed executable bit).
  - **CON-002**: `Config` single source (incl. `BIND=127.0.0.1`,
    `IMPORT_IMAGE_MAX_DIM=8192`, `IMPORT_IMAGE_MAX_PIXELS=16777216`,
    `REJECTED_CAP=64`, `AVG_TILE_SEED=131072`; NO `QUEUE_CAP`, NO bare
    `IMPORT_IMAGE_MAX`); demos id0 2048 (21) + id1 4096 (85), each ensured
    independently. Node is test-only, never a runtime dep.
- Prior-phase deps: none (first phase; ground truth v1.13, 8 files at
  `version: 1.13`).
- Inputs: empty repo. Outputs: exact pins, authoritative `build.sh`,
  compilable stub, ready convention, two-track test story.

## Tasks

### TASK-001 — Maven pins (offline validation track only)

- Create `NEW pom.xml`: `maven.compiler.release=21` with EXACT
  `maven-compiler-plugin 3.13.0`, `maven-surefire-plugin 3.2.5`,
  `maven-jar-plugin 3.3.0` (manifest `Main-Class=com.ultratile.Main`; never
  `>=` ranges); JUnit `5.10.3` test-only.
- Header comment: DEVELOPMENT-ONLY — requires a primed Maven cache;
  clean-machine grading uses `build.sh` (authoritative track).
- Create dirs `src/main/java/com/ultratile/{net,http,proto,tiles,ws}`,
  `src/main/resources/web`, `src/test/java/com/ultratile/{proto,tiles,ws}`,
  `data/images`, `docs/protocol`, `scripts`.
- Done when: `mvn -q validate` passes (offline validation track).

### TASK-002 — Config + Main with parsed bind variable

- Create `NEW src/main/java/com/ultratile/Config.java` with every CON-002
  constant (`BIND="127.0.0.1"`, `IMPORT_IMAGE_MAX_DIM=8192`,
  `IMPORT_IMAGE_MAX_PIXELS=16777216` — 16 MP as an RGBA8 ESTIMATE of ≈64 MiB
  pixels, not a true worst case; `META_MAX_BYTES=16384`,
  `META_NAME_MAX=128`, `REJECTED_CAP=64`, `AVG_TILE_SEED=131072`;
  NO `QUEUE_CAP`).
- Create `NEW Main.java` (no PORT/BIND fields): parse optional
  `--bind <addr>` into a LOCAL `bind` (default `Config.BIND`; explicit
  `0.0.0.0` opts into LAN; unparseable → exit 2); construct
  `new NioHttpServer(bind, Config.PORT)` — the parsed variable, never
  `Config.BIND` directly. Expose the parsed value for tests (package-visible
  `static String parseBind(String[] args)` returning the effective bind).
- Repo-root `.gitignore` already exists.
- Done when: `! grep -q PORT= Main.java` + `grep -q BIND Config.java` +
  `! grep -q QUEUE_CAP Config.java` +
  `grep -q "NioHttpServer(bind," Main.java`.

### TASK-003 — Compilable stub server

- Create compilable `NEW src/main/java/com/ultratile/net/NioHttpServer.java`:
  `private final String bind; private final int port;` +
  `public NioHttpServer(String bind,int port){...}` + `start()` binds
  `bind:port` (loopback default) + `getBindAddress()` returning
  `((InetSocketAddress) serverChannel.getLocalAddress())` for the bind test;
  `accept()` loop + `Thread.ofVirtual().start(()->handle(ch))`; stub
  `handle` closes (strict lexical logic phase 04, WS branch phase 05).
- Comment: transport lives here + `ws/` only — a mandated async transport
  (ASSUMPTION-004) swaps these files, not the protocol.
- Done when: `mvn -q compile` passes (offline validation track).

### TASK-004 — Authoritative build.sh (JDK + userland block)

- Create `NEW build.sh`: `#!/usr/bin/env bash` + `set -euo pipefail` +
  `rm -rf target/classes` + `mkdir -p target/classes` +
  `javac --release 21 -d target/classes $(find src/main/java -name
  '*.java')` + `cp -a src/main/resources/. target/classes/` (dot-form:
  empty-tree-safe; never `resources/*`) +
  `jar --create --file target/ultratile-1.0.jar
  --main-class com.ultratile.Main -C target/classes .`;
  `git add --chmod=+x build.sh`.
- Header comment: AUTHORITATIVE clean-machine build/runtime path — the ONLY
  path the grader may be assumed to run (Maven/Node/Python/curl/rg are
  offline-validation-path tooling, never assumed here); manifest grep.
- Ready convention comment (tmp→validate→`.ready`→rename; §phase-02).
- Done when: authoritative track green from an EMPTY Maven cache +
  `[ -x build.sh ]`.

## Validation Commands

Authoritative track — JDK + standard Unix userland ONLY (bash, coreutils,
`find`, `unzip`, `grep`, `seq`, `sleep`, and the bash `/dev/tcp` probe —
no downloaded dependencies; no Maven, Node, Python, curl, rg):

```sh
[ -x build.sh ] || { echo "build.sh not executable" >&2; exit 1; }
./build.sh
unzip -p target/ultratile-1.0.jar META-INF/MANIFEST.MF | grep Main-Class
java -jar target/ultratile-1.0.jar & pid=$!
alive=0; for i in $(seq 1 15); do (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null && { alive=1; echo tcp-alive; exec 3<&-; exec 3>&-; break; } || sleep 1; done; [ "$alive" = "1" ] || { echo "TCP never came up" >&2; kill "$pid"; exit 1; }
kill "$pid"; wait "$pid" 2>/dev/null || true
```

Offline validation track — bind behavior (no vacuous localhost probe):

```sh
mvn -q test -Dtest=MainTest
```

`MainTest` (new, JUnit): `parseBind({})` → `"127.0.0.1"`;
`parseBind({"--bind","0.0.0.0"})` → `"0.0.0.0"`; unparseable → exit path
(throws/fails, never silently defaults); start a `NioHttpServer` on an
ephemeral port with bind `"127.0.0.1"` and assert `getBindAddress()`
reports the loopback address, not the wildcard. (v1.10's
`curl localhost` probe passed identically for a loopback-only and a
wildcard server — connecting to `localhost` cannot distinguish them, so the
value is now asserted directly. Note the `wait` after `kill`: the second
server must never start while the first JVM still holds the port.)

## Notes for Implementer

- TWO TRACKS with frozen names and frozen memberships: the AUTHORITATIVE
  track (JDK + standard Unix userland — `build.sh` itself uses `find`,
  `cp`, `rm`, `mkdir`, and the validation block uses `unzip`, `grep`,
  `seq`, `sleep` plus the bash-builtin `/dev/tcp` probe; none of these
  needs downloading, so all are allowed here; Maven/Node/Python/curl/rg
  are offline-validation-path tooling, never assumed here) and the
  OFFLINE VALIDATION track (primed Maven cache
  + Node/Python/curl/rg). No validation block may mix them without saying
  which track it belongs to. Phase-07's rehearsal runs both explicitly
  labeled.
- Stub closes connections immediately: TCP-alive ONLY here (`/healthz`
  arrives phase 04). The `alive` flag makes budget exhaustion FAIL LOUD —
  frozen pattern for every retry loop in later phases.
- `cp -a src/main/resources/. target/classes/` is the empty-tree-safe form;
  never `resources/*`.
- Executable bits are part of the deliverable: `build.sh` here,
  `scripts/import_vips.sh` in phase-02. Every block invoking `./...`
  asserts `[ -x ... ]` first.
