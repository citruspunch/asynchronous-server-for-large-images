package com.ultratile.tiles;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Iterator;
import java.util.logging.Logger;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;

import com.ultratile.Config;

/**
 * Validated atomic importer with synthetic and pre-decode-capped ImageIO modes.
 *
 * <p>Both modes share one publish path: stage, validate, write meta plus
 * ready marker, then atomically rename into place.
 */
public final class IngestTool {
    private static final Logger LOG = Logger.getLogger(IngestTool.class.getName());

    private static final Path DEFAULT_BASE = PyramidTileStore.defaultRoot();

    private IngestTool() {}

    public static void main(String[] args) throws Exception {
        int rc = run(args, DEFAULT_BASE);
        if (rc != 0) {
            System.exit(rc);
        }
    }

    /**
     * Runs an import, returning a process-style exit code (0 ok, 2 refused).
     * Never throws for refuses; throws only on unexpected I/O.
     */
    public static int run(String[] args, Path base) throws Exception {
        if (args == null || args.length == 0) {
            System.err.println("usage: IngestTool <id> <w> <h> | IngestTool --image <file> <id>");
            return 2;
        }
        if ("--image".equals(args[0])) {
            if (args.length != 3) {
                System.err.println("usage: IngestTool --image <file> <id>");
                return 2;
            }
            return runImage(base, Path.of(args[1]), args[2]);
        }
        if (args.length != 3) {
            System.err.println("usage: IngestTool <id> <w> <h>");
            return 2;
        }
        int w;
        int h;
        try {
            w = Integer.parseInt(args[1]);
            h = Integer.parseInt(args[2]);
        } catch (NumberFormatException e) {
            System.err.println("invalid dimensions: " + args[1] + " " + args[2]);
            return 2;
        }
        return runSynthetic(base, args[0], w, h);
    }

    /** Canonical-ID gate shared by both modes. Returns parsed id or -1. */
    static int canonicalIdOrRefuse(String rawId) {
        if (rawId == null || !rawId.matches("^[0-9]+$")) {
            System.err.println("invalid id (must be decimal 0..65535): " + rawId);
            return -1;
        }
        int parsed;
        try {
            parsed = Integer.parseInt(rawId);
        } catch (NumberFormatException e) {
            System.err.println("invalid id (must be decimal 0..65535): " + rawId);
            return -1;
        }
        if (parsed < 0 || parsed > 65535) {
            System.err.println("invalid id (must be decimal 0..65535): " + rawId);
            return -1;
        }
        if (!rawId.equals(Integer.toString(parsed))) {
            System.err.println("invalid id (leading zeros rejected): " + rawId);
            return -1;
        }
        return parsed;
    }

    /**
     * Shared admission gate for both import modes.
     *
     * <p>Three distinct limits, each with its own reason, so a refusal always
     * names the actual cause: positive dimensions, protocol representability
     * (tile grid addressable on the wire), then the operational tile-count
     * policy.
     *
     * @return the feasibility plan, so callers can log real numbers
     * @throws IllegalArgumentException with the specific reason
     */
    static PyramidTileStore.PyramidPlan admit(int w, int h) {
        PyramidTileStore.checkRepresentable(w, h);
        PyramidTileStore.PyramidPlan plan = PyramidTileStore.plan(w, h);
        if (plan.totalTiles() > Config.IMPORT_MAX_TILES) {
            throw new IllegalArgumentException("pyramid tile count " + plan.totalTiles()
                    + " exceeds operational limit " + Config.IMPORT_MAX_TILES
                    + " (" + plan.describe() + ")");
        }
        return plan;
    }

