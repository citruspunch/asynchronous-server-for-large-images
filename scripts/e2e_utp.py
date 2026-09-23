#!/usr/bin/env python3
"""Public-contract E2E probe for UltraTile UTP/1.0 (stdlib, TEST-ONLY).

Observable wire only: handshake, masked chunk/COMMIT/ABORT sends, one
gen-1 TILE read, superseding gen-2 send, gen-2 TILE + END collection,
Ping/Pong health. Asserts NOTHING about server internals (no counters,
no missing-file behavior, never waits for the superseded gen-1 END).

Frame direction split: `parse_server_frame` is the LIVE path (server to
client MUST be unmasked per RFC 6455 + minimal-length enforced);
`parse_any_frame` is the generic parser kept for unit vectors. Both are
imported by `test_e2e_parser.py`.

Usage: python3 scripts/e2e_utp.py [--host H] [--port P]
Prints: E2E-OK sealed superseded completed
"""
import argparse
import base64
import hashlib
import os
import socket
import struct
import sys
import time

SUBPROTOCOL = "ultratile.utp.v1"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# Fixed test key (RFC 6455 example); Accept is pinned in SessionTest and
# test_e2e_parser.py, so any change here fails loudly there.
KEY = "dGhlIHNhbXBsZSBub25jZQ=="

MAGIC = 0xAA
T_VIEWPORT = 0x01
T_TILE = 0x02
T_ABORT = 0x03
T_END = 0x04
T_COMMIT = 0x05

OP_CONT = 0x0
OP_BIN = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

# Demo image 0 (2048x2048, N=2): zoom 2 is 4x4 tiles of real JPEGs.
IMAGE = 0
ZOOM = 2
GEN1 = 1
GEN2 = 2


class ProtocolError(Exception):
    """Peer violated the wire contract (observable as an exception here)."""


class NeedMore(Exception):
    """Truncated stream: caller must feed more bytes (never a hang)."""


def expected_accept(key):
    sha1 = hashlib.sha1((key.strip() + GUID).encode("ascii"))
    return base64.b64encode(sha1.digest()).decode("ascii")


def parse_server_frame(buf):
    """Parse ONE server-to-client frame at buf[0].

    Returns (event, consumed). Events: ("binary", payload),
    ("ping", payload), ("pong", b""), ("close", code|None, reason).
    Raises ProtocolError on masked frames, non-minimal lengths,
    high-bit-set 64-bit lengths, unknown opcodes, or bad control frames.
    Raises NeedMore on truncation.
    """
    if len(buf) < 2:
        raise NeedMore("header")
    b0, b1 = buf[0], buf[1]
    fin = (b0 & 0x80) != 0
    rsv = (b0 >> 4) & 0x07
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    len7 = b1 & 0x7F
    if masked:
        raise ProtocolError("server frame must be unmasked")
    if rsv != 0:
        raise ProtocolError("rsv must be zero")
    if opcode not in (OP_CONT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG):
        raise ProtocolError(f"unknown opcode {opcode}")
    control = opcode >= 0x8
    off = 2
    if len7 <= 125:
        length = len7
        if control and (not fin or length > 125):
            raise ProtocolError("bad control frame")
    elif len7 == 126:
        if len(buf) < 4:
            raise NeedMore("126 ext")
        length = struct.unpack(">H", bytes(buf[2:4]))[0]
        if length < 126:
            raise ProtocolError("non-minimal 126-form length")
        if control:
            raise ProtocolError("control frame too large")
        off = 4
    else:
        if len(buf) < 10:
            raise NeedMore("127 ext")
        ext = bytes(buf[2:10])
        if ext[0] & 0x80:
            raise ProtocolError("64-bit high bit set")
        length = struct.unpack(">Q", ext)[0]
        if length < 65536:
            raise ProtocolError("non-minimal 127-form length")
        if control:
            raise ProtocolError("control frame too large")
        off = 10
    if len(buf) < off + length:
        raise NeedMore("payload")
    payload = bytes(buf[off:off + length])
    consumed = off + length
    if opcode == OP_BIN:
        if not fin:
            raise ProtocolError("server must not fragment data here")
        return (("binary", payload), consumed)
    if opcode == OP_PING:
        return (("ping", payload), consumed)
    if opcode == OP_PONG:
        return (("pong", b""), consumed)
    if opcode == OP_CLOSE:
        if len(payload) == 0:
            return (("close", None, b""), consumed)
        if len(payload) == 1:
            raise ProtocolError("close length 1")
        code = struct.unpack(">H", payload[:2])[0]
        return (("close", code, payload[2:]), consumed)
    raise ProtocolError("fragment without open")


