package com.ultratile.ws;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.OptionalInt;

import com.ultratile.Config;

/**
 * RFC 6455 frame parsing for the client-to-server direction plus the
 * server-side minimal-length encoder rules and the peer Close-code validator.
 */
public final class WsFrame {
    private WsFrame() {}

    public static final int OP_CONT = 0x0;
    public static final int OP_TEXT = 0x1;
    public static final int OP_BIN = 0x2;
    public static final int OP_CLOSE = 0x8;
    public static final int OP_PING = 0x9;
    public static final int OP_PONG = 0xA;

    /** Inbound application cap: well-formed messages past this are 1009. */
    public static final int INBOUND_CAP = Config.WS_MSG_CAP;

    /** Protocol violation carrying the Close code to emit. */
    public static final class WsProtocolException extends Exception {
        public final int closeCode;

        public WsProtocolException(int closeCode, String msg) {
            super(msg);
            this.closeCode = closeCode;
        }
    }

    /** Parsed client frame header (payload not yet consumed). */
    public record Header(
            boolean fin,
            int opcode,
            long payloadLen,
            byte[] maskKey,
            int headerLen) {}

    /** Reassembled message-level events. Null return means need-more-frames. */
    public sealed interface Event
            permits Event.Binary, Event.Text, Event.Ping, Event.Pong, Event.Close {
        record Binary(byte[] payload) implements Event {}

        record Text(byte[] payload, boolean validUtf8) implements Event {}

        record Ping(byte[] payload) implements Event {}

        record Pong() implements Event {}

        record Close(OptionalInt code, byte[] reason, boolean reasonValid) implements Event {}
    }

    /**
     * Frozen Close-code validator (explicit sets, never an inclusive range).
     * Valid peer codes: 1000-1003, 1007-1014 except the non-transmittables,
     * plus 3000-4999 private use. 1005/1006/1015 and friends are invalid.
     */
    public static boolean isValidPeerCode(int code) {
        switch (code) {
            case 1000:
            case 1001:
            case 1002:
            case 1003:
            case 1007:
            case 1008:
            case 1009:
            case 1010:
            case 1011:
            case 1012:
            case 1013:
            case 1014:
                return true;
            default:
                return code >= 3000 && code <= 4999;
        }
    }

