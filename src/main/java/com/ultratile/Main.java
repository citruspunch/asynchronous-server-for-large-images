package com.ultratile;

import java.nio.file.Path;

import com.ultratile.net.NioHttpServer;

/**
 * Entry point. Parses an optional bind address and data root, then serves.
 *
 * <p>Usage: {@code Main [--bind <addr>] [--data-root <dir>]}. Options may appear
 * in either order; anything else is refused rather than silently defaulted.
 */
public final class Main {
    private Main() {}

    /** Parsed CLI options. */
    record Options(String bind, Path dataRoot) {}

    /**
     * Parses the full option set. Only {@code --bind} and {@code --data-root}
     * are recognised; an unknown flag, a missing value, or an empty value is an
     * error, so a typo can never fall back to a default unnoticed.
     */
    static Options parse(String[] args) {
        String bind = Config.BIND;
        Path root = Path.of(Config.DATA_ROOT);
        if (args == null) {
            return new Options(bind, root);
        }
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--bind".equals(a)) {
                String v = value(args, ++i, "--bind");
                bind = v;
            } else if ("--data-root".equals(a)) {
                String v = value(args, ++i, "--data-root");
                root = Path.of(v);
            } else {
                throw new IllegalArgumentException(usage() + " (unrecognised argument: " + a + ")");
            }
        }
        return new Options(bind, root);
    }

    private static String value(String[] args, int i, String flag) {
        if (i >= args.length) {
            throw new IllegalArgumentException(usage() + " (" + flag + " requires a value)");
        }
        String v = args[i];
        if (v == null || v.isEmpty()) {
            throw new IllegalArgumentException(usage() + " (" + flag + " requires a non-empty value)");
        }
        return v;
    }

    private static String usage() {
        return "usage: Main [--bind <addr>] [--data-root <dir>]";
    }

    /**
     * Returns the effective bind address for the given CLI args.
     *
     * @param args CLI args
     * @return the bind address to use
     * @throws IllegalArgumentException on unparseable args (caller exits 2)
     */
    static String parseBind(String[] args) {
        return parse(args).bind();
    }

    /**
     * Returns the effective data root for the given CLI args.
     *
     * @param args CLI args
     * @return the pyramid root to serve from
     * @throws IllegalArgumentException on unparseable args (caller exits 2)
     */
    static Path parseDataRoot(String[] args) {
        return parse(args).dataRoot();
    }

    public static void main(String[] args) throws Exception {
        Options o;
        try {
            o = parse(args);
        } catch (IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        NioHttpServer server = new NioHttpServer(o.bind(), Config.PORT, o.dataRoot());
        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try {
                server.close();
            } catch (Exception ignored) {
            }
        }));
        Thread.currentThread().join();
    }
}
