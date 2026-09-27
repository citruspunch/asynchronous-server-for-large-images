package com.ultratile.tiles;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

import com.ultratile.Config;

/**
 * Live registry over the configured data root: fresh snapshot per call, strict
 * bounded metadata, per-ID demo ensure with repair.
 */
public final class ImageRegistry {

    private static final Logger LOG = Logger.getLogger(ImageRegistry.class.getName());

    private final Path base;

    public ImageRegistry() {
        this(PyramidTileStore.defaultRoot());
    }

    public ImageRegistry(Path base) {
        this.base = base;
    }

    /** Image metadata entry. */
    public record ImageInfo(int id, String name, int w, int h, int levels) {}

    /** Fresh snapshot list, sorted by id. Never throws on bad metadata. */
    public List<ImageInfo> list() {
        List<ImageInfo> out = new ArrayList<>();
        if (!Files.isDirectory(base)) {
            return out;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(base)) {
            for (Path child : ds) {
                String fn = child.getFileName().toString();
                if (fn.startsWith(".tmp-") || fn.startsWith(".stale-")) {
                    continue;
                }
                if (!Files.isDirectory(child)) {
                    continue;
                }
                ImageInfo info = readIfValid(child, fn);
                if (info != null) {
                    out.add(info);
                }
            }
        } catch (IOException e) {
            LOG.warning("registry scan failed: " + e.getMessage());
        }
        out.sort(Comparator.comparingInt(ImageInfo::id));
        return out;
    }

    /** Fresh snapshot get. Returns null when absent or invalid. */
    public ImageInfo get(int id) {
        if (id < 0 || id > 65535) {
            return null;
        }
        String canon = Integer.toString(id);
        Path dir = base.resolve(canon);
        if (!Files.isDirectory(dir) || !Files.isRegularFile(dir.resolve(".ready"))) {
            return null;
        }
        return readIfValid(dir, canon);
    }