    /** Synthetic mode. */
    public static int runSynthetic(Path base, String rawId, int w, int h) throws Exception {
        int id = canonicalIdOrRefuse(rawId);
        if (id < 0) {
            return 2;
        }
        String canon = Integer.toString(id);
        try {
            admit(w, h);
        } catch (IllegalArgumentException e) {
            System.err.println("refusing synthetic image-" + canon + ": " + e.getMessage());
            return 2;
        }
        Path target = base.resolve(canon);
        if (Files.isRegularFile(target.resolve(".ready"))) {
            System.out.println("already-ready image-" + canon);
            return 0;
        }
        recoverTmp(base, canon);
        quarantineNonReady(target, base, canon);
        Path tmp = base.resolve(".tmp-" + canon);
        Files.createDirectories(tmp);
        try {
            generateSynthetic(tmp, w, h);
            writeMeta(tmp, id, canon, w, h);
            validateStaged(tmp, w, h);
            Files.createFile(tmp.resolve(".ready"));
            publish(tmp, target);
        } catch (Exception e) {
            throw e;
        }
        return 0;
    }

    /** Bounded real-image mode. */
    public static int runImage(Path base, Path srcFile, String rawId) throws Exception {
        int id = canonicalIdOrRefuse(rawId);
        if (id < 0) {
            return 2;
        }
        String canon = Integer.toString(id);
        Path target = base.resolve(canon);
        if (Files.isRegularFile(target.resolve(".ready"))) {
            System.out.println("already-ready image-" + canon);
            return 0;
        }
        BufferedImage src;
        int w;
        int h;
        try (ImageInputStream iis = ImageIO.createImageInputStream(srcFile.toFile())) {
            if (iis == null) {
                System.err.println("unreadable image: " + srcFile);
                return 2;
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                System.err.println("unreadable image (no reader): " + srcFile);
                return 2;
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(iis);
                w = reader.getWidth(0);
                h = reader.getHeight(0);
                if (Math.max(w, h) > Config.IMPORT_IMAGE_MAX_DIM
                        || (long) w * h > Config.IMPORT_IMAGE_MAX_PIXELS) {
                    System.err.println("too large for ImageIO fallback — use import_vips.sh: "
                            + w + "x" + h);
                    return 2;
                }
                src = reader.read(0);
            } finally {
                reader.dispose();
            }
        }
        if (src == null) {
            System.err.println("unreadable image (decode failed): " + srcFile);
            return 2;
        }
        w = src.getWidth();
        h = src.getHeight();
        try {
            admit(w, h);
        } catch (IllegalArgumentException e) {
            System.err.println("refusing image-" + canon + ": " + e.getMessage());
            return 2;
        }
        recoverTmp(base, canon);
        quarantineNonReady(target, base, canon);
        Path tmp = base.resolve(".tmp-" + canon);
        Files.createDirectories(tmp);
        generateFromImage(tmp, src, w, h);
        writeMeta(tmp, id, canon, w, h);
        validateStaged(tmp, w, h);
        Files.createFile(tmp.resolve(".ready"));
        publish(tmp, target);
        return 0;
    }

    private static void recoverTmp(Path base, String canon) throws IOException {
        Path tmp = base.resolve(".tmp-" + canon);
        if (Files.exists(tmp)) {
            String epoch = Long.toString(System.currentTimeMillis() / 1000L);
            Path dest = base.resolve(".stale-tmp-" + canon + "-" + epoch);
            Files.move(tmp, dest);
            System.out.println("recovered leftover staging to " + dest.getFileName());
            LOG.info("recovered leftover staging " + tmp + " to " + dest);
        }
    }

    private static void quarantineNonReady(Path target, Path base, String canon) throws IOException {
        if (Files.exists(target) && !Files.isRegularFile(target.resolve(".ready"))) {
            String epoch = Long.toString(System.currentTimeMillis() / 1000L);
            Path dest = base.resolve(".stale-" + canon + "-" + epoch);
            Files.move(target, dest);
            System.out.println("quarantined non-ready target to " + dest.getFileName());
            LOG.info("quarantined non-ready " + target + " to " + dest);
        }
    }

