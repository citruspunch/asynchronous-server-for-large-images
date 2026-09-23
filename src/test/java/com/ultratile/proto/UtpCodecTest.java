package com.ultratile.proto;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HashSet;
import java.util.Set;

import com.ultratile.Config;
import org.junit.jupiter.api.Test;

class UtpCodecTest {

    @Test
    void viewport28BWithLod0AndBigEndian() {
        UtpMessages.ViewportUpdate m = new UtpMessages.ViewportUpdate(1, 3, 0, 512, 7, 0, 3, 0, 3);
        byte[] enc = UtpCodec.encodeViewport(m);
        assertEquals(28, enc.length);
        // Big-endian spot checks: imageId=1 at 2..3, tileSize=512 (0x0200) at 6..7.
        assertEquals(0, enc[2]);
        assertEquals(1, enc[3]);
        assertEquals(0x02, enc[6] & 0xFF);
        assertEquals(0x00, enc[7] & 0xFF);
        // reqId=7 at 8..11 big-endian.
        assertEquals(0, enc[8]);
        assertEquals(0, enc[9]);
        assertEquals(0, enc[10]);
        assertEquals(7, enc[11]);
        UtpMessages.ViewportUpdate back = UtpCodec.decodeViewport(enc);
        assertEquals(m, back);
    }

    @Test
    void commitAbort8B() {
        UtpMessages.ViewportCommit c = new UtpMessages.ViewportCommit(1, 9);
        byte[] ce = UtpCodec.encodeCommit(c);
        assertEquals(8, ce.length);
        assertEquals(new UtpMessages.ViewportCommit(1, 9), UtpCodec.decodeCommit(ce));
        UtpMessages.AbortStream a = new UtpMessages.AbortStream(1, 9);
        byte[] ae = UtpCodec.encodeAbort(a);
        assertEquals(8, ae.length);
        assertEquals(new UtpMessages.AbortStream(1, 9), UtpCodec.decodeAbort(ae));
    }

    @Test
    void tileHeaderGolden24B() {
        UtpMessages.TileHeader m = new UtpMessages.TileHeader(3, 1, 1, 512, 1, 0, 0, 0x00120304L);
        byte[] enc = UtpCodec.encodeTileHeader(m);
        assertEquals(24, enc.length);
        // LEN at 20..23 golden: 0x00120304 -> 00 12 03 04.
        assertEquals(0x00, enc[20] & 0xFF);
        assertEquals(0x12, enc[21] & 0xFF);
        assertEquals(0x03, enc[22] & 0xFF);
        assertEquals(0x04, enc[23] & 0xFF);
        assertEquals(1, enc[5] & 0xFF, "format must be 1");
        assertEquals(m, UtpCodec.decodeTileHeader(enc));
    }

    @Test
    void end16B() {
        UtpMessages.GenerationEnd m = new UtpMessages.GenerationEnd(1, 4, 4, 0);
        byte[] enc = UtpCodec.encodeEnd(m);
        assertEquals(16, enc.length);
        assertEquals(m, UtpCodec.decodeEnd(enc));
    }

