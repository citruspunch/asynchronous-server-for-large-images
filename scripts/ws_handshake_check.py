#!/usr/bin/env python3
"""Raw-socket WebSocket upgrade probe (stdlib, TEST-ONLY).

Sends a well-formed upgrade for /ws with the mandatory subprotocol and reads
EXACTLY through \\r\\n\\r\\n (a correct 101 has few lines and never EOFs, so
head-counting reads would hang). Asserts the expected status.
"""
import argparse
import base64
import hashlib
import socket
import sys

KEY = "dGhlIHNhbXBsZSBub25jZQ=="
SUBPROTOCOL = "ultratile.utp.v1"


def expected_accept(key):
    sha1 = hashlib.sha1((key.strip() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii"))
    return base64.b64encode(sha1.digest()).decode("ascii")


def read_head(sock):
    buf = bytearray()
    while True:
        chunk = sock.recv(1)
        if not chunk:
            break
        buf += chunk
        if len(buf) >= 4 and bytes(buf[-4:]) == b"\r\n\r\n":
            break
        if len(buf) > 16384:
            break
    return bytes(buf).decode("iso-8859-1")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect", required=True, choices=("101", "400"),
                    help="expected status code")
    ap.add_argument("--extra-header", action="append", default=[],
                    help='ADDS a field line alongside the base headers')
    ap.add_argument("--version", default="13",
                    help="REPLACES the single base Sec-WebSocket-Version value")
    ap.add_argument("--no-subprotocol", action="store_true",
                    help="omit the subprotocol line")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args(argv)

    lines = [
        "GET /ws HTTP/1.1",
        f"Host: {args.host}:{args.port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {KEY}",
        f"Sec-WebSocket-Version: {args.version}",
    ]
    if not args.no_subprotocol:
        lines.append(f"Sec-WebSocket-Protocol: {SUBPROTOCOL}")
    lines += args.extra_header
    lines += ["Connection: close", ""]
    # The trailing Connection: close only adds a non-upgrade token to the
    # aggregated set; the mandatory Upgrade token is still present.
    request = "\r\n".join(lines) + "\r\n"

    with socket.create_connection((args.host, args.port), timeout=5) as sock:
        sock.settimeout(5)
        sock.sendall(request.encode("ascii"))
        head = read_head(sock)

    status = head.split("\r\n", 1)[0] if head else ""
    want = f"HTTP/1.1 {args.expect}"
    if not status.startswith(want):
        print(f"expected {want}, got: {status!r}\n{head}", file=sys.stderr)
        return 1
    if args.expect == "101":
        for token in ("Upgrade", "Connection", "Accept", "Sec-WebSocket-Protocol"):
            if token.lower() not in head.lower():
                print(f"101 missing {token}:\n{head}", file=sys.stderr)
                return 1
        if expected_accept(KEY) not in head:
            print(f"101 bad Accept derivation:\n{head}", file=sys.stderr)
            return 1
    print(f"handshake-ok {args.expect}")
    print(head, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
