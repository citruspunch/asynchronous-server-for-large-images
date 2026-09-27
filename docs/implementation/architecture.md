# Architecture as built

> This document describes the current package structure and runtime control flow.
> It is derived from the source tree. If a name or an ordering here does not match
> the code, the code is authoritative.
> For normative UTP wire behavior see [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md).

## Packages

Five packages, four of them under `com.ultratile`. The dependency direction runs
strictly downward and inward, and transport is quarantined at the bottom.

| Package | Classes | Responsibility |
| --- | --- | --- |
| `com.ultratile` | `Main`, `Config` | CLI parsing, startup, and operational tuning constants. Knows nothing about HTTP. |
| `com.ultratile.net` | `NioHttpServer` | Socket accept, the strict HTTP/1.1 subset, routing, JSON endpoints, and the WebSocket upgrade hand-off. |
| `com.ultratile.ws` | `WsHandshake`, `WsFrame`, `WsWriter`, `SessionCoordinator` | RFC 6455 framing, the opening handshake, the serialized writer, and all UTP session rules. |
| `com.ultratile.proto` | `UtpMessages`, `UtpCodec` | Wire magic, type codes, the validated record types, and the big-endian codec. Transport-independent. |
| `com.ultratile.tiles` | `PyramidTileStore`, `ImageRegistry`, `IngestTool` | Pyramid math, canonical tile paths, live metadata discovery, and the two Java import paths. |
| `resources/web` | `index.html`, `styles.css`, `js/*.js` | The viewer. Ten classic deferred scripts served out of the jar. No bundler, no CDN. |

### The isolation boundary

Transport lives in `net/` and `ws/` and nowhere else. `PyramidTileStore`,
`ImageRegistry`, `UtpCodec`, `UtpMessages`, and the whole viewer know nothing
about sockets. A `SessionCoordinator` is constructed from an `InputStream`, a
`WritableByteChannel`, a `Closeable`, a `TileOpener`, and an `ImageLookup`, so it
can be driven from a unit test with byte arrays and no sockets. That is the
concrete reason a selector-based transport swap is possible: the swap replaces
`NioHttpServer` and the `SocketChannel` plumbing in `ws/`, and touches nothing
above them.

The one leak is deliberate and documented: `SessionCoordinator.defaultOpener()`
narrows a `long` tile coordinate to `int` before building a path, because
`PyramidTileStore` path helpers take `int`. The narrowing is unreachable today
because coordinates are validated against the protocol bound before a session
sees them, and if it were ever reached the store rejects the negative value, the
serving loop counts the tile as skipped, and no wrong file can be opened.

## Component diagram

Derived from the constructor graph and the call sites, not from a plan.

```text
Main
 │  parses --bind / --data-root, then hands both to the server
 ▼
NioHttpServer
 │
 ├── ImageRegistry.ensureStartup(dataRoot)      quarantines, generates demos 0/1
 │                                                 (runs BEFORE the socket binds)
 ├── accept loop (one virtual thread)
 │     └── per connection: one virtual thread
 │           ├── readHead()                      CRLFCRLF scan, 16 KiB cap
 │           └── dispatch()                      frozen gate order, then route()
 │                 ├── sendWeb()                 jar resource, cacheable 1 h
 │                 ├── sendHealth()              200 iff demos 0 and 1 validate
 │                 ├── sendImages()              /api/images
 │                 ├── sendInfo()                /api/images/<id>/info
 │                 └── handshakeWs()             101, then ownership transfers
 │                       └── SessionCoordinator  reader VT + dispatcher VT
 │                             ├── WsFrame         client frame parsing, cap 1 KiB
 │                             ├── UtpCodec        UTP decode (proto, no transport)
 │                             ├── UtpMessages     record validation
 │                             ├── WsWriter        one ReentrantLock per session
 │                             ├── ImageLookup     -> ImageRegistry
 │                             └── TileOpener      -> PyramidTileStore -> FileChannel
 │
 └── no HTTP tile route exists; tiles only travel inside WebSocket frames
```

Import side, all of it offline with respect to the server:

```text
scripts/import_vips.sh ──┐
                         ├── stage .tmp-<id>/ -> validate -> meta.json + .ready
IngestTool (synthetic) ──┤   -> atomic rename to <id>/
IngestTool (--image) ────┘
                              │
                              ▼
                        ImageRegistry sees it
```

The browser, as served:

```text
index.html
 ├── <script defer> constants.js     shared tunables and wire values
 ├── <script defer> structures.js    reqId allocator, LruCache, DecodePipeline
 ├── <script defer> state.js         every mutable binding, in one place
 ├── <script defer> geometry.js      pyramid math, LOD, budgets, coverage
 ├── <script defer> codec.js         big-endian encode and validated parse
 ├── <script defer> epoch.js         viewEpoch cleanup and decode completion
 ├── <script defer> render.js        canvas compositing and the HUD
 ├── <script defer> net.js           socket, receive pipeline, END accounting
 ├── <script defer> batches.js       the network batch loop
 └── <script defer> app.js           boot, selectImage, input handlers, public seam
```