    @Test
    void rejectMagic() {
        byte[] bad = UtpCodec.encodeCommit(new UtpMessages.ViewportCommit(1, 1));
        bad[0] = 0x55;
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeCommit(bad));
        byte[] badV = UtpCodec.encodeViewport(
                new UtpMessages.ViewportUpdate(1, 0, 0, 512, 1, 0, 0, 0, 0));
        badV[0] = 0x00;
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(badV));
    }

    @Test
    void rejectTileSize256() {
        byte[] enc = UtpCodec.encodeViewport(
                new UtpMessages.ViewportUpdate(1, 0, 0, 512, 1, 0, 0, 0, 0));
        enc[6] = 0x01;
        enc[7] = 0x00;
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(enc));
    }

    @Test
    void rejectLod1Reserved() {
        byte[] enc = UtpCodec.encodeViewport(
                new UtpMessages.ViewportUpdate(1, 0, 0, 512, 1, 0, 0, 0, 0));
        enc[5] = 0x01;
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(enc));
        assertThrows(IllegalArgumentException.class,
                () -> new UtpMessages.ViewportUpdate(1, 0, 1, 512, 1, 0, 0, 0, 0));
    }

    @Test
    void rejectLen3MiB() {
        long threeMiB = 3L * 1024 * 1024;
        assertTrue(threeMiB > Config.MAX_TILE_BYTES);
        assertThrows(IllegalArgumentException.class,
                () -> new UtpMessages.TileHeader(1, 0, 1, 512, 1, 0, 0, threeMiB));
        ByteBuffer b = ByteBuffer.allocate(24).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA);
        b.put((byte) 0x02);
        b.putShort((short) 1);
        b.put((byte) 0);
        b.put((byte) 1);
        b.putShort((short) 512);
        b.putInt(1);
        b.putInt(0);
        b.putInt(0);
        b.putInt((int) threeMiB);
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeTileHeader(b.array()));
    }

    @Test
    void rejectTruncated() {
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(new byte[27]));
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeCommit(new byte[7]));
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeAbort(new byte[3]));
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeTileHeader(new byte[23]));
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeEnd(new byte[15]));
    }

    @Test
    void rejectSpanOver128() {
        assertThrows(IllegalArgumentException.class,
                () -> new UtpMessages.ViewportUpdate(1, 0, 0, 512, 1, 0, 200, 0, 0));
    }

    @Test
    void u32MaxDecodesTo4294967295() {
        ByteBuffer b = ByteBuffer.allocate(28).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA);
        b.put((byte) 0x01);
        b.putShort((short) 1);
        b.put((byte) 0);
        b.put((byte) 0);
        b.putShort((short) 512);
        b.putInt(1);
        b.putInt(-1);
        b.putInt(0);
        b.putInt(0);
        b.putInt(0);
        byte[] raw = b.array();
        // Raw u32 parse yields 4294967295, never -1.
        ByteBuffer r = ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN);
        r.position(12);
        assertEquals(4294967295L, Integer.toUnsignedLong(r.getInt()));
        // Codec rejects on image-bounds/span validation.
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(raw));
    }

    @Test
    void rejectReversedRange() {
        ByteBuffer b = ByteBuffer.allocate(28).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA);
        b.put((byte) 0x01);
        b.putShort((short) 1);
        b.put((byte) 0);
        b.put((byte) 0);
        b.putShort((short) 512);
        b.putInt(1);
        b.putInt(5);
        b.putInt(3);
        b.putInt(0);
        b.putInt(0);
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(b.array()));
    }

    @Test
    void rejectHugeSpanProductInLong() {
        ByteBuffer b = ByteBuffer.allocate(28).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA);
        b.put((byte) 0x01);
        b.putShort((short) 1);
        b.put((byte) 0);
        b.put((byte) 0);
        b.putShort((short) 512);
        b.putInt(1);
        b.putInt(0);
        b.putInt(-1);
        b.putInt(0);
        b.putInt(0);
        // Product is 4294967296 in long, rejected without int-overflow.
        long w = 0xFFFFFFFFL - 0L + 1L;
        assertEquals(4294967296L, w);
        assertTrue(w > Config.GEN_TILE_CAP);
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeViewport(b.array()));
    }

    @Test
    void rejectLenMaxU32() {
        ByteBuffer b = ByteBuffer.allocate(24).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA);
        b.put((byte) 0x02);
        b.putShort((short) 1);
        b.put((byte) 0);
        b.put((byte) 1);
        b.putShort((short) 512);
        b.putInt(1);
        b.putInt(0);
        b.putInt(0);
        b.putInt(-1);
        assertEquals(4294967295L, Integer.toUnsignedLong(b.array()[20] << 24
                | (b.array()[21] & 0xFF) << 16 | (b.array()[22] & 0xFF) << 8
                | (b.array()[23] & 0xFF)));
        assertThrows(IllegalArgumentException.class, () -> UtpCodec.decodeTileHeader(b.array()));
    }

    @Test
    void format2RoundTripsAtCodec() {
        // Reserved, never emitted by the server: parsed here, handled downstream.
        UtpMessages.TileHeader m = new UtpMessages.TileHeader(1, 0, 2, 512, 1, 0, 0, 100);
        byte[] enc = UtpCodec.encodeTileHeader(m);
        assertEquals(2, enc[5] & 0xFF);
        assertEquals(m, UtpCodec.decodeTileHeader(enc));
    }

    @Test
    void dedupeAwareCap() {
        Set<Long> requested = new HashSet<>();
        for (int i = 0; i < Config.GEN_TILE_CAP; i++) {
            assertTrue(UtpCodec.admitTileKey(requested, i),
                    "first 256 unique keys must be admitted");
        }
        assertEquals(Config.GEN_TILE_CAP, requested.size());
        assertTrue(UtpCodec.admitTileKey(requested, 0L),
                "duplicate at cap must be accepted");
        assertEquals(Config.GEN_TILE_CAP, requested.size());
        assertFalse(UtpCodec.admitTileKey(requested, 256L),
                "257th unique key must be rejected");
    }
}