    private ImageInfo readIfValid(Path dir, String dirname) {
        int dirId;
        try {
            if (!dirname.matches("^[0-9]+$")) {
                return null;
            }
            dirId = Integer.parseInt(dirname);
            if (dirId < 0 || dirId > 65535) {
                return null;
            }
            if (!dirname.equals(Integer.toString(dirId))) {
                LOG.warning("ignoring non-canonical dirname: " + dirname);
                return null;
            }
        } catch (NumberFormatException e) {
            return null;
        }
        Path meta = dir.resolve("meta.json");
        Path ready = dir.resolve(".ready");
        if (!Files.isRegularFile(meta) || !Files.isRegularFile(ready)) {
            return null;
        }
        try {
            return parseMeta(meta, dirId);
        } catch (Exception e) {
            LOG.warning("ignoring invalid metadata in " + dirname + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Tiny strict hand parser for the exact generated schema.
     * Returns null (with WARNING) on oversize/malformed/inconsistent input.
     */
    static ImageInfo parseMeta(Path meta, int dirId) throws IOException {
        byte[] buf = readBounded(meta, Config.META_MAX_BYTES + 1);
        if (buf == null) {
            LOG.warning("ignoring oversize meta.json in " + dirId);
            return null;
        }
        String s;
        try {
            s = new String(buf, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            LOG.warning("ignoring undecodable meta.json in " + dirId);
            return null;
        }
        Map<String, String> raw;
        Map<String, Integer> kinds;
        try {
            Parsed p = parseObject(s);
            raw = p.raw;
            kinds = p.kinds;
        } catch (IllegalArgumentException e) {
            LOG.warning("ignoring malformed meta.json in " + dirId + ": " + e.getMessage());
            return null;
        }
        if (raw.size() != 6 || !raw.containsKey("id") || !raw.containsKey("name")
                || !raw.containsKey("w") || !raw.containsKey("h")
                || !raw.containsKey("levels") || !raw.containsKey("tile")) {
            LOG.warning("ignoring meta.json with wrong keys in " + dirId);
            return null;
        }
        if (kinds.get("name") != 1 || kinds.get("id") != 0 || kinds.get("w") != 0
                || kinds.get("h") != 0 || kinds.get("levels") != 0 || kinds.get("tile") != 0) {
            LOG.warning("ignoring meta.json with wrong types in " + dirId);
            return null;
        }
        int id;
        int w;
        int h;
        int levels;
        int tile;
        try {
            id = parseStrictInt(raw.get("id"));
            w = parseStrictInt(raw.get("w"));
            h = parseStrictInt(raw.get("h"));
            levels = parseStrictInt(raw.get("levels"));
            tile = parseStrictInt(raw.get("tile"));
        } catch (IllegalArgumentException e) {
            LOG.warning("ignoring meta.json with bad ints in " + dirId);
            return null;
        }
        String name = raw.get("name");
        if (tile != PyramidTileStore.TILE) {
            LOG.warning("ignoring meta.json with bad tile in " + dirId);
            return null;
        }
        if (!PyramidTileStore.isRepresentable(w, h)) {
            // Same rule the importer enforces, so a successfully imported image
            // can never be dropped here. The message names the actual cause.
            String why;
            try {
                PyramidTileStore.checkRepresentable(w, h);
                why = "unknown";
            } catch (IllegalArgumentException e) {
                why = e.getMessage();
            }
            LOG.warning("ignoring meta.json in " + dirId + " (w=" + w + " h=" + h + "): " + why);
            return null;
        }
        // NOTE: Config.IMPORT_MAX_TILES is deliberately NOT applied here. That is
        // an import-time resource policy ("can we afford to build this?"), not a
        // claim that the metadata is invalid or unservable. Enforcing it here
        // would make the registry silently drop a legitimate pyramid that already
        // exists on disk -- one imported before the cap was raised, or produced by
        // another tool. The registry is deliberately more permissive than the
        // importer, never stricter.
        if (name.length() > Config.META_NAME_MAX) {
            LOG.warning("ignoring meta.json with long name in " + dirId);
            return null;
        }
        if (!name.equals("image-" + dirId)) {
            LOG.warning("ignoring meta.json with non-canonical name in " + dirId);
            return null;
        }
        if (id != dirId) {
            LOG.warning("ignoring meta.json with id mismatch in " + dirId);
            return null;
        }
        int expect;
        try {
            expect = PyramidTileStore.levelCount(w, h);
        } catch (IllegalArgumentException e) {
            LOG.warning("ignoring meta.json with bad dims in " + dirId);
            return null;
        }
        if (levels != expect) {
            LOG.warning("ignoring meta.json with bad levels in " + dirId);
            return null;
        }
        return new ImageInfo(dirId, name, w, h, levels);
    }

    /** Reads at most cap bytes; returns null when the file is longer. */
    private static byte[] readBounded(Path p, int cap) throws IOException {
        try (InputStream in = Files.newInputStream(p)) {
            byte[] buf = new byte[cap];
            int off = 0;
            while (off < cap) {
                int r = in.read(buf, off, cap - off);
                if (r < 0) {
                    break;
                }
                off += r;
            }
            if (off == cap && in.read() >= 0) {
                return null;
            }
            byte[] out = new byte[off];
            System.arraycopy(buf, 0, out, 0, off);
            return out;
        }
    }

    private static int parseStrictInt(String v) {
        if (v == null || !v.matches("^-?[0-9]+$")) {
            throw new IllegalArgumentException("bad int: " + v);
        }
        try {
            return Integer.parseInt(v);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("bad int: " + v);
        }
    }

    private static final class Parsed {
        final Map<String, String> raw = new HashMap<>();
        final Map<String, Integer> kinds = new HashMap<>();
    }

    /** Minimal strict object parser: strings with escapes, ints, no nesting. */
    private static Parsed parseObject(String s) {
        int n = s.length();
        int i = 0;
        while (i < n && Character.isWhitespace(s.charAt(i))) {
            i++;
        }
        if (i >= n || s.charAt(i) != '{') {
            throw new IllegalArgumentException("must start with {");
        }
        i++;
        Parsed p = new Parsed();
        boolean first = true;
        while (true) {
            while (i < n && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
            if (i < n && s.charAt(i) == '}') {
                i++;
                break;
            }
            if (!first) {
                if (i >= n || s.charAt(i) != ',') {
                    throw new IllegalArgumentException("expected ,");
                }
                i++;
                while (i < n && Character.isWhitespace(s.charAt(i))) {
                    i++;
                }
            }
            first = false;
            if (i >= n || s.charAt(i) != '"') {
                throw new IllegalArgumentException("expected string key");
            }
            String key = parseJsonString(s, i);
            int keyEnd = scanJsonStringEnd(s, i);
            i = keyEnd;
            while (i < n && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
            if (i >= n || s.charAt(i) != ':') {
                throw new IllegalArgumentException("expected :");
            }
            i++;
            while (i < n && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
            if (i >= n) {
                throw new IllegalArgumentException("truncated value");
            }
            char c = s.charAt(i);
            if (c == '"') {
                String val = parseJsonString(s, i);
                i = scanJsonStringEnd(s, i);
                if (p.raw.containsKey(key)) {
                    throw new IllegalArgumentException("duplicate key");
                }
                p.raw.put(key, val);
                p.kinds.put(key, 1);
            } else if (c == '-' || (c >= '0' && c <= '9')) {
                int j = i;
                if (s.charAt(j) == '-') {
                    j++;
                }
                int start = j;
                while (j < n && s.charAt(j) >= '0' && s.charAt(j) <= '9') {
                    j++;
                }
                if (j == start) {
                    throw new IllegalArgumentException("bad number");
                }
                String num = s.substring(i, j);
                if (p.raw.containsKey(key)) {
                    throw new IllegalArgumentException("duplicate key");
                }
                p.raw.put(key, num);
                p.kinds.put(key, 0);
                i = j;
            } else {
                throw new IllegalArgumentException("unsupported value");
            }
        }
        while (i < n && Character.isWhitespace(s.charAt(i))) {
            i++;
        }
        if (i != n) {
            throw new IllegalArgumentException("trailing data");
        }
        return p;
    }

    private static int scanJsonStringEnd(String s, int start) {
        int n = s.length();
        int i = start + 1;
        while (i < n) {
            char c = s.charAt(i);
            if (c == '\\') {
                i += 2;
                continue;
            }
            if (c == '"') {
                return i + 1;
            }
            if (c < 0x20) {
                throw new IllegalArgumentException("unescaped control in string");
            }
            i++;
        }
        throw new IllegalArgumentException("unterminated string");
    }

    private static String parseJsonString(String s, int start) {
        int n = s.length();
        StringBuilder sb = new StringBuilder();
        int i = start + 1;
        while (i < n) {
            char c = s.charAt(i);
            if (c == '"') {
                return sb.toString();
            }
            if (c == '\\') {
                if (i + 1 >= n) {
                    throw new IllegalArgumentException("bad escape");
                }
                char e = s.charAt(i + 1);
                switch (e) {
                    case '"', '\\', '/' -> sb.append(e);
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        if (i + 5 >= n) {
                            throw new IllegalArgumentException("bad unicode escape");
                        }
                        String hex = s.substring(i + 2, i + 6);
                        try {
                            sb.append((char) Integer.parseInt(hex, 16));
                        } catch (NumberFormatException ex) {
                            throw new IllegalArgumentException("bad unicode escape");
                        }
                        i += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape");
                }
                i += 2;
                continue;
            }
            if (c < 0x20) {
                throw new IllegalArgumentException("unescaped control in string");
            }
            sb.append(c);
            i++;
        }
        throw new IllegalArgumentException("unterminated string");
    }

    /**
     * Startup repair: quarantine non-ready numeric dirs, then per-ID demo
     * ensure with repair for ids 0 and 1.
     */
    public static void ensureStartup(Path base) throws Exception {
        Files.createDirectories(base);
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(base)) {
            for (Path child : ds) {
                String fn = child.getFileName().toString();
                if (fn.startsWith(".tmp-") || fn.startsWith(".stale-")) {
                    continue;
                }
                if (!Files.isDirectory(child) || !fn.matches("^[0-9]+$")) {
                    continue;
                }
                if (!Files.isRegularFile(child.resolve(".ready"))) {
                    String epoch = Long.toString(System.currentTimeMillis() / 1000L);
                    Path dest = base.resolve(".stale-" + fn + "-" + epoch);
                    Files.move(child, dest);
                    LOG.info("quarantined non-ready " + fn + " to " + dest.getFileName());
                }
            }
        }
        ImageRegistry reg = new ImageRegistry(base);
        int[][] demos = {{0, 2048, 2048}, {1, 4096, 4096}};
        for (int[] d : demos) {
            int id = d[0];
            String canon = Integer.toString(id);
            Path target = base.resolve(canon);
            if (!Files.exists(target)) {
                IngestTool.runSynthetic(base, canon, d[1], d[2]);
                continue;
            }
            if (Files.isRegularFile(target.resolve(".ready")) && reg.get(id) == null) {
                String epoch = Long.toString(System.currentTimeMillis() / 1000L);
                Path dest = base.resolve(".stale-invalid-" + canon + "-" + epoch);
                Files.move(target, dest, StandardCopyOption.ATOMIC_MOVE);
                LOG.warning("quarantined invalid demo " + canon + " to " + dest.getFileName());
                IngestTool.runSynthetic(base, canon, d[1], d[2]);
            } else if (!Files.isRegularFile(target.resolve(".ready"))) {
                // Already quarantined above; generate fresh.
                IngestTool.runSynthetic(base, canon, d[1], d[2]);
            }
        }
    }
}
