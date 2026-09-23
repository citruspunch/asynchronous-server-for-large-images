package com.ultratile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.net.InetSocketAddress;

import com.ultratile.net.NioHttpServer;
import org.junit.jupiter.api.Test;

class MainTest {

    @Test
    void defaultBindIsLoopback() {
        assertEquals("127.0.0.1", Main.parseBind(new String[]{}));
    }

    @Test
    void explicitBindOptIn() {
        assertEquals("0.0.0.0", Main.parseBind(new String[]{"--bind", "0.0.0.0"}));
    }

    @Test
    void unparseableNeverSilentlyDefaults() {
        assertThrows(IllegalArgumentException.class, () -> Main.parseBind(new String[]{"--bind"}));
        assertThrows(IllegalArgumentException.class, () -> Main.parseBind(new String[]{"--bogus"}));
        assertThrows(IllegalArgumentException.class, () -> Main.parseBind(new String[]{"--bind", ""}));
    }

    @Test
    void bindAddressIsLoopbackNotWildcard() throws Exception {
        NioHttpServer server = new NioHttpServer("127.0.0.1", 0);
        try (NioHttpServer s = server) {
            s.start();
            InetSocketAddress addr = s.getBindAddress();
            assertTrue(addr.getAddress().isLoopbackAddress(),
                    "expected loopback bind, got " + addr);
            assertEquals("127.0.0.1", addr.getAddress().getHostAddress());
        }
        assertFalse(server.isAcceptAlive(), "accept thread must terminate after close()");
    }
}