def parse_any_frame(buf):
    """Generic parser (either direction): unmasks masked frames.

    Same return/raise contract as parse_server_frame, minus the
    unmasked-only rule. Kept for unit vectors of client-style frames.
    """
    if len(buf) < 2:
        raise NeedMore("header")
    b0, b1 = buf[0], buf[1]
    fin = (b0 & 0x80) != 0
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    len7 = b1 & 0x7F
    if opcode not in (OP_CONT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG):
        raise ProtocolError(f"unknown opcode {opcode}")
    off = 2
    if len7 <= 125:
        length = len7
    elif len7 == 126:
        if len(buf) < 4:
            raise NeedMore("126 ext")
        length = struct.unpack(">H", bytes(buf[2:4]))[0]
        if length < 126:
            raise ProtocolError("non-minimal 126-form length")
        off = 4
    else:
        if len(buf) < 10:
            raise NeedMore("127 ext")
        ext = bytes(buf[2:10])
        if ext[0] & 0x80:
            raise ProtocolError("64-bit high bit set")
        length = struct.unpack(">Q", ext)[0]
        if length < 65536:
            raise ProtocolError("non-minimal 127-form length")
        off = 10
    if masked:
        if len(buf) < off + 4:
            raise NeedMore("mask key")
        key = bytes(buf[off:off + 4])
        off += 4
    else:
        key = None
    if len(buf) < off + length:
        raise NeedMore("payload")
    payload = bytearray(buf[off:off + length])
    if key is not None:
        for i in range(len(payload)):
            payload[i] ^= key[i % 4]
    payload = bytes(payload)
    consumed = off + length
    if opcode == OP_BIN:
        if not fin:
            raise ProtocolError("fragmented data unsupported here")
        return (("binary", payload), consumed)
    if opcode == OP_PING:
        return (("ping", payload), consumed)
    if opcode == OP_PONG:
        return (("pong", b""), consumed)
    if len(payload) == 0:
        return (("close", None, b""), consumed)
    if len(payload) == 1:
        raise ProtocolError("close length 1")
    return (("close", struct.unpack(">H", payload[:2])[0], payload[2:]), consumed)


def mask_frame(opcode, payload):
    """One masked client frame: fresh key per frame, single-byte length."""
    if len(payload) > 125:
        raise ValueError("E2E send path stays single-byte (max 28B packet)")
    key = os.urandom(4)
    head = bytes([0x80 | opcode, 0x80 | len(payload)]) + key
    masked = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return head + masked


def chunk(image, zoom, req, x0, x1, y0, y1):
    return struct.pack(">BBHBBHIIIII", MAGIC, T_VIEWPORT, image, zoom, 0,
                       512, req, x0, x1, y0, y1)


def commit(image, req):
    return struct.pack(">BBHI", MAGIC, T_COMMIT, image, req)


def abort(image, req):
    return struct.pack(">BBHI", MAGIC, T_ABORT, image, req)


def parse_tile(payload):
    if len(payload) < 24:
        raise ProtocolError("tile frame short")
    magic, typ, image, zoom, fmt, tsize, req, tx, ty, plen = struct.unpack(
        ">BBHBBHIIII", payload[:24])
    return {"magic": magic, "type": typ, "image": image, "zoom": zoom,
            "format": fmt, "tileSize": tsize, "req": req, "x": tx, "y": ty,
            "len": plen, "body": payload[24:]}


def parse_end(payload):
    if len(payload) != 16:
        raise ProtocolError("end must be 16B")
    magic, typ, image, req, sent, skipped = struct.unpack(">BBHIII", payload)
    return {"magic": magic, "type": typ, "image": image, "req": req,
            "sent": sent, "skipped": skipped}


def read_head(sock):
    buf = bytearray()
    while True:
        chunk_b = sock.recv(1)
        if not chunk_b:
            break
        buf += chunk_b
        if len(buf) >= 4 and bytes(buf[-4:]) == b"\r\n\r\n":
            break
        if len(buf) > 16384:
            break
    return bytes(buf).decode("iso-8859-1")


