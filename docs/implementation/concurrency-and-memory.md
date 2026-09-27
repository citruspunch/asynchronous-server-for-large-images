# Concurrency and memory

> This document describes the current concurrency model and the memory envelope
> as implemented. Where the two disagree, the code is authoritative.
>
> For the UTP lifecycle rules this concurrency exists to serve, see
> [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md) §5 and §8.

## The concurrency model, stated plainly

UltraTile uses **blocking I/O on Java 21 virtual threads**, one virtual thread
per unit of work. It is not selector-based non-blocking async, and it is not
`AsynchronousServerSocketChannel`. JEP 444 distinguishes these, and naming the
distinction is more useful than blurring it.

```text
main thread                     parked on Thread.currentThread().join()
server accept VT                blocked in ServerSocketChannel.accept()
per HTTP connection VT          one per accepted socket, blocking reads/writes
per WS session: reader VT       blocked on socket read
per WS session: dispatcher VT   blocked on readyPermit.acquire()
```

The per-connection virtual thread is short-lived for HTTP: it serves one request
and closes the connection. For a WebSocket it returns as soon as the handshake
succeeds, so a live session holds exactly two virtual threads.

A server with ten browser tabs open holds one accept thread, ten reader threads,
and ten dispatcher threads, plus one virtual thread per in-flight HTTP request.
That count is a function of clients, not of image size.

### Why virtual threads and not a selector

Virtual threads give one-thread-per-connection semantics with none of the
platform-thread limit, which is what makes the blocking model viable for tens of
clients. The cost is that each blocking call needs a carrier. A synchronized
monitor can pin a carrier and defeat that; `WsWriter` therefore uses a
`ReentrantLock`, which does not pin. `SessionCoordinator` uses
`Semaphore.acquire()` and `AtomicReference` rather than monitors for the same
reason.

### Where the transport boundary is

Every piece of the design that could survive a transport swap does survive it, and
the tests demonstrate it rather than asserting it. `SessionCoordinator` takes an
`InputStream`, a `WritableByteChannel`, a `Closeable`, a `TileOpener`, and an
`ImageLookup`. `SessionTest` runs the entire state machine, including close
ordering and the writer lock, against a `ByteArrayInputStream` and a
`RecordingChannel`, with no socket anywhere. `UtpCodec` and `UtpMessages` are pure.
`PyramidTileStore` and `ImageRegistry` are pure plus filesystem. The viewer has no
idea what a socket is.

The only reason a swap is not already done is the open question recorded in
UTP-1.0 §8: whether the assignment's "servidor asíncrono" wording is satisfied by
application-level virtual-thread concurrency. That is a decision to make, not a
technical obstacle.

## Synchronization primitives, and why each one

| Primitive | Where | Job |
| --- | --- | --- |
| `ReentrantLock` | `WsWriter` | One serialized writer per session. The lock makes the close-versus-data admission check and the first byte a single critical section, so no data frame can start after a Close and no Close can interleave a frame. |
| `Semaphore` | `readyPermit` | Wakes the dispatcher. A permit is banked only on a null-to-non-null transition of the ready slot, so a burst of COMMITs collapses to at most one wakeup. |
| `AtomicReference` | `active`, `readySlot`, `currentTile` | Publication of the active generation, the coalesced slot, and the teardown-only tile channel handle. |
| `AtomicLong` | `lastReqIdSeen` | The monotonic accept watermark, read by the reader and consulted by purge logic. |
| `AtomicBoolean` | `closed`, `closeSent` | Teardown state, each with exactly one writer. `closed` is CAS-set only by `closeSession()`. |
| `volatile` | `GenerationState.sealed/canceled/work/sent/skipped` | Cross-thread visibility between the reader and the dispatcher without making the whole object a lock. |
| `LinkedHashSet` | `requested`, `rejectedReqIds` | Reader-confined insertion order, and dedupe for the tile set. |

The owner split is the contract. The reader owns the requested set and the bbox
until seal. The dispatcher owns `sent`, `skipped`, and the local drain index. The
writer lock owns nothing mutable; it only reads generation state to evaluate the
admission predicate.

### Teardown and wakeup

There is no polling and no timeout anywhere in the session. Teardown works by
making both blocking calls return:

```text
closeSession()
  CAS closed false -> true
  socketToClose.close()     unblocks a reader parked in read()
  currentTile.getAndSet(null).close()   unblocks a write stuck on a file
  readyPermit.release()     unblocks a dispatcher parked in acquire()
```