    /** Strict UTF-8 check (overlong/illegal sequences fail). */
    public static boolean validUtf8(byte[] bytes) {
        CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder();
        dec.onMalformedInput(CodingErrorAction.REPORT);
        dec.onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            dec.decode(ByteBuffer.wrap(bytes));
            return true;
        } catch (CharacterCodingException e) {
            return false;
        }
    }

    /**
     * Reads one client frame header. Never consumes payload bytes.
     *
     * @throws WsProtocolException on any shape violation (code carried)
     * @throws IOException on transport EOF/failure (caller tears down silently)
     */
    public static Header readFrameHeader(InputStream in) throws IOException, WsProtocolException {
        int b0 = readByte(in);
        int b1 = readByte(in);
        boolean fin = (b0 & 0x80) != 0;
        int rsv = (b0 >> 4) & 0x07;
        int opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        int len7 = b1 & 0x7F;
        if (!masked) {
            throw new WsProtocolException(1002, "client frame must be masked");
        }
        if (rsv != 0) {
            throw new WsProtocolException(1002, "rsv must be zero");
        }
        if (!isKnownOpcode(opcode)) {
            throw new WsProtocolException(1002, "unknown opcode " + opcode);
        }
        boolean control = opcode >= 0x8;
        long payloadLen;
        int headerLen = 2;
        if (len7 <= 125) {
            payloadLen = len7;
            if (control && (!fin || payloadLen > 125)) {
                throw new WsProtocolException(1002, "bad control frame");
            }
        } else if (len7 == 126) {
            byte[] ext = readFully(in, 2);
            headerLen += 2;
            payloadLen = ((ext[0] & 0xFF) << 8) | (ext[1] & 0xFF);
            if (payloadLen < 126) {
                throw new WsProtocolException(1002, "non-minimal 126-form length");
            }
            if (control) {
                throw new WsProtocolException(1002, "control frame too large");
            }
        } else {
            byte[] ext = readFully(in, 8);
            headerLen += 8;
            if ((ext[0] & 0x80) != 0) {
                throw new WsProtocolException(1002, "64-bit high bit set");
            }
            payloadLen = 0;
            for (int i = 0; i < 8; i++) {
                payloadLen = (payloadLen << 8) | (ext[i] & 0xFF);
            }
            if (payloadLen < 65536) {
                throw new WsProtocolException(1002, "non-minimal 127-form length");
            }
            if (control) {
                throw new WsProtocolException(1002, "control frame too large");
            }
        }
        byte[] mask = readFully(in, 4);
        headerLen += 4;
        return new Header(fin, opcode, payloadLen, mask, headerLen);
    }

    /**
     * Reads exactly the declared payload and unmasks it. Callers enforce the
     * inbound cap BEFORE calling, so oversize payloads are never buffered.
     */
    public static byte[] readFramePayload(InputStream in, Header h) throws IOException {
        long len = h.payloadLen();
        if (len > Integer.MAX_VALUE) {
            throw new IOException("frame too large to buffer");
        }
        byte[] payload = readFully(in, (int) len);
        for (int i = 0; i < payload.length; i++) {
            payload[i] ^= h.maskKey()[i % 4];
        }
        return payload;
    }

    private static boolean isKnownOpcode(int opcode) {
        return opcode == OP_CONT
                || opcode == OP_TEXT
                || opcode == OP_BIN
                || opcode == OP_CLOSE
                || opcode == OP_PING
                || opcode == OP_PONG;
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) {
            throw new EOFException("eof in frame header");
        }
        return b;
    }

    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) {
                throw new EOFException("eof in frame");
            }
            off += r;
        }
        return buf;
    }

    /**
     * Fragment reassembly with the incremental 1 KiB cap. Feed headers plus
     * their (already cap-checked) payloads; returns a message event once a
     * complete message arrives, null while more frames are needed.
     */
    public static final class Assembler {
        private int fragOpcode = -1;
        private final ByteArrayOutputStream fragBuf = new ByteArrayOutputStream();

        /** Currently buffered reassembly bytes (never past cap + header). */
        public long bufferedBytes() {
            return fragBuf.size();
        }

        /** Pending bytes for the session-level pre-read cap check. */
        public long pendingBytes() {
            return fragBuf.size();
        }

        public Event accept(Header h, byte[] payload) throws WsProtocolException {
            switch (h.opcode()) {
                case OP_CLOSE -> {
                    if (payload.length == 1) {
                        throw new WsProtocolException(1002, "close length 1");
                    }
                    if (payload.length == 0) {
                        return new Event.Close(OptionalInt.empty(), new byte[0], true);
                    }
                    int code = ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF);
                    byte[] reason = new byte[payload.length - 2];
                    System.arraycopy(payload, 2, reason, 0, reason.length);
                    return new Event.Close(OptionalInt.of(code), reason, validUtf8(reason));
                }
                case OP_PING -> {
                    return new Event.Ping(payload);
                }
                case OP_PONG -> {
                    return new Event.Pong();
                }
                case OP_TEXT, OP_BIN -> {
                    if (fragOpcode != -1) {
                        throw new WsProtocolException(1002, "data opcode mid-fragment");
                    }
                    if ((long) fragBuf.size() + payload.length > INBOUND_CAP) {
                        throw new WsProtocolException(1009, "message over cap");
                    }
                    if (h.fin()) {
                        byte[] msg = payload;
                        if (h.opcode() == OP_TEXT) {
                            return new Event.Text(msg, validUtf8(msg));
                        }
                        return new Event.Binary(msg);
                    }
                    fragBuf.write(payload, 0, payload.length);
                    fragOpcode = h.opcode();
                    return null;
                }
                case OP_CONT -> {
                    if (fragOpcode == -1) {
                        throw new WsProtocolException(1002, "continuation without open");
                    }
                    if ((long) fragBuf.size() + payload.length > INBOUND_CAP) {
                        throw new WsProtocolException(1009, "message over cap");
                    }
                    fragBuf.write(payload, 0, payload.length);
                    if (h.fin()) {
                        byte[] msg = fragBuf.toByteArray();
                        fragBuf.reset();
                        int op = fragOpcode;
                        fragOpcode = -1;
                        if (op == OP_TEXT) {
                            return new Event.Text(msg, validUtf8(msg));
                        }
                        return new Event.Binary(msg);
                    }
                    return null;
                }
                default -> throw new WsProtocolException(1002, "unknown opcode");
            }
        }
    }
}