    /**
     * Publishes the staged tree with a REQUIRED atomic rename.
     *
     * <p>There is deliberately no non-atomic fallback. A plain
     * {@code Files.move} degrades to copy-then-delete, and the copy order is
     * unspecified, so the zero-byte {@code .ready} marker could land before the
     * tiles it certifies. That would expose exactly the partial-publication
     * state {@code .ready} exists to make unobservable, and it would do so
     * silently. Failing loudly is the correct trade: staging
     * ({@code .tmp-<id>}) and the target ({@code <id>}) are always siblings under
     * one root, so a same-filesystem rename is the normal case, and a
     * filesystem that refuses it is a real deployment problem an operator needs
     * to see rather than a condition to paper over.
     */
    private static void publish(Path tmp, Path target) throws IOException {
        try {
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            throw new IOException("filesystem cannot publish atomically (ATOMIC_MOVE "
                    + "unsupported for " + target.getParent() + "); refusing to publish image-"
                    + target.getFileName() + ". A non-atomic move could expose .ready before "
                    + "the tiles it certifies. Staging and target must be siblings on one "
                    + "filesystem.", e);
        }
    }

    /** Deterministic synthetic pixel: gradient plus diagonal texture. */
    static int pixel(int gx, int gy, int w, int h) {
        int r = w <= 1 ? 128 : (gx * 255) / (w - 1);
        int g = h <= 1 ? 128 : (gy * 255) / (h - 1);
        int b = (gx + gy) & 0xFF;
        // Add checker texture so decodes are distinguishable from flat fills.
        if (((gx >> 5) + (gy >> 5)) % 2 == 0) {
            r = Math.min(255, r + 24);
            g = Math.min(255, g + 24);
        }
        return (r << 16) | (g << 8) | b;
    }

    private static void generateSynthetic(Path tmp, int w, int h) throws IOException {
        int n = PyramidTileStore.maxLevel(w, h);
        for (int z = 0; z <= n; z++) {
            int lw = PyramidTileStore.levelW(w, h, z);
            int lh = PyramidTileStore.levelH(w, h, z);
            int cols = PyramidTileStore.cols(w, h, z);
            int rows = PyramidTileStore.rows(w, h, z);
            for (int ty = 0; ty < rows; ty++) {
                for (int tx = 0; tx < cols; tx++) {
                    BufferedImage tile = new BufferedImage(
                            PyramidTileStore.TILE, PyramidTileStore.TILE,
                            BufferedImage.TYPE_INT_RGB);
                    int aw = Math.min(PyramidTileStore.TILE, lw - tx * PyramidTileStore.TILE);
                    int ah = Math.min(PyramidTileStore.TILE, lh - ty * PyramidTileStore.TILE);
                    // Frozen fill: solid black, content top-left, pad right/bottom.
                    Graphics2D g = tile.createGraphics();
                    g.setColor(Color.BLACK);
                    g.fillRect(0, 0, PyramidTileStore.TILE, PyramidTileStore.TILE);
                    g.dispose();
                    for (int py = 0; py < ah; py++) {
                        int ly = ty * PyramidTileStore.TILE + py;
                        for (int px = 0; px < aw; px++) {
                            int lx = tx * PyramidTileStore.TILE + px;
                            tile.setRGB(px, py, pixel(lx, ly, lw, lh));
                        }
                    }
                    Path out = PyramidTileStore.stagePath(tmp, z, tx, ty);
                    Files.createDirectories(out.getParent());
                    writeJpeg(tile, out);
                }
            }
        }
    }

