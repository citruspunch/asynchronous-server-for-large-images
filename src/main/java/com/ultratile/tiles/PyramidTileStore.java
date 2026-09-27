package com.ultratile.tiles;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

import com.ultratile.Config;
import com.ultratile.proto.UtpMessages;

/**
 * Ceiling pyramid math plus canonical tile naming.
 *
 * <p>Edge JPEGs are physically 512x512 post-padded (solid black,
 * content top-left).
 */
public final class PyramidTileStore {
    private PyramidTileStore() {}

    /** Tile edge in pixels. */
    public static final int TILE = 512;

    /** Number of levels for a w-by-h image (N+1 where N is max level). */
    public static int levelCount(int w, int h) {
        if (w < 1 || h < 1) {
            throw new IllegalArgumentException("w,h must be >= 1");
        }
        int max = Math.max(w, h);
        int n = 0;
        long size = TILE;
        while (size < max) {
            size *= 2;
            n++;
        }
        return n + 1;
    }

    /** Max level index (N). */
    public static int maxLevel(int w, int h) {
        return levelCount(w, h) - 1;
    }

    /** Width of level Z (ceildiv, min 1). */
    public static int levelW(int w, int h, int z) {
        int n = maxLevel(w, h);
        checkLevel(z, n);
        int shift = n - z;
        long div = 1L << shift;
        long v = ((long) w + div - 1) / div;
        return (int) Math.max(1, v);
    }

    /** Height of level Z (ceildiv, min 1). */
    public static int levelH(int w, int h, int z) {
        int n = maxLevel(w, h);
        checkLevel(z, n);
        int shift = n - z;
        long div = 1L << shift;
        long v = ((long) h + div - 1) / div;
        return (int) Math.max(1, v);
    }

    /**
     * Tile columns at level Z.
     *
     * <p>Computed in {@code long} so the {@code +TILE-1} rounding step cannot
     * wrap even for a level width within a few hundred pixels of
     * {@link Integer#MAX_VALUE}. The result is an {@code int} because a level
     * can never usefully have more than {@code Integer.MAX_VALUE} columns; see
     * {@link #colsChecked} for the guarded variant used on the import path.
     */
    public static int cols(int w, int h, int z) {
        long lw = levelW(w, h, z);
        return (int) ((lw + TILE - 1) / TILE);
    }

    /** Tile rows at level Z. {@code long} rounding, as in {@link #cols}.} */
    public static int rows(int w, int h, int z) {
        long lh = levelH(w, h, z);
        return (int) ((lh + TILE - 1) / TILE);
    }

    /**
     * Total tile count across all levels, as a {@code long}.
     *
     * <p>{@code long} is mandatory, not defensive: a 65536x65536-tile image
     * (the largest this protocol can address) has 2^32 tiles in its finest
     * level alone, which overflows {@code int}. Callers that compare against a
     * cap must widen before multiplying.
     */
    public static long totalTiles(int w, int h) {
        int n = maxLevel(w, h);
        long total = 0L;
        for (int z = 0; z <= n; z++) {
            total += (long) cols(w, h, z) * rows(w, h, z);
        }
        return total;
    }

    /**
     * Largest image dimension, in pixels, that the UTP protocol can address.
     *
     * <p>Derived from the protocol's tile-coordinate bound rather than chosen:
     * see {@link UtpMessages#maxRepresentableDim()}. This is a
     * REPRESENTABILITY limit, not a resource policy — it is the point past
     * which some tile of the finest level could not be named on the wire at
     * all, no matter how the pyramid were stored.
     */
    public static final int MAX_REPRESENTABLE_DIM = UtpMessages.maxRepresentableDim();

    /**
     * Tiles per axis on the finest level for a {@code dim}-pixel axis.
     *
     * <p>Computed in {@code long}; for a legal image the result is at most
     * {@link UtpMessages#MAX_TILES_PER_AXIS}, but the intermediate stays wide
     * so an over-large input yields its true count instead of wrapping.
     */
    public static long tilesPerAxis(int dim) {
        return (((long) dim + TILE - 1) / TILE);
    }

    /**
     * Verifies that every tile of the finest level is addressable by the
     * protocol, and that the dimensions are positive.
     *
     * <p>Single source of truth for representability: {@link ImageRegistry}
     * (serving time) and {@link IngestTool} (import time) both call this, so
     * they cannot disagree about which images are legal.
     *
     * @throws IllegalArgumentException with the specific reason
     */
    public static void checkRepresentable(int w, int h) {
        if (w < 1 || h < 1) {
            throw new IllegalArgumentException(
                    "dimension must be >= 1: " + w + "x" + h);
        }
        long cols = tilesPerAxis(w);
        long rows = tilesPerAxis(h);
        long cap = UtpMessages.MAX_TILES_PER_AXIS;
        if (cols > cap || rows > cap) {
            throw new IllegalArgumentException("tile grid exceeds protocol coordinate range: "
                    + w + "x" + h + " needs " + cols + "x" + rows + " tiles per axis but the "
                    + "protocol addresses at most " + cap + " (coordinate bound "
                    + UtpMessages.MAX_TILE_COORD + " x " + TILE + " px tiles = "
                    + MAX_REPRESENTABLE_DIM + " px)");
        }
    }