class Stream:
    """Incremental server-frame stream over one socket."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = bytearray()

    def next_event(self, deadline):
        while True:
            try:
                ev, consumed = parse_server_frame(self.buf)
                del self.buf[:consumed]
                return ev
            except NeedMore:
                pass
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("frame wait timed out")
            self.sock.settimeout(min(remaining, 2.0))
            data = self.sock.recv(65536)
            if not data:
                raise ConnectionError("server closed the stream")
            self.buf += data


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args(argv)

    sock = socket.create_connection((args.host, args.port), timeout=5)
    sock.settimeout(5)
    try:
        req_lines = [
            "GET /ws HTTP/1.1",
            f"Host: {args.host}:{args.port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {KEY}",
            "Sec-WebSocket-Version: 13",
            f"Sec-WebSocket-Protocol: {SUBPROTOCOL}",
            "",
            "",
        ]
        sock.sendall("\r\n".join(req_lines).encode("ascii"))
        head = read_head(sock)
        status = head.split("\r\n", 1)[0] if head else ""
        if not status.startswith("HTTP/1.1 101"):
            print(f"handshake failed: {status!r}\n{head}", file=sys.stderr)
            return 1
        low = head.lower()
        for token in ("upgrade: websocket", "connection: upgrade",
                      "sec-websocket-protocol: " + SUBPROTOCOL):
            if token not in low:
                print(f"101 missing {token}:\n{head}", file=sys.stderr)
                return 1
        if expected_accept(KEY) not in head:
            print(f"101 bad Accept derivation:\n{head}", file=sys.stderr)
            return 1

        stream = Stream(sock)
        send = lambda op, p: sock.sendall(mask_frame(op, p))

        # Gen 1: two same-REQ_ID chunks + COMMIT, then read ONE tile.
        send(OP_BIN, chunk(IMAGE, ZOOM, GEN1, 0, 0, 0, 0))
        send(OP_BIN, chunk(IMAGE, ZOOM, GEN1, 1, 1, 0, 0))
        send(OP_BIN, commit(IMAGE, GEN1))
        first = None
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            ev = stream.next_event(deadline)
            if ev[0] == "binary" and len(ev[1]) >= 24 \
                    and ev[1][0] == MAGIC and ev[1][1] == T_TILE:
                t = parse_tile(ev[1])
                if t["req"] == GEN1:
                    first = t
                    break
            elif ev[0] == "close":
                print(f"server closed early: {ev}", file=sys.stderr)
                return 1
        if first is None:
            print("no gen-1 TILE before deadline", file=sys.stderr)
            return 1
        assert first["magic"] == MAGIC and first["type"] == T_TILE
        assert first["tileSize"] == 512, first
        assert first["format"] == 1, first
        assert first["req"] == GEN1, first
        assert first["body"][:2] == b"\xff\xd8", "tile is not JPEG"
        assert first["len"] == len(first["body"]), "LEN mismatch"

        # Supersede WITHOUT waiting for the gen-1 END, then retire gen 1
        # with a correctly-paired ABORT (stale by then: ignored, alive).
        send(OP_BIN, chunk(IMAGE, ZOOM, GEN2, 2, 2, 0, 0))
        send(OP_BIN, chunk(IMAGE, ZOOM, GEN2, 3, 3, 0, 0))
        send(OP_BIN, commit(IMAGE, GEN2))
        send(OP_BIN, abort(IMAGE, GEN1))

        # Collect 5 s: gen-2 TILE + 0x04 required; post-switch gen-1
        # bytes are already-buffered TCP and only discarded -- that covers
        # TILEs AND a gen-1 END written before the supersession arrived
        # (tiny generations drain in microseconds; the dispatcher cannot be
        # expected to lose that race). "Accepts 0 gen-1" means the client
        # never treats gen-1 as current: nothing decoded, nothing awaited.
        gen2_tiles = []
        gen2_end = None
        buffered_gen1 = 0
        buffered_gen1_ends = 0
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and \
                (not gen2_tiles or gen2_end is None):
            try:
                ev = stream.next_event(deadline)
            except TimeoutError:
                break
            if ev[0] != "binary" or len(ev[1]) < 2:
                if ev[0] == "close":
                    print(f"server closed mid-run: {ev}", file=sys.stderr)
                    return 1
                continue
            if ev[1][0] != MAGIC:
                continue
            typ = ev[1][1]
            if typ == T_TILE and len(ev[1]) >= 24:
                t = parse_tile(ev[1])
                if t["req"] == GEN2:
                    gen2_tiles.append(t)
                elif t["req"] == GEN1:
                    buffered_gen1 += 1  # received, discarded, never accepted
            elif typ == T_END and len(ev[1]) == 16:
                e = parse_end(ev[1])
                if e["req"] == GEN2:
                    gen2_end = e
                elif e["req"] == GEN1:
                    buffered_gen1_ends += 1  # received, discarded, never awaited
        if not gen2_tiles:
            print("no gen-2 TILE after supersession", file=sys.stderr)
            return 1
        if gen2_end is None:
            print("no gen-2 END after supersession", file=sys.stderr)
            return 1
        if gen2_end["sent"] + gen2_end["skipped"] != 2:
            print(f"gen-2 END accounting off: {gen2_end}", file=sys.stderr)
            return 1
        for t in gen2_tiles:
            assert t["tileSize"] == 512 and t["format"] == 1
            assert t["body"][:2] == b"\xff\xd8"

        # Ping/Pong health on the live connection.
        ping_body = b"utp-e2e-ping"
        send(OP_PING, ping_body)
        deadline = time.monotonic() + 5.0
        pong_ok = False
        while time.monotonic() < deadline:
            try:
                ev = stream.next_event(deadline)
            except TimeoutError:
                break
            if ev[0] == "pong":
                pong_ok = True
                break
            if ev[0] == "close":
                print(f"server closed on ping: {ev}", file=sys.stderr)
                return 1
        if not pong_ok:
            print("no Pong for Ping", file=sys.stderr)
            return 1

        print("E2E-OK sealed superseded completed")
        print(f"(buffered-gen1-discarded={buffered_gen1},"
              f"buffered-gen1-ends={buffered_gen1_ends})")
        return 0
    finally:
        try:
            sock.close()
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
