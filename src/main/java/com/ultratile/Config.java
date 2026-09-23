package com.ultratile;

/**
 * Single source for operational tuning constants.
 *
 * <p>Wire magic and UTP type codes live in {@code proto.UtpMessages},
 * not here. This class owns tuning only: tile size, cache, decode
 * budgets, image caps, generation caps, transport caps, seeds, scales.
 */
public final class Config {
    private Config() {}

    /** Default bind address (loopback; use --bind 0.0.0.0 to opt into LAN). */
    public static final String BIND = "127.0.0.1";

    /** Default TCP port. */
    public static final int PORT = 8080;

    /** Tile edge in pixels. */
    public static final int TILE_SIZE = 512;

    /** LRU cache capacity in tiles. */
    public static final int CACHE_CAP = 40;

    /** Max concurrent decodes in flight. */
    public static final int DECODE_MAX = 6;

    /** Decode queue cap in jobs. */
    public static final int DECODE_QUEUE_JOBS = 24;

    /** Decode queue cap in bytes (4 MiB). */
    public static final int DECODE_QUEUE_BYTES = 4 * 1024 * 1024;

    /** JPEG quality for generated tiles. */
    public static final int JPEG_QUALITY = 85;

    /** Max image dimension in pixels. */
    public static final int MAX_DIM = 262144;

    /** Max dimension for the ImageIO convenience fallback. */
    public static final int IMPORT_IMAGE_MAX_DIM = 8192;

    /**
     * Max pixel count for the ImageIO convenience fallback.
     * 16 MP as an RGBA8 estimate of about 64 MiB pixels, not a true
     * worst case: higher-bit-depth sources and downsampling working
     * images allocate beyond the raw pixel product.
     */
    public static final int IMPORT_IMAGE_MAX_PIXELS = 16777216;

    /** Max unique tiles per generation. */
    public static final int GEN_TILE_CAP = 256;

    /** Max tiles per client batch. */
    public static final int BATCH_CAP = 30;

    /** Max span per viewport chunk packet. */
    public static final int SPAN_CAP = 128;

    /** Max WebSocket message size class (1 KiB control cap family). */
    public static final int WS_MSG_CAP = 1024;

    /** Max encoded tile bytes (2 MiB). */
    public static final int MAX_TILE_BYTES = 2 * 1024 * 1024;

    /** Max metadata file bytes (16 KiB). */
    public static final int META_MAX_BYTES = 16384;

    /** Max metadata display-name length. */
    public static final int META_NAME_MAX = 128;

    /** Max remembered rejected request ids (never evicts live entries). */
    public static final int REJECTED_CAP = 64;

    /** Seed estimate for average tile bytes (128 KiB). */
    public static final int AVG_TILE_SEED = 131072;

    /** Minimum viewport scale. */
    public static final double SCALE_MIN = 1e-3;

    /** Maximum viewport scale. */
    public static final double SCALE_MAX = 32.0;
}
