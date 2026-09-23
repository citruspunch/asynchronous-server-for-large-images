package com.ultratile.tiles;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

import com.ultratile.Config;

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
        long v = (w + div - 1) / div;
        return (int) Math.max(1, v);
    }

    /** Height of level Z (ceildiv, min 1). */
    public static int levelH(int w, int h, int z) {
        int n = maxLevel(w, h);
        checkLevel(z, n);
        int shift = n - z;
        long div = 1L << shift;
        long v = (h + div - 1) / div;
        return (int) Math.max(1, v);
    }

    /** Tile columns at level Z. */
    public static int cols(int w, int h, int z) {
        return (levelW(w, h, z) + TILE - 1) / TILE;
    }

    /** Tile rows at level Z. */
    public static int rows(int w, int h, int z) {
        return (levelH(w, h, z) + TILE - 1) / TILE;
    }

    /** Total tile count across all levels. */
    public static int totalTiles(int w, int h) {
        int n = maxLevel(w, h);
        int total = 0;
        for (int z = 0; z <= n; z++) {
            total += cols(w, h, z) * rows(w, h, z);
        }
        return total;
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

    /** Default image root: {@code data/images/<canonical id>}. */
    public static Path imageRoot(int id) {
        return imageRoot(Path.of("data", "images"), id);
    }

    /** Image root under a base dir. */
    public static Path imageRoot(Path base, int id) {
        checkId(id);
        return base.resolve(Integer.toString(id));
    }

    /** Serving path: {@code imageRoot(id).resolve(relative)}. */
    public static Path servePath(int id, int z, int x, int y) {
        return servePath(Path.of("data", "images"), id, z, x, y);
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