    /** True when {@link #checkRepresentable} would accept these dimensions. */
    public static boolean isRepresentable(int w, int h) {
        try {
            checkRepresentable(w, h);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /**
     * Pre-import feasibility summary for a candidate image.
     *
     * <p>Every count here is a {@code long}: pixel products and tile-count
     * sums both exceed {@code int} for large inputs. Produced before any
     * expensive encode so a refusal can be explained with numbers.
     */
    public record PyramidPlan(int w, int h, int levels, int finestCols, int finestRows,
            long pixels, long totalTiles) {

        /** Finest level index (== {@code levels - 1}). */
        public int finestLevel() {
            return levels - 1;
        }

        /** One-line human summary, used in import refusals and logs. */
        public String describe() {
            return w + "x" + h + " (" + pixels + " px, " + levels + " levels, finest "
                    + finestCols + "x" + finestRows + " tiles, " + totalTiles + " tiles total)";
        }
    }

    /**
     * Builds the feasibility plan for a candidate image.
     *
     * <p>Requires {@code w >= 1 && h >= 1}; does not validate representability,
     * so it can also describe an image that is about to be refused.
     */
    public static PyramidPlan plan(int w, int h) {
        if (w < 1 || h < 1) {
            throw new IllegalArgumentException("w,h must be >= 1");
        }
        int levels = levelCount(w, h);
        int n = levels - 1;
        return new PyramidPlan(w, h, levels, cols(w, h, n), rows(w, h, n),
                (long) w * h, totalTiles(w, h));
    }

    private static void checkLevel(int z, int n) {
        if (z < 0 || z > n) {
            throw new IllegalArgumentException("level out of range: " + z);
        }
    }

    /**
     * Canonical tile naming as a relative path.
     * One naming algorithm owned by the store, never bound to a root.
     */
    public static String tileRelativePath(int z, int x, int y) {
        if (z < 0 || x < 0 || y < 0) {
            throw new IllegalArgumentException("z,x,y must be >= 0");
        }
        return "level-" + z + "/" + x + "_" + y + ".jpg";
    }

    /**
     * Default image root, honouring {@link Config#DATA_ROOT}. Every no-argument
     * path helper resolves through here so the whole store moves together when
     * {@code --data-root} is used; nothing may re-spell the literal default.
     */
    public static Path defaultRoot() {
        return Path.of(Config.DATA_ROOT);
    }

    /** Default image root: {@code <data root>/<canonical id>}. */
    public static Path imageRoot(int id) {
        return imageRoot(defaultRoot(), id);
    }

    /** Image root under a base dir. */
    public static Path imageRoot(Path base, int id) {
        checkId(id);
        return base.resolve(Integer.toString(id));
    }

    /** Serving path: {@code imageRoot(id).resolve(relative)}. */
    public static Path servePath(int id, int z, int x, int y) {
        return servePath(defaultRoot(), id, z, x, y);
    }

    /** Serving path under a base dir. */
    public static Path servePath(Path base, int id, int z, int x, int y) {
        checkId(id);
        if (z < 0 || x < 0 || y < 0) {
            throw new IllegalArgumentException("z,x,y must be >= 0");
        }
        return imageRoot(base, id).resolve(tileRelativePath(z, x, y));
    }

    /** Staging path: {@code tmpRoot.resolve(relative)}. */
    public static Path stagePath(Path tmpRoot, int z, int x, int y) {
        if (tmpRoot == null) {
            throw new IllegalArgumentException("tmpRoot must not be null");
        }
        if (z < 0 || x < 0 || y < 0) {
            throw new IllegalArgumentException("z,x,y must be >= 0");
        }
        return tmpRoot.resolve(tileRelativePath(z, x, y));
    }

    private static void checkId(int id) {
        if (id < 0 || id > 65535) {
            throw new IllegalArgumentException("id out of range: " + id);
        }
    }

    /** Rejects missing/unreadable/empty/oversize tiles. */
    public static void checkSize(Path path) throws IOException {
        if (path == null || !Files.isRegularFile(path) || !Files.isReadable(path)) {
            throw new IOException("missing/unreadable tile: " + path);
        }
        long size = Files.size(path);
        if (size <= 0) {
            throw new IOException("empty tile: " + path);
        }
        if (size > Config.MAX_TILE_BYTES) {
            throw new IOException("tile too large: " + path + " (" + size + " bytes)");
        }
    }

    /** Size of a tile after {@link #checkSize(Path)}. */
    public static long tileSize(Path path) throws IOException {
        checkSize(path);
        return Files.size(path);
    }

    /**
     * Opens a tile channel for serving. Validates id before path join.
     */
    public static FileChannel openTileChannel(int id, int z, int x, int y) throws IOException {
        Path p = servePath(id, z, x, y);
        checkSize(p);
        return FileChannel.open(p, StandardOpenOption.READ);
    }

    /** Test-only byte[] read. */
    public static byte[] readTile(int id, int z, int x, int y) throws IOException {
        Path p = servePath(id, z, x, y);
        checkSize(p);
        return Files.readAllBytes(p);
    }

    /** Test-only byte[] read under a base dir. */
    public static byte[] readTile(Path base, int id, int z, int x, int y) throws IOException {
        Path p = servePath(base, id, z, x, y);
        checkSize(p);
        return Files.readAllBytes(p);
    }
}
