---
phase: phase-04-http-bootstrap
goal: GOAL-004 Strict lexical HTTP plus live metadata
status: 'Planned'
parent: ./overview.md
version: 1.12
date_created: 2026-09-15
last_updated: 2026-09-16
---

# Phase 04 — HTTP Bootstrap ![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

## Context

- Parent goal: UltraTile UTP/1.0 system — Java 21 tiling server + offline viewer + protocol doc
- Requirements for this phase:
  - **REQ-003**: Strict HTTP/1.1 subset with FROZEN lexical grammar
    (bytes-level, deliberately stricter than RFC 9112 where stated).
    - Head: read with `readFully` to `\r\n\r\n` (16 KB→431); bare `\n`
      ANYWHERE in the head →400 (exact CRLF only).
    - Request line: `method SP request-target SP HTTP/1.1` with
      `method = token` (generic per RFC 9112 — `POST`/`DELETE`/anything
      token-shaped parses lexically; method handling happens at the gate,
      NOT the grammar; only the version token is frozen to `HTTP/1.1`, a
      documented subset simplification — no 505). Lowercase `get` IS a valid
      token: it parses lexically and returns 405 at the method gate like any
      unknown method; only non-token methods die at the grammar with 400.
      Single SP separators (extra/missing whitespace →400); empty target
      →400.
    - Headers: `field-name ":" OWS field-value OWS` (colon glued to the name
      in notation AND parser — whitespace BEFORE `:` →400, smuggling
      ambiguity; name MUST be RFC 9110 `token` — empty/whitespace/control
      →400); lines beginning with SP/HTAB (obs-fold) →400; NUL or CTL (other
      than HTAB) in name or value →400; only SP/HTAB stripped at value
      edges.
    - `Content-Length` value strict ASCII `0-9` (empty/non-digit →400) parsed
      as `long` with overflow detection (overflow →400).
    - Absolute-form profile (frozen): plain `http` scheme only (anything
      else →400), no userinfo (`@` →400), no fragment (`#` →400), authority
      = normalized host/IP-literal plus optional numeric port; the
      normalized authority MUST equal the single Host value else 400
      (silent discard and RFC authority-replacement both rejected for this
      subset).
    - Exactly-one syntactically valid Host; headers as
      `Map<String,List<String>>` (multiplicity preserved; duplicates
      detected pre-collapse).
    - FROZEN gate order: lexical parse → header/Host validation → GLOBAL
      body-framing gate (before routing AND before the method gate: any
      `Transfer-Encoding` →400; `Content-Length`: zero headers → ok; exactly
      one `0` → ok; exactly one nonzero →400; MORE THAN ONE header →400
      unconditionally, even `0,0`) → method gate (`method.equals("GET")`
      else `405` + `Allow: GET` + close) → target routing. Consequences
      pinned by probes: bodyless `POST` →405, but `POST`+`Content-Length:
      1` →400 and `POST`+`Transfer-Encoding: chunked` →400.
    - `writeFully` loop; exact routes `/`, `/viewer.js`, `/styles.css`,
      `/api/images`, `/api/images/{id}/info`, `/healthz`, `/ws`;
      `Connection: close` except upgraded `/ws`.
    - For `/ws`: same global body gate (TE/any-`CL!=0`/duplicated-CL→400, no
      upgrade); preserve post-header bytes ONLY after bodyless valid upgrade
      (all other trailing bytes → close+discard, no pipelining).
    - API JSON bodies serialized through ONE shared `jsonEscape(String)`
      routine (quotes/backslash/CTL → backslash-u hex escapes; DEL left
      literal; non-ASCII passed through as UTF-8) used by BOTH `/api/images`
      and `/info` — registry canonical names make escaping
      defense-in-depth, not the primary defense.
  - **REQ-004**: Locally served frontend, offline; `resizeCanvas()` DPR=1
    before frustum math (viewer phase-06).
  - **CON-003**: Assets under `src/main/resources/web/`, correct MIME, no
    CDN.
  - **GUD-001**: `Cache-Control` split; FINE logs; HUD/E2E counters
    (`rxBytes` = UTP TILE `payloadLen`, vs `decodedBytes`) prove
    transfer+eviction.
