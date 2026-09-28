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

Optional evidence, never a gate (needs images 4/5/6; ~5 min):

```sh
node scripts/cache_workload_benchmark.cjs
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
- **`data/sources/` is protected by default, but reclaimable under disk
  pressure.** Those ESO TIFFs are the ESO VVV public-survey mosaic (Paranal /
  VISTA, published by ESO; provenance recorded in
  `docs/grading-preflight.md`), so they are re-obtainable rather than a unique
  capture. Treat them as expensive to replace, not as untouchable. Reclaim in
  this order, and never out of order:
  1. `data/images/.stale-tmp-*` -- quarantined staging, never published, always safe.
  2. `data/images/<id>` -- pyramids, regenerable from the source in minutes.
  3. `data/sources/*.tif` -- **only** when a pyramid for that id is published and
     verified, and the space is genuinely needed because an evaluator tier will
     not fit.
  Never delete a source while its pyramid is the only copy of that image, and
  never remove `meta.json` or `.ready` from a published image. Reclaiming a
  source costs the ability to re-validate that image against its own header, so
  `verify_pyramid.py` falls back to `meta.json` and says so loudly.
- **The browser cache is LFUDA-40, and LRU is forbidden here.** The course
  requires a distinct replacement algorithm per group and another group holds
  LRU. The policy is Least Frequently Used with Dynamic Aging: a frequency and
  a priority per entry, a global `age` watermark raised to each victim's
  priority, and a victim chosen by lowest priority then oldest `insertedSeq`.
  Three traps in `LfudaCache`:
  - **Never reintroduce recency.** No recency list, no reordering on read, and
    never recency as the equal-priority tie-break. `render()` uses `peek()`.
  - **A frequency is a viewport epoch, not a render.** `markNeeded(key, epoch)`
    is the only thing that raises a frequency, and it is rate-limited by
    `lastCountedEpoch`. The browser redraws a cached bitmap hundreds of times
    per pan; counting those measures the redraw rate, not reuse.
  - **Protection is eligibility, not frequency.** `protectTarget()` and the
    `z === 0` pin decide *who may be evicted*; LFUDA decides *who loses*. Never
    encode viewport relevance into a fake frequency. `MAX_CACHE` stays 40;
    changing the policy is not a reason to change the capacity, and
    `Config.CACHE_CAP` must move with it or parity fails.
  - **`age` is a monotonic watermark: `max(age, victim.priority)`.** Textbook
    LFUDA writes `age = victim.priority`, which only ever rises because it
    assumes the victim is the global minimum. Viewport and `z === 0`
    protection break that assumption, so a protected key can end up below the
    watermark; the `max` is the minimal adaptation that keeps the floor from
    receding. Never revert it to a bare assignment, and never assert
    `entry.priority >= age`: a protected entry may legitimately sit below the
    floor. `docs/implementation/viewer.md` owns why.
  - **The historical LRU numbers are a data fixture, not a code path.**
    `scripts/cache-baseline-lru.json` records the pre-migration measurements. It
    is never executed and cannot be regenerated. Do not add an LRU class, a
    policy flag, or a `?cache=` parameter to make it live; a policy selector is
    exactly how the distinct-algorithm requirement stops being distinct.
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
- **Preserve file modes.** `build.sh` and the scripts in `scripts/` are 755 with
  the bit committed, except the `.cjs` harnesses (`test_viewer.cjs`,
  `cache_workload_benchmark.cjs`), which are 644 and run as
  `node scripts/<name>.cjs`. Java sources are 644.
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
- **There is exactly one source of truth per fact, and design history is not
  kept.** `docs/plans/` was deleted on purpose: a superseded plan that still
  names a constant, a class or a test count is a second source of truth waiting
  to be wrong. Do not reintroduce it, and do not add a "current state" summary
  anywhere else. When behavior changes, the as-built document in
  `docs/implementation/` is updated in the same change; if the reasoning behind
  a decision is worth keeping, it belongs in that document as a paragraph, not
  in a parallel tree.
- Report which commands you actually ran, and anything you did not run.
