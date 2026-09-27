# Testing

> This document describes how the system is currently tested, and what each axis
> of testing does and does not prove.
>
> For the recorded results of one validation run, see
> [`docs/protocol/E2E-REPORT.md`](../protocol/E2E-REPORT.md). That file is not
> duplicated here; it goes stale faster than anything written from scratch.

## Two frozen tracks

The distinction is deliberate and load-bearing. One track is what the grading
machine can be assumed to run. The other is everything we use to be confident.

### Authoritative track

The only assumptions allowed here: a JDK 21 and standard Unix userland (`bash`,
`find`, `cp`, `rm`, `mkdir`, `jar`). No Maven, no Node, no Python, no curl, no
ripgrep.

```sh
./build.sh                                  # -> target/ultratile-1.0.jar
java -jar target/ultratile-1.0.jar          # loopback 127.0.0.1:8080
```

`build.sh` is `javac`, `cp`, and `jar`, and nothing else. The jar is
self-contained: the viewer is served out of it from `src/main/resources/web/`.
Startup generates demo images 0 and 1 if absent, so there is no install step.

Then a human opens `http://localhost:8080/`, picks an image, pans and zooms, and
watches tiles and the HUD respond with no console errors. That is the whole
contract, and it is a small one on purpose.

### Offline validation track

Everything scripted. Usable fully disconnected, given a primed `~/.m2` cache for
`mvn -o`.

```sh
mvn -o -q test                            # 126 JUnit tests
mvn -o test -Dtest=SessionTest            # one class
node scripts/test_viewer.cjs              # 42 viewer tests, ~3 min
python3 scripts/test_e2e_parser.py        # 12 frame-parser vectors
python3 scripts/check_const_parity.py     # Java <-> shell <-> JS constants
```

Against a **running** server on port 8080:

```sh
python3 scripts/e2e_utp.py                            # E2E-OK sealed superseded completed
python3 scripts/ws_handshake_check.py --expect 101   # also --no-subprotocol, --extra-header, --version
```

With libvips and the real sources:

```sh
python3 scripts/real_pipeline_test.py --images 6 --clients 10 --seam
python3 scripts/verify_pyramid.py --all
python3 scripts/measure_import.py
python3 scripts/crash_recovery_test.py
```

## The JUnit suite

126 tests across seven classes. Run with `mvn -o -q test`; the whole suite is a
few seconds.

| Class | Tests | Covers |
| --- | ---: | --- |
| `ws/SessionTest` | 39 | The frozen UTP session rules, the writer lock, close ordering, the handshake matrix |
| `tiles/PyramidLimitTest` | 23 | The derived representability limit, the tile-cap derivation, long arithmetic, registry/importer agreement |
| `tiles/TileMathTest` | 20 | Ceiling pyramid math, canonical paths, the ready gate, quarantine, strict metadata, the ImageIO path |
| `proto/UtpCodecTest` | 16 | Golden packet round-trips, u32 discipline, dedupe-aware admission |
| `ws/WsFrameTest` | 15 | Client frame parsing, minimal-length enforcement, the Close-code validator, the inbound cap |
| `DataRootTest` | 9 | CLI option parsing, a custom data root, atomic publication inside one root |
| `MainTest` | 4 | Bind defaults, refusal of typos, loopback not wildcard |

### The tests worth reading first

`SessionTest` names its cases after the rule they freeze, so the test names
function as an index of the protocol's awkward decisions:

| Test | Rule it pins |
| --- | --- |
| `historyBeforeValidation` | Staleness is decided before validation, so a late packet for a since-removed image is stale, not invalid |
| `invalidNewerSplit` | An invalid-newer CHUNK records and survives; an invalid-newer COMMIT closes immediately |
| `bad9Valid9Resurrection` | A refused reqId can never later be accepted |
| `noEvict64Then65thCloses` | A 65th live rejected ID closes instead of evicting a live one |
| `centerFirstOrder` | The exact center-first work ordering |
| `coalescedStress20` | Twenty seals collapse to at most one dispatch |
| `lockAdmissionShutdown` | No data frame starts after a Close, under the lock |
| `closeSentClosedSplit` | `closeSent` and `closed` are separate, with `closed` owned by `closeSession()` alone |
| `noChannelCloseOnCancel` | Cancellation lands at a frame boundary |
| `dispatcherFatalWakesReader` | Teardown wakes both threads, in both directions |
| `emptyCommitDispatchesEnd00` | An empty COMMIT flows through the same coalesced slot and emits `END 0,0` |
| `formatNeverTwo` | WebP is parsed and never emitted |