- Prior-phase deps:
  - **DEP-003**: Requires phases 01 (pins, `Config`, stub, `build.sh`) + 02
    (`ImageRegistry` fresh-snapshot, per-ID demos + repair, strict bounded
    meta incl. canonical names).
- Inputs: phase-01 stub + phase-02 registry. Outputs: strict lexical HTTP +
  live metadata + readiness (no tile generation here).

## Tasks

### TASK-001 — Strict request handling in NioHttpServer

- Extend the phase-01 stub `NioHttpServer.handle`:
  - `readFully` to `\r\n\r\n` (16 KB→431; a lone `\n` in the scanned head
    →400 immediately); split head into CRLF-delimited lines (any line not
    CRLF-terminated inside the head →400).
  - Request-line grammar `method SP target SP HTTP/1.1` with generic-token
    `method` (see REQ-003 above — the grammar MUST NOT hard-code `GET` or
    the 405 path becomes unreachable).
  - Header grammar `field-name ":" OWS field-value OWS` into
    `LinkedHashMap<String,List<String>>` lowercase names — multiplicity
    PRESERVED (single-value collapse would defeat duplicate detection —
    v1.6 bug).
  - Exactly one syntactically valid `Host` value else 400 (covers
    missing/duplicate/invalid).
  - GLOBAL body-framing gate BEFORE the method gate (TE-any / CL-nonzero /
    duplicated-CL / CL-overflow →400); method gate
    (`!method.equals("GET")` → `405` + `Allow: GET` + close).
  - Absolute-form profile per REQ-003 (scheme/userinfo/fragment checks,
    authority==Host); `writeFully` loop; exact routes; `Connection: close`
    except upgraded `/ws`. For `/ws`: leftover kept only after bodyless
    valid upgrade.
- Done when: `mvn -q compile` passes (offline validation track).

### TASK-002 — Live metadata wiring

- Wire metadata using phase-02 `ImageRegistry` (no generation here):
  `GET /api/images` serializes the fresh-snapshot registry per call (demos +
  imports; never hardcoded) via shared `jsonEscape()`;
  `GET /api/images/{id}/info` full `levelsDetail` from the SAME fresh
  snapshot (no stale-`get` window) via the same routine; `no-store`.
- `GET /healthz` 200 `OK` ONLY when scan done AND `registry.get(0)` +
  `registry.get(1)` are BOTH valid entries (parsed metadata, not merely
  directories containing `.ready` — a corrupt demo must fail readiness, not
  serve half a gallery).
- Static MIME; 404 `..`/unknown.
- Done when: `curl /api/images/1/info` shows `"z":3` + 4 entries.

### TASK-003 — Placeholder frontend shell

- Create `NEW src/main/resources/web/index.html` (picker + HUD incl.
  `rxBytes`/`decodedBytes` split + `epoch` + `netCov`/`covCov`) +
  `NEW styles.css` + placeholder `NEW viewer.js` log (full viewer phase-06).
  Zero external refs.
- Done when: `curl -s /` contains `id="image"` + `id="rxBytes"`.

### TASK-004 — Asserting validation block (offline validation track)

- Self-contained validation on SPLIT LINES with LOUD readiness: build with
  Maven (offline validation track; authoritative track uses `./build.sh` —
  phase-07 rehearses both); own line `java -jar ... &` + `pid=$!` +
  `trap 'kill "$pid"' EXIT`; `ready=0` loop (≤40×2s) on `/healthz` then
  `[ "$ready" = "1" ] || { echo ...; kill "$pid"; exit 1; }`.
- `curl` set: static/info/404 + bodyless-POST→405 with `Allow: GET` +
  POST-with-`Content-Length: 1`→400 + POST-with-`Transfer-Encoding:
  chunked`→400 (the gate-order trio).
- Every raw-socket probe ASSERTS its status line with
  `|| { echo "<name> probe failed" >&2; kill "$pid"; exit 1; }`:
  duplicate-`Host`→400; absolute-form match→200; FOREIGN authority→400;
  `https://` scheme→400; `http://user@host/` userinfo→400; absolute-target
  with `#` fragment→400; `Transfer-Encoding: chunked`→400;
  `Content-Length: 1`→400; duplicated `CL: 0`+`CL: 0`→400.
