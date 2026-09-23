package com.ultratile.proto;

import com.ultratile.Config;

/**
 * Single owner of wire magic and UTP type codes.
 *
 * <p>Protocol constants live here, NOT in {@code Config} (which owns
 * operational tuning only).
 */
public final class UtpMessages {
    private UtpMessages() {}

    /** Wire magic. */
    public static final int MAGIC = 0xAA;

    /** Viewport chunk. */
    public static final int T_VIEWPORT = 0x01;
    /** Tile data header (server to client). */
    public static final int T_TILE = 0x02;
    /** Abort stream. */
    public static final int T_ABORT = 0x03;
    /** Generation end (server to client). */
    public static final int T_END = 0x04;
    /** Viewport commit (seal). */
    public static final int T_COMMIT = 0x05;

    /** Mandatory subprotocol. */
    public static final String SUBPROTOCOL = "ultratile.utp.v1";

    /** Nearest-only LOD. Values 1/2 are reserved and rejected. */
    public static final int LOD_NEAREST = 0;

    /** JPEG: the only implemented format. */
    public static final int FORMAT_JPEG = 1;
    /** WebP: reserved wire value, parsed but never emitted. */
    public static final int FORMAT_WEBP = 2;

    /** Max request id (no-wrap: never reset on image switch). */
    public static final long REQ_ID_MAX = 0xFFFFFFFEL;

    /** Viewport chunk: 28B. */
    public record ViewportUpdate(
            int imageId,
            int zoom,
            int lodMode,
            int tileSize,
            long reqId,
            long minX,
            long maxX,
            long minY,
            long maxY) {
        public ViewportUpdate {
            if (imageId < 0 || imageId > 65535) {
                throw new IllegalArgumentException("imageId out of range: " + imageId);
            }
            if (zoom < 0 || zoom > 255) {
                throw new IllegalArgumentException("zoom out of range: " + zoom);
            }
            if (lodMode != LOD_NEAREST) {
                throw new IllegalArgumentException("lodMode reserved (only 0): " + lodMode);
            }
            if (tileSize != Config.TILE_SIZE) {
                throw new IllegalArgumentException("tileSize must be 512: " + tileSize);
            }
            if (reqId < 1 || reqId > REQ_ID_MAX) {
                throw new IllegalArgumentException("reqId out of range: " + reqId);
            }
            if (!u32(minX) || !u32(maxX) || !u32(minY) || !u32(maxY)) {
                throw new IllegalArgumentException("coords must be u32");
            }
            if (minX > 65535 || maxX > 65535 || minY > 65535 || maxY > 65535) {
                throw new IllegalArgumentException("coords image-agnostic bound 65535 exceeded");
            }
            if (minX > maxX || minY > maxY) {
                throw new IllegalArgumentException("reversed range");
            }
            long w = maxX - minX + 1L;
            long h = maxY - minY + 1L;
            if (w > Config.SPAN_CAP || h > Config.SPAN_CAP) {
                throw new IllegalArgumentException("span exceeds 128");
            }
            if (w * h > Config.GEN_TILE_CAP) {
                throw new IllegalArgumentException("chunk exceeds generation cap");
            }
        }
    }

    /** Commit (seal): 8B. Empty COMMIT is legal. */
    public record ViewportCommit(int imageId, long reqId) {
        public ViewportCommit {
            if (imageId < 0 || imageId > 65535) {
                throw new IllegalArgumentException("imageId out of range: " + imageId);
            }
            if (reqId < 1 || reqId > REQ_ID_MAX) {
                throw new IllegalArgumentException("reqId out of range: " + reqId);
            }
        }
    }

    /** Abort: 8B, terminal, no END. */
    public record AbortStream(int imageId, long abortReqId) {
        public AbortStream {
            if (imageId < 0 || imageId > 65535) {
                throw new IllegalArgumentException("imageId out of range: " + imageId);
            }
            if (abortReqId < 1 || abortReqId > REQ_ID_MAX) {
                throw new IllegalArgumentException("abortReqId out of range: " + abortReqId);
            }
        }
    }

    /** Tile header: 24B (no payload bytes here). */
    public record TileHeader(
            int imageId,
            int zoom,
            int format,
            int tileSize,
            long reqId,
            long tileX,
            long tileY,
            long payloadLen) {
        public TileHeader {
            if (imageId < 0 || imageId > 65535) {
                throw new IllegalArgumentException("imageId out of range: " + imageId);
            }
            if (zoom < 0 || zoom > 255) {
                throw new IllegalArgumentException("zoom out of range: " + zoom);
            }
            if (format != FORMAT_JPEG && format != FORMAT_WEBP) {
                throw new IllegalArgumentException("format must be 1 or 2: " + format);
            }
            if (tileSize != Config.TILE_SIZE) {
                throw new IllegalArgumentException("tileSize must be 512: " + tileSize);
            }
            if (reqId < 1 || reqId > REQ_ID_MAX) {
                throw new IllegalArgumentException("reqId out of range: " + reqId);
            }
            if (!u32(tileX) || !u32(tileY)) {
                throw new IllegalArgumentException("tile coords must be u32");
            }
            if (tileX > 65535 || tileY > 65535) {
                throw new IllegalArgumentException("tile coords bound 65535 exceeded");
            }
            if (payloadLen < 1 || payloadLen > Config.MAX_TILE_BYTES) {
                throw new IllegalArgumentException("payloadLen gate: " + payloadLen);
            }
        }
    }

    /** Generation end: 16B. */
    public record GenerationEnd(int imageId, long reqId, long sent, long skipped) {
        public GenerationEnd {
            if (imageId < 0 || imageId > 65535) {
                throw new IllegalArgumentException("imageId out of range: " + imageId);
            }
            if (reqId < 1 || reqId > REQ_ID_MAX) {
                throw new IllegalArgumentException("reqId out of range: " + reqId);
            }
            if (!u32(sent) || !u32(skipped)) {
                throw new IllegalArgumentException("sent/skipped must be u32");
            }
        }
    }

    private static boolean u32(long v) {
        return v >= 0 && v <= 0xFFFFFFFFL;
    }
}
