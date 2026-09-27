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

    /**
     * Max image id, inclusive. Distinct from {@link #MAX_TILE_COORD}: this one
     * IS a wire width, since imageId is a u16 field. It happens to share the
     * value 65535, which is exactly why the two must not share a name.
     */
    public static final int MAX_IMAGE_ID = 0xFFFF;

    /**
     * Max tile coordinate on either axis, inclusive.
     *
     * <p>This bounds every coordinate field: the VIEWPORT chunk
     * {@code minX/maxX/minY/maxY} rectangle and the TILE header
     * {@code tileX/tileY}.
     *
     * <p><b>This is a policy bound, not a wire limit.</b> UTP/1.0 section 4
     * encodes those fields as u32 and requires only that they lie in
     * {@code 0..0xFFFFFFFF}; the specification does not require 65535. An
     * earlier revision of this comment claimed the bound was forced by the
     * {@code (x << 32) | y} tile-key packing. That claim was wrong, and has been
     * measured: the packing round-trips correctly across the whole u32 range,
     * including {@code x = 2^31} and {@code x = 2^32-1}, because {@code x} is a
     * {@code long} and {@code key >>> 32} recovers it even when the packed value
     * has its sign bit set.
     *
     * <p>It is retained because (a) it is the specified, implemented and tested
     * bound, and widening it is a protocol-visible behaviour change with no
     * benefit at any plausible image size, and (b) it keeps every coordinate
     * inside 16 bits, so all consumers - wire codec, key packing, the {@code int}
     * path components in the tile store, and the viewer's JS number arithmetic -
     * are trivially in range without per-layer range reasoning.
     *
     * <p>Headroom is large: 65536 tiles per axis is 33,554,432 px, whereas a
     * 9 gigapixel 108200x81500 mosaic needs 212 tiles per axis, about 309x
     * margin. Widening this bound would be a UTP/1.1 decision and would require
     * no wire-format change.
     */
    public static final int MAX_TILE_COORD = 65535;

    /** Tiles per axis at {@link #MAX_TILE_COORD}: endpoints are inclusive. */
    public static final int MAX_TILES_PER_AXIS = MAX_TILE_COORD + 1;

    /**
     * Largest image dimension, in pixels, that this protocol can address.
     *
     * <p>Derived, not chosen: maximum representable dimension = maximum tile
     * count per axis × tile size = {@code (MAX_TILE_COORD + 1) * 512} =
     * 33,554,432 px. An image needing more tiles along an axis than
     * {@link #MAX_TILES_PER_AXIS} could not have all of its tiles addressed on
     * the wire, so it is not representable regardless of how it is stored.
     */
    public static int maxRepresentableDim() {
        return (int) ((long) MAX_TILES_PER_AXIS * Config.TILE_SIZE);
    }

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
            if (imageId < 0 || imageId > MAX_IMAGE_ID) {
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
            if (minX > MAX_TILE_COORD || maxX > MAX_TILE_COORD
                    || minY > MAX_TILE_COORD || maxY > MAX_TILE_COORD) {
                throw new IllegalArgumentException(
                        "tile coordinate exceeds protocol bound " + MAX_TILE_COORD);
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
            if (imageId < 0 || imageId > MAX_IMAGE_ID) {
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
            if (imageId < 0 || imageId > MAX_IMAGE_ID) {
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
            if (imageId < 0 || imageId > MAX_IMAGE_ID) {
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
            if (tileX > MAX_TILE_COORD || tileY > MAX_TILE_COORD) {
                throw new IllegalArgumentException(
                        "tile coordinate exceeds protocol bound " + MAX_TILE_COORD);
            }
            if (payloadLen < 1 || payloadLen > Config.MAX_TILE_BYTES) {
                throw new IllegalArgumentException("payloadLen gate: " + payloadLen);
            }
        }
    }

    /** Generation end: 16B. */
    public record GenerationEnd(int imageId, long reqId, long sent, long skipped) {
        public GenerationEnd {
            if (imageId < 0 || imageId > MAX_IMAGE_ID) {
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
