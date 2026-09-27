# UltraTile as-built documentation

This directory documents the software that exists in this repository today. Every
claim here was read out of the current source tree, and the source tree wins when
the two disagree.

UltraTile is a Java 21 tiling server plus an offline browser viewer for images far
too large to transfer whole. An image is imported once into a pyramid of 512x512
JPEG tiles on disk. At serving time the server never touches the source file
again. A browser fetches the viewer shell over HTTP, opens one WebSocket, and
then requests only the tiles its current viewport needs. The server streams each
requested tile straight from disk into a WebSocket frame without buffering it in
a large byte array. The viewer decodes a bounded number of tiles at a time and
disposes the rest.

## The three documentation layers

```text
docs/plans/            design history. What was intended, in what order,
                       which alternatives were rejected, and why.
                       Superseded assumptions stay here on purpose.

docs/protocol/         normative. UTP-1.0.md is the single authority for
                       anything visible on the wire or to a peer.
                       E2E-REPORT.md records one validation run.

docs/implementation/   as-built. Where the code lives, how the pieces fit,
                       what the current constants are, and which invariants a
                       future change must not break.
```

The distinction matters when you are looking for a fact. Wire behavior comes from
`docs/protocol/UTP-1.0.md`. Design rationale comes from `docs/plans/`. Current
structure and current constants come from this directory. If an implementation
document and the code disagree, the code is correct and this document is stale.

Nothing in this directory restates UTP semantics in full. Where a UTP rule is
needed to explain the implementation, it is summarized and linked to
[the normative spec](../protocol/UTP-1.0.md).

## Where to start

| If you want to | Read |
| --- | --- |
| Run it | [operations.md](operations.md) |
| Handle an evaluator-scale image | [docs/grading-preflight.md](../grading-preflight.md) |
| Know what is broken or unresolved | [known-limitations.md](known-limitations.md) |
| Know the shape of the system | [architecture.md](architecture.md) |
| Know what shape a tile takes and where it lives | [tile-pyramid-and-storage.md](tile-pyramid-and-storage.md) |
| Get an image in | [image-import.md](image-import.md) |
| Know every current limit and who owns it | [configuration-and-limits.md](configuration-and-limits.md) |
| Know how correctness is checked | [testing.md](testing.md) |
| Change a limit or a wire constant | [configuration-and-limits.md](configuration-and-limits.md), then [the parity check](testing.md#parity-is-a-test-not-a-style-choice) |

## The documents

### [architecture.md](architecture.md)

Packages, responsibilities, startup order, and the dependency direction between
transport, protocol, storage, and frontend. Read this first if you have never
seen the codebase.

### [tile-pyramid-and-storage.md](tile-pyramid-and-storage.md)

The ceiling pyramid: level math, the 512x512 invariant, edge padding, canonical
tile paths, the metadata schema, `.ready`, staging, atomic publication, and
quarantine. Includes a worked example computed against a real imported image.

### [image-import.md](image-import.md)

The three import paths (libvips, ImageIO fallback, synthetic), the feasibility
checks each one runs, and why the libvips path is the only one that scales past
RAM.

### [http-server.md](http-server.md)

The strict HTTP/1.1 subset: parser structure, the frozen gate order, routing,
the JSON endpoints, and where the implementation deliberately differs from
general HTTP behavior.

### [websocket-and-sessions.md](websocket-and-sessions.md)

The reader and dispatcher virtual threads, generations, sealing, the coalesced
ready slot, supersession, and close discipline. Links to UTP-1.0.md for every
normative rule it touches.

### [viewer.md](viewer.md)

The ten-module browser client: bootstrap, image switching, camera, level
selection, the tile ownership pipeline, the decode queue, and the LRU cache.

### [concurrency-and-memory.md](concurrency-and-memory.md)

The actual concurrency model and the memory envelope, split into five ledgers
that must not be added together.

### [configuration-and-limits.md](configuration-and-limits.md)

One inventory of every limit, its current value, its owner file, its category,
and what happens when it is exceeded. Also names the constants that the server
does not actually use.

### [testing.md](testing.md)

The two frozen verification tracks, the real-image ladder, and what each axis of
testing does and does not prove.

### [operations.md](operations.md)

Copy-and-paste commands: build, run, import, inspect, recover.

### [known-limitations.md](known-limitations.md)

The unresolved constraints in one place: what `.ready` does and does not prove,
the atomicity guarantee's dependence on the filesystem, the missing
`IngestTool --data-root`, the `/healthz` caveat, the 4K cache tightness, and what
has never been measured. Read this before promising something works.

## End-to-end shape

```text
Large source image on disk
       │
       ▼
scripts/import_vips.sh   (libvips dzsave, demand-driven, never fully decoded)
       │
       ▼
512x512 JPEG ceiling pyramid on disk, Q85, post-padded edges
       │
       ▼
ImageRegistry  ── scans the data root, validates meta.json + .ready
PyramidTileStore ── level math and canonical tile paths
       │
       ├── HTTP:  / , /styles.css, /js/*.js, /healthz,
       │          /api/images, /api/images/<id>/info
       │
       └── WebSocket /ws, then UTP/1.0 binary frames
                    │
                    ▼
              Browser viewer (ten deferred scripts)
                    │
                    ▼
              Selective tile requests, bounded decode, LRU bitmap cache
```

There is no HTTP route that serves a tile. Tiles travel over the WebSocket only,
inside UTP frames.

## Related documents

- [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md). Normative wire and
  application protocol.
- [`docs/protocol/E2E-REPORT.md`](../protocol/E2E-REPORT.md). Result table for one
  end-to-end validation run.
- [`docs/grading-preflight.md`](../grading-preflight.md). The operator procedure
  for the evaluator-scale images (28 GB, 55 GB, 93 GB): inspect, gate, import,
  watch memory, verify, serve. This directory explains the system;
  `grading-preflight.md` tells you what to do when one of those images lands.
- [`src/main/java/com/ultratile/proto/UTP_SPEC.md`](../../src/main/java/com/ultratile/proto/UTP_SPEC.md).
  A non-normative pointer to the spec plus a golden packet-offset table, kept next
  to the codec.
- [`docs/plans/feature-ultratile-system/`](../plans/feature-ultratile-system/overview.md).
  Design history. Useful for the reasoning, not for the current state.
- [`project_instructions.md`](../../project_instructions.md). The original
  assignment statement (Spanish).
- [`AGENTS.md`](../../AGENTS.md). Repository conventions and the traps that break
  contributors.