`PyramidLimitTest` is the executable form of the two limit decisions.
`oldCeilingIsNowAnOrdinaryImage` asserts 262144 x 262144 is accepted at 349,525
tiles; `onePixelPastTheLimitIsRefusedWithTheCoordinateReason` asserts the refusal
names the coordinate range and does not say "too large";
`totalTilesExceedsIntRangeAtTheProtocolLimit` asserts `long` is mandatory;
`registryIsMorePermissiveThanTheImporter` asserts the registry/importer
relationship across eleven probe widths.

Two of its cases are about the operational cap rather than representability.
`tileCapIsDerivedNotArbitrary` pins `IMPORT_MAX_TILES` to 2^24 exactly, asserts it
is a power of two so the intent stays legible instead of drifting to an arbitrary
literal, asserts more than 100x headroom over the 9 gigapixel VVV mosaic
(45,252 tiles), and asserts headroom over the brief's 400 gigapixel figure.
`realLadderImagesAreAllWellUnderTheCap` asserts all four real dimensions, the VVV
mosaic included, are admitted.

`TileMathTest.noTilePrefixLiteralsOutsideStore()` walks `src/main/java` and fails
if any file other than `PyramidTileStore` contains the string `level-`. That is
the mechanism keeping tile naming single-sourced.

## The viewer suite

`node scripts/test_viewer.cjs`, 42 tests, roughly three minutes, zero
dependencies. It concatenates the ten viewer modules into one `node:vm` script so
the shared lexical scope behaves as deferred script tags make it behave in a
browser, then tests against that.

Covered: golden wire vectors, the 4002 close discipline, allocator exhaustion and
reconnect, single-owner image switching, the A-B-A and late-A races, resize during
fetch, empty registry, stale versus valid FORMAT=2, stale END and stale TILE
discards, `netCov` versus `covCov`, `BatchState` reclamation, terminal and skipped
keys becoming requestable next epoch, LRU eviction under a serpentine sweep, zoom
out raising `rxBytes` and recording `effZ`, headroom gating, and `clearRect`
running before any tile draw.

Two of the slow tests are the interesting ones:
`tiny-tile streaks plan against the floor` and `mean governs once avgTileBytes
clears the floor` are what stop the budget computation from being wrong in either
direction, and `serpentine pan sweep evicts` and `zoom out raises rxBytes, records
effZ, closes more bitmaps` are what pin the cache and disposal behavior under
realistic navigation.

## The Python probes

`scripts/test_e2e_parser.py` is 12 vectors against the frame parsers in
`e2e_utp.py`, with no server: 126-form and 127-form exact recovery, both
minimal-length rejections, both minimal boundaries accepted on the
server-to-client path, a masked server frame rejected, a 64-bit high bit rejected,
truncated streams raising `NeedMore` rather than hanging, masked client frame
recovery, and the pinned Accept derivation.

`scripts/e2e_utp.py` needs a running server. It drives the public wire contract
only: handshake, masked chunk/COMMIT/ABORT sends, one generation-1 TILE, a
superseding generation 2, generation-2 TILE and END collection, and Ping/Pong.
It asserts nothing about server internals, and in particular it never waits for
the superseded generation-1 END. Success prints
`E2E-OK sealed superseded completed`.

`scripts/ws_handshake_check.py` sends a raw upgrade and reads exactly through
`\r\n\r\n`, asserting the status. `--expect 400` with `--no-subprotocol`,
`--extra-header`, or `--version` covers the rejection matrix.

## Parity is a test, not a style choice

`python3 scripts/check_const_parity.py` is the mechanism that keeps four copies of
each shared number from drifting. It reads two Java owners, so asserting a tuning
constant against the wire file fails and vice versa.

It also enforces the things that are easy to regress silently:

- `Config.DATA_ROOT` and the shell importer's default must be the identical
  string, or an import publishes where the server does not look. The shell must
  accept `--data-root`.
- `MAX_DIM` must not exist in `Config`, and the literal `262144` must not appear
  in `Config`, in `UtpMessages`, or in the non-comment lines of `import_vips.sh`.
  The representability derivation is recomputed independently rather than trusted
  from a comment.
- `IMPORT_MAX_TILES` is pinned to 16777216 in `expect_ints`, so the Java constant,
  the shell copy, and the JUnit pin must all move together.
- `MAX_TILES_PER_AXIS` must be the symbolic `MAX_TILE_COORD + 1`, and
  `maxRepresentableDim()` must derive from `Config.TILE_SIZE`.
- `totalTiles` must be declared `long`.
- `QUEUE_CAP` must be gone.
- The old `web/viewer.js` monolith must not reappear.
- The bare `serverSkipped` identifier must be extinct; only
  `serverSkippedThisEpoch` exists.
- No module may contain `http://`, `https://`, or `cdn`.
- `index.html` must load the ten scripts in the same order as `JS_FILES`.
- `PLAN_FLOOR` must stay outside the parity map.
- The viewer must never contain `ws.close(1002` or a codeless `ws.close()`.

If you change a shared constant, run this first. It is faster than the tests that
would otherwise catch the same drift by accident.

## Real-image validation

The three imported ESO pyramids form a deliberate size ladder.

| ID | Source | Dimensions | Levels | Tiles | Pyramid | What it adds |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 4 | 248 MB | 10000 x 7533 | 6 | 409 | 50 MB | The smallest real image. Proves the pipeline on a file a laptop can hold. |
| 5 | 1.65 GB | 25000 x 18832 | 7 | 2,470 | 349 MB | A source that genuinely does not fit in a normal heap budget. |
| 6 | 4.21 GB | 40000 x 30131 | 8 | 6,270 | 902 MB | The largest imported, and the one with the most levels. |

They are the same mosaic at three downsample factors, so the ladder is a clean
scaling series. All three load through `tiffload`, a streaming loader, and all
three are LZW-compressed (TIFF tag 5), 8 bits/sample, 3 bands. Import wall time
was 7, 19, and 39 seconds, with
peak RSS of 100, 172, and 252 MB. The falling RSS-to-raw-RGB ratio (46 %, 13 %,
7 %) is measured evidence consistent with bounded, demand-driven processing
rather than whole-raster decoding. It is not a proof, and it is specific to these
three inputs with a streaming `tiffload`.

Each rung is verified by `scripts/verify_pyramid.py`, which is deliberately
independent of the importer: it re-derives the expected geometry from the source
dimensions and checks the **published** tree against it, so a bug shared between
importer and verifier is unlikely.

Per image it asserts `.ready` present; `meta.json` field-for-field against the
source; exact level count and per-level extents; the exact expected tile
coordinate set with nothing unexpected; every tile within `(0, 2 MiB]`; every tile
header reading 512x512; every edge tile fully decoded with its pad verified as a
step at the right offset (black from the computed content offset, content
top-left, pad right and bottom); a sample of interior tiles decoded and confirmed
non-blank; no duplicate payloads within a level; and seam-gradient sanity on the
finest level.

The pad assertion is worth a note. An exact-zero check on the pad region was tried
and produced 30 false failures on a correct pyramid, because Q85 JPEG rings the
8x8 DCT block straddling the content/pad boundary: the worst single pad pixel
measured on image 6 is 23.33 of 255, with a median of 13.33. The check that is
both meaningful and correct is a step at the right offset, asserted on the region
**mean** (under 2.0) rather than on the peak.

`scripts/real_pipeline_test.py` then drives the actual wire against a running
server using the real pyramids: corners and centre at levels 0, half, and finest;
exact tile-set accounting against END; no tile outside the requested rectangle; no
duplicates; generation supersession; mid-session image switching with a check that
no tile from the previous image arrives afterwards; seam continuity across the
delivered mosaic; and N concurrent clients with server RSS sampled before and
after.

