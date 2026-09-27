# E2E Report — UltraTile UTP/1.0

> **This is a dated snapshot, not a current status page.** It records one
> validation run. For current behavior see
> [`docs/implementation/`](../implementation/README.md); for the normative
> contract see [`UTP-1.0.md`](UTP-1.0.md), which wins over this file.

Normative spec: [`docs/protocol/UTP-1.0.md`](UTP-1.0.md).

## Snapshot identity

| Field | Value |
| --- | --- |
| Date | 2026-09-27 |
| Git revision | working tree at `5f7e22a` ("test: harden viewer planning and union vectors") plus uncommitted changes |
| OS | macOS 26.6.2 (build 25G83), APFS |
| JDK | OpenJDK 21.0.11 (Homebrew) |
| libvips | 8.18.7 (only for the real-image probes) |
| Python | 3.14 |
| Images under test | 0 and 1 (synthetic demos), 4, 5, 6 (real ESO ladder) |

The working tree carried uncommitted changes at the time of this run, so the
revision alone does not identify the state. The commands below, plus the code
they exercise, are the fuller description.

## Commands run

```sh
./build.sh
mvn -o -q test
node scripts/test_viewer.cjs
python3 scripts/test_e2e_parser.py
python3 scripts/check_const_parity.py
python3 scripts/e2e_utp.py                                    # needs a server
python3 scripts/ws_handshake_check.py --expect 101            # needs a server
python3 scripts/ws_handshake_check.py --expect 400 --no-subprotocol
python3 scripts/real_pipeline_test.py --images 6 --clients 5  # needs a server
python3 scripts/verify_pyramid.py 6                           # needs libvips
python3 scripts/verify_pyramid.py --all                       # whole real ladder
python3 scripts/crash_recovery_test.py                        # needs libvips
python3 scripts/measure_import.py 4 5 6                       # needs libvips, re-imports
```

## Verdict table

| Probe | Result |
| ----- | ------ |
| `./build.sh` | PASS, `target/ultratile-1.0.jar` produced |
| `mvn -o -q test` (codec, pyramid, sessions, handshake, data root) | PASS, 127 tests, 0 failures, 0 errors |
| `node scripts/test_viewer.cjs` (wire vectors, races, eviction) | PASS, 42 tests |
| `python3 scripts/test_e2e_parser.py` (12 vectors, 127-form offline) | PASS |
| `python3 scripts/check_const_parity.py` (Config + wire + shell + JS) | PASS, `parity-ok` |
| `python3 scripts/e2e_utp.py` (sealed supersede, Ping/Pong) | `E2E-OK sealed superseded completed` |
| `python3 scripts/ws_handshake_check.py --expect 101` | `handshake-ok 101` |
| `python3 scripts/ws_handshake_check.py --expect 400 --no-subprotocol` | `handshake-ok 400` |
| `python3 scripts/ws_handshake_check.py --expect 400 --version 8` | `handshake-ok 400` |
| `python3 scripts/real_pipeline_test.py --images 6 --clients 5` | PASS, 0 failures |
| `python3 scripts/verify_pyramid.py 6` | PASS, 0 failures, 0 warnings |
| `python3 scripts/verify_pyramid.py --all` (images 4, 5, 6) | PASS, 0 failures, 0 warnings |
| `python3 scripts/crash_recovery_test.py` (9 kill points) | PASS, 0 failures |
| `python3 scripts/real_pipeline_test.py --images 4,5,6 --clients 10 --seam` | PASS, 0 failures, 45 viewports |
| 10x parallel E2E, per-child `wait "$child_pid"` | PASS, `rc==0` |
| Port-8080-free proof only after `wait "$server_pid"` | PASS, no leak |

Test counts in this table describe this run. They are not a property of the
project and will drift; the commands are the contract, not the numbers.

## The real ladder (import -> registry -> protocol)

Three real ESO Milky Way TIFFs, the same mosaic at three downsample factors.
None is modified; they are the only copy of that data. All three load through
`tiffload` (streaming, not a whole-image fallback) and are LZW, so the source
is close to raw size. Measured with `scripts/measure_import.py`:

| | image-4 | image-5 | image-6 |
| --- | --- | --- | --- |
| source bytes | 247,623,888 | 1,647,002,712 | 4,212,364,900 |
| dimensions | 10000x7533 | 25000x18832 | 40000x30131 |
| raw RGB | 0.23 GB | 1.41 GB | 3.62 GB |
| levels expected / actual | 6 / 6 | 7 / 7 | 8 / 8 |
| tiles expected / actual | 409 / 409 | 2,470 / 2,470 | 6,270 / 6,270 |
| import wall clock | 7.2 s | 19.2 s | 39.1 s |
| **peak import RSS** | **100 MB** | **172 MB** | **252 MB** |
| RSS as share of raw | 46 % | 13 % | **7 %** |
| pyramid on disk | 50 MB | 349 MB | 902 MB |
| pyramid as share of raw | 22 % | 25 % | 25 % |
| avg / median / p95 / max tile | 119/128/149/154 KB | 138/146/165/172 KB | 140/147/165/173 KB |
| `dzsave`+transform / post-pad / validation | 1/5/1 s | 6/12/1 s | 18/19/2 s |

The RSS share FALLING as the image grows is the load-bearing result: libvips
memory tracks its strip/tile working set, not the image, so nothing decodes a
whole image. Import cost is dominated by `dzsave` and then the post-pad pass,
which is O(perimeter) not O(area) -- 66 / 171 / 272 edge tiles re-encoded
respectively, at ~70 ms per `vips embed` process.

