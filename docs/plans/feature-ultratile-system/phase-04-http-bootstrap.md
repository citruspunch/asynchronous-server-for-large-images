---
phase: phase-04-http-bootstrap
goal: GOAL-004 Strict GET-only multi-value-header HTTP plus live metadata
status: 'Planned'
parent: ./overview.md
version: 1.8
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 04 — HTTP Bootstrap ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: Strict HTTP/1.1 subset: GET-only (`405` + `Allow: GET`), origin-form + absolute-form (normalized authority MUST equal the single Host value else 400 — silent discard and RFC authority-replacement both rejected for this subset), exactly-one valid Host, headers as `Map<String,List<String>>` (multiplicity preserved; duplicates detected pre-collapse), globally bodyless (any `Transfer-Encoding` →400 on EVERY route incl. static/metadata; any `Content-Length` with a value ≠0 →400; DUPLICATE `Content-Length` headers →400 even when values agree — the single frozen rule; exactly one `Content-Length: 0` permitted, no body follows), `writeFully`/`readFully`, leftover bytes only after bodyless valid upgrade (all other post-header bytes → close + discard, no pipelining); UTP/1.0 over RFC 6455 documented.
  - **REQ-004**: Locally served frontend, offline; `resizeCanvas()` DPR=1 before frustum math (viewer phase-06).
  - **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
  - **GUD-001**: `Cache-Control` split; FINE logs; HUD/E2E counters (`rxBytes` vs `decodedBytes` split) prove transfer+eviction.
- Prior-phase deps:
  - **DEP-003**: Requires phases 01 (pins, `Config`, stub, `build.sh`) + 02 (`ImageRegistry` fresh-snapshot, `.ready` demos, strict bounded meta).
- Inputs: phase-01 stub + phase-02 registry. Outputs: strict HTTP + live metadata + readiness (no tile generation here).

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Implement `NioHttpServer.handle` strict subset in `src/main/java/com/ultratile/net/NioHttpServer.java` (extend phase-01 stub): `readFully` to `\r\n\r\n` (16 KB→431); parse headers into `LinkedHashMap<String,List<String>>` with lowercase names — multiplicity PRESERVED (a `Map<String,String>` would silently overwrite the first `Host`/`Content-Length` and defeat duplicate detection — v1.6 bug); exactly one syntactically valid `Host` value else 400 (covers missing/duplicate/invalid); method gate FIRST (`!=GET` → `405` + `Allow: GET` + close); GLOBAL body gate SECOND (before routing): `Transfer-Encoding` present in ANY form →400; `Content-Length` values: zero headers → ok; exactly one `0` → ok (no body follows); exactly one nonzero →400; MORE THAN ONE `Content-Length` header →400 unconditionally (even `0,0` — frozen simplest rule, no "must agree" ambiguity); target: origin-form → path+query; absolute-form → parse authority, REQUIRE authority==Host value else 400 (never silently drop it), then path+query; anything else →400; `writeFully` loop; exact routes `/`,`/viewer.js`,`/styles.css`,`/api/images`,`/api/images/{id}/info`,`/healthz`,`/ws`; `Connection: close` except upgraded `/ws`. For `/ws`: same global body gate already enforced (TE/any-`CL!=0`/duplicated-CL→400, no upgrade); preserve post-header bytes ONLY after bodyless valid upgrade (all other trailing bytes → close + discard). | — | `mvn -q compile` passes |  |  |
| TASK-002 | Wire metadata using phase-02 `ImageRegistry` (no generation here): `GET /api/images` serializes fresh-snapshot registry per call (demos + imports; never hardcoded); `GET /api/images/{id}/info` full `levelsDetail` from the SAME fresh snapshot (no stale-`get` window); `no-store`; `GET /healthz` 200 `OK` ONLY when scan done and demo `.ready` stores present; static MIME; 404 `..`/unknown. | TASK-001 | `curl /api/images/1/info` shows `"z":3` + 4 entries |  |  |
| TASK-003 | Create `NEW src/main/resources/web/index.html` (picker + HUD incl. `rxBytes`/`decodedBytes` split + `epoch`) + `NEW styles.css` + placeholder `NEW viewer.js` log (full viewer phase-06). Zero external refs. | TASK-001 | `curl -s /` contains `id="image"` + `id="rxBytes"` |  |  |
| TASK-004 | Self-contained validation on SPLIT LINES with LOUD readiness: build with Maven; own line `java -jar ... &` + `pid=$!` + `trap 'kill "$pid"' EXIT`; `ready=0` loop (≤40×2s) on `/healthz` then `[ "$ready" = "1" ] || { echo ...; kill "$pid"; exit 1; }`; `curl` set (static/info/404 + POST→405 with `Allow: GET`); every raw-socket probe ASSERTS its status line (a printed response proves nothing): duplicate-`Host`→`grep -q "400"`; absolute-form with matching authority→`grep -q "200"`; absolute-form with FOREIGN authority (`http://evil/` + `Host: localhost:8080`)→`grep -q "400"`; `Transfer-Encoding: chunked` on `/healthz`→`grep -q "400"`; `Content-Length: 1` on `/healthz`→`grep -q "400"`; duplicated `Content-Length: 0`+`Content-Length: 0`→`grep -q "400"`; each probe carries `|| { echo "<name> probe failed" >&2; kill "$pid"; exit 1; }`; `rg https?:// web/` empty. Never `kill %1`, never fixed `sleep`, never silent fall-through, never print-without-assert. | TASK-002 | full block green |  |  |

## Validation Commands

```sh
mvn -q compile
mvn -o -q clean package -DskipTests
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$pid"; exit 1; }
curl -s http://localhost:8080/api/images
curl -s -X POST http://localhost:8080/api/images -i | grep -E "405|Allow: GET"
printf 'GET /healthz HTTP/1.1\r\nHost: a\r\nHost: b\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "duplicate-Host probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET http://localhost:8080/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "200" || { echo "absolute-form probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET http://evil/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "foreign-authority probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "TE probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nContent-Length: 1\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "CL probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nContent-Length: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "dup-CL probe failed" >&2; kill "$pid"; exit 1; }
rg -n "https?://" src/main/resources/web/ || echo "no-external-refs"
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Header multiplicity is a security property: duplicate-`Host` and duplicate-`Content-Length` detection is IMPOSSIBLE after collapsing to single values — parse to lists first, validate, then select.
- Every retry loop in every phase carries an explicit loud-failure tail; silent fall-through to cleanup is forbidden. New v1.8 rule: every probe ASSERTS (print-then-continue proved nothing — the v1.7 duplicate-Host probe could print 200 and stay green).
- The global body gate runs BEFORE routing so no future route can accidentally accept a body; `/ws` inherits it (its "bodyless-only" rule is now a special case of the global invariant).
