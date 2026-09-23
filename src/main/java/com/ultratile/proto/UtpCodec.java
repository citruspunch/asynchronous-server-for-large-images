package com.ultratile.proto;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Set;

import com.ultratile.Config;

/**
 * Big-endian UTP/1.0 codec with u32 discipline.
 */
public final class UtpCodec {
    private UtpCodec() {}

    public static final int LEN_VIEWPORT = 28;
    public static final int LEN_COMMIT = 8;
    public static final int LEN_ABORT = 8;
    public static final int LEN_TILE = 24;
    public static final int LEN_END = 16;

    // ---- encode ----

    public static byte[] encodeViewport(UtpMessages.ViewportUpdate m) {
        ByteBuffer b = ByteBuffer.allocate(LEN_VIEWPORT).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) UtpMessages.MAGIC);
        b.put((byte) UtpMessages.T_VIEWPORT);
        b.putShort((short) m.imageId());
        b.put((byte) m.zoom());
        b.put((byte) m.lodMode());
        b.putShort((short) m.tileSize());
        b.putInt((int) m.reqId());
        b.putInt((int) m.minX());
        b.putInt((int) m.maxX());
        b.putInt((int) m.minY());
        b.putInt((int) m.maxY());
        return b.array();
    }

    public static byte[] encodeCommit(UtpMessages.ViewportCommit m) {
        ByteBuffer b = ByteBuffer.allocate(LEN_COMMIT).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) UtpMessages.MAGIC);
        b.put((byte) UtpMessages.T_COMMIT);
        b.putShort((short) m.imageId());
        b.putInt((int) m.reqId());
        return b.array();
    }

    public static byte[] encodeAbort(UtpMessages.AbortStream m) {
        ByteBuffer b = ByteBuffer.allocate(LEN_ABORT).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) UtpMessages.MAGIC);
        b.put((byte) UtpMessages.T_ABORT);
        b.putShort((short) m.imageId());
        b.putInt((int) m.abortReqId());
        return b.array();
    }

    public static byte[] encodeTileHeader(UtpMessages.TileHeader m) {
        ByteBuffer b = ByteBuffer.allocate(LEN_TILE).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) UtpMessages.MAGIC);
        b.put((byte) UtpMessages.T_TILE);
        b.putShort((short) m.imageId());
        b.put((byte) m.zoom());
        b.put((byte) m.format());
        b.putShort((short) m.tileSize());
        b.putInt((int) m.reqId());
        b.putInt((int) m.tileX());
        b.putInt((int) m.tileY());
        b.putInt((int) m.payloadLen());
        return b.array();
    }

    public static byte[] encodeEnd(UtpMessages.GenerationEnd m) {
        ByteBuffer b = ByteBuffer.allocate(LEN_END).order(ByteOrder.BIG_ENDIAN);
        b.put((byte) UtpMessages.MAGIC);
        b.put((byte) UtpMessages.T_END);
        b.putShort((short) m.imageId());
        b.putInt((int) m.reqId());
        b.putInt((int) m.sent());
        b.putInt((int) m.skipped());
        return b.array();
    }

    // ---- decode ----

    public static UtpMessages.ViewportUpdate decodeViewport(byte[] data) {
        if (data == null || data.length != LEN_VIEWPORT) {
            throw new IllegalArgumentException("viewport must be 28B");
        }
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN);
        int magic = b.get() & 0xFF;
        int type = b.get() & 0xFF;
        if (magic != UtpMessages.MAGIC) {
            throw new IllegalArgumentException("bad magic");
        }
        if (type != UtpMessages.T_VIEWPORT) {
            throw new IllegalArgumentException("bad type for viewport");
        }
        int imageId = Short.toUnsignedInt(b.getShort());
        int zoom = b.get() & 0xFF;
        int lodMode = b.get() & 0xFF;
        int tileSize = Short.toUnsignedInt(b.getShort());
        long reqId = Integer.toUnsignedLong(b.getInt());
        long minX = Integer.toUnsignedLong(b.getInt());
        long maxX = Integer.toUnsignedLong(b.getInt());
        long minY = Integer.toUnsignedLong(b.getInt());
        long maxY = Integer.toUnsignedLong(b.getInt());
        if (tileSize != Config.TILE_SIZE) {
            throw new IllegalArgumentException("tileSize must be 512");
        }
        if (lodMode != UtpMessages.LOD_NEAREST) {
            throw new IllegalArgumentException("lodMode reserved");
        }
        if (minX > maxX || minY > maxY) {
            throw new IllegalArgumentException("reversed range");
        }
        // Widths/spans computed in long before comparing (never int-overflow).
        long w = maxX - minX + 1L;
        long h = maxY - minY + 1L;
        long product = w * h;
        if (w > Config.SPAN_CAP || h > Config.SPAN_CAP) {
            throw new IllegalArgumentException("span exceeds 128");
        }
        if (product > Config.GEN_TILE_CAP) {
            throw new IllegalArgumentException("chunk exceeds generation cap");
        }
        return new UtpMessages.ViewportUpdate(
                imageId, zoom, lodMode, tileSize, reqId, minX, maxX, minY, maxY);
    }

    public static UtpMessages.ViewportCommit decodeCommit(byte[] data) {
        if (data == null || data.length != LEN_COMMIT) {
            throw new IllegalArgumentException("commit must be 8B");
        }
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN);
        int magic = b.get() & 0xFF;
        int type = b.get() & 0xFF;
        if (magic != UtpMessages.MAGIC) {
            throw new IllegalArgumentException("bad magic");
        }
        if (type != UtpMessages.T_COMMIT) {
            throw new IllegalArgumentException("bad type for commit");
        }
        int imageId = Short.toUnsignedInt(b.getShort());
        long reqId = Integer.toUnsignedLong(b.getInt());
        return new UtpMessages.ViewportCommit(imageId, reqId);
    }

    public static UtpMessages.AbortStream decodeAbort(byte[] data) {
        if (data == null || data.length != LEN_ABORT) {
            throw new IllegalArgumentException("abort must be 8B");
        }
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN);
        int magic = b.get() & 0xFF;
        int type = b.get() & 0xFF;
        if (magic != UtpMessages.MAGIC) {
            throw new IllegalArgumentException("bad magic");
        }
        if (type != UtpMessages.T_ABORT) {
            throw new IllegalArgumentException("bad type for abort");
        }
        int imageId = Short.toUnsignedInt(b.getShort());
        long reqId = Integer.toUnsignedLong(b.getInt());
        return new UtpMessages.AbortStream(imageId, reqId);
    }

    public static UtpMessages.TileHeader decodeTileHeader(byte[] data) {
        if (data == null || data.length != LEN_TILE) {
            throw new IllegalArgumentException("tile header must be 24B");
        }
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN);
        int magic = b.get() & 0xFF;
        int type = b.get() & 0xFF;
        if (magic != UtpMessages.MAGIC) {
            throw new IllegalArgumentException("bad magic");
        }
        if (type != UtpMessages.T_TILE) {
            throw new IllegalArgumentException("bad type for tile");
        }
        int imageId = Short.toUnsignedInt(b.getShort());
        int zoom = b.get() & 0xFF;
        int format = b.get() & 0xFF;
        int tileSize = Short.toUnsignedInt(b.getShort());
        long reqId = Integer.toUnsignedLong(b.getInt());
        long tileX = Integer.toUnsignedLong(b.getInt());
        long tileY = Integer.toUnsignedLong(b.getInt());
        long payloadLen = Integer.toUnsignedLong(b.getInt());
        if (tileSize != Config.TILE_SIZE) {
            throw new IllegalArgumentException("tileSize must be 512");
        }
        if (payloadLen < 1 || payloadLen > Config.MAX_TILE_BYTES) {
            throw new IllegalArgumentException("payloadLen gate");
        }
        return new UtpMessages.TileHeader(
                imageId, zoom, format, tileSize, reqId, tileX, tileY, payloadLen);
    }

    public static UtpMessages.GenerationEnd decodeEnd(byte[] data) {
        if (data == null || data.length != LEN_END) {
            throw new IllegalArgumentException("end must be 16B");
        }
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN);
        int magic = b.get() & 0xFF;
        int type = b.get() & 0xFF;
        if (magic != UtpMessages.MAGIC) {
            throw new IllegalArgumentException("bad magic");
        }
        if (type != UtpMessages.T_END) {
            throw new IllegalArgumentException("bad type for end");
        }
        int imageId = Short.toUnsignedInt(b.getShort());
        long reqId = Integer.toUnsignedLong(b.getInt());
        long sent = Integer.toUnsignedLong(b.getInt());
        long skipped = Integer.toUnsignedLong(b.getInt());
        return new UtpMessages.GenerationEnd(imageId, reqId, sent, skipped);
    }

    /**
     * Dedupe-aware generation-cap admission.
     * A duplicate at cap is accepted; the 257th unique key is rejected.
     *
     * @return true when admitted (key added when new), false when rejected
     */
    public static boolean admitTileKey(Set<Long> requested, long key) {
        if (!requested.contains(key) && requested.size() == Config.GEN_TILE_CAP) {
            return false;
        }
        requested.add(key);
        return true;
    }
}