A run against image 6 at the finest level (79 x 59) does 256-tile corner and
centre viewports in 107 to 200 ms each, and five concurrent 8x8 clients complete
64 tiles each in about 50 ms apiece, 320 tiles and 49.9 MB in 0.06 s wall. It also
reports the frame-boundary race happening in practice: supersession discarded 5
already-sent generation-1 TILEs with the socket open, which is the documented
behavior rather than a fault.

## The axes are separate on purpose

No single test proves scalability. Correctness and scale are tested along
independent axes, and a weakness in one is not covered by strength in another.

| Axis | What proves it | What it cannot prove |
| --- | --- | --- |
| Importer correctness on real content | `verify_pyramid.py --all` | Anything about dimensions beyond 40000 x 30131 |
| Huge dimensions, header-only | `PyramidLimitTest`, all `long` math, `PyramidPlan.describe()` | That a pyramid of that size would build; no such pyramid exists |
| Realistic tile payload size | the ESO ladder, ~120 to 175 KB per tile | That a noisy satellite image at the same dimensions would be the same size |
| Concurrency | `real_pipeline_test.py --clients 10`, `coalescedStress20` | Behavior at 1000 clients; the model is trusted to be linear |
| Protocol correctness | `UtpCodecTest`, `WsFrameTest`, `SessionTest`, `test_e2e_parser.py`, `e2e_utp.py` | Behavior against a hostile peer; that is out of scope by design |
| Disk scalability | the `--data-root` relocation, the importer's free-space floor, the `long` tile counts | Filesystem behavior at tens of terabytes |
| Import crash safety | `crash_recovery_test.py`, 9 kill points | A power cut during the final `rename` on a filesystem without atomic rename |
| Evaluation-scale images | the 28, 55, and 93 GB sources the evaluator is expected to use | They are not in this repository, so nothing here is measured on them |

The important caveat is the last one. The largest real pyramid built here is
6270 tiles and 902 MB. Everything known about the 28, 55, and 93 GB cases is
extrapolation from the derivation plus the per-tile measurements on the ladder.

### Why a synthetic pyramid is not a substitute

The synthetic importer produces a gradient plus a 32-pixel checker, and that
compresses to about 15 KB per tile at Q85. The real ESO content at the same
settings produces 120 to 175 KB per tile, roughly ten times more. A synthetic
pyramid is an excellent test of geometry, naming, padding, metadata, and the
publish sequence, because those do not depend on content. It is a poor test of
payload size, network behavior, decode time, or the browser's memory envelope,
because all four of those do.

Both are used, for these different jobs. The demos are synthetic so that startup
is fast and dependency-free. The ladder is real so that everything content-shaped
is measured rather than assumed.

## Running everything

```sh
# 1. Authoritative build, from clean.
./build.sh

# 2. JUnit.
mvn -o -q test

# 3. Parity, before anything else if you touched a constant.
python3 scripts/check_const_parity.py

# 4. Parser self-test, no server needed.
python3 scripts/test_e2e_parser.py

# 5. Viewer, slow.
node scripts/test_viewer.cjs

# 6. Server plus wire probes.
java -jar target/ultratile-1.0.jar &
server_pid=$!
# ... wait for the port before probing; never assume it is up ...
python3 scripts/e2e_utp.py
python3 scripts/ws_handshake_check.py --expect 101
python3 scripts/ws_handshake_check.py --expect 400 --no-subprotocol
wait "$server_pid"

# 7. Real-image probes. These need libvips and data/sources/.
python3 scripts/verify_pyramid.py --all
python3 scripts/real_pipeline_test.py --images 6 --clients 10 --seam
```

The `wait "$server_pid"` before the port-free check is not optional politeness.
Probing before the JVM is up produces a confusing connection refusal that looks
like a server bug.

## What is not tested

- No load test above ten clients.
- No browser-automation test. The viewer suite runs in `node:vm` with injected
  fakes for `fetch`, `WebSocket`, `createImageBitmap`, and the DOM, so it
  exercises logic and state machines but not real canvas, real decode, or real
  network behavior. The manual browser smoke on the authoritative track is what
  covers that.
- No long-running soak. Nothing exercises a session that idles for hours.
- No hostile-peer or fuzz input beyond the vectors named above.
- No coverage of the filesystem paths an evaluator's 93 GB import would take
  (the data root relocation is tested, at small scale).
