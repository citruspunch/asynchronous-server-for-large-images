# E2E Report — UltraTile UTP/1.0

Normative spec: `docs/protocol/UTP-1.0.md` (wins over every other doc).

## Verdict table (offline validation track)

| Probe | Result |
| ----- | ------ |
| `mvn -o -q test` (codec, ceiling, sessions, handshake matrix) | PASS |
| `node scripts/test_viewer.cjs` (wire vectors, races, eviction) | PASS |
| `python3 scripts/test_e2e_parser.py` (12 vectors, 127-form offline) | PASS |
| `python3 scripts/check_const_parity.py` (Config + wire + shell + JS) | PASS |
| `python3 scripts/e2e_utp.py` (sealed supersede, Ping/Pong) | `E2E-OK sealed superseded completed` |
| 10x parallel E2E, per-child `wait "$child_pid"` | PASS, `rc==0` |
| Port-8080-free proof only after `wait "$server_pid"` | PASS, no leak |

## Memory envelope (UTP-1.0 §9 summary)

RETAINED (application-managed): 40 MiB RGBA-equivalent pixels + overhead,
12 MiB in-flight + 4 MiB queued compressed. TRANSIENT (UA socket, NOT
managed): up to 60 MiB pathological per legal 30-tile batch. Two ledgers,
never one total. Typical traffic is ~45–95 KiB/tile.

## Manual browser path (authoritative track)

`./build.sh` → `java -cp target/classes
com.ultratile.tiles.IngestTool 0 2048 2048` (+ id 1) → `java -jar
target/ultratile-1.0.jar` → open `http://localhost:8080/`, pick images
0/1, pan/zoom; tiles + HUD update; no console errors. Zoom 3→1: `effZ`
recorded, `rxBytes` rises, old bitmaps `close()`d. 2048 smoke-only.

## Notes

- 10x parallel E2E uses `server_pid`/`child_pid` naming (never bare `pid`);
  JVM is `wait`ed before the port-free proof (no race, no leak).
- Forbidden patterns, all avoided: vacuous END-wait (superseded gen-1 END
  never awaited), internal-counter asserts, bare-`wait`, `pid`-shadowing,
  `head -N`-on-upgrade (reads exactly through `\r\n\r\n`),
  `localhost`-connect-as-bind-proof (bind proven via `getBindAddress`).
