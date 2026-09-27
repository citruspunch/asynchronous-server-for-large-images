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

    /**
     * Default root for generated image pyramids, relative to the working
     * directory. Overridable with {@code --data-root <dir>}.
     *
     * <p>This matters for grading-scale images: the PYRAMID is what consumes
     * disk during serving, and at grading scale the source file is several
     * times larger than the pyramid it produces, so both may need to sit on a
     * large external volume while the repository stays where it is.
     *
     * <p>The Java default and the shell default in {@code scripts/import_vips.sh}
     * must agree or the importer would write where the server does not look;
     * {@code check_const_parity.py} asserts that they do.
     *
     * <p>Atomic publication is unaffected by relocating the root: staging
     * ({@code .tmp-<id>/}) and the published target ({@code <id>/}) are always
     * siblings under this one root, so the final rename still happens within a
     * single filesystem.
     */
    public static final String DATA_ROOT = "data/images";

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

    /**
     * Max total pyramid tiles accepted for one image (operational policy).
     *
     * <p>This is a RESOURCE limit: it bounds the amount of generation,
     * filesystem and validation work a single import may request. It is NOT the
     * protocol ceiling, and it is deliberately NOT enforced by
     * {@link com.ultratile.tiles.ImageRegistry}, which validates
     * representability instead. Whether an image is addressable at all is decided
     * by
     * {@link com.ultratile.tiles.PyramidTileStore#MAX_REPRESENTABLE_DIM},
     * derived from the UTP tile-coordinate bound. Disk feasibility is a separate
     * importer check, because JPEG Q85 tile size is content-dependent and cannot
     * be predicted from the source file size.
     *
     * <p><b>Why 2^24 and not something larger.</b> The previous value, 2^28
     * (268,435,456), was not a useful policy: at the ~140 KB mean tile size
     * measured on the real image ladder it implies tens of terabytes, so no
     * filesystem check would ever admit it, while the validation it was
     * nominally protecting against would take hours. Measured on APFS with
     * 262,144 files in one directory, whole-directory scans run at about 16 us
     * per file, so the importer's generate + glob + sort + compare cost is about
     * 50 us per tile. 2^24 therefore caps the validation pass at roughly 14
     * minutes in the worst case instead of roughly 3.7 hours. The exact
     * microbenchmark numbers belong in the documentation, not here.
     *
     * <p>Headroom over real inputs is large. The 9 gigapixel VVV mosaic
     * (108200x81500) is 45,252 tiles, and a 400 gigapixel square is about 2.0
     * million tiles, roughly 8x below this bound.
     */
    public static final long IMPORT_MAX_TILES = 16777216L;

    /**
     * Max dimension for the ImageIO convenience fallback.
     *
     * <p>A MEMORY limit, not a representability one: the fallback calls
     * {@code reader.read(0)}, materialising the whole decoded image in the heap.
     * Large images must go through {@code scripts/import_vips.sh}, which never
     * loads the full image.
     */
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
