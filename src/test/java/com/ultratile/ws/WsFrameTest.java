package com.ultratile.ws;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.WritableByteChannel;
import java.util.Arrays;

import com.ultratile.ws.WsFrame.WsProtocolException;
import org.junit.jupiter.api.Test;

class WsFrameTest {

    static final byte[] MASK = {1, 2, 3, 4};

    /** Minimal client frame encoding, masked. lenForm: 0 minimal, 1 force-126, 2 force-127. */
    static byte[] clientFrame(int opcode, boolean fin, byte[] payload, int lenForm) {
        int len = payload.length;
        int ext;
        if (lenForm == 1) {
            ext = 126;
        } else if (lenForm == 2) {
            ext = 127;
        } else if (len <= 125) {
            ext = len;
        } else if (len <= 65535) {
            ext = 126;
        } else {
            ext = 127;
        }
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write((fin ? 0x80 : 0) | opcode);
        b.write(0x80 | ext);
        if (ext == 126) {
            b.write((len >> 8) & 0xFF);
            b.write(len & 0xFF);
        } else if (ext == 127) {
            long wide = len;
            for (int i = 7; i >= 0; i--) {
                b.write((int) ((wide >> (8 * i)) & 0xFF));
            }
        }
        b.write(MASK, 0, 4);
        for (int i = 0; i < len; i++) {
            b.write(payload[i] ^ MASK[i % 4]);
        }
        return b.toByteArray();
    }

    static WsFrame.Header parse(byte[] frame) throws Exception {
        return WsFrame.readFrameHeader(new ByteArrayInputStream(frame));
    }

    /** Parses the header then reads the payload from the same stream. */
    record FrameAndPayload(WsFrame.Header header, byte[] payload) {}

    static FrameAndPayload parseFull(byte[] frame) throws Exception {
        ByteArrayInputStream in = new ByteArrayInputStream(frame);
        WsFrame.Header h = WsFrame.readFrameHeader(in);
        return new FrameAndPayload(h, WsFrame.readFramePayload(in, h));
    }

    @Test
    void unmaskedRejected() {
        byte[] f = clientFrame(WsFrame.OP_BIN, true, new byte[] {1, 2}, 0);
        f[1] &= 0x7F;
        WsProtocolException e = assertThrows(
                WsProtocolException.class, () -> parse(f));
        assertEquals(1002, e.closeCode);
    }

    @Test
    void rsvAndOpcodeAndControlShape() {
        byte[] rsv = clientFrame(WsFrame.OP_BIN, true, new byte[] {1}, 0);
        rsv[0] |= 0x40;
        assertEquals(1002, assertThrows(WsProtocolException.class, () -> parse(rsv)).closeCode);

        byte[] badOp = clientFrame(0x7, true, new byte[] {1}, 0);
        assertEquals(1002, assertThrows(WsProtocolException.class, () -> parse(badOp)).closeCode);

        byte[] fragPing = clientFrame(WsFrame.OP_PING, false, new byte[] {1}, 0);
        assertEquals(
                1002, assertThrows(WsProtocolException.class, () -> parse(fragPing)).closeCode);

        byte[] bigPing = clientFrame(WsFrame.OP_PING, true, new byte[126], 0);
        assertEquals(
                1002, assertThrows(WsProtocolException.class, () -> parse(bigPing)).closeCode);
    }

    @Test
    void closeLenOneRejected() throws Exception {
        FrameAndPayload fp = parseFull(clientFrame(WsFrame.OP_CLOSE, true, new byte[] {1}, 0));
        WsFrame.Assembler a = new WsFrame.Assembler();
        assertEquals(1002, assertThrows(WsProtocolException.class,
                () -> a.accept(fp.header(), fp.payload())).closeCode);
    }

    @Test
    void nonMinimal126Rejected() {
        byte[] f = clientFrame(WsFrame.OP_BIN, true, new byte[124], 1);
        assertEquals(1002, assertThrows(WsProtocolException.class, () -> parse(f)).closeCode);
    }

    @Test
    void nonMinimal127Rejected() {
        byte[] f = clientFrame(WsFrame.OP_BIN, true, new byte[1000], 2);
        assertEquals(1002, assertThrows(WsProtocolException.class, () -> parse(f)).closeCode);
    }

    @Test
    void minimal126Accepted() throws Exception {
        byte[] payload = new byte[126];
        Arrays.fill(payload, (byte) 7);
        byte[] f = clientFrame(WsFrame.OP_BIN, true, payload, 0);
        FrameAndPayload fp = parseFull(f);
        WsFrame.Header h = fp.header();
        assertEquals(8, h.headerLen());
        assertEquals(126, h.payloadLen());
        WsFrame.Assembler a = new WsFrame.Assembler();
        WsFrame.Event ev = a.accept(h, fp.payload());
        assertTrue(ev instanceof WsFrame.Event.Binary);
        assertEquals(126, ((WsFrame.Event.Binary) ev).payload().length);
    }

    @Test
    void oversize127Bounded() throws Exception {
        // 10-byte header declaring 65536, followed by only 2 KiB: the 1009
        // rule fires on the declaration without consuming the body.
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        byte[] hdr = {(byte) 0x82, (byte) 0xFF, 0, 0, 0, 0, 0, 1, 0, 0, 1, 2, 3, 4};
        raw.write(hdr);
        raw.write(new byte[2048]);
        ByteArrayInputStream in = new ByteArrayInputStream(raw.toByteArray());
        WsFrame.Header h = WsFrame.readFrameHeader(in);
        assertEquals(65536, h.payloadLen());
        assertEquals(14, h.headerLen());
        assertTrue(0 + h.payloadLen() > WsFrame.INBOUND_CAP);
        assertEquals(2048, in.available());
    }

