# AGENTS.md

Working instructions for coding agents on this repository. Concise on purpose:
if a fact is not here and an agent would plausibly get it wrong, it belongs in
`docs/`, not in this file.

## What this is

UltraTile: a Java 21 server that serves ultra-high-resolution images as
512x512 JPEG tiles over a custom protocol, plus an offline browser viewer.

- **Runtime**: JDK 21 only, plus standard Unix userland. No framework, no
  runtime dependency to install.
- **Wire protocol**: UTP/1.0, a custom binary protocol over WebSocket. There is
  deliberately no HTTP tile route.
- **Viewer**: ten classic `<script defer>` files, one shared global scope, no
  bundler, no CDN, no network fetch of anything not served by this server.
- **Image import**: `scripts/import_vips.sh` (libvips) is the only path that
  scales past RAM. The Java `ImageIO` path is a capped convenience fallback.

## Commands

```sh
./build.sh                          # authoritative build -> target/ultratile-1.0.jar
mvn -o -q test                      # JUnit suite (needs a primed ~/.m2)
python3 scripts/check_const_parity.py   # shared-constant parity, Java <-> shell <-> JS
node scripts/test_viewer.cjs        # viewer suite (slow, no deps)
python3 scripts/test_e2e_parser.py  # WS frame-parser vectors, no server needed
```

Against a running server on :8080:

```sh
python3 scripts/e2e_utp.py                          # prints E2E-OK ...
python3 scripts/ws_handshake_check.py --expect 101
python3 scripts/ws_handshake_check.py --expect 400 --no-subprotocol
python3 scripts/real_pipeline_test.py --images 6 --clients 5
```

Run `java -jar target/ultratile-1.0.jar`, then `curl -s localhost:8080/api/images`
to confirm it is up. Do not count tests from memory; the counts drift.

## Documentation authority

Exactly one owner per fact. Do not duplicate a fact into a second document; link
to its owner instead.

| Fact | Owner |
| --- | --- |
| UTP wire and application semantics | `docs/protocol/UTP-1.0.md` (normative; wins over everything) |
| One dated validation snapshot | `docs/protocol/E2E-REPORT.md` |
| Current constants, limits, and their owners | `docs/implementation/configuration-and-limits.md` |
| Current architecture and behavior | `docs/implementation/*.md` |
| Unresolved constraints | `docs/implementation/known-limitations.md` |
| How to run things | `docs/implementation/operations.md` |
| Evaluator-image procedure and tiers | `docs/grading-preflight.md` |
| Historical reasoning | `docs/plans/` (deliberately superseded) |

## Read before editing

Do not skip this. Pick the row that matches the subsystem and read both files.

| Touching | Read first |
| --- | --- |
| UTP, sessions, wire, close codes, handshake | `docs/protocol/UTP-1.0.md`, then `docs/implementation/websocket-and-sessions.md` |
| Importer, pyramid math, storage, metadata | `docs/implementation/image-import.md`, `docs/implementation/tile-pyramid-and-storage.md`, `docs/implementation/configuration-and-limits.md` |
| Viewer JS, epochs, LOD, decode, cache | `docs/implementation/viewer.md` |
| HTTP parser, routing, JSON endpoints | `docs/implementation/http-server.md` |
| Concurrency, threads, memory envelope | `docs/implementation/concurrency-and-memory.md` |
| Build, CLI, runtime, scripts | `docs/implementation/operations.md` |
| Any test harness change | `docs/implementation/testing.md` |

`presentation/` is a separate Vite/React slide deck with its own
`AGENTS.md`. It is not part of the server and is not built by `build.sh`.

## Traps

These are the things that break silently.

- **The authoritative build must stay JDK-only.** `build.sh` is `javac`, `cp`,
  and `jar`. Never make Maven, Node, Python, curl, or ripgrep a build or runtime
  requirement. They are offline-validation tooling.
- **The viewer must stay offline-clean.** No CDN, no external URL, no fetch of
  anything outside this server. `check_const_parity.py` enforces it.
- **Never delete or modify `data/sources/`.** Those ESO TIFFs are the only copy
  of that data and are protected test inputs. The pyramids under
  `data/images/` are regenerable; the sources are not.
- **Shared constants live in four places**: the owning Java file
  (`Config.java` for tuning, `proto/UtpMessages.java` for wire values),
  `web/js/constants.js`, `scripts/import_vips.sh` where applicable, and the
  `expect_ints` table in `check_const_parity.py`. Change all of them, then run
  parity. Owner separation is enforced: a tuning name in the wire file fails.
- **The viewer module list is triplicated**: the `<script defer>` tags in
  `web/index.html`, `VIEWER_FILES` in `scripts/test_viewer.cjs`, and `JS_FILES`
  in `scripts/check_const_parity.py`. A new or renamed module goes in all three.
  Load order is semantic, since these files share one global lexical scope.
  `web/viewer.js` was a removed monolith; it must not come back.
- **Do not reintroduce an arbitrary `MAX_DIM`.** Representability is derived:
  `UtpMessages.maxRepresentableDim()`. `check_const_parity.py` fails if the
  identifier or the old literal reappears in `Config`, `UtpMessages`, or the
  non-comment lines of `import_vips.sh`.
- **Protocol representability is not practical importability.** The tile cap
  (`Config.IMPORT_MAX_TILES`) is operational importer policy, is NOT enforced by
  `ImageRegistry`, and is not a wire limit. Keep the two separate in prose and
  in error messages.
- **Never use Java `ImageIO` for huge-image import.** `ImageReader.read(0)`
  materializes the whole image, which is why that path is capped at 8192 px and
  16 MP. Real images go through `import_vips.sh`.
- **Keep IDs and tile paths single-sourced.** IDs are canonical decimal
  `0..65535` (`01` is rejected in Java, in the shell, and by the registry); build
  every path with `Integer.toString(id)`. `tileRelativePath` is the only tile
  naming algorithm, enforced by `TileMathTest.noTilePrefixLiteralsOutsideStore`.
- **`import_vips.sh` must keep running under the bash 3.2 that macOS ships.** No
  `mapfile`, no `${var,,}`, no associative arrays. Use the
  `${a[@]+"${a[@]}"}` idiom for possibly-empty arrays under `set -u`.
- **Preserve file modes.** `build.sh` and the scripts in `scripts/` (except
  `test_viewer.cjs`) are 755 with the bit committed; Java sources are 644.
- **Stale TILEs across a supersession are legal.** UTP/1.0 §4 allows a TILE whose
  frame already started to finish. Tests must assert the client classifies and
  discards it with the socket open, never that such a frame cannot be observed.
- **Changing UTP wire or lifecycle behavior requires updating
  `docs/protocol/UTP-1.0.md` and the interoperability tests together.** The spec
  is normative; code and spec must not diverge.

## Before finishing

- Run the narrow tests for the subsystem you changed.
- Run `python3 scripts/check_const_parity.py` if any shared constant, the viewer
  module list, or a viewer file changed.
- Run `./build.sh`.
- Update the owning document in `docs/implementation/` when behavior changed.
  Do not update `docs/protocol/UTP-1.0.md` unless normative behavior changed.
- Do not edit `docs/plans/` to make it look current. It is history.
- Report which commands you actually ran, and anything you did not run.