- LEXICAL suite: `X : y` (space before colon)→400; obs-fold continuation
  line (` SP tail`)→400; bare-LF request line (`\n` endings)→400; NUL byte
  in a header value→400; `HTTP/1.0` version→400; malformed request line
  (`GET  /healthz` double space)→400; lowercase `get`→405 (unknown method,
  valid token — NOT 400); `rg https?:// web/` empty.
- Never `kill %1`, never fixed `sleep`, never silent fall-through, never
  print-without-assert.
- Done when: full block green (see Validation Commands).

## Validation Commands

Offline validation track:

```sh
mvn -q compile
mvn -o -q clean package -DskipTests
java -jar target/ultratile-1.0.jar & pid=$!; trap 'kill "$pid"' EXIT
ready=0; for i in $(seq 1 40); do curl -sf http://localhost:8080/healthz && { ready=1; break; } || sleep 2; done; [ "$ready" = "1" ] || { echo "server never ready" >&2; kill "$pid"; exit 1; }
curl -s http://localhost:8080/api/images
curl -s -X POST http://localhost:8080/api/images -i | grep -E "405|Allow: GET"
curl -s -X POST -H "Content-Length: 1" --data-binary "x" http://localhost:8080/api/images -i | grep -q "400" || { echo "POST-with-body probe failed" >&2; kill "$pid"; exit 1; }
printf 'POST /api/images HTTP/1.1\r\nHost: localhost:8080\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "POST-with-TE probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: a\r\nHost: b\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "duplicate-Host probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET http://localhost:8080/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "200" || { echo "absolute-form probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET http://evil/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "foreign-authority probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET https://localhost:8080/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "https-scheme probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET http://user@localhost:8080/healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "userinfo probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "TE probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nContent-Length: 1\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "CL probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nContent-Length: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "dup-CL probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nX : y\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "pre-colon-space probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\n X-fold: y\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "obs-fold probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz\nHost: localhost:8080\nConnection: close\n\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); s.settimeout(3); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "bare-LF probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.1\r\nHost: localhost:8080\r\nX-Bad: a\x00b\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "NUL-value probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET /healthz HTTP/1.0\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "version probe failed" >&2; kill "$pid"; exit 1; }
printf 'GET  /healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "400" || { echo "request-line probe failed" >&2; kill "$pid"; exit 1; }
printf 'get /healthz HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\n\r\n' | python3 -c "import socket,sys; s=socket.create_connection(('localhost',8080)); s.sendall(sys.stdin.buffer.read()); print(s.recv(200).decode(errors='replace').split(chr(13))[0])" | grep -q "405" || { echo "lowercase-method probe failed" >&2; kill "$pid"; exit 1; }
rg -n "https?://" src/main/resources/web/ || echo "no-external-refs"
kill "$pid"; trap - EXIT
```

## Notes for Implementer

- Header multiplicity is a security property: duplicate-`Host` and
  duplicate-`Content-Length` detection is IMPOSSIBLE after collapsing to
  single values — parse to lists first, validate, then select.
- Every retry loop carries an explicit loud-failure tail; every probe
  ASSERTS (print-then-continue proved nothing — the v1.7 duplicate-Host
  probe could print 200 and stay green).
- The framing gate runs BEFORE routing AND before the method gate so no
  future route can accidentally accept a body; `/ws` inherits it. The method
  gate is what produces 405 — the grammar must NOT pre-empt it by
  hard-coding `GET` (v1.9 contradiction).
- Lexical strictness is the anti-smuggling layer: with no
  pipeline/keep-alive ambiguity allowed (close + discard on any trailing
  bytes), every malformed head deterministically dies with 400 on a dead
  connection. Lone-`\n` rejection is FROZEN (TASK-001: the reader scans for
  it and 400s immediately), so the bare-LF probe asserts a real `400` line;
  its 3s client timeout is purely a hang-guard — an implementation that
  blocks instead of rejecting FAILS loudly here (no silent pass).
