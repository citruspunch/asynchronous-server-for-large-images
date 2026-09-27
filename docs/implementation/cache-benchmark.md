# The cache workload benchmark

> What `scripts/cache_workload_benchmark.cjs` measures, how to run it, and what
> its numbers do and do not support.
>
> The cache design itself is owned by
> [viewer.md](viewer.md#the-lfuda-40-decoded-bitmap-cache). This document owns
> the harness, the workload definitions, the metric definitions, and the
> historical baseline fixture. Nothing here is a runtime dependency.

## LFUDA is the only production cache

UltraTile has exactly one replacement policy for the browser's decoded-bitmap
cache: **LFUDA**, capacity `MAX_CACHE = 40`, implemented by `LfudaCache` in
`web/js/structures.js`. There is no second implementation under `src/`, and no
runtime selector. There is no `?cache=lru` query parameter, no `--cache-policy`
flag, and no configuration key that changes the policy. The course requires each
group to use a distinct algorithm and another group holds LRU, so LRU is
absent from this repository as code.

The benchmark therefore measures the one policy that ships. It does not
reimplement LRU, and it must never grow a way to select a policy, because a
selector is how a distinct-algorithm requirement quietly stops being distinct.

### The historical LRU baseline is data, not code

`scripts/cache-baseline-lru.json` holds the numbers measured from the real
pre-migration `LruCache` bundle, captured before LRU was removed. It is a JSON
fixture. Nothing executes it, and regenerating it is impossible because the
bundle it came from is gone. It exists so the earlier comparative claims stay
auditable instead of becoming folklore.

## Why the harness exists

Three reasons, in order of importance.

**The LFUDA migration's evidence was not reproducible.** The comparative numbers
were produced by a harness that lived outside the repository, precisely because
it instrumented a copy of the bundle. That is a bad reason to keep a
measurement you intend to cite: nobody else can run it, and nobody can check it.

**Correctness tests and workload behaviour are different claims.**
`scripts/test_viewer.cjs` proves the policy is correct, with 20 unit vectors
against the exported class and 4 integration vectors against the wiring. It does
not, and cannot, tell you what the policy does over 130 viewport operations
against real tiles. This harness is the other half, and §
[The relationship to the viewer suite](#the-relationship-to-the-viewer-suite)
keeps the two from being confused.

**A grader should not have to take a number on trust.** Every workload here
reproduces bit-identically, including the decision signature, so "same source,
same workload, same LFUDA decisions" is checkable rather than asserted.

## What it exercises, and what it deliberately does not

The harness concatenates the ten shipped viewer modules, in the load order read
out of `web/index.html`, into one `node:vm` script. That is the same mechanism
`scripts/test_viewer.cjs` uses, and it means the modules share one global
lexical scope exactly as deferred `<script>` tags make them in a browser. The
harness then calls the production functions:

| Production component | How the harness uses it |
| --- | --- |
| `boot()`, `selectImage()` | the only way an image is selected |
| `installHandlers()` input path | every pan and zoom is a real `pointerdown` / `pointermove` / `pointerup` / `wheel` DOM event delivered to the listener the viewer installed |
| `visibleTileRange()`, `effectiveLOD()`, `selectLevel()` | read to size steps, to calibrate, and to compute the protected target union |
| `runViewportBatches()` → `markNeeded()` | the only path that raises a frequency; the hit and miss counters are its product |
| `cacheSnapshot()` | the existing test seam, for per-entry frequency, priority, `insertedSeq` and protection |
| HUD counters | `updateHud()`'s own output, read through the stub `document` |
| `MAX_CACHE`, `UNION_CAP`, `INTENT_DEBOUNCE_MS`, `TILE` | read out of the running bundle with `vm.runInContext`, not restated in the harness |

It does **not** reimplement `visibleTileRange`, `effectiveLOD`,
`requestableKeys`, the epoch machinery, batch planning, or `LfudaCache`. A pure
key-list LFUDA simulator would be easy to write and would prove nothing about
this system, because the interesting part is the interaction between the camera,
the LOD downgrade, the protection set and the replacement policy.

Two things are stubbed, and both are outside the production path: `fetch` and
`WebSocket` are real, while the DOM and `createImageBitmap` are fakes. A real
decode of the 46 MB these sessions receive would measure the host, not the
policy; the policy depends on object identity and `close()`. The decode stub
resolves in call order, so decode completion order equals submit order, which is
what makes the admission sequence reproducible.

### The one production seam this needed

`UltraTile.cameraState()` in `web/js/state.js` is a read-only observer added for
this harness. The camera is module-private, and a viewport-operator benchmark has
to know where the camera is in order to decide the next operation. The
alternatives were both worse: re-deriving the camera from `visibleTileRange()`
quantises it to a tile, and re-implementing the pointer and wheel arithmetic in
the harness would be a second copy of production behaviour. It reads state that
already exists, it moves nothing, and no control flow reads it, which is the same
discipline `cacheSnapshot()` already follows.

Notably, the harness does **not** use a new metrics seam. It reads the HUD, which
is the instrumentation the application already ships. Adding a second counter
source would have created a second thing to keep true.

## Workloads

Four canonical workloads, defined in the harness and pinned to published image
dimensions:

| id | image | dimensions | viewport |
| --- | ---: | --- | --- |
| `image-4-1080p` | 4 | 10000 x 7533 | 1920 x 1080 |
| `image-5-1080p` | 5 | 25000 x 18832 | 1920 x 1080 |
| `image-6-1080p` | 6 | 40000 x 30131 | 1920 x 1080 |
| `image-6-4k` | 6 | 40000 x 30131 | 3840 x 2160 |

Dimensions are pinned deliberately. A workload whose published image is the
wrong size is a **failure**, not a substitution: if image 6 is not on the server
the workload is skipped with a `SKIP` line naming the import command, and a demo
image is never quietly used in its place.

### Traces

Workloads are expressed as viewport operations, not tile keys: select image, set
viewport, pan by a distance, zoom to a scale, recentre, switch image. Each
operation dispatches its input and then waits for exactly one debounced viewport
intent. The nine traces, in order:

| Trace | Operations |
| --- | --- |
| `pan left x3 then right x3` | 3 steps left, 3 right, recentre |
| `pan right x3 then left x3` | 3 right, 3 left, recentre |
| `small back-and-forth x10` | 10 x (one step out, one step back) |
| `zoom ladder x2, pan, back, revisit` | x4, 4 steps, x2, 3 diagonal steps, back to base, 4 steps, recentre |
| `serpentine 6 cols x 5 rows` | 6 alternating columns per row, 5 rows, one row step between |
| `wide sweep 20 steps` | 20 steps, recentre |
| `vertical sweep 14 steps` | 14 steps, recentre |
| `deep zoom revisit ladder` | x8, x4, x2, x1 then x1, x2, x4, x8, a step at each, recentre |
| `image switch out and back` | to image 4 and back |

A **step** is two tiles of world travel at the level the viewport is currently
serving, so a step is a fixed fraction of what is on screen rather than a fixed
pixel count. Sweeps reverse at 75 % and 25 % of the image extent so they keep
finding new ground instead of grinding along an edge; the serpentine uses 80 %
and 20 %.

`recenter` moves the camera to the image centre, which is the anchor all the
traces return to.

### Calibration

Before the measured section, the harness sweeps 91 scales, `2^(-7 + i * 0.2)`,
through the real wheel handler and keeps the scale whose `effectiveLOD` asks for
the most tiles, which is the operating point that stresses the cache hardest. On
the real ladder that is always 24 keys per viewport.

Zooming about the viewport centre leaves the camera centre where it is, so the
sweep needs no settle per sample: the handlers are synchronous and the debounce
coalesces all 91 wheels into one intent. As a side effect it is a free check that
rendering never moves a frequency, because every sample redraws the cache.

The calibration grid is not a free parameter. It decides which level every later
step pans at, so changing it changes the workload. An earlier version of this
harness used a different grid and produced numbers that could not be compared
with anything; the grid is now pinned and the chosen scale is reported.

## Metric definitions

Cache-policy metrics and network metrics are separate, and the distinction is
load-bearing.

### Cache policy, from the viewer's own counters

| Metric | Definition |
| --- | --- |
| `viewport_needs` | `cache_hits + cache_misses`: keys the viewport asked the cache about, one `markNeeded` per key per epoch |
| `cache_hits` | keys the cache already held when a new epoch needed them. Each hit is also at most one frequency for that tile |
| `cache_misses` | keys a new epoch needed and the cache did not hold |
| `evictions` | `cache.evicts`, cumulative, survives `clear()` |
| `lfuda_age_*` | the aging watermark: final, peak at an epoch boundary, number of decreases, largest decrease |

**A miss is not a fetch.** A miss can correspond to a key already pending or in
flight, which `requestableKeys()` filters out before requesting. That is exactly
why re-fetches are counted from the wire and not from this counter.

### Network, counted from the wire

The harness subclasses the real `WebSocket` and inspects every inbound TILE frame
before the viewer sees it, parsing the 24-byte header itself.

| Metric | Definition |
| --- | --- |
| `re_fetches` | a TILE frame whose `image:z:x:y` key was already successfully transferred earlier in the session |
| `re_fetch_bytes` | the sum of those frames' `payloadLen` |
| `re_fetches_excl_image_switch` | the same, but the "already transferred" history restarts at every `selectImage()` |
| `rx_bytes` | the viewer's own `rxBytes`: sum of TILE `payloadLen`, duplicates included |
| `decoded_bytes` | the viewer's `decodedBytes`: payload bytes at cache insert. A payload counter, not a memory counter |
| `wire_tile_frames` | TILE frames observed, for cross-checking |

Two re-fetch metrics, deliberately. The strict one keeps the whole session's
history, so the `image switch out and back` trace contributes to it even though
`cache.clear()` makes those fetches a cost of switching images rather than of the
replacement policy. The switch-excluded one isolates the policy cost by
restarting history at each switch. Neither replaces the other; the gap between
them is the cost of `clear()`.

`rx_bytes` is cross-checked against the harness's own wire total, and a
disagreement is a hard failure. Byte totals are **observational**: they depend on
the libvips and JPEG versions that built the pyramid, so a re-import on a
different machine will produce different numbers from the same source image. No
byte total is ever asserted.

## Hard invariants and observational metrics

The benchmark fails on the first list and only reports the second.

**Hard, and enforced at every epoch boundary:**

- the cache never exceeds `MAX_CACHE` (40)
- `age` is a non-negative integer, and the age an entry was last written at is
  non-negative
- `priority >= frequency` for every entry
- at most one reference per viewport epoch: a key cannot gain more frequencies
  than the number of epochs that elapsed
- `insertedSeq` strictly increases along the Map's admission order
- `cacheSnapshot()` agrees with the HUD on size, hits, misses and evictions
- the harness's own wire byte total agrees with the viewer's `rxBytes`
- every bitmap is `close()`d at most once, and decodes balance against closes
  plus still-open bitmaps, which is the leak check
- every key an epoch received from the wire is still cached when that epoch
  settles, which is the viewport-protection contract observed end to end
- the protected target stays below the capacity, and `UNION_CAP` stays below
  `MAX_CACHE`

**Observational, and never a pass/fail gate:** wall time, throughput, JPEG byte
totals, re-fetch counts, miss counts, and the size of any improvement over the
historical baseline. Historical comparative values are evidence about one
session, not protocol requirements, and the regular test suite does not run this
harness at all.

### The `age` watermark is not monotone, and the benchmark says so

`age` is assigned the priority of each victim. Viewport protection can hold an
entry below the current watermark: a key that was protected while the watermark
rose past it keeps its old priority, and when the target moves on, that key
becomes the lowest-priority candidate and the assignment lowers `age` again. The
trend is strongly upward and each dip is re-climbed immediately, so the
harness counts decreases and reports the largest one as
`lfuda_age_largest_dip` rather than treating them as faults. Observed on the
real ladder: 2 to 11 decreases per session, largest 14 to 26.

An earlier version of this harness asserted that `age` never decreases. It
failed, and the failure was real. The rule is `age = victim.priority`, not
`age = max(age, victim.priority)`; see
[viewer.md](viewer.md#the-lfuda-40-decoded-bitmap-cache) for what that means for
the policy and why it has not been changed.

## The decision signature

Each viewport operation contributes one line to the signature:

```text
epoch,requested,hits,misses,evictions,size,age
```

and the whole sequence is hashed with FNV-1a into eight hex digits. Only fields
that are a function of the workload and the policy go in. No timing, no byte
totals, no wall clock, no host-dependent anything. Two runs of the same source
against the same workload produce the same signature, and a change to the policy
changes it.

Signatures are also asserted structurally: every viewport operation must advance
the epoch by exactly one. A workload that did not do that would not be
deterministic, and the harness stops rather than reporting unstable numbers.

## How to run it

```sh
node scripts/cache_workload_benchmark.cjs
```

That is the whole interface. It needs images 4, 5 and 6 published (see
[grading-preflight.md](../grading-preflight.md)) and a JDK on `PATH`. It starts
`target/ultratile-1.0.jar` itself if nothing is answering on `:8080`, and stops
it afterwards.

```sh
node scripts/cache_workload_benchmark.cjs --list              # ids and dimensions
node scripts/cache_workload_benchmark.cjs --image 6           # one image
node scripts/cache_workload_benchmark.cjs --viewport 3840x2160
node scripts/cache_workload_benchmark.cjs --json --out bench.json
node scripts/cache_workload_benchmark.cjs --base http://127.0.0.1:8080 --no-spawn
node scripts/cache_workload_benchmark.cjs --keep-server
```

`--no-compare-baseline` suppresses the historical side-by-side.

### Example output

```text
CACHE-WORKLOAD image-6-1080p
image=6 (40000x30131) viewport=1920x1080 policy=LFUDA-40 capacity=40 union_cap=36
epochs=139 viewport_operations=131 viewport_needs=2575
hits=2154 misses=421 evictions=400
refetches=254 refetch_bytes=26457969 refetches_excl_image_switch=247
rx_bytes=46017731 decoded_bytes=46017731 requests=81
peak_cache=40 final_cache=7 lfuda_age=0 lfuda_age_peak>=136 lfuda_age_dips=10 largest_dip=19
decodes=459 bitmaps_closed=452 bitmaps_open=7
signature=cf7c7714  (per viewport operation: epoch,requested,hits,misses,evictions,size,age)
historical-baseline Lru-40 workload_comparable=false misses=220 evictions=175 re_fetches=52 re_fetch_bytes=5630992 rx_bytes=26556454
historical-degenerate-traces=3 (small back-and-forth x10, serpentine 6 cols x 5 rows, wide sweep 20 steps)  -- side-by-side only, NOT a delta; see docs/implementation/cache-benchmark.md
invariants capacity_never_exceeded=true age_is_non_negative_integer=true priority_never_below_frequency=true age_at_update_non_negative=true at_most_one_reference_per_epoch=true inserted_seq_strictly_increasing=true snapshot_agrees_with_hud=true wire_rx_bytes_agrees_with_viewer=true no_bitmap_closed_twice=true decode_close_balance=true protected_target_survived_its_epoch=true union_cap_below_capacity=true aging_was_engaged=true
PASS

CACHE-BENCH-OK 4 workload(s), 0 invariant failures
```

A full run is about five minutes, dominated by the settle window after each of
roughly 130 operations per workload.

## Results

Measured on the published ESO pyramids, 2026-09-27, with the canonical harness:

| Workload | ops | needs | hits | misses | evict | re-fetches | re-fetch bytes | rxBytes | peak | age peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `image-4-1080p` | 131 | 2486 | 2134 | 352 | 331 | 244 | 26.57 MB | 39.47 MB | 40 | >=122 |
| `image-5-1080p` | 132 | 2254 | 2063 | 191 | 170 | 93 | 8.98 MB | 20.00 MB | 40 | >=80 |
| `image-6-1080p` | 131 | 2575 | 2154 | 421 | 400 | 254 | 26.46 MB | 46.02 MB | 40 | >=136 |
| `image-6-4k` | 131 | 2584 | 2144 | 440 | 400 | 286 | 27.16 MB | 44.58 MB | 40 | >=124 |

Signatures: `a9c3b97e`, `42043f8f`, `cf7c7714`, `5f3dd845`. All four reproduce
exactly across independent runs, and so does every metric above including the
byte totals.

What this shows: the cache fills to exactly 40 and holds there, sustains a hit
rate of 82 to 92 % of viewport needs, ages actively, and never leaks a bitmap or
exceeds its bound. `image-6` at 1920x1080 and at 3840x2160 ask for the same 24
keys per viewport, which is the `UNION_CAP` result described in
[viewer.md](viewer.md#why-the-4k-viewport-is-not-actually-tight-any-more): a
larger window does not mean a larger request.

## The historical comparison, and why it is not a delta

The harness prints the historical LRU-40 numbers side by side and
deliberately never differences them.

The pre-migration harness had a sign error. Its `recenter` passed
`(anchor - camera)` to a pointer handler that *subtracts* the delta, which
reflects the camera about the anchor instead of moving it to it. The camera
therefore did not return to the image centre, drifted into clipped image
corners, and three of the nine traces became degenerate:

| Trace | misses | evictions | re-fetches | visible keys at trace end |
| --- | ---: | ---: | ---: | ---: |
| `small back-and-forth x10` | 0 | 0 | 0 | 24 |
| `serpentine 6 cols x 5 rows` | 0 | 0 | 0 | 6 |
| `wide sweep 20 steps` | 0 | 0 | 0 | 6 |

Six keys means the viewport was clipped against an image corner, where a
two-tile step keeps revisiting the same handful of tiles. Those three traces are
about 51 of the roughly 128 viewport operations in the session, contributing
nothing at all.

Two consequences, and both matter.

**The earlier "LFUDA re-fetches 30 to 44 % fewer tiles than LRU-40" claim is
internally consistent but externally weak.** Both halves came from the same
harness in the same session shape, so their comparison is apples to apples. But
roughly 40 % of that session's operations contributed nothing to it, and the
camera was not where a user would have put it. The number has not been
withdrawn, because it was measured, and
`docs/implementation/known-limitations.md` records the qualification. It should
be read as "on that session, LFUDA re-fetched less", not as a workload-level
result.

**This harness's workload is harder, not better.** With a correct recenter it
explores roughly 50 % more tiles per session, so its re-fetch counts are
naturally much larger than the baseline's. That is a property of the workload,
not of the policy, and it is exactly why the two are not subtracted.

The canonical harness cannot produce an LFUDA-versus-LRU verdict, because LRU
does not exist to measure. A grader who wants that verdict needs to restore the
old bundle and run both through *this* harness's workload; that is possible,
because the workload is a definition rather than a program, and it is recorded
here in full.

## How to interpret results

Reasonable to conclude:

- the policy is deterministic and its decisions are reproducible from the
  signature
- occupancy is bounded at 40, protection holds, and bitmaps are not leaked
- aging is genuinely active on real workloads
- behaviour is characterised per trace, so a regression points at a trace

Not reasonable to conclude:

- that LFUDA is better than LRU. There is no comparable LRU measurement
- that these byte totals are requirements. They move when the pyramid is rebuilt
- that this workload is representative of users. It is nine scripted traces
- anything about the 28, 55 and 93 GB evaluator images. These are the 409, 2470
  and 6270-tile rungs

## The relationship to the viewer suite

```text
scripts/test_viewer.cjs            proves the cache is correct
scripts/cache_workload_benchmark.cjs   shows what it does on real workloads
```

`test_viewer.cjs` owns correctness: 20 LFUDA vectors including the one that
proves the policy is not least-recently-used, plus the `UNION_CAP` structural
invariant. It runs in `node:vm` with no network, takes about three minutes, and
is part of the offline validation track.

This harness owns behaviour. It needs a live server and the real pyramids, takes
about five minutes, and is not part of any test suite. It deliberately does not
duplicate the unit vectors; where the tiers, the tie-break, the admission guard
and the aging rule need proving, `test_viewer.cjs` is where that lives. The one
exception is the end-to-end protection contract in
[Hard invariants](#hard-invariants-and-observational-metrics), which no unit
vector can state because it is a property of the whole pipeline.
