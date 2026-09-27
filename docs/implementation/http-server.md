# The HTTP server

> This document describes the current `NioHttpServer` implementation. It
> explains how the parser and router are put together and where the server
> deliberately differs from general HTTP behavior.
>
> The normative HTTP subset is specified in
> [`docs/protocol/UTP-1.0.md`](../protocol/UTP-1.0.md) §1. This document explains
> the code that implements it and does not restate the lexical grammar.

## Startup and bind

`Main` constructs `NioHttpServer(bind, Config.PORT, dataRoot)` and calls
`start()`. The port is not configurable from the CLI; it is `Config.PORT`,
currently 8080.

`start()` does the demo ensure before it binds, so a cold data root delays the
first accepted connection by the time it takes to generate two small demo
pyramids. It then opens a `ServerSocketChannel`, sets it blocking, binds
`InetSocketAddress(bind, port)`, and starts the accept loop on a virtual thread.

The bind default is `127.0.0.1`. `--bind 0.0.0.0` is the explicit opt-in to a
trusted LAN. `MainTest.bindAddressIsLoopbackNotWildcard()` asserts the default is
loopback and not the wildcard, and that the accept thread terminates on `close()`.

There is no timeout on the accept loop. `ClosedChannelException` from `close()` is
a normal shutdown and breaks the loop without being logged as an error; any other
`IOException` is treated as transient and the loop retries.

## Per-connection handling

Each accepted socket gets its own virtual thread. The handler:

1. Sets a 5-second read timeout for the request head.
2. Reads bytes through `CRLFCRLF` and stops exactly there.
3. Dispatches, unless the WebSocket upgrade claimed the socket.
4. Closes the socket in a `finally` block unless ownership was transferred.

The head reader is byte-at-a-time and hand-rolled, for two reasons. It must reject
a bare LF by returning an empty array so the caller can answer 400, and it must
never read past the terminator, because `SessionCoordinator` continues on the
same `InputStream` and any over-read bytes would be lost from the WebSocket
stream. The cap is 16 KiB, above which it answers 431 and closes.

The read timeout matters twice: a client that opens a connection and sends
nothing is dropped after 5 seconds, and the same timeout would kill an idle
WebSocket, which is why `handshakeWs()` clears it with `setSoTimeout(0)` before
starting the session. Tile streams are allowed to idle.

## Parser structure

The parser has no shared framework object. `dispatch()` is a linear sequence of
gates, each of which either responds and returns or falls through to the next:

```java
String hs = new String(head, ISO_8859_1);
if (!hs.endsWith("\r\n\r\n"))                     -> 400
split on "\r\n"; reject any line with a stray CR/LF -> 400
parseRequestLine(lines[0])                        -> 400
parseHeaders(lines, 1)                             -> 400
exactly one Host, charset-checked                 -> 400
Transfer-Encoding present                         -> 400
Content-Length present and not exactly one "0"    -> 400
method != "GET"                                   -> 405 + Allow: GET
absolute-form target profile                      -> 400
strip query, reject ".."                           -> 404
route(path, ...)
```

Headers land in a `LinkedHashMap<String, List<String>>` with lowercased keys and
multi-value lists preserved. That shape is what makes the singleton checks
possible: a duplicated `Host` or a duplicated `Sec-WebSocket-Key` is a 400 even
when the two values are equal.

The request line accepts any RFC 9112 token as `method`, then requires exactly
`HTTP/1.1` and single-space separation. Leading, trailing, and doubled spaces are
400. The target is not restricted to origin-form; see the absolute-form note
below.

`cleanField()` rejects NUL, every CTL below 0x20 except HTAB, and DEL, in both
field names and raw values. A field starting with SP or HTAB (obs-fold) is a 400.

## The frozen gate order

Two orderings are load-bearing and are the reason this is documented rather than
left to the code.

**Body framing runs before the method gate.** A `POST` with a nonzero
`Content-Length` is a 400 about framing, not a 405 about the method. The rationale
is that the server refuses to reason about a body at all, and that refusal must
not depend on which method was used.

**Non-`GET` collapses to 405.** RFC 9110 would return 501 for a method the server
does not implement. This profile deliberately maps every syntactically valid
non-`GET` token to 405 with `Allow: GET`, including `HEAD`, lowercase `get`, and
tokens the server has never heard of. That is a labeled profile decision recorded
in UTP-1.0 §1, not a bug. Do not "fix" it to 501 without changing the spec.

## Body policy

The server accepts no request body. `Transfer-Encoding` in any form is a 400. A
missing `Content-Length` is fine, because the request is bodyless. A present
`Content-Length` must be exactly one field whose value matches `^[0-9]+$` and
parses to exactly 0. Duplicates, non-digits, overflow, and any nonzero value are
all 400. This applies to `GET` as well as to any other method, which is the point
of putting the gate first.

## Routing

`route()` logs the path at FINE and then switches on it:

| Path | Response | Cache-Control |
| --- | --- | --- |
| `/` | `index.html`, `text/html; charset=utf-8` | `public, max-age=3600` |
| `/styles.css` | `styles.css`, `text/css; charset=utf-8` | `public, max-age=3600` |
| `/healthz` | `200 OK` or `503`, `text/plain` | `no-store` |
| `/api/images` | `200`, `application/json` | `no-store` |
| `/ws` | upgrade, or 400 / 403 | n/a |
| `/js/*.js` | the file, `application/javascript; charset=utf-8` | `public, max-age=3600` |
| `/api/images/<id>/info` | `200`, `application/json` | `no-store` |
| anything else, or any path containing `..` | `404` | `no-store` |

The `..` check runs before the switch, so a traversal attempt is a 404 rather
than reaching a handler. The `/js/` rule requires the prefix and the `.js`
suffix, so `/js/` alone is a 404.

Every response sets `Connection: close` and a correct `Content-Length`. The
server does not implement keep-alive; each HTTP request costs a fresh connection.
That is acceptable because the viewer's HTTP traffic is a handful of requests at
boot.

### Static resources

`sendWeb()` reads from the classpath at `/web/<name>`, which is how the viewer
ships inside the jar. If that returns null, two filesystem paths are tried as a
fallback so a direct `java -cp target/classes` run works during development:
`src/main/resources/web/<name>` and `target/classes/web/<name>`. Both are
`readAllBytes`, so the viewer's ten scripts are buffered in full at request time.
They are a few kilobytes each; this is not a streaming path and does not need to
be one.

### `/healthz`

`200` with body `OK` if and only if **both** demo 0 and demo 1 resolve through
`ImageRegistry.get()`. Otherwise `503` with body `not ready`.

This is a demo-readiness probe, not a general health check. A server serving only
real images 4, 5, and 6 with the demos removed would answer 503 even though it
is serving those images correctly. If you are using it as a readiness signal in a
script, that coupling is the thing to be aware of.

### `/api/images`

A fresh `ImageRegistry.list()` per request, rendered by hand:

```json
[{"id":0,"name":"image-0","w":2048,"h":2048,"levels":3},
 {"id":4,"name":"image-4","w":10000,"h":7533,"levels":6}]
```

Sorted by ID. There is no `tile` field here; the viewer knows the tile size from
its own pinned constant.

### `/api/images/<id>/info`

The ID must match `^[0-9]+$`, parse into `0..65535`, and equal
`Integer.toString(parsed)`, so `01` is a 404. An unknown or invalid image is a
404. On success the response adds `tile` and a per-level breakdown:

```json
{"id":6,"name":"image-6","w":40000,"h":30131,"levels":8,"tile":512,
 "levelsDetail":[
   {"z":0,"w":313,"h":236,"cols":1,"rows":1},
   ...
   {"z":7,"w":40000,"h":30131,"cols":79,"rows":59}]}
```

`levelsDetail` is computed on every request from `PyramidTileStore`, not read from
disk. For a 33,554,432 square that is 17 objects, so the cost is negligible.

Both endpoints build JSON through one shared `jsonEscape()`, which escapes quotes,
backslashes, and CTLs as `\u00xx` and passes non-ASCII through as UTF-8. The
header always declares `application/json` without a charset parameter.

### The WebSocket entry point

`/ws` is a route, not a separate listener. `dispatch()` has already enforced the
lexical parse, the Host rule, the body gate, the `GET` gate, and the target
profile by the time `route()` runs, so `handshakeWs()` only does handshake work.
It delegates to `WsHandshake.evaluate()` and either writes the failure status or
writes 101 and starts a session. See
[websocket-and-sessions.md](websocket-and-sessions.md).

## Deliberate restrictions

Collected, with the reason each exists, so a future change does not remove one by
accident.

| Restriction | Reason |
| --- | --- |
| No keep-alive | Each request closes. HTTP traffic is a handful of requests. |
| No request bodies | The server has no use for one. Framing is refused before the method gate. |
| No `501`, always `405` | Labeled profile decision (UTP-1.0 §1). |
| No chunked `Transfer-Encoding` | Same reason as no bodies. |
| No absolute-form except plain `http` | The scheme must be `http`, userinfo is refused, the authority is charset-checked, and it must equal `Host` case-insensitively. |
| No fragment in the target | A fragment is not sent by a real client; one in the request line is malformed. |
| `..` is a 404, not a 400 | Keeps the traversal check ahead of routing. |
| Static resources are a fixed allowlist | No directory listing, no path parameter reaching the filesystem for web assets. |
| No HTTP tile route | The assignment requires that image data travel over the custom protocol. There is no such route at any level. |
| `/healthz` depends on the demos | Documented above; do not read it as a general liveness signal. |

## Absolute-form targets

The parser accepts a target of the form `http://host[:port]/path`, which is what
RFC 9112 requires a server to accept for a request sent to a proxy. The profile
is restricted: only the `http` scheme, no userinfo, a charset-checked
authority with an optional numeric port, and the authority must equal the `Host`
header. A mismatch is a 400 that names the reason (`bad scheme`,
`bad authority`, `authority mismatch`, `bad target`) rather than a bare 400.

The IPv6 bracket form is handled in `validAuthority()`: a bracketed literal must
close, and anything after `]` must be `:` followed by digits.