    @Test
    void highBit64Rejected() {
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        raw.write(0x82);
        raw.write(0xFF);
        raw.write(new byte[] {(byte) 0x80, 0, 0, 0, 0, 0, 0, 1}, 0, 8);
        raw.write(MASK, 0, 4);
        byte[] f = raw.toByteArray();
        assertEquals(1002, assertThrows(WsProtocolException.class, () -> parse(f)).closeCode);
    }

    @Test
    void closeCodeValidator() {
        int[] valid = {1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011,
                1012, 1013, 1014, 3000, 4002, 4999};
        for (int c : valid) {
            assertTrue(WsFrame.isValidPeerCode(c), "valid: " + c);
        }
        int[] invalid = {0, 999, 1004, 1005, 1006, 1015, 1016, 2000, 2999, 5000, 6000};
        for (int c : invalid) {
            assertFalse(WsFrame.isValidPeerCode(c), "invalid: " + c);
        }
    }

    @Test
    void continuationWithoutOpenRejected() throws Exception {
        WsFrame.Assembler a = new WsFrame.Assembler();
        FrameAndPayload fp = parseFull(clientFrame(WsFrame.OP_CONT, true, new byte[] {1}, 0));
        assertEquals(1002, assertThrows(WsProtocolException.class,
                () -> a.accept(fp.header(), fp.payload())).closeCode);
    }

    @Test
    void secondDataOpcodeMidFragRejected() throws Exception {
        WsFrame.Assembler a = new WsFrame.Assembler();
        FrameAndPayload fp1 = parseFull(clientFrame(WsFrame.OP_BIN, false, new byte[] {1, 2}, 0));
        assertEquals(null, a.accept(fp1.header(), fp1.payload()));
        FrameAndPayload fp2 = parseFull(clientFrame(WsFrame.OP_BIN, true, new byte[] {3}, 0));
        assertEquals(1002, assertThrows(WsProtocolException.class,
                () -> a.accept(fp2.header(), fp2.payload())).closeCode);
    }

    @Test
    void fragmentedReassembly() throws Exception {
        WsFrame.Assembler a = new WsFrame.Assembler();
        FrameAndPayload fp1 = parseFull(clientFrame(WsFrame.OP_BIN, false, "hel".getBytes(), 0));
        assertEquals(null, a.accept(fp1.header(), fp1.payload()));
        FrameAndPayload fp2 = parseFull(clientFrame(WsFrame.OP_CONT, true, "lo".getBytes(), 0));
        WsFrame.Event ev = a.accept(fp2.header(), fp2.payload());
        assertTrue(ev instanceof WsFrame.Event.Binary);
        assertEquals("hello", new String(((WsFrame.Event.Binary) ev).payload()));
    }

    @Test
    void incrementalCap() throws Exception {
        WsFrame.Assembler a = new WsFrame.Assembler();
        FrameAndPayload fp1 = parseFull(clientFrame(WsFrame.OP_BIN, false, new byte[600], 0));
        assertEquals(null, a.accept(fp1.header(), fp1.payload()));
        FrameAndPayload fp2 = parseFull(clientFrame(WsFrame.OP_CONT, true, new byte[500], 0));
        assertEquals(1009, assertThrows(WsProtocolException.class,
                () -> a.accept(fp2.header(), fp2.payload())).closeCode);
    }

    @Test
    void textValidityFlag() throws Exception {
        WsFrame.Assembler a = new WsFrame.Assembler();
        FrameAndPayload fp1 = parseFull(clientFrame(WsFrame.OP_TEXT, true, "hi".getBytes("UTF-8"), 0));
        WsFrame.Event e1 = a.accept(fp1.header(), fp1.payload());
        assertTrue(e1 instanceof WsFrame.Event.Text);
        assertTrue(((WsFrame.Event.Text) e1).validUtf8());

        byte[] overlong = {(byte) 0xC0, (byte) 0xAF};
        FrameAndPayload fp2 = parseFull(clientFrame(WsFrame.OP_TEXT, true, overlong, 0));
        WsFrame.Event e2 = a.accept(fp2.header(), fp2.payload());
        assertTrue(e2 instanceof WsFrame.Event.Text);
        assertFalse(((WsFrame.Event.Text) e2).validUtf8());
    }

    static final class RecordingChannel implements WritableByteChannel {
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        boolean open = true;

        @Override
        public int write(ByteBuffer src) {
            int n = src.remaining();
            byte[] b = new byte[n];
            src.get(b);
            buf.write(b, 0, n);
            return n;
        }

        @Override
        public boolean isOpen() {
            return open;
        }

        @Override
        public void close() {
            open = false;
        }
    }

    @Test
    void serverHeadersMinimal() throws Exception {
        RecordingChannel ch = new RecordingChannel();
        WsWriter w = new WsWriter(ch);
        w.writeBinary(new byte[125]);
        assertEquals(2 + 125, ch.buf.size());
        assertEquals((byte) 0x82, ch.buf.toByteArray()[0]);
        assertEquals(125, ch.buf.toByteArray()[1] & 0xFF);

        ch.buf.reset();
        w.writeBinary(new byte[126]);
        byte[] b = ch.buf.toByteArray();
        assertEquals(4 + 126, b.length);
        assertEquals(126, b[1] & 0xFF);

        ch.buf.reset();
        w.writeBinary(new byte[65535]);
        assertEquals(4 + 65535, ch.buf.size());

        ch.buf.reset();
        w.writeBinary(new byte[65536]);
        b = ch.buf.toByteArray();
        assertEquals(10 + 65536, b.length);
        assertEquals(127, b[1] & 0xFF);
    }
}
