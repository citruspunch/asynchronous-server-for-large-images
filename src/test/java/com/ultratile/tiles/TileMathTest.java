package com.ultratile.tiles;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.image.BufferedImage;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.CRC32;

import javax.imageio.ImageIO;

import com.ultratile.Config;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TileMathTest {

    @Test
    void ceilingLevels() {
        assertEquals(3, PyramidTileStore.levelCount(2048, 2048));
        assertEquals(2, PyramidTileStore.maxLevel(2048, 2048));
        assertEquals(1, PyramidTileStore.levelCount(256, 256));
        assertEquals(1, PyramidTileStore.levelCount(17, 17));
        assertEquals(257, PyramidTileStore.levelW(513, 513, 0));
        assertEquals(21, PyramidTileStore.totalTiles(2048, 2048));
        assertEquals(85, PyramidTileStore.totalTiles(4096, 4096));
        assertEquals(1, PyramidTileStore.totalTiles(256, 256));
        assertEquals(5, PyramidTileStore.totalTiles(513, 513));
    }

    @Test
    void directNtoZ() {
        // n=0 smallest maps directly.
        assertEquals(0, PyramidTileStore.maxLevel(512, 512));
        assertEquals(1, PyramidTileStore.levelCount(512, 512));
        assertEquals(256, PyramidTileStore.levelW(256, 256, 0));
        assertEquals(256, PyramidTileStore.levelH(256, 256, 0));
        assertEquals(1, PyramidTileStore.cols(256, 256, 0));
        assertEquals(1, PyramidTileStore.rows(256, 256, 0));
    }

    @Test
    void canonicalRelativePathnames() {
        assertEquals("level-3/0_4.jpg", PyramidTileStore.tileRelativePath(3, 0, 4));
        assertEquals("level-2/0_0.jpg", PyramidTileStore.tileRelativePath(2, 0, 0));
        assertThrows(IllegalArgumentException.class,
                () -> PyramidTileStore.tileRelativePath(-1, 0, 0));
    }

    @Test
    void noTilePrefixLiteralsOutsideStore() throws Exception {
        Path root = Path.of("src/main/java");
        if (!Files.isDirectory(root)) {
            // Maven always runs from the repo root; fail loud otherwise.
            throw new IOException("missing src/main/java (run from repo root)");
        }
        try (var walk = Files.walk(root)) {
            for (Path p : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
                if (p.getFileName().toString().equals("PyramidTileStore.java")) {
                    continue;
                }
                String content = Files.readString(p);
                assertFalse(content.contains("level-"),
                        "tile prefix literal outside store: " + p);
            }
        }
    }

    @Test
    void readTileMissingThrows() {
        assertThrows(IOException.class, () -> PyramidTileStore.readTile(9999, 0, 0, 0));
        assertThrows(IllegalArgumentException.class,
                () -> PyramidTileStore.servePath(-1, 0, 0, 0));
    }

    @Test
    void sizeGate(@TempDir Path tmp) throws Exception {
        Path missing = tmp.resolve("nope.jpg");
        assertThrows(IOException.class, () -> PyramidTileStore.checkSize(missing));
        Path empty = tmp.resolve("empty.jpg");
        Files.createFile(empty);
        assertThrows(IOException.class, () -> PyramidTileStore.checkSize(empty));
        Path big = tmp.resolve("big.jpg");
        byte[] payload = new byte[Config.MAX_TILE_BYTES + 1];
        payload[0] = 1;
        Files.write(big, payload);
        assertThrows(IOException.class, () -> PyramidTileStore.checkSize(big));
        Path ok = tmp.resolve("ok.jpg");
        Files.write(ok, new byte[]{1, 2, 3});
        assertEquals(3, PyramidTileStore.tileSize(ok));
    }

    @Test
    void syntheticGenerates21WithReady(@TempDir Path tmp) throws Exception {
        int rc = IngestTool.runSynthetic(tmp, "0", 2048, 2048);
        assertEquals(0, rc);
        assertTrue(Files.isRegularFile(tmp.resolve("0/.ready")));
        long count;
        try (var walk = Files.walk(tmp.resolve("0"))) {
            count = walk.filter(p -> p.toString().endsWith(".jpg")).count();
        }
        assertEquals(21, count);
        // Canonical pathnames resolve through the serving resolver.
        assertTrue(Files.isRegularFile(PyramidTileStore.servePath(tmp, 0, 2, 0, 0)));
    }

    @Test
    void noBlackBleed(@TempDir Path tmp) throws Exception {
        int rc = IngestTool.runSynthetic(tmp, "5", 600, 600);
        assertEquals(0, rc);
        // Finest level is Z=1 with 2x2 tiles; tile (1,1) is 88x88 content + pad.
        Path edge = PyramidTileStore.servePath(tmp, 5, 1, 1, 1);
        assertTrue(Files.isRegularFile(edge));
        BufferedImage img = ImageIO.read(edge.toFile());
        assertNotNull(img);
        assertEquals(512, img.getWidth());
        assertEquals(512, img.getHeight());
        int content = img.getRGB(0, 0) & 0xFFFFFF;
        int pad = img.getRGB(511, 511) & 0xFFFFFF;
        assertEquals(0, pad, "pad must be solid black");
        assertTrue(content != 0, "content pixel must not be black-bled");
    }

    @Test
    void readyGate(@TempDir Path tmp) throws Exception {
        Path dir = tmp.resolve("9");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("meta.json"),
                "{\"id\":9,\"name\":\"image-9\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512}");
        ImageRegistry reg = new ImageRegistry(tmp);
        assertNull(reg.get(9), "dirs without .ready must be ignored");
        assertTrue(reg.list().isEmpty());
    }

    @Test
    void tmpRecovery(@TempDir Path tmp) throws Exception {
        Path leftover = tmp.resolve(".tmp-9");
        Files.createDirectories(leftover);
        Files.writeString(leftover.resolve("junk.txt"), "leftover");
        int rc = IngestTool.runSynthetic(tmp, "9", 256, 256);
        assertEquals(0, rc);
        assertTrue(Files.isRegularFile(tmp.resolve("9/.ready")));
        boolean quarantined;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(tmp, ".stale-tmp-9-*")) {
            quarantined = ds.iterator().hasNext();
        }
        assertTrue(quarantined, "leftover staging must be quarantined");
    }

    @Test
    void idValidation(@TempDir Path tmp) throws Exception {
        String[] bad = {"../0", "-1", "70000", "01", "0001"};
        for (String raw : bad) {
            int rc = IngestTool.runSynthetic(tmp, raw, 256, 256);
            assertEquals(2, rc, "id must be refused: " + raw);
        }
        assertFalse(Files.exists(tmp.resolve("01")));
        assertFalse(Files.exists(tmp.resolve("0001")));
    }

    @Test
    void idempotentNoOp(@TempDir Path tmp) throws Exception {
        assertEquals(0, IngestTool.runSynthetic(tmp, "11", 256, 256));
        Path meta = tmp.resolve("11/meta.json");
        long m1 = Files.getLastModifiedTime(meta).toMillis();
        Thread.sleep(5);
        assertEquals(0, IngestTool.runSynthetic(tmp, "11", 256, 256));
        long m2 = Files.getLastModifiedTime(meta).toMillis();
        assertEquals(m1, m2, "ready target must be untouched on rerun");
    }

    @Test
    void perIdDemoRule(@TempDir Path tmp) throws Exception {
        assertEquals(0, IngestTool.runSynthetic(tmp, "7", 256, 256));
        ImageRegistry.ensureStartup(tmp);
        ImageRegistry reg = new ImageRegistry(tmp);
        assertNotNull(reg.get(0));
        assertNotNull(reg.get(1));
        ImageRegistry.ImageInfo seven = reg.get(7);
        assertNotNull(seven, "custom id7 must survive demo ensure");
        assertEquals(256, seven.w());
    }

    @Test
    void demoRepair(@TempDir Path tmp) throws Exception {
        Path zero = tmp.resolve("0");
        Files.createDirectories(zero);
        Files.writeString(zero.resolve("meta.json"), "{bad json");
        Files.createFile(zero.resolve(".ready"));
        ImageRegistry.ensureStartup(tmp);
        boolean quarantined;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(tmp, ".stale-invalid-0-*")) {
            quarantined = ds.iterator().hasNext();
        }
        assertTrue(quarantined, "corrupt ready demo must be quarantined");
        ImageRegistry reg = new ImageRegistry(tmp);
        ImageRegistry.ImageInfo info = reg.get(0);
        assertNotNull(info, "demo 0 must be regenerated");
        assertEquals(2048, info.w());
    }

    @Test
    void strictMetaVectors(@TempDir Path tmp) throws Exception {
        // Positive control.
        assertEquals(0, IngestTool.runSynthetic(tmp, "20", 256, 256));
        assertNotNull(new ImageRegistry(tmp).get(20));

        // Each bad case lives in its own base so ids do not collide.
        assertIgnoredMeta("malformed", "{not json", true);
        assertIgnoredMeta("bad-tile", "{\"id\":30,\"name\":\"image-30\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":256}", true);
        assertIgnoredMeta("bad-levels", "{\"id\":31,\"name\":\"image-31\",\"w\":2048,\"h\":2048,\"levels\":9,\"tile\":512}", true);
        assertIgnoredMeta("bad-escape", "{\"id\":32,\"name\":\"a\\qb\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512}", true);
        assertIgnoredMeta("id-mismatch", "{\"id\":0,\"name\":\"image-5\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512}", false, "5");
        assertIgnoredMeta("bad-name", "{\"id\":5,\"name\":\"other\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512}", false, "5");
        // Non-canonical dirname with otherwise valid meta.
        Path base01 = Files.createTempDirectory("meta01");
        try {
            Path d = base01.resolve("01");
            Files.createDirectories(d);
            Files.writeString(d.resolve("meta.json"),
                    "{\"id\":1,\"name\":\"image-1\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512}");
            Files.createFile(d.resolve(".ready"));
            assertNull(new ImageRegistry(base01).get(1));
            assertTrue(new ImageRegistry(base01).list().isEmpty());
        } finally {
            deleteRec(base01);
        }
        // 17 KiB meta ignored pre-parse.
        Path baseBig = Files.createTempDirectory("metabig");
        try {
            Path d = baseBig.resolve("40");
            Files.createDirectories(d);
            StringBuilder sb = new StringBuilder("{\"id\":40,\"name\":\"image-40\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512,");
            while (sb.length() < 17 * 1024) {
                sb.append("\"pad\":\"x\",");
            }
            sb.append("\"end\":1}");
            Files.writeString(d.resolve("meta.json"), sb.toString());
            Files.createFile(d.resolve(".ready"));
            assertNull(new ImageRegistry(baseBig).get(40));
        } finally {
            deleteRec(baseBig);
        }
        // 200-char name ignored.
        Path baseName = Files.createTempDirectory("metaname");
        try {
            Path d = baseName.resolve("41");
            Files.createDirectories(d);
            String longName = "x".repeat(200);
            Files.writeString(d.resolve("meta.json"),
                    "{\"id\":41,\"name\":\"" + longName + "\",\"w\":256,\"h\":256,\"levels\":1,\"tile\":512}");
            Files.createFile(d.resolve(".ready"));
            assertNull(new ImageRegistry(baseName).get(41));
        } finally {
            deleteRec(baseName);
        }
    }

    private void assertIgnoredMeta(String tag, String json, boolean useOwnDir) throws Exception {
        assertIgnoredMeta(tag, json, useOwnDir, "30");
    }

    private void assertIgnoredMeta(String tag, String json, boolean useOwnDir, String dir)
            throws Exception {
        Path base = Files.createTempDirectory("meta-" + tag);
        try {
            Path d = base.resolve(dir);
            Files.createDirectories(d);
            Files.writeString(d.resolve("meta.json"), json);
            Files.createFile(d.resolve(".ready"));
            ImageRegistry reg = new ImageRegistry(base);
            int id = Integer.parseInt(dir);
            assertNull(reg.get(id), tag + " must be ignored");
            assertTrue(reg.list().isEmpty(), tag + " must not list");
        } finally {
            deleteRec(base);
        }
        if (useOwnDir) {
            // no-op to keep signature stable
        }
    }

    @Test
    void imageIoMode(@TempDir Path tmp) throws Exception {
        BufferedImage img = new BufferedImage(96, 64, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 64; y++) {
            for (int x = 0; x < 96; x++) {
                img.setRGB(x, y, ((x * 255 / 95) << 16) | ((y * 255 / 63) << 8) | 128);
            }
        }
        Path png = tmp.resolve("src.png");
        ImageIO.write(img, "png", png.toFile());
        Path base = tmp.resolve("base");
        Files.createDirectories(base);
        int rc = IngestTool.runImage(base, png, "21");
        assertEquals(0, rc);
        assertTrue(Files.isRegularFile(base.resolve("21/.ready")));
        assertEquals(1, PyramidTileStore.totalTiles(96, 64));
        assertTrue(Files.isRegularFile(PyramidTileStore.servePath(base, 21, 0, 0, 0)));
    }

    @Test
    void imageIoRefusesLargeDim(@TempDir Path tmp) throws Exception {
        BufferedImage img = new BufferedImage(9000, 16, BufferedImage.TYPE_INT_RGB);
        Path png = tmp.resolve("wide.png");
        ImageIO.write(img, "png", png.toFile());
        Path base = tmp.resolve("base");
        Files.createDirectories(base);
        int rc = IngestTool.runImage(base, png, "22");
        assertEquals(2, rc, "9000px-wide source must be refused with exit 2");
        assertFalse(Files.exists(base.resolve("22")));
    }

    @Test
    void imageIoPixelCapOnly(@TempDir Path tmp) throws Exception {
        // Header-only PNG: IHDR claims 4097x4097 (both axes within the dim
        // cap, area above the pixel cap). The importer must refuse BEFORE
        // decode, so no full raster is ever allocated.
        Path png = tmp.resolve("big.png");
        writeMinimalPng(png, 4097, 4097);
        Path base = tmp.resolve("base");
        Files.createDirectories(base);
        int rc = IngestTool.runImage(base, png, "23");
        assertEquals(2, rc, "4097x4097 pixel-cap-only source must be refused with exit 2");
        assertFalse(Files.exists(base.resolve("23")));
    }

    @Test
    void crossImporterPathnames(@TempDir Path tmp) throws Exception {
        assertEquals(0, IngestTool.runSynthetic(tmp, "31", 256, 256));
        BufferedImage img = new BufferedImage(96, 64, BufferedImage.TYPE_INT_RGB);
        Path png = tmp.resolve("c.png");
        ImageIO.write(img, "png", png.toFile());
        assertEquals(0, IngestTool.runImage(tmp, png, "32"));
        for (int id : new int[]{31, 32}) {
            ImageRegistry.ImageInfo info = new ImageRegistry(tmp).get(id);
            assertNotNull(info);
            int n = info.levels() - 1;
            for (int z = 0; z <= n; z++) {
                int cols = PyramidTileStore.cols(info.w(), info.h(), z);
                int rows = PyramidTileStore.rows(info.w(), info.h(), z);
                for (int y = 0; y < rows; y++) {
                    for (int x = 0; x < cols; x++) {
                        assertTrue(Files.isRegularFile(PyramidTileStore.servePath(tmp, id, z, x, y)),
                                "missing tile for " + id + " z" + z + " " + x + "," + y);
                    }
                }
            }
        }
    }

    @Test
    void nonReadyQuarantineOnStartup(@TempDir Path tmp) throws Exception {
        Path dir = tmp.resolve("42");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("junk.txt"), "x");
        ImageRegistry.ensureStartup(tmp);
        boolean found;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(tmp, ".stale-42-*")) {
            found = ds.iterator().hasNext();
        }
        assertTrue(found);
        List<ImageRegistry.ImageInfo> list = new ImageRegistry(tmp).list();
        assertTrue(list.stream().anyMatch(i -> i.id() == 0));
        assertTrue(list.stream().anyMatch(i -> i.id() == 1));
    }

    private static void writeMinimalPng(Path p, int w, int h) throws Exception {
        try (DataOutputStream out = new DataOutputStream(Files.newOutputStream(p))) {
            out.write(new byte[]{(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A});
            byte[] ihdr = new byte[13];
            ihdr[0] = (byte) (w >> 24);
            ihdr[1] = (byte) (w >> 16);
            ihdr[2] = (byte) (w >> 8);
            ihdr[3] = (byte) w;
            ihdr[4] = (byte) (h >> 24);
            ihdr[5] = (byte) (h >> 16);
            ihdr[6] = (byte) (h >> 8);
            ihdr[7] = (byte) h;
            ihdr[8] = 8;
            ihdr[9] = 2;
            ihdr[10] = 0;
            ihdr[11] = 0;
            ihdr[12] = 0;
            writeChunk(out, "IHDR", ihdr);
            writeChunk(out, "IEND", new byte[0]);
        }
    }

    private static void writeChunk(DataOutputStream out, String type, byte[] data)
            throws Exception {
        out.writeInt(data.length);
        byte[] tb = type.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        out.write(tb);
        out.write(data);
        CRC32 crc = new CRC32();
        crc.update(tb);
        crc.update(data);
        out.writeInt((int) crc.getValue());
    }

    private static void deleteRec(Path p) throws Exception {
        if (!Files.exists(p)) {
            return;
        }
        try (var walk = Files.walk(p)) {
            for (Path q : (Iterable<Path>) walk.sorted(java.util.Comparator.reverseOrder())::iterator) {
                Files.deleteIfExists(q);
            }
        }
    }
}
