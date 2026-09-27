package com.ultratile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.ultratile.net.NioHttpServer;
import com.ultratile.tiles.ImageRegistry;
import com.ultratile.tiles.IngestTool;
import com.ultratile.tiles.PyramidTileStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * CLI option parsing and the configurable data root.
 *
 * <p>The data root exists so a large pyramid can live on an external volume: the
 * source file and the pyramid it produces can both outgrow the repository
 * filesystem, and source size does not predict pyramid size in either direction.
 * See docs/grading-preflight.md for the disk-planning procedure.
 */
class DataRootTest {

    // ---- option parsing ----

    @Test
    void defaultsWhenNoArgs() {
        assertEquals(Config.BIND, Main.parseBind(new String[]{}));
        assertEquals(Path.of("data", "images"), Main.parseDataRoot(new String[]{}));
        assertEquals("data/images", Config.DATA_ROOT);
    }

    @Test
    void dataRootIsOptIn() {
        assertEquals(Path.of("/Volumes/SSD/pyr"),
                Main.parseDataRoot(new String[]{"--data-root", "/Volumes/SSD/pyr"}));
    }

    @Test
    void optionsCombineInEitherOrder() {
        assertEquals("0.0.0.0",
                Main.parseBind(new String[]{"--bind", "0.0.0.0", "--data-root", "/tmp/p"}));
        assertEquals("0.0.0.0",
                Main.parseBind(new String[]{"--data-root", "/tmp/p", "--bind", "0.0.0.0"}));
        assertEquals(Path.of("/tmp/p"),
                Main.parseDataRoot(new String[]{"--bind", "0.0.0.0", "--data-root", "/tmp/p"}));
    }

    @Test
    void typosAndBadValuesNeverSilentlyDefault() {
        // A mistyped flag must NOT quietly fall back to the default root, or an
        // import would land somewhere the server is not looking.
        assertThrows(IllegalArgumentException.class,
                () -> Main.parseDataRoot(new String[]{"--dataroot", "/tmp/p"}));
        assertThrows(IllegalArgumentException.class,
                () -> Main.parseDataRoot(new String[]{"--data-root"}));
        assertThrows(IllegalArgumentException.class,
                () -> Main.parseDataRoot(new String[]{"--data-root", ""}));
        assertThrows(IllegalArgumentException.class,
                () -> Main.parseBind(new String[]{"--bogus"}));
    }

    // ---- server honours the root ----

    @Test
    void serverExposesItsDataRootAndDefaultsToConfig() throws Exception {
        Path custom = Path.of("/tmp/does-not-need-to-exist");
        try (NioHttpServer s = new NioHttpServer("127.0.0.1", 0, custom)) {
            assertEquals(custom, s.dataRoot());
        }
        try (NioHttpServer s = new NioHttpServer("127.0.0.1", 0)) {
            assertEquals(Path.of(Config.DATA_ROOT), s.dataRoot());
        }
        assertThrows(IllegalArgumentException.class,
                () -> new NioHttpServer("127.0.0.1", 0, null));
    }

    @Test
    void serverStartsAndBindsOnAnAlternateRoot() throws Exception {
        Path root = Files.createTempDirectory("ultratile-root-");
        NioHttpServer server = new NioHttpServer("127.0.0.1", 0, root);
        try (NioHttpServer s = server) {
            s.start();
            InetSocketAddress addr = s.getBindAddress();
            assertTrue(addr.getAddress().isLoopbackAddress());
        }
        assertFalse(server.isAcceptAlive());
    }

    // ---- import + serve against an alternate root ----

    @Test
    void importAndRegistryAgreeOnACustomRoot(@TempDir Path tmp) throws Exception {
        Path root = tmp.resolve("external-pyramids");
        Files.createDirectories(root);

        // Import into the alternate root using the same id-gated path the shell
        // importer uses, then confirm the registry rooted there sees it.
        assertEquals(0, IngestTool.runSynthetic(root, "77", 1024, 768));

        ImageRegistry reg = new ImageRegistry(root);
        ImageRegistry.ImageInfo info = reg.get(77);
        assertNotNull(info, "registry rooted at the custom path must see the image");
        assertEquals(77, info.id());
        assertEquals(1024, info.w());
        assertEquals(768, info.h());
        assertEquals(1, reg.list().size());

        // A registry on a DIFFERENT root must not see it -- this is the whole
        // point of the option, and the failure mode if it silently leaked.
        Path other = tmp.resolve("other-pyramids");
        Files.createDirectories(other);
        assertEquals(null, new ImageRegistry(other).get(77));
    }

    @Test
    void atomicPublicationStaysInsideOneRoot(@TempDir Path tmp) throws Exception {
        // Staging (.tmp-<id>) and the target (<id>) must be siblings under the
        // chosen root so the final rename is same-filesystem.
        Path root = tmp.resolve("atomic");
        assertEquals(0, IngestTool.runSynthetic(root, "5", 512, 512));
        assertTrue(Files.isRegularFile(root.resolve("5").resolve(".ready")));
        assertFalse(Files.exists(root.resolve(".tmp-5")),
                "staging directory must be gone after publication");
        // No staging or quarantine residue anywhere under the root.
        try (var s = Files.list(root)) {
            for (Path p : s.toList()) {
                String n = p.getFileName().toString();
                assertFalse(n.startsWith(".tmp-") || n.startsWith(".stale"),
                        "leftover transient directory: " + n);
            }
        }
    }

    @Test
    void publicationSucceedsOnlyWithAnAtomicRename(@TempDir Path tmp) throws Exception {
        // Locks in the guarantee that publish() REQUIRES ATOMIC_MOVE with no
        // non-atomic fallback. The failure branch itself needs a filesystem that
        // refuses ATOMIC_MOVE, which is not available here, so this test pins
        // what it can: publication completes via the atomic path on a normal
        // filesystem, and the published tree is whole the instant it appears.
        //
        // A plain Files.move fallback would be worse than failing: it degrades
        // to copy-then-delete with unspecified order, so the zero-byte .ready
        // could land before the tiles it certifies, which is the precise state
        // .ready exists to make unobservable.
        Path root = tmp.resolve("strict-atomic");
        assertEquals(0, IngestTool.runSynthetic(root, "6", 1024, 768));

        Path published = root.resolve("6");
        assertTrue(Files.isRegularFile(published.resolve(".ready")));
        // Every tile the geometry promises is present the moment the directory
        // is visible, i.e. the atomic rename published a complete tree.
        ImageRegistry.ImageInfo info = new ImageRegistry(root).get(6);
        assertNotNull(info);
        int expected = (int) PyramidTileStore.totalTiles(info.w(), info.h());
        long actual;
        try (var walk = Files.walk(published)) {
            actual = walk.filter(p -> p.toString().endsWith(".jpg")).count();
        }
        assertEquals(expected, actual,
                "atomic publication must expose a complete tree, not a partial one");
    }

    @Test
    void demoEnsureRespectsTheAlternateRoot(@TempDir Path tmp) throws Exception {
        // ensureStartup must generate demos 0 and 1 under the GIVEN root, not
        // the process working directory.
        Path root = tmp.resolve("demos");
        ImageRegistry.ensureStartup(root);
        ImageRegistry reg = new ImageRegistry(root);
        assertNotNull(reg.get(0));
        assertNotNull(reg.get(1));
        assertEquals(2048, reg.get(0).w());
        assertEquals(4096, reg.get(1).w());
    }
}
