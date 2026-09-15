---
phase: phase-02-http-bootstrap
goal: GOAL-002 Raw HTTP with exact channel semantics plus dual-demo metadata
status: 'Planned'
parent: ./overview.md
version: 1.3
date_created: 2026-09-15
last_updated: 2026-09-15
---

# Phase 02 — HTTP Bootstrap ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: Initial HTTP/1.1 serves static bundle + metadata; image control uses custom UTP/1.0 binary protocol over WebSocket (RFC 6455), fully documented with RFC references.
  - **REQ-004**: Frontend HTML/JS/CSS, all libs locally served; zero external requests; offline grading; canvas resize sets backing store to CSS pixels at DPR=1 before camera/frustum math.
  - **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no CDN.
  - **GUD-001**: `Cache-Control` static vs `no-store` metadata; FINE logs; HUD/E2E show bytes, active Z, reqs, evicts, decodes proving transfer+eviction.
- Prior-phase deps:
  - **DEP-001**: Requires phase-01 `pom.xml` + `Config` + compilable `NioHttpServer` + `build.sh`.
- Inputs: phase-01 skeleton. Outputs: exact HTTP semantics + dual-demo full-levels metadata, never advertising absent files.

## Tasks

| Task | Description (files:lines, functions, exact steps) | Depends on | Done when | Completed | Date |
| ---- | ------------------------------------------------- | ---------- | --------- | --------- | ---- |
| TASK-001 | Implement `NioHttpServer.handle(SocketChannel)` exact semantics in `NEW src/main/java/com/ultratile/net/NioHttpServer.java`: `readFully` until `\r\n\r\n` preserving any post-header bytes in `leftover ByteBuffer` for WS decoder (never discard); cap 16 KB else `431`; normalize header names lowercase; require exactly one `Host` (HTTP/1.1, else 400, byte-based `Content-Length` if present); exact route match `/`, `/viewer.js`, `/styles.css`, `/api/images`, `/api/images/{id}/info`, `/healthz`, `/ws` (no prefix fuzz); `writeFully(ByteBuffer)` loop until drained; `Connection: close` for HTTP, keep-alive only for upgraded `/ws`. | — | `mvn -q compile` passes |  |  |
| TASK-002 | Create `NEW src/main/java/com/ultratile/tiles/ImageRegistry.java`: `ImageInfo(id 0..65535,name,w 1..MAX_DIM,h,levels)`; `levelsFor` ceiling PAT-001 all Z0..N; startup ensures demos exist — if `data/images/0/meta.json` or `/1/meta.json` absent, invoke `IngestTool 0 2048 2048` and `IngestTool 1 4096 4096` (streaming, bounded) before serving; `list()` returns only ids with validated `meta.json` + spot-checked tile file present (never fallback metadata without files). | TASK-001 | `mvn -q compile` passes |  |  |
| TASK-003 | Wire metadata: `GET /api/images` lists `[{id:0,2048,levels:3,tile:512},{id:1,4096,levels:4,tile:512}]`; `GET /api/images/{id}/info` returns full `levelsDetail` (2048: Z0 1/Z1 4/Z2 16 tiles; 4096: +Z3 64 tiles, total 85); `no-store`; 404 unknown; `GET /healthz` → `OK`. | TASK-002 | `curl /api/images/1/info` shows `"z":3` + 4 entries |  |  |
| TASK-004 | Create `NEW src/main/resources/web/index.html` with picker `<select id="image">` + HUD `lod/bytes/reqs/evicts/cache/decodes` + `<canvas id="view">`; `styles.css`; placeholder `viewer.js` log. Zero external refs. | TASK-001 | `curl -s /` contains `id="image"` + `id="bytes"` |  |  |

## Validation Commands

```sh
mvn -q compile
mvn -o -q package -DskipTests && java -jar target/ultratile-1.0.jar &
sleep 2
curl -i http://localhost:8080/
curl -s http://localhost:8080/api/images
curl -s http://localhost:8080/api/images/1/info | grep -o '"z":3'
rg -n "https?://" src/main/resources/web/ || echo "no-external-refs"
kill %1
```

## Notes for Implementer

- Leftover bytes after `\r\n\r\n` belong to WS frames; pass them to `WsFrame` decoder, do not drop.
- Distribution model frozen: auto-generate at startup if absent (deterministic) AND `build` may pre-generate; listing requires files present.
- 2048 = smoke (21 tiles, cannot evict); 4096 = eviction demo (85 tiles).