The dispatcher checks `closed` immediately after every wake and returns without
emitting. A dispatcher-side fatal `IOException` closes the socket first, which is
what wakes the reader. Both directions are pinned by tests.

The consequence worth stating: an idle viewer socket is never reaped. A browser
tab left open holds two virtual threads and one socket until the client goes away
or the process ends. That is a deliberate choice for a trusted-LAN demo scope and
it is the main thing to revisit for a public deployment.

## Why tiles are streamed rather than buffered

A tile's bytes go from the filesystem to the socket with no large intermediate
copy:

```text
FileChannel (positional)  ──transferTo──▶  WritableByteChannel
        ▲                                          ▲
   64 KiB fallback buffer                    the WebSocket frame,
   only after 3 zero-progress returns         already header-declared
```

`WsWriter.transferTileIf()` declares the frame length as `24 + fileSize` from a
`ch.size()` call, writes the 24 UTP header bytes, then loops
`src.transferTo(offset, remaining, out)` at an explicit offset. A 2 MiB tile never
becomes a `byte[]`.

The offset is explicit for a specific reason. `FileChannel.transferTo` does not
advance the channel's position, so a read that relied on the position would resend
the previous tile's bytes. The zero-progress fallback exists because
`transferTo` is allowed to return 0, which would otherwise spin forever; after
three consecutive zeros the writer switches to positional reads into a 64 KiB
buffer. `SessionTest.zeroThenProgressNoFallback()` and
`fallbackPersistentZero()` pin both halves of that rule.

Two smaller consequences of the same design. There is no server-side tile cache,
so repeated requests for the same tile re-read from disk, which is the page cache's
job and the JVM heap's non-job. And a failed write mid-frame is fatal rather than
skippable, because a truncated frame would desynchronize the WebSocket stream, so
the size gate is re-checked before the frame starts and a short read before the
advertised length throws.

## The memory envelope, as five ledgers

These are different quantities measured in different units by different
processes. Adding them produces a number that means nothing. The two that get
conflated most often are the server's and the browser's.

### 1. Server heap and RSS

Flat with respect to image size, image dimensions, and tiles already served.

Per in-flight tile the server holds a 24-byte UTP header, plus a 64 KiB fallback
buffer only on the zero-progress path. Per WS session it holds two virtual thread
stacks, which are heap objects in the low tens of kilobytes, plus the reader's
reassembly buffer capped at 1 KiB, plus the `requested` set of at most 256 packed
longs, plus the immutable work list of at most 256 `TileReq` records. Per HTTP
request it holds at most 16 KiB of head bytes, plus a whole web asset when one is
served (a few kilobytes each).

Nothing in the serving path is proportional to the source file size, the image
dimensions, or the pyramid size. The clearest measurement available:
`real_pipeline_test.py` against image 6 (40000 x 30131, 6270 tiles on disk) served
five 16x16 viewports at the finest level plus five more corner and centre sweeps,
about 180 MB of tile payload in total, and the server's total RSS went to 55 MiB,
a delta of +5 MiB across the whole run. Roughly 50 MB of compressed JPEG passed
through the process and the heap did not move with it.

### 2. Browser retained memory

The bitmap cache is the only thing that grows with what the user has looked at,
and it is capped at 40 entries:

```text
40 tiles x 512 x 512 px x 4 B (RGBA-equivalent) = 41,943,040 B = 40 MiB
```

plus per-bitmap overhead the browser adds, plus the GPU copy. The current viewport
target and the `z = 0` overview tile are protected against eviction, so the
effective floor is a few MiB above zero. This is the number that stays flat no
matter how large the image is, which is the entire point of the tiling design.
The replacement policy is LFUDA; see [viewer.md](viewer.md) for why the choice
of policy does not change this figure.

### 3. Browser transient compressed bytes

Not application-managed, and this is where honesty matters more than a tidy
total. The decode queue is only told to reject work **after** each WebSocket
message has already arrived, so the user agent's socket buffer is outside
anything the page controls. The bound the page can reason about:

```text
in-flight decodes   6 x 2 MiB  = 12 MiB   (theoretical; the pipeline admits
queued decodes     24 jobs, 4 MiB by the byte cap
```

and the transient socket buffering, which the application does not control:

```text
one legal batch of 30 planned tiles x 2 MiB max TILE = up to 60 MiB
```

60 MiB is the adversarial bound for a pathological legal batch, not an operating
point. Real traffic on the imported ESO pyramids is 120 to 175 KB per tile, and
on the synthetic demos around 15 KB, so a 30-tile batch is normally 0.4 to 5 MB.
Planning shrinks the window, because `planTileBytes = max(avgTileBytes, 65536)`
keeps the batch size honest against observed tile size, but the page does not get
to bound UA socket buffering and this document does not claim it does.

### 4. Importer memory

`scripts/import_vips.sh`: libvips is demand-driven and region-wise, so its memory
is a tunable cache, not a function of image size. The measured peak RSS across the
real ladder is the evidence, and the ratio is the signal:

| Image | Raw RGB | Peak RSS | RSS / raw RGB | Import wall |
| --- | ---: | ---: | ---: | ---: |
| 10000 x 7533 | 0.23 GB | 100 MB | 46 % | 7 s |
| 25000 x 18832 | 1.41 GB | 172 MB | 13 % | 19 s |
| 40000 x 30131 | 3.62 GB | 252 MB | 7 % | 39 s |

The ratio falling as the image grows is evidence consistent with bounded,
demand-driven processing: if RSS tracked the decoded image, the ratio would sit
near 100 % and stay flat. It is evidence, not proof, and it is specific to these
three inputs with a streaming `tiffload`. The inverse makes a useful tripwire: if
RSS approaches the raw RGB size, something has materialized the whole raster, and
that is a bug to investigate rather than a slow run. `measure_import.py` records
these figures under `/usr/bin/time`, and `docs/grading-preflight.md` gives the
command for watching RSS during an evaluator-scale import.

What the property actually is: the scalable path does not hold the entire decoded
raster in memory. Peak RSS can still depend on the loader, strip or tile geometry,
image width, the operations in the pipeline, libvips' cache configuration, and
temporary working regions. A format whose loader falls back to whole-image decode,
or a pathologically wide image, can still be memory-hungry.

`IngestTool --image`: one `BufferedImage` for the entire decoded image, which is
exactly why that path is capped at 8192 px per axis and 16 MP. 16 MP as RGBA8 is
about 64 MiB of pixels, and higher-bit-depth sources and downsampling scratch
allocate beyond that product, so the real figure is higher.

`IngestTool` synthetic: one 512x512 `TYPE_INT_RGB` buffer at a time, about 1 MiB,
released per tile.

### 5. Disk

The pyramid, which is the only thing that scales with the image.

```text
40000 x 30131   source 4.21 GB  ->  pyramid 902 MB   6270 tiles, mean 140 KB
25000 x 18832   source 1.65 GB  ->  pyramid 349 MB   2470 tiles, mean 138 KB
10000 x 7533    source 248 MB   ->  pyramid 50 MB     409 tiles, mean 119 KB
2048 x 2048     synthetic       ->  pyramid 0.3 MB   21 tiles, mean 16 KB
```

The pyramid is a stable 22 to 25 % of the raw RGB at the finest level for
photographic content, which is why the sources are all slightly larger than their
own raw RGB (about 110 to 117 %, since they are near-uncompressed TIFF) while the
pyramids are a quarter of it. Note the gap in the other direction: a synthetic
gradient is 1/500th the size of photographic content at the same dimensions and
the same Q85.

Disk scales with tile count and with tile content. Two 40000 x 30131 images cost
the same, and the same dimensions cost different amounts for different content.

### Source file size does not predict pyramid size

For the three measured ESO TIFFs the pyramid came out at roughly 22 to 25 % of
raw RGB, and the sources themselves came out at roughly 110 to 117 % of raw RGB
(they are LZW, which expands rather than compresses this noisy photographic
content). So for these three inputs the source file is about 4x the pyramid.

That ratio is a property of those three inputs, not a rule. Pyramid size depends
on dimensions, content entropy, source encoding, channels, and bit depth. A
source that is already JPEG-compressed will have a file size that says very
little about what Q85 tiles will cost, and a heavily compressed source can
produce a pyramid LARGER than the original file. Do not plan disk by
multiplying a source file size by any constant.

What the importer actually checks is a floor: 4,096 bytes per tile. It refuses
only when fitting is impossible. Passing that check does not mean the pyramid
will fit. Measure free space, import, then read the real result with `du`.

