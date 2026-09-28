# Known limitations

> These are unresolved constraints of the current implementation, collected in
> one place so they are not rediscovered. Each entry says what was observed, what
> the impact is, and where the detail lives.
>
> This document is not a to-do list. An entry stays until the code or the
> surrounding design changes, and then it goes away.

## Storage and integrity

### `.ready` is a publication marker, not integrity

A `.ready` file records that the importer validated the staged tree before
publishing it. It is not a checksum, and nothing re-validates the tile tree
afterwards. Verified behavior: deleting `data/images/N/level-*` while leaving
`.ready` and `meta.json` in place leaves the image discoverable and servable, with
missing tiles surfacing as END `skipped`. Re-running the importer does not repair
it, because a ready target short-circuits to `already-ready` and exits 0.

Impact: a partially deleted published pyramid is neither invisible nor
self-healing. Repair procedure in
[operations.md](operations.md#repair-a-corrupted-published-image); integrity
checking is `verify_pyramid.py`'s job.

### Atomic publication depends on the filesystem

The Java importer now **requires** `ATOMIC_MOVE` and refuses to publish without
it, so a filesystem that cannot do a same-filesystem atomic rename fails loudly
instead of degrading to a copy. The shell importer uses plain `mv` between
siblings, which POSIX `rename(2)` performs atomically, but it does not verify
that. Guarantee table in
[tile-pyramid-and-storage.md](tile-pyramid-and-storage.md#the-atomicity-guarantee-precisely).

Impact: an unusual external filesystem (some network and exFAT-family mounts)
either refuses the import or, on the shell path, would cross-copy silently.

### Source size does not predict pyramid size

There is no planning constant, and the importer deliberately does not attempt
one. The 4 KiB-per-tile free-space check is a minimum-impossibility floor:
passing it does not mean the pyramid will fit. See
[Disk planning](../grading-preflight.md#2-disk-planning) for the three measured
ladder ratios and why they do not generalize.

## Import

### Java `IngestTool` CLI has no `--data-root`

`IngestTool.main()` always resolves the base from `Config.DATA_ROOT`, so the
external-volume workflow is reachable from the command line only through
`scripts/import_vips.sh`. Calling `IngestTool.runSynthetic(base, ...)` or
`runImage(base, ...)` from code, as the tests do, is the only Java-side route to
a custom root.

### The importer does not reject fallback loaders

`import_vips.sh` detects loader problems only by letting `vipsheader` fail, so
it cannot distinguish "no loader" from "a loader that will decode the whole
image". A fallback loader silently defeats the streaming property the path
depends on. The check is documented as an operator step
(`vipsheader -f vips-loader`) rather than enforced in the script.

### Post-pad dominates import time

The post-pad pass is `O(perimeter)`, not `O(area)`, and is the slowest phase on
the real ladder. Edge tiles per level sum to roughly the sum of `cols + rows`
across levels.

## Server

### `/healthz` is demo readiness, not liveness

It answers 200 only when **both** synthetic demo 0 and demo 1 resolve through the
registry. A server correctly serving only real images 4, 5, and 6 answers 503.
Use `/api/images` as a general check.

### No deadlines or keepalive

There is no read timeout on a WebSocket session, no keepalive ping timer, and no
per-client quota. A browser tab left open holds two virtual threads and a socket
until the client goes away or the process exits. Deliberate for a trusted-LAN
demo scope, and the first thing to add for anything else.

### The "asynchronous" question is unresolved

Concurrency is blocking `SocketChannel` I/O on Java 21 virtual threads, not
selector-based non-blocking async. Recorded as an open instructor question in
[UTP-1.0.md](../protocol/UTP-1.0.md) §8. If explicit selector async is required,
the change is confined to `net/` and `ws/`, and the protocol does not move.

## Viewer

### The 4K cache symptom is gone, for a reason unrelated to the policy

An earlier version of this file claimed that a 3840 x 2160 CSS-pixel viewport at
scale 1.0 needs about 40 tiles, which is exactly the cache capacity, so one
visible tile is evicted and re-fetched. That symptom could not be reproduced on
the real image-6 ladder under either replacement policy, and the reason is
`UNION_CAP`, not the cache: `effectiveLOD()` caps the union of visible tiles at
36, which is below `MAX_CACHE = 40`, so a single viewport can never overflow the
cache. The largest single-viewport request measured on image-6 was 24 tiles at
both 1920x1080 and 3840x2160. See
[viewer.md](viewer.md#why-the-4k-viewport-is-not-actually-tight-any-more).

What is left is a real but different effect: the cache does reach 40 and does
evict, because a long session accumulates history across viewport epochs, and
the re-fetch rate on that history is where the replacement policy actually shows
up. On the pre-migration measurement session, LFUDA re-fetched 30 to 44 % fewer
tiles than the previous LRU-40, with miss and eviction counts within about 4 %
either way.

That comparison needs its qualification. The harness that produced it had a sign
error in its `recenter` step, which reflected the camera about the image centre
instead of moving it there, so the camera drifted into clipped image corners and
three of the nine traces recorded zero misses, zero evictions and zero
re-fetches. The two halves came from the same harness in the same session shape,
so the comparison between them stands, but roughly 40 % of that session's
operations contributed nothing to it. No comparable LRU measurement exists now,
because LRU no longer exists as code; those numbers are preserved in
`scripts/cache-baseline-lru.json`, and current non-degenerate LFUDA measurements
are in [cache-benchmark.md](cache-benchmark.md#results). What this supports is
"on that session, LFUDA re-fetched less", not a workload-level result.

`MAX_CACHE` was deliberately left at 40. Nothing measured here implicates the
capacity, so there is no evidence for raising it, and the memory cost is linear.

### An entry can sit below the aging watermark

`age` is a monotonic watermark, maintained as `max(previousAge, victimPriority)`.
That does **not** mean every cached entry sits at or above it. A key written
early and then held below the rising floor by viewport protection keeps its old
priority until the target moves on. It is the cheapest candidate, so it is
evicted first once it becomes eligible, and the watermark does not move. That is
the aging working as intended, not a defect, and it is described in
[viewer.md](viewer.md#the-lfuda-40-decoded-bitmap-cache).

The practical consequence for anyone reading `cacheSnapshot()`: do not assume
`entry.priority >= cache.age`. Read `entry.priority - entry.frequency` instead,
which is the watermark as it stood when that entry was last written and is
guaranteed to be a value the watermark actually took.

### `covCov` is a weak signal

It is computed over the union of visible tiles at **all** levels while only one
effective level is fetched, so it reads low in normal operation. It is
observational only; control flow never waits on it. `netCov` is the
network-progress counter.

## Testing

### No load data above ten clients

The pipeline harness defaults to ten concurrent clients, and the largest run
recorded in the E2E report used five. Behavior at hundreds of clients is
extrapolated from the fact that per-session cost is constant, not measured.

### No measurement at evaluator scale

The largest pyramid built in this repository is 6,270 tiles and 902 MB. The
17 / 28 / 55 / 93 GB tiers are unmeasured; everything known about them is
extrapolation from the derivation plus the ladder. See
[grading-preflight.md](../grading-preflight.md) for the procedure.

### No long-duration soak

Nothing exercises a session that idles for hours, and nothing exercises
filesystem behavior at tens of terabytes.

### No browser automation

The viewer suite runs the concatenated modules in `node:vm` with injected fakes
for `fetch`, `WebSocket`, `createImageBitmap`, and the DOM. It exercises logic
and state machines but not real canvas, real decode, or real network behavior.
The manual browser pass in the preflight document is what covers those.

### The atomic-move failure branch is not unit-tested

Requiring `ATOMIC_MOVE` means there is now a failure path that needs a
filesystem refusing atomic rename to exercise. No such filesystem is available
in this repository, so the test pins the success path and the completeness of the
published tree, and the refusal itself is verified only by inspection.
