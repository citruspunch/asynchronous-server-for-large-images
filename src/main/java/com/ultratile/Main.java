package com.ultratile;

import com.ultratile.net.NioHttpServer;

/**
 * Entry point. Parses an optional bind address and serves.
 */
public final class Main {
    private Main() {}

    /**
     * Returns the effective bind address for the given CLI args.
     *
     * @param args CLI args (empty or {@code ["--bind", addr]})
     * @return the bind address to use
     * @throws IllegalArgumentException on unparseable args (caller exits 2)
     */
    static String parseBind(String[] args) {
        if (args == null || args.length == 0) {
            return Config.BIND;
        }
        if (args.length == 2 && "--bind".equals(args[0])) {
            String addr = args[1];
            if (addr == null || addr.isEmpty()) {
                throw new IllegalArgumentException("--bind requires a non-empty address");
            }
            return addr;
        }
        throw new IllegalArgumentException("usage: Main [--bind <addr>]");
    }

    public static void main(String[] args) throws Exception {
        String bind;
        try {
            bind = parseBind(args);
        } catch (IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        NioHttpServer server = new NioHttpServer(bind, Config.PORT);
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
