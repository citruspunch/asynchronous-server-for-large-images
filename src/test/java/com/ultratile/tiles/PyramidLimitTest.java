package com.ultratile.tiles;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.ultratile.Config;
import com.ultratile.proto.UtpMessages;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Large-dimension boundary tests for the pyramid math, the derived
 * representability limit, and registry/importer agreement.
 *
 * <p>Every case here is header-only or pure math: no pyramid is generated, so
 * nothing needs disk proportional to the dimensions under test. The largest
 * case is 33554432x33554432, which would be 5.7 billion tiles and tens of TB.
 *
 * <p>Import admission is exercised through {@link IngestTool#admit}, the pure
 * gate both import modes share, rather than by generating a pyramid.
 */
class PyramidLimitTest {

    // ---- the derived limit itself ----

    @Test
    void derivedLimitFollowsFromCoordinateBoundAndTileSize() {
        assertEquals(65535, UtpMessages.MAX_TILE_COORD);
        assertEquals(65536, UtpMessages.MAX_TILES_PER_AXIS);
        assertEquals(512, Config.TILE_SIZE);
        // max representable dimension = max tiles per axis * tile size
        assertEquals(33554432, UtpMessages.maxRepresentableDim());
        assertEquals(UtpMessages.maxRepresentableDim(), PyramidTileStore.MAX_REPRESENTABLE_DIM);
        // The ceiling is 2^25, comfortably inside a u32 coordinate space. It is
        // NOT derived from the key packing: that round-trips over all of u32
        // (measured). 2^25 simply comes from 65536 tiles x 512 px.
        assertEquals(1L << 25, PyramidTileStore.MAX_REPRESENTABLE_DIM);
        assertTrue(PyramidTileStore.MAX_REPRESENTABLE_DIM <= 0xFFFFFFFFL);
    }

    @Test
    void imageIdAndTileCoordBoundsAreDistinctConcepts() {
        // Both are 65535 today, but one is a u16 wire width and the other an
        // application bound on u32 fields. They must not be conflated.
        assertEquals(0xFFFF, UtpMessages.MAX_IMAGE_ID);
        assertEquals(65535, UtpMessages.MAX_TILE_COORD);
    }

    // ---- the old 262144 ceiling is no longer a boundary ----

    @Test
    void oldCeilingIsNowAnOrdinaryImage() {
        // Previously refused outright. It is a 68.7 gigapixel image: entirely
        // representable, and only ~350k tiles.
        assertTrue(PyramidTileStore.isRepresentable(262144, 262144));
        assertEquals(349525L, PyramidTileStore.totalTiles(262144, 262144));
        assertNotNull(IngestTool.admit(262144, 262144));
    }

    @Test
    void justAboveOldCeilingIsAccepted() throws Exception {
        assertTrue(PyramidTileStore.isRepresentable(262145, 262145));
        assertTrue(PyramidTileStore.isRepresentable(262145, 100000));
        assertTrue(PyramidTileStore.isRepresentable(300000, 300000));
        assertNotNull(IngestTool.admit(300000, 300000));
    }

    // ---- the real protocol boundary ----

    @Test
    void maximumRepresentableSquareIsAccepted() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        assertTrue(PyramidTileStore.isRepresentable(d, d));
        assertEquals(UtpMessages.MAX_TILES_PER_AXIS, PyramidTileStore.cols(d, d, 16));
        assertEquals(UtpMessages.MAX_TILES_PER_AXIS, PyramidTileStore.rows(d, d, 16));
        assertEquals(17, PyramidTileStore.levelCount(d, d));
    }

    @Test
    void onePixelPastTheLimitIsRefusedWithTheCoordinateReason() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM + 1;
        assertFalse(PyramidTileStore.isRepresentable(d, d));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> PyramidTileStore.checkRepresentable(d, d));
        String msg = e.getMessage();
        // A refusal must name the actual cause, never just "too large".
        assertTrue(msg.contains("protocol coordinate range"), msg);
        assertTrue(msg.contains(String.valueOf(UtpMessages.MAX_TILES_PER_AXIS)), msg);
        assertFalse(msg.contains("too large"), msg);
    }

    @Test
    void protocolTileCoordinateBoundary() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        assertEquals(UtpMessages.MAX_TILE_COORD, d / Config.TILE_SIZE - 1);
        assertNotNull(new UtpMessages.TileHeader(0, 0, UtpMessages.FORMAT_JPEG,
                Config.TILE_SIZE, 1L, UtpMessages.MAX_TILE_COORD, UtpMessages.MAX_TILE_COORD, 16));
        assertThrows(IllegalArgumentException.class, () -> new UtpMessages.TileHeader(
                0, 0, UtpMessages.FORMAT_JPEG, Config.TILE_SIZE, 1L,
                UtpMessages.MAX_TILE_COORD + 1L, 0, 16));
    }

    @Test
    void viewportCoordinateBoundary() {
        long c = UtpMessages.MAX_TILE_COORD;
        assertNotNull(new UtpMessages.ViewportUpdate(0, 0, UtpMessages.LOD_NEAREST,
                Config.TILE_SIZE, 1L, c, c, c, c));
        assertThrows(IllegalArgumentException.class, () -> new UtpMessages.ViewportUpdate(
                0, 0, UtpMessages.LOD_NEAREST, Config.TILE_SIZE, 1L, c + 1, c, c, c));
    }

    // ---- long arithmetic where int would silently wrap ----

    @Test
    void totalTilesExceedsIntRangeAtTheProtocolLimit() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        long total = PyramidTileStore.totalTiles(d, d);
        // Finest level alone is 65536*65536 = 2^32 tiles, which does not fit int.
        long finest = (long) UtpMessages.MAX_TILES_PER_AXIS * UtpMessages.MAX_TILES_PER_AXIS;
        assertEquals(4294967296L, finest);
        assertTrue(finest > Integer.MAX_VALUE);
        assertTrue(total > Integer.MAX_VALUE,
                "expected the long total past int range, got " + total);
        assertTrue(total > finest, "the smaller levels add to the finest");
    }

    @Test
    void pixelProductUsesLong() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        long px = (long) d * d;
        assertEquals(1125899906842624L, px);         // 2^50
        assertEquals(px, PyramidTileStore.plan(d, d).pixels());
    }

    @Test
    void naiveIntMultiplyWouldWrapWhereOursDoesNot() {
        // 46341^2 = 2,147,488,281 overflows a signed int and wraps NEGATIVE.
        assertTrue(46341 * 46341 < 0, "sanity: naive int multiply wraps");
        assertEquals(2147488281L, (long) 46341 * 46341);
        // Our long path keeps the true value for a perfectly legal image.
        assertTrue(PyramidTileStore.isRepresentable(46341, 46341));
        assertEquals(2147488281L, PyramidTileStore.plan(46341, 46341).pixels());
        // And the 2^50 case wraps to exactly 0 in int.
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        assertEquals(0, d * d);
        assertNotEquals((long) (d * d), (long) d * d);
    }

    // ---- aspect ratios ----

    @Test
    void degenerateDimensionsAreRefusedNotClamped() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        assertFalse(PyramidTileStore.isRepresentable(d, 0));
        assertFalse(PyramidTileStore.isRepresentable(0, d));
        assertFalse(PyramidTileStore.isRepresentable(-1, 10));
        assertThrows(IllegalArgumentException.class,
                () -> PyramidTileStore.checkRepresentable(10, 0));
    }

    @Test
    void veryWideAndVeryTallAreAsymmetric() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        // 65536 tiles across, one down: legal at the very limit.
        assertTrue(PyramidTileStore.isRepresentable(d, Config.TILE_SIZE));
        var plan = PyramidTileStore.plan(d, Config.TILE_SIZE);
        assertEquals(UtpMessages.MAX_TILES_PER_AXIS, plan.finestCols());
        assertEquals(1, plan.finestRows());
        assertEquals(17, PyramidTileStore.levelCount(d, 1));
        assertEquals(UtpMessages.MAX_TILES_PER_AXIS, PyramidTileStore.cols(d, 1, 16));
        assertEquals(1, PyramidTileStore.rows(d, 1, 16));
    }

    // ---- plan / feasibility numbers ----

    @Test
    void planMatchesTheShippedTestImages() {
        var p = PyramidTileStore.plan(40000, 30131);
        assertEquals(8, p.levels());
        assertEquals(7, p.finestLevel());
        assertEquals(79, p.finestCols());
        assertEquals(59, p.finestRows());
        assertEquals(1205240000L, p.pixels());
        assertEquals(6270L, p.totalTiles());
        assertTrue(p.describe().contains("40000x30131"));
    }

    @Test
    void everyLevelIsAddressableAtTheLimit() {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        int n = PyramidTileStore.maxLevel(d, d);
        assertEquals(d, PyramidTileStore.levelW(d, d, n));
        // Coarsest level is 512x512 px, which is exactly ONE tile -- "one tile"
        // is a grid fact, not a one-pixel level.
        assertEquals(512, PyramidTileStore.levelW(d, d, 0));
        assertEquals(1, PyramidTileStore.cols(d, d, 0));
        assertEquals(1, PyramidTileStore.rows(d, d, 0));
        for (int z = 0; z <= n; z++) {
            assertTrue(PyramidTileStore.cols(d, d, z) <= UtpMessages.MAX_TILES_PER_AXIS, "z=" + z);
            assertTrue(PyramidTileStore.rows(d, d, z) <= UtpMessages.MAX_TILES_PER_AXIS, "z=" + z);
        }
    }

    // ---- importer policy, independent of representability ----

    @Test
    void tileCapIsDerivedNotArbitrary() {
        // The cap must stay far above every plausible real image while keeping
        // the importer's validation bounded. Anchors measured on real data:
        long vvv = PyramidTileStore.totalTiles(108200, 81500);   // 9 gigapixel
        assertEquals(45252L, vvv);
        // ~8x headroom even against the brief's aspirational 400 gigapixels
        // (400e9 / 512^2 * 4/3).
        long fourHundredGp = (long) (400e9 / (512.0 * 512.0) * 4.0 / 3.0);
        assertTrue(Config.IMPORT_MAX_TILES > fourHundredGp,
                "cap " + Config.IMPORT_MAX_TILES + " must exceed " + (long) fourHundredGp);
        assertTrue(Config.IMPORT_MAX_TILES > vvv * 100,
                "cap must have >100x headroom over a 9 gigapixel image");
        // Pinned to 2^24 exactly, and asserted to BE a power of two so the
        // intent stays legible rather than drifting to an arbitrary literal.
        assertEquals(16777216L, Config.IMPORT_MAX_TILES);
        assertEquals(24, Long.numberOfTrailingZeros(Config.IMPORT_MAX_TILES));
        assertEquals(0L, Config.IMPORT_MAX_TILES & (Config.IMPORT_MAX_TILES - 1L));
    }

    @Test
    void realLadderImagesAreAllWellUnderTheCap() {
        int[][] ladder = {{10000, 7533}, {25000, 18832}, {40000, 30131},
                          {108200, 81500}};
        for (int[] d : ladder) {
            long n = PyramidTileStore.totalTiles(d[0], d[1]);
            assertTrue(n <= Config.IMPORT_MAX_TILES,
                    d[0] + "x" + d[1] + " -> " + n + " tiles exceeds the cap");
            assertNotNull(IngestTool.admit(d[0], d[1]));
        }
    }

    @Test
    void representableButAbsurdIsRefusedByTheTileCap() {
        // The largest protocol-representable square needs 5.7e9 tiles, which the
        // operational policy declines. Two different reasons, two different
        // messages -- this is the point of separating the two limits.
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        assertTrue(PyramidTileStore.isRepresentable(d, d));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> IngestTool.admit(d, d));
        String msg = e.getMessage();
        assertTrue(msg.contains("exceeds operational limit"), msg);
        assertTrue(msg.contains(String.valueOf(Config.IMPORT_MAX_TILES)), msg);
        assertFalse(msg.contains("too large"), msg);
    }

    @Test
    void importerRefusesUnrepresentableBeforeTouchingDisk(@TempDir Path tmp) throws Exception {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM + 1;
        // admit() runs before any directory is created, so this is cheap.
        assertEquals(2, IngestTool.runSynthetic(tmp, "40", d, d));
        assertFalse(Files.exists(tmp.resolve("40")));
    }

    // ---- registry must not silently drop a legal large image ----

    @Test
    void registryAcceptsImagesAboveTheOldCeiling(@TempDir Path tmp) throws IOException {
        assertNotNull(writeMeta(tmp, 41, 400000, 300000));
        assertNotNull(writeMeta(tmp, 44, 262145, 262145));
        assertNotNull(writeMeta(tmp, 45, 1000000, 1000000));
    }

    @Test
    void registryRepresentsTheProtocolMaximum(@TempDir Path tmp) throws IOException {
        // The protocol maximum is accepted by the registry, because the tile
        // cap is an IMPORT policy, not a serving-time restriction. What a real
        // deployment would do is run out of disk, not out of representability.
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        assertNotNull(writeMeta(tmp, 42, d, d));
    }

    @Test
    void registryRefusesOnePastTheProtocolMaximum(@TempDir Path tmp) throws IOException {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM + 1;
        assertNull(writeMeta(tmp, 43, d, d));
    }

    @Test
    void registryIsMorePermissiveThanTheImporter(@TempDir Path tmp) throws IOException {
        int d = PyramidTileStore.MAX_REPRESENTABLE_DIM;
        int[] probes = {1, 2, 511, 512, 513, 262144, 262145, 1000000, d - 1, d, d + 1};
        int id = 50;
        for (int w : probes) {
            boolean registryOk = writeMeta(tmp, id, w, w) != null;
            boolean representable = PyramidTileStore.isRepresentable(w, w);
            boolean withinCap = PyramidTileStore.totalTiles(w, w) <= Config.IMPORT_MAX_TILES;
            boolean importerOk;
            try {
                IngestTool.admit(w, w);
                importerOk = true;
            } catch (IllegalArgumentException e) {
                importerOk = false;
            }
            // The registry tracks representability exactly: it must never serve
            // an image whose tile grid the protocol could not address.
            assertEquals(representable, registryOk,
                    "registry must track representability at " + w);
            // The importer is representability AND the resource cap, so it may
            // refuse strictly more -- but never something representable that is
            // also within the cap.
            assertEquals(representable && withinCap, importerOk,
                    "importer admission is wrong at " + w);
            // And the registry is never stricter than the importer.
            assertTrue(!registryOk || importerOk || !withinCap,
                    "registry refused " + w + " that the importer would accept");
            id++;
        }
    }

    // ---- helpers ----

    /**
     * Writes a header-only image (meta.json plus .ready, no tiles) and returns
     * the parsed record, or null when the registry rejects it. Mirrors what the
     * importer publishes without generating a pyramid.
     */
    private static ImageRegistry.ImageInfo writeMeta(Path base, int id, int w, int h)
            throws IOException {
        Path dir = base.resolve(Integer.toString(id));
        Files.createDirectories(dir);
        String json = "{\"id\":" + id + ",\"name\":\"image-" + id + "\",\"w\":" + w
                + ",\"h\":" + h + ",\"levels\":" + PyramidTileStore.levelCount(w, h)
                + ",\"tile\":512}";
        Files.writeString(dir.resolve("meta.json"), json, StandardCharsets.UTF_8);
        Files.createFile(dir.resolve(".ready"));
        return new ImageRegistry(base).get(id);
    }
}