Load order is semantic, not cosmetic. These are classic scripts sharing one
global lexical scope, so a top-level `let` in an earlier file is visible to
every later file. `check_const_parity.py` asserts that `index.html` loads them in
the same order as its own `JS_FILES` list, so reordering a `<script>` tag without
reordering that list fails a test.

## Startup sequence

`Main.main()` does four things and then parks forever.

1. `Main.parse(args)` accepts exactly `--bind <addr>` and `--data-root <dir>`, in
   either order. An unknown flag, a missing value, or an empty value throws, and
   `main` prints the message and exits 2. There is no silent fallback to a
   default, because a mistyped `--data-root` would otherwise publish a pyramid
   where the server does not look.
2. `new NioHttpServer(bind, Config.PORT, dataRoot)`. The port is not a CLI
   option; it is `Config.PORT`, currently 8080.
3. `server.start()`, which in this order:
   - calls `ImageRegistry.ensureStartup(dataRoot)`. That creates the data root,
     quarantines every numeric directory without `.ready` to
     `.stale-<id>-<epoch>/`, then ensures demo 0 (2048x2048) and demo 1
     (4096x4096) exist and validate. A demo that exists with `.ready` but fails
     validation is moved to `.stale-invalid-<id>-<epoch>/` and regenerated. A
     failure here is logged as a warning and does not stop the server.
   - opens and binds a `ServerSocketChannel`.
   - starts the accept loop on a virtual thread.

   Note the ordering: the server does not accept connections until the demo
   images exist. On a cold data root the first start spends a moment generating
   two small pyramids before the port is live.
4. Registers a shutdown hook that calls `server.close()`, then blocks on
   `Thread.currentThread().join()`. The main thread exists to hold the JVM open.

## Request control flow

```text
accept() -> virtual thread per connection
  setSoTimeout(5000)                  5 s read timeout for the head
  readHead()                          stop exactly at CRLFCRLF, never over-read
  dispatch()
    1  lexical parse          request line, headers, bare CR/LF, CTL
    2  Host                   exactly one, charset-checked
    3  body framing           Transfer-Encoding -> 400; Content-Length must be 0
    4  method gate            anything not GET -> 405 with Allow: GET
    5  target                 absolute-form profile, query stripped, ".." -> 404
    route()
      /ws  -> handshakeWs() -> SessionCoordinator.start() -> owned, return
      else -> respond, then close the connection
```

The head reader stopping exactly at the terminator is what lets the WebSocket
session continue on the same `InputStream` with no bytes lost and no bytes
duplicated. `setSoTimeout(0)` clears the 5 s timeout before the session starts,
because a tile stream is allowed to idle.

The order of gates 3 and 4 is frozen: the global body-framing gate runs before
the method gate, so `POST` with a nonzero `Content-Length` is a 400, not a 405.
See [http-server.md](http-server.md).

## Where the logic lives

| Concern | Owner | Notes |
| --- | --- | --- |
| Pyramid geometry, tile paths, size gate | `PyramidTileStore` | Static and pure. No I/O except the three `checkSize`/`openTileChannel`/`readTile` helpers. |
| Metadata discovery and validation | `ImageRegistry` | Fresh directory scan per call. No cache, so no restart after an import. |
| Import | `IngestTool`, `scripts/import_vips.sh` | Both stage, validate, mark ready, and rename. |
| Wire constants and packet validation | `UtpMessages` | Every packet type is a Java record with a compact constructor that throws. |
| Wire encoding and decoding | `UtpCodec` | Big-endian, u32 fields read with `Integer.toUnsignedLong`. |
| Session rules | `SessionCoordinator` | The only stateful UTP component. |
| Frame bytes | `WsFrame`, `WsWriter` | No UTP knowledge. |
| Operational tuning | `Config` | See [configuration-and-limits.md](configuration-and-limits.md) for which of these the server actually reads. |
| Viewer | `web/js/*.js` | No build step. One shared lexical scope. |

## What is deliberately absent

There is no HTTP endpoint that returns a tile, at any level, in any format. The
viewer's only way to obtain image data is a UTP TILE frame. This is the
assignment's "images must not be served whole" requirement expressed as a
missing route rather than as a policy check.

There is no server-side tile cache. `Config.CACHE_CAP` exists but is never read
by the server. Every request re-reads from disk, which is why server memory does
not grow with the number of distinct tiles served.

There is no authentication, no TLS, and no per-client quota. The bind default is
loopback, and `--bind 0.0.0.0` is an explicit opt-in to a trusted LAN.

## Not part of the server

`presentation/` is a separate Vite and React slide deck. It has its own
`package.json`, its own dependencies, and a gitignored `dist/`. Nothing in
`src/main/java` references it, and it is not part of the build. The server build
(`build.sh`) and the runtime never touch it.