    private static void generateFromImage(Path tmp, BufferedImage src, int w, int h)
            throws IOException {
        int n = PyramidTileStore.maxLevel(w, h);
        for (int z = 0; z <= n; z++) {
            int lw = PyramidTileStore.levelW(w, h, z);
            int lh = PyramidTileStore.levelH(w, h, z);
            int cols = PyramidTileStore.cols(w, h, z);
            int rows = PyramidTileStore.rows(w, h, z);
            long div = 1L << (n - z);
            for (int ty = 0; ty < rows; ty++) {
                for (int tx = 0; tx < cols; tx++) {
                    BufferedImage tile = new BufferedImage(
                            PyramidTileStore.TILE, PyramidTileStore.TILE,
                            BufferedImage.TYPE_INT_RGB);
                    Graphics2D g = tile.createGraphics();
                    g.setColor(Color.BLACK);
                    g.fillRect(0, 0, PyramidTileStore.TILE, PyramidTileStore.TILE);
                    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                            RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                    int aw = Math.min(PyramidTileStore.TILE, lw - tx * PyramidTileStore.TILE);
                    int ah = Math.min(PyramidTileStore.TILE, lh - ty * PyramidTileStore.TILE);
                    int srcX0 = (int) ((long) tx * PyramidTileStore.TILE * div);
                    int srcY0 = (int) ((long) ty * PyramidTileStore.TILE * div);
                    int srcX1 = (int) Math.min(w, srcX0 + (long) aw * div);
                    int srcY1 = (int) Math.min(h, srcY0 + (long) ah * div);
                    g.drawImage(src, 0, 0, aw, ah, srcX0, srcY0, srcX1, srcY1, null);
                    g.dispose();
                    Path out = PyramidTileStore.stagePath(tmp, z, tx, ty);
                    Files.createDirectories(out.getParent());
                    writeJpeg(tile, out);
                }
            }
        }
    }

    static void writeJpeg(BufferedImage img, Path out) throws IOException {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("no JPEG writer");
        }
        ImageWriter writer = writers.next();
        try {
            ImageWriteParam p = writer.getDefaultWriteParam();
            p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            p.setCompressionQuality(Config.JPEG_QUALITY / 100.0f);
            try (ImageOutputStream ios = ImageIO.createImageOutputStream(out.toFile())) {
                writer.setOutput(ios);
                writer.write(null, new IIOImage(img, null, null), p);
            }
        } finally {
            writer.dispose();
        }
    }

    static void writeMeta(Path dir, int id, String canon, int w, int h) throws IOException {
        int levels = PyramidTileStore.levelCount(w, h);
        String json = "{\"id\":" + id + ",\"name\":\"image-" + canon
                + "\",\"w\":" + w + ",\"h\":" + h
                + ",\"levels\":" + levels + ",\"tile\":" + PyramidTileStore.TILE + "}";
        Files.writeString(dir.resolve("meta.json"), json);
    }

    /** Full validation of a staged tree before publish. */
    static void validateStaged(Path tmp, int w, int h) throws IOException {
        int n = PyramidTileStore.maxLevel(w, h);
        int expectedLevels = PyramidTileStore.levelCount(w, h);
        for (int z = 0; z <= n; z++) {
            int cols = PyramidTileStore.cols(w, h, z);
            int rows = PyramidTileStore.rows(w, h, z);
            for (int ty = 0; ty < rows; ty++) {
                for (int tx = 0; tx < cols; tx++) {
                    Path p = PyramidTileStore.stagePath(tmp, z, tx, ty);
                    PyramidTileStore.checkSize(p);
                    int[] dims = jpegDims(p);
                    if (dims[0] != PyramidTileStore.TILE || dims[1] != PyramidTileStore.TILE) {
                        throw new IOException("tile not 512x512: " + p);
                    }
                }
            }
        }
        // Meta presence is checked by the registry at serve time; here we at
        // least require the file to exist and be within bounds.
        Path meta = tmp.resolve("meta.json");
        if (!Files.isRegularFile(meta) || Files.size(meta) > Config.META_MAX_BYTES) {
            throw new IOException("staged meta.json missing or oversize");
        }
        if (expectedLevels < 1) {
            throw new IOException("bad level count");
        }
    }

    /** JPEG dimensions without a full decode. */
    static int[] jpegDims(Path p) throws IOException {
        try (ImageInputStream iis = ImageIO.createImageInputStream(p.toFile())) {
            if (iis == null) {
                throw new IOException("unreadable tile: " + p);
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new IOException("unreadable tile: " + p);
            }
            ImageReader r = readers.next();
            try {
                r.setInput(iis);
                return new int[]{r.getWidth(0), r.getHeight(0)};
            } finally {
                r.dispose();
            }
        }
    }
}