Re-importing an already-published id is a no-op: identical tile bytes and an
unmodified `meta.json` mtime, so published pyramids are immutable.

## Real-image results (image 6, 40000 x 30131, 6270 tiles)

From the `real_pipeline_test.py` run:

| Probe | Result |
| --- | --- |
| 256-tile corner and centre viewports, finest level | 107–200 ms each, 29–43 MB each, `skipped=0` |
| Supersession | 5 already-sent generation-1 TILEs discarded, socket open, generation 2 completed at 16 tiles |
| 5 concurrent clients, 8x8 each | 64 tiles per client, ~50 ms each, 320 tiles and 49.9 MB in 0.06 s wall |
| Server RSS after the whole run | 55 MiB, delta +5 MiB |
| 10 concurrent clients, images 4/5/6, 45 viewports incl. seam checks | PASS, 0 failures; 640 tiles and 101.4 MB in 0.10 s (1.06-1.35 GB/s) |
| Server RSS across the 10-client run | 49 MiB before, 65 MiB after, delta +16 MiB |

`verify_pyramid.py 6` reported `.ready` present, `meta.json` exact, the exact
6,270-tile set, 272 edge tiles decoded with 280 pad checks passed, 174 interior
tiles decoded, and seam continuity with a median ratio of 0.57 and worst 4.83
over 12 seams.

The five discarded stale TILEs in the supersession probe are the expected
frame-boundary behavior described in UTP-1.0 §4, not a defect: a TILE whose
frame already started before the supersession still arrives, and the client
discards it by generation.

## Memory envelope (UTP-1.0 §9 summary)

RETAINED (application-managed): 40 MiB RGBA-equivalent pixels plus overhead, plus
12 MiB in-flight and 4 MiB queued compressed, bounded by cache and queue caps
rather than by image size. TRANSIENT (UA socket, NOT managed): up to 60 MiB for
one pathological legal 30-tile batch. Two ledgers, never one total.

Observed tile payload sizes in this run, by corpus. There is no single "typical"
value, because tile size is content-dependent:

| Corpus | Observed range | Mean | Median |
| --- | --- | ---: | ---: |
| Synthetic demos (image 0/1, smooth gradient) | ~15–17 KB | 15–16 KB | 16 KB |
| Real ESO ladder (images 4/5/6) | ~6–173 KB | 119–140 KB | 128–147 KB |

## Import crash recovery

`scripts/crash_recovery_test.py` SIGKILLs the whole import process group at nine
moments spanning `dzsave`, the tree transform, edge padding, validation and
pre-publication, then asserts the invariants and re-runs. All nine pass:

| Invariant | Result |
| --- | --- |
| a published `<id>/` never exists without `.ready` | held at every kill point |
| the registry never adopts partial data | held (only ready + valid metadata) |
| a previously-ready image is never damaged | held (sentinel image byte-count identical) |
| re-run after a kill recovers | 65/65 tiles, correct `meta.json`, every time |
| quarantined staging stays bounded | 2 dirs after 9 crashes, retention `ULTRASTILE_STALE_TMP_KEEP` |

## Space policy is two-tier, and the gap matters

`import_vips.sh` reports both tiers because JPEG Q85 tile size is
content-dependent and cannot be predicted from source size:

- hard **floor** 4 KiB/tile -- refuses only what cannot possibly fit;
- **planning** figure 128 KiB/tile, the measured real median -- warns, never refuses.

A 45,252-tile image "needs" 185 MB by the floor, so the floor alone would wave
through an import whose real output is ~6 GB and which then dies of ENOSPC
partway, leaving a quarantined `.stale-tmp-*` tree. The planning tier is what
catches that, and the pre-flight also reports bytes already held by quarantined
staging.

## Manual browser path (authoritative track)

`./build.sh` → `java -cp target/classes com.ultratile.tiles.IngestTool 0 2048
2048` (and id 1) → `java -jar target/ultratile-1.0.jar` → open
`http://localhost:8080/`, pick images 0/1, pan/zoom; tiles and HUD update with no
console errors. Zoom 3→1: `effZ` recorded, `rxBytes` rises, old bitmaps `close()`d.
2048 is a smoke test only. No browser automation exists in this repository, so
this step is manual by necessity and was not re-run for this snapshot.

## Notes

- 10x parallel E2E uses `server_pid`/`child_pid` naming (never bare `pid`); the
  JVM is `wait`ed before the port-free proof (no race, no leak).
- Forbidden patterns, all avoided: vacuous END-wait (a superseded generation-1
  END is never awaited), internal-counter asserts, bare `wait`, `pid`-shadowing,
  `head -N`-on-upgrade (reads exactly through `\r\n\r\n`), and
  `localhost`-connect-as-bind-proof (bind proven via `getBindAddress`).
- The two coordinate bounds stay distinct: `MAX_IMAGE_ID = 0xFFFF` is a u16 wire
  width, `MAX_TILE_COORD = 65535` is a policy bound on u32 fields. An earlier
  revision wrongly claimed the tile-key packing `(x << 32) | y` forced
  `x < 2^31`; that was measured false (it round-trips over all of u32) and the
  claim has been removed from code, spec and tests.
- Peak import RSS and per-image pyramid sizes are recorded separately in
  [`docs/implementation/concurrency-and-memory.md`](../implementation/concurrency-and-memory.md)
  and are not repeated here.
