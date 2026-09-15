---
phase: phase-04-http-bootstrap
goal: GOAL-004 Strict HTTP-subset plus live metadata plus readiness
status: 'Planned'
parent: ./overview.md
version: 1.5
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 04 — HTTP Bootstrap ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: Honest HTTP/1.1 subset (origin-form + absolute-form normalization, exactly-one valid Host, `writeFully`/`readFully`, leftover bytes kept only after bodyless valid upgrade) serves static + metadata; UTP/1.0 over RFC 6455 documented.
  - **REQ-004**: Locally served frontend, offline; `resizeCanvas()` DPR=1 before frustum math (viewer phase-06).
  - **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
  - **GUD-001**: `Cache-Control` split; FINE logs; HUD/E2E counters prove transfer+eviction.
- Prior-phase deps:
  - **DEP-003**: Requires phases 01 (pins, `Config`, stub, `build.sh`) + 02 (`ImageRegistry`, `.ready` demos) — this ordering fixes the v1.4 forward compile edge.
- Inputs: phase-01 stub + phase-02 registry. Outputs: strict HTTP + live metadata + readiness (no tile generation here).

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Implement `NioHttpServer.handle` strict subset in `src/main/java/com/ultratile/net/NioHttpServer.java` (extend phase-01 stub): `readFully` to `\r\n\r\n` (16 KB→431); lowercase header map; exactly one syntactically valid `Host` else 400; origin-form + absolute-form (normalize absolute URI→path+query, reject others 400); byte-based `Content-Length` (conflicting/multiple→400); `writeFully` loop; exact routes `/`,`/viewer.js`,`/styles.css`,`/api/images`,`/api/images/{id}/info`,`/healthz`,`/ws`; `Connection: close` except upgraded `/ws`. For `/ws`: reject `Transfer-Encoding`/any-`CL!=0`/conflicts (400, no upgrade); preserve post-header bytes ONLY after bodyless valid upgrade (else discard with channel). | — | `mvn -q compile` passes |  |  |
| TASK-002 | Wire metadata using phase-02 `ImageRegistry` (no generation logic here — demos already ensured): `GET /api/images` serializes live registry per call (demos + any imports; never a hardcoded array); `GET /api/images/{id}/info` full `levelsDetail`; `no-store`; `GET /healthz` 200 `OK` ONLY when registry scan done and demo `.ready` stores present (readiness semantic for E2E loops); static MIME (html/js/css/utf-8, json); 404 `..`/unknown. | TASK-001 | `curl /api/images/1/info` shows `"z":3` + 4 entries |  |  |
| TASK-003 | Create `NEW src/main/resources/web/index.html` (picker `<select id="image">` + HUD `lod/effZ/bytes/reqs/evicts/cache/decodesB/gen`) + `NEW styles.css` + placeholder `NEW viewer.js` log (full viewer phase-06). Zero external refs. | TASK-001 | `curl -s /` contains `id="image"` + `id="effZ"` |  |  |
| TASK-004 | Self-contained validation: build, `java -jar ... & pid=$!; trap 'kill "$pid"' EXIT`, readiness loop (≤40×2s) on `/healthz`, `curl` set (static/info/404), absolute-form probe via python raw socket expecting `HTTP/1.1 200`, `rg https?:// web/` empty. Never `kill %1`, never fixed `sleep`. | TASK-002 | full block green |  |  |

## Validation Commands

```sh
mvn -q compile
mvn -o -q package -DskipTests && java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && break || sleep 2; done
curl -s http://localhost:8080/api/images
curl -s http://localhost:8080/api/images/1/info | grep -o '"z":3'
printf 'GET http://localhost:8080/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])"
rg -n "https?://" src/main/resources/web/ || echo "no-external-refs"
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Subset honesty: origin-form + absolute-form only; document as project-needed HTTP/1.1 subset (RFC 9112), not full conformance.
- Readiness loop + `pid=$!` + `trap` is the frozen lifecycle for every later validation block (portable, no job control).