## What scales with what

| Quantity | Scales with | Does not scale with |
| --- | --- | --- |
| Server RSS | number of WS sessions, in-flight HTTP requests | image dimensions, source size, tiles served, total tiles |
| Server per-tile buffer | nothing; 24 B plus an optional 64 KiB fallback | tile payload size |
| Browser retained | cache occupancy, capped at 40 entries | image dimensions, source size, total tiles |
| Browser transient | one batch, bounded by the protocol caps | image dimensions |
| Importer RSS (libvips) | libvips cache configuration | source size |
| Importer RSS (ImageIO) | decoded pixel product | nothing, it refuses past the cap |
| Importer RSS (synthetic) | one 512x512 buffer | image dimensions |
| Disk | total tiles, and bytes per tile | client count, viewport size |

## Why a 28, 55, or 93 GB image does not imply 28, 55, or 93 GB of RAM

The chain is worth spelling out, because it is the claim the architecture exists
to support and it is easy to assume without checking.

```text
A 93 GB source file
   │
   ├─ import: libvips reads it demand-driven, region by region, and writes each
   │  output tile as it is produced. Nothing holds the whole raster. RSS is the
   │  libvips cache, not the file size.
   │
   ├─ store: the pyramid lands on disk and the source is never read again.
   │  The pyramid is smaller than the source for these inputs, because Q85
   │  JPEG at tile granularity beats a 16-bit lossless mosaic.
   │
   ├─ serve: a request names a tile rectangle. At most GEN_TILE_CAP (256) tiles
   │  per generation, and the client asks for at most 30 per batch. Each tile
   │  is pumped from the file to the socket with no large buffer. Server memory
   │  is 24 bytes plus, occasionally, 64 KiB per in-flight tile.
   │
   └─ view: the browser holds at most 40 decoded 512x512 bitmaps, 40 MiB total,
      and asks for the tiles its viewport needs at the level it can afford. A
      400 gigapixel image and a 4 megapixel one cost the same 40 MiB.
```

The scaling is in tile count and in disk, both of which are cheap and visible. It
is not in RAM anywhere in the serving path.

What does grow with image size, honestly:

- **Disk**, roughly linearly in tiles, and disk is where the constraint lives. The
  importer checks a floor against free space before starting, and the data root is
  relocatable with `--data-root` precisely because the pyramid and often the
  source both need an external volume. The measured pyramid is about a quarter of
  the raw RGB, so plan generously and then measure. There is no source-size
  multiplier: see [source file size does not predict pyramid
  size](#source-file-size-does-not-predict-pyramid-size).
- **Tile count per image**, and therefore the depth of the finest level. This is
  why `totalTiles` and the pixel product are `long`: a 33,554,432 square has 2^32
  tiles in its finest level alone, which does not fit in an `int`. As a reference
  anchor, the public 9 gigapixel VVV mosaic at 108200 x 81500 is 9 levels and
  45,252 tiles, and a 400 gigapixel square works out to about 2.04 million tiles.
  Neither figure is a prediction for any specific evaluator input; the actual
  tiers and the procedure for handling them are in
  [`docs/grading-preflight.md`](../grading-preflight.md).
- **First-paint latency** for a cold cache, since the browser must fetch the tiles
  it needs before it can draw them. That is a bandwidth and RTT question, and it is
  why `effectiveLOD` downgrades the requested level to fit the union budget rather
  than asking for a window it cannot render quickly.
- **Import wall time**, roughly linearly in tiles plus a fixed per-level
  validation cost. Measured at 7, 19, and 39 seconds for the three real images.
  The dominant cost is the post-pad pass, which is `O(perimeter)` rather than
  `O(area)`, at roughly 70 ms per edge tile. The importer batches its dimension
  probes for the same kind of reason; the unbatched form took about 24 hours on a
  350,000-tile pyramid where the actual encode took under a second.

## Open items

Two, stated rather than buried.

**The "asynchronous" question.** The assignment wording has an open reading about
whether application-level virtual-thread concurrency counts. UTP-1.0 §8 records
it. If an instructor requires explicit selector async, the change is confined to
`net/` and `ws/`, and the protocol does not move.

**No deadlines.** There is no read timeout on a WebSocket session, no keepalive
ping timer, and no per-client quota. A stalled client holds its session open. For
a trusted-LAN demo this is a reasonable trade; it is the first thing to add for
anything else.
