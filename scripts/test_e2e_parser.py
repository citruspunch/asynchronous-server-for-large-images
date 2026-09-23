#!/usr/bin/env python3
"""Parser self-test for the E2E frame parsers (stdlib, TEST-ONLY, offline).

Imports BOTH parsers from e2e_utp.py: the live server-direction parser
(parse_server_frame, unmasked-only + minimal-length) and the generic
parser (parse_any_frame, masked-tolerant). No server is started.

Vectors:
- 126-form (200B) + 127-form (70000B, high-bit-clear) exact recovery
- Minimal-length: 126-form length 124 and 127-form length 1000 rejected;
  boundary 126 and 65536 accepted HERE (server-to-client TILEs are large
  by design; the client-to-server WsFrameTest maps well-formed-65536 to
  1009 per the phase-05 precedence rule -- different direction, different
  rule, both correct)
- Masked server-style frame rejected; 64-bit high-bit-set rejected
- Truncated stream raises NeedMore (documented, never hangs)
- parse_any_frame recovers a masked client-style frame
- Accept derivation: fixed key maps to the exact expected Accept string

Usage: python3 scripts/test_e2e_parser.py
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_utp import (NeedMore, ProtocolError, expected_accept,
                     parse_any_frame, parse_server_frame)

PASS = 0


def check(name, cond):
    global PASS
    if not cond:
        print(f"PARSER-FAIL: {name}")
        sys.exit(1)
    PASS += 1
    print(f"parser-ok {name}")


def expect_raise(name, fn, exc):
    global PASS
    try:
        fn()
    except exc:
        PASS += 1
        print(f"parser-ok {name}")
        return
    except Exception as e:
        print(f"PARSER-FAIL: {name} raised {type(e).__name__}: {e}")
        sys.exit(1)
    print(f"PARSER-FAIL: {name} did not raise {exc.__name__}")
    sys.exit(1)


def server_bin(payload):
    n = len(payload)
    if n <= 125:
        return bytes([0x82, n]) + payload
    if n <= 65535:
        return bytes([0x82, 126]) + struct.pack(">H", n) + payload
    return bytes([0x82, 127]) + struct.pack(">Q", n) + payload


def main():
    # 126-form exact recovery (200B payload).
    p200 = bytes((i * 7 + 3) & 0xFF for i in range(200))
    ev, used = parse_server_frame(server_bin(p200))
    check("126-form-200B", ev == ("binary", p200) and used == 4 + 200)

    # 127-form exact recovery (70000B payload, high-bit-clear).
    p70k = bytes((i * 13 + 5) & 0xFF for i in range(70000))
    ev, used = parse_server_frame(server_bin(p70k))
    check("127-form-70000B", ev == ("binary", p70k) and used == 10 + 70000)

    # Minimal-length violations reject.
    bad126 = bytes([0x82, 126]) + struct.pack(">H", 124) + bytes(124)
    expect_raise("126-form-124-rejected", lambda: parse_server_frame(bad126),
                 ProtocolError)
    bad127 = bytes([0x82, 127]) + struct.pack(">Q", 1000) + bytes(1000)
    expect_raise("127-form-1000-rejected", lambda: parse_server_frame(bad127),
                 ProtocolError)

    # Minimal boundaries accepted on the server-to-client path.
    edge126 = bytes([0x82, 126]) + struct.pack(">H", 126) + bytes(126)
    ev, _ = parse_server_frame(edge126)
    check("126-form-126-accepted", ev[0] == "binary" and len(ev[1]) == 126)
    edge127 = bytes([0x82, 127]) + struct.pack(">Q", 65536) + bytes(65536)
    ev, _ = parse_server_frame(edge127)
    check("127-form-65536-accepted", ev[0] == "binary" and len(ev[1]) == 65536)

    # Masked server-style frame rejected (RFC 6455: server MUST NOT mask).
    masked = bytes([0x82, 0x80 | 5]) + b"\x01\x02\x03\x04" + bytes(5)
    expect_raise("masked-server-rejected", lambda: parse_server_frame(masked),
                 ProtocolError)

    # 64-bit high-bit-set length rejected.
    highbit = bytes([0x82, 127, 0x80, 0, 0, 0, 0, 0, 0, 100])
    expect_raise("high-bit-rejected", lambda: parse_server_frame(highbit),
                 ProtocolError)

    # Truncated stream is NeedMore, never a hang.
    expect_raise("truncated-header", lambda: parse_server_frame(bytes([0x82])),
                 NeedMore)
    expect_raise("truncated-payload",
                 lambda: parse_server_frame(bytes([0x82, 10]) + bytes(4)),
                 NeedMore)

    # Generic parser recovers a masked client-style frame.
    key = b"\xA1\xB2\xC3\xD4"
    raw = b"hello-utp"
    masked_client = bytes([0x82, 0x80 | len(raw)]) + key + bytes(
        b ^ key[i % 4] for i, b in enumerate(raw))
    ev, _ = parse_any_frame(masked_client)
    check("any-frame-masked-recovery", ev == ("binary", raw))

    # Accept derivation: fixed key maps to the exact pinned string.
    check("accept-vector",
          expected_accept("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    print(f"parser-selftest-ok {PASS} vectors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
