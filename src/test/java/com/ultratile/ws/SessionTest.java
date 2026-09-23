package com.ultratile.ws;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.NonWritableChannelException;
import java.nio.channels.ReadableByteChannel;
import java.nio.channels.WritableByteChannel;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.OptionalInt;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import com.ultratile.net.NioHttpServer;
import com.ultratile.proto.UtpCodec;
import com.ultratile.proto.UtpMessages;
import com.ultratile.tiles.ImageRegistry;
import com.ultratile.ws.WsWriter.TileOutcome;
import org.junit.jupiter.api.Test;

class SessionTest {

    // ---------- wire builders (raw, bypassing record validation) ----------

    static byte[] chunkBytes(int img, int zoom, long req, long x0, long x1, long y0, long y1) {
        ByteBuffer b = ByteBuffer.allocate(28).order(java.nio.ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA).put((byte) 0x01);
        b.putShort((short) img).put((byte) zoom).put((byte) 0).putShort((short) 512);
        b.putInt((int) req).putInt((int) x0).putInt((int) x1).putInt((int) y0).putInt((int) y1);
        return b.array();
    }

    static byte[] commitBytes(int img, long req) {
        ByteBuffer b = ByteBuffer.allocate(8).order(java.nio.ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA).put((byte) 0x05);
        b.putShort((short) img).putInt((int) req);
        return b.array();
    }

    static byte[] abortBytes(int img, long req) {
        ByteBuffer b = ByteBuffer.allocate(8).order(java.nio.ByteOrder.BIG_ENDIAN);
        b.put((byte) 0xAA).put((byte) 0x03);
        b.putShort((short) img).putInt((int) req);
        return b.array();
    }

    // ---------- doubles ----------

    static class Lookup implements SessionCoordinator.ImageLookup {
        final Map<Integer, ImageRegistry.ImageInfo> map = new HashMap<>();
        final AtomicInteger calls = new AtomicInteger();

        Lookup() {
            map.put(0, new ImageRegistry.ImageInfo(0, "image-0", 2048, 2048, 3));
            map.put(1, new ImageRegistry.ImageInfo(1, "image-1", 4096, 4096, 4));
            map.put(9, new ImageRegistry.ImageInfo(9, "image-9", 16384, 16384, 6));
        }

        @Override
        public ImageRegistry.ImageInfo lookup(int imageId) {
            calls.incrementAndGet();
            return map.get(imageId);
        }
    }

    static class RecordingChannel implements WritableByteChannel {
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        final List<String> events;
        boolean open = true;
        volatile boolean throwOnWrite = false;

        RecordingChannel(List<String> events) {
            this.events = events;
        }

        @Override
        public synchronized int write(ByteBuffer src) throws IOException {
            if (throwOnWrite) {
                throw new IOException("boom");
            }
            int n = src.remaining();
            byte[] b = new byte[n];
            src.get(b);
            buf.write(b, 0, n);
            events.add("write");
            return n;
        }

        synchronized byte[] bytes() {
            return buf.toByteArray();
        }

        @Override
        public boolean isOpen() {
            return open;
        }

        @Override
        public void close() {
            open = false;
        }
    }

    static class FakeSocket implements Closeable {
        final List<String> events = Collections.synchronizedList(new ArrayList<>());
        volatile boolean closed = false;
        final Object gate = new Object();
        final InputStream in = new InputStream() {
            @Override
            public int read() {
                synchronized (gate) {
                    while (!closed) {
                        try {
                            gate.wait(50);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            return -1;
                        }
                    }
                    return -1;
                }
            }
        };

        @Override
        public void close() {
            closed = true;
            events.add("close");
            synchronized (gate) {
                gate.notifyAll();
            }
        }
    }

    static class FakeTileChannel extends FileChannel {
        final byte[] payload;
        long sizeOverride = -1;
        final long[] script;
        int si = 0;
        int transferCalls = 0;
        int readCalls = 0;
        volatile boolean closeCalled = false;
        volatile boolean entered = false;
        volatile boolean blockInTransfer = false;
        final Object gate = new Object();
        volatile boolean released = false;
        long pos = 0;

        FakeTileChannel(byte[] payload, long... script) {
            this.payload = payload;
            this.script = script;
        }

        void release() {
            synchronized (gate) {
                released = true;
                gate.notifyAll();
            }
        }

        @Override
        public long transferTo(long position, long count, WritableByteChannel target)
                throws IOException {
            transferCalls++;
            if (blockInTransfer) {
                entered = true;
                synchronized (gate) {
                    long deadline = System.currentTimeMillis() + 15000;
                    while (!released && System.currentTimeMillis() < deadline) {
                        try {
                            gate.wait(50);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            throw new ClosedChannelException();
                        }
                    }
                    if (!released) {
                        throw new IOException("latch timeout");
                    }
                }
            }
            long n;
            if (si < script.length) {
                n = script[si++];
            } else {
                n = Math.min(count, (long) payload.length - position);
                if (n < 0) {
                    n = 0;
                }
            }
            long toWrite = Math.min(n, (long) payload.length - position);
            if (toWrite < 0) {
                toWrite = 0;
            }
            if (toWrite > 0) {
                target.write(
                        ByteBuffer.wrap(payload, (int) position, (int) toWrite));
            }
            return n;
        }

        @Override
        public int read(ByteBuffer dst, long position) {
            readCalls++;
            if (position >= payload.length) {
                return -1;
            }
            int n = Math.min(dst.remaining(), payload.length - (int) position);
            dst.put(payload, (int) position, n);
            return n;
        }

        @Override
        public long size() {
            return sizeOverride >= 0 ? sizeOverride : payload.length;
        }

        @Override
        protected void implCloseChannel() {
            closeCalled = true;
        }

        @Override
        public int read(ByteBuffer dst) {
            int n = read(dst, pos);
            if (n > 0) {
                pos += n;
            }
            return n;
        }

        @Override
        public long read(ByteBuffer[] dsts, int offset, int length) {
            for (int i = offset; i < offset + length; i++) {
                int n = read(dsts[i]);
                if (n != 0) {
                    return n;
                }
            }
            return 0;
        }

        @Override
        public long position() {
            return pos;
        }

        @Override
        public FileChannel position(long p) {
            pos = p;
            return this;
        }

        @Override
        public long transferFrom(ReadableByteChannel src, long position, long count) {
            throw new NonWritableChannelException();
        }

        @Override
        public int write(ByteBuffer src) {
            throw new NonWritableChannelException();
        }

        @Override
        public long write(ByteBuffer[] srcs, int offset, int length) {
            throw new NonWritableChannelException();
        }

        @Override
        public int write(ByteBuffer src, long position) {
            throw new NonWritableChannelException();
        }

        @Override
        public FileChannel truncate(long size) {
            throw new NonWritableChannelException();
        }

        @Override
        public void force(boolean metaData) {
        }

        @Override
        public java.nio.MappedByteBuffer map(MapMode mode, long position, long size) {
            throw new UnsupportedOperationException();
        }

        @Override
        public FileLock lock(long position, long size, boolean shared) {
            return null;
        }

        @Override
        public FileLock tryLock(long position, long size, boolean shared) {
            return null;
        }
    }

    static class ThrowingWriter extends WsWriter {
        ThrowingWriter(WritableByteChannel out) {
            super(out);
        }

        @Override
        public void writeControl(int opcode, byte[] payload) throws IOException {
            throw new IOException("boom");
        }
    }

    // ---------- session scaffolding ----------

    record Harness(
            SessionCoordinator coord,
            Lookup lookup,
            RecordingChannel rec,
            FakeSocket sock,
            List<String> events,
            List<FakeTileChannel> channels) {}

    static Harness newHarness() {
        return newHarness(null);
    }

    static Harness newHarness(WsWriter writer) {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        RecordingChannel rec = new RecordingChannel(events);
        FakeSocket sock = new FakeSocket();
        Lookup lookup = new Lookup();
        List<FakeTileChannel> channels = Collections.synchronizedList(new ArrayList<>());
        byte[] tiny = new byte[100];
        for (int i = 0; i < tiny.length; i++) {
            tiny[i] = (byte) (i + 1);
        }
        SessionCoordinator.TileOpener opener = (id, zoom, x, y) -> {
            FakeTileChannel ch = new FakeTileChannel(tiny.clone());
            channels.add(ch);
            return ch;
        };
        WsWriter w = writer != null ? writer : new WsWriter(rec);
        SessionCoordinator coord =
                new SessionCoordinator(sock.in, w, sock, opener, lookup);
        return new Harness(coord, lookup, rec, sock, events, channels);
    }

    // ---------- server-stream parsing ----------

    record ServerFrame(int opcode, byte[] payload) {}

    static List<ServerFrame> parseServerStream(byte[] data) {
        List<ServerFrame> out = new ArrayList<>();
        int i = 0;
        while (i < data.length) {
            int b0 = data[i++] & 0xFF;
            int b1 = data[i++] & 0xFF;
            int op = b0 & 0x0F;
            long len;
            int marker = b1 & 0x7F;
            if (marker <= 125) {
                len = marker;
            } else if (marker == 126) {
                len = ((data[i] & 0xFF) << 8) | (data[i + 1] & 0xFF);
                i += 2;
            } else {
                len = 0;
                for (int k = 0; k < 8; k++) {
                    len = (len << 8) | (data[i + k] & 0xFF);
                }
                i += 8;
            }
            byte[] p = Arrays.copyOfRange(data, i, i + (int) len);
            i += (int) len;
            out.add(new ServerFrame(op, p));
        }
        return out;
    }

    static List<ServerFrame> controlFrames(byte[] data) {
        List<ServerFrame> out = new ArrayList<>();
        for (ServerFrame f : parseServerStream(data)) {
            if (f.opcode() >= 0x8) {
                out.add(f);
            }
        }
        return out;
    }

    static int closeCodeOf(ServerFrame f) {
        return ((f.payload()[0] & 0xFF) << 8) | (f.payload()[1] & 0xFF);
    }

    record TileSeen(long reqId, long x, long y, int format) {}

    static List<TileSeen> tilesSeen(byte[] data) throws Exception {
        List<TileSeen> out = new ArrayList<>();
        for (ServerFrame f : parseServerStream(data)) {
            if (f.opcode() == WsFrame.OP_BIN && f.payload().length >= 2
                    && f.payload()[0] == (byte) 0xAA && f.payload()[1] == 0x02) {
                UtpMessages.TileHeader h =
                        UtpCodec.decodeTileHeader(Arrays.copyOfRange(f.payload(), 0, 24));
                out.add(new TileSeen(h.reqId(), h.tileX(), h.tileY(), h.format()));
            }
        }
        return out;
    }

    record EndSeen(long reqId, long sent, long skipped) {}

    static List<EndSeen> endsSeen(byte[] data) throws Exception {
        List<EndSeen> out = new ArrayList<>();
        for (ServerFrame f : parseServerStream(data)) {
            if (f.opcode() == WsFrame.OP_BIN && f.payload().length == 16
                    && f.payload()[0] == (byte) 0xAA && f.payload()[1] == 0x04) {
                UtpMessages.GenerationEnd e = UtpCodec.decodeEnd(f.payload());
                out.add(new EndSeen(e.reqId(), e.sent(), e.skipped()));
            }
        }
        return out;
    }

    static void awaitTrue(BooleanSupplier cond, long timeoutMs, String what) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!cond.getAsBoolean()) {
            if (System.currentTimeMillis() > deadline) {
                fail("timeout: " + what);
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                fail("interrupted: " + what);
            }
        }
    }

    static void awaitEnds(Harness h, int n, long timeoutMs) {
        awaitTrue(
                () -> {
                    try {
                        return endsSeen(h.rec.bytes()).size() >= n;
                    } catch (Exception e) {
                        return false;
                    }
                },
                timeoutMs,
                "END frames");
    }

    // ---------- rejected-set discipline ----------

    @Test
    void rejectedChunkThenCommitCloses() throws Exception {
        Harness h = newHarness();
        // Image 0 at zoom 2 has 4 cols; x=10 is outside: parses, fails image rules.
        h.coord.onViewportChunk(chunkBytes(0, 2, 9, 10, 12, 0, 0));
        assertFalse(h.coord.closed.get());
        assertFalse(h.coord.closeSent.get());
        assertTrue(h.coord.rejectedReqIds.contains(9L));
        assertEquals(0, h.coord.lastReqIdSeen.get());

        h.coord.onCommit(commitBytes(0, 9));
        assertTrue(h.coord.closeSent.get());
        assertTrue(h.sock.closed);
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(0x8, ctrls.get(0).opcode());
        assertEquals(1002, closeCodeOf(ctrls.get(0)));
        assertTrue(endsSeen(h.rec.bytes()).isEmpty());
        List<String> ev = h.sock.events;
        assertEquals(List.of("close"), ev);
        assertTrue(h.rec.bytes().length > 0);
    }

    @Test
    void bad9Valid9Resurrection() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 2, 9, 10, 12, 0, 0));
        h.coord.onViewportChunk(chunkBytes(0, 0, 9, 0, 0, 0, 0));
        assertTrue(h.coord.closeSent.get());
        assertTrue(h.sock.closed);
        assertNull(h.coord.active.get());
        assertEquals(0, h.coord.lastReqIdSeen.get());
    }

    @Test
    void invalidNewerSplit() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(9999, 0, 100, 0, 0, 0, 0));
        assertFalse(h.coord.closed.get());
        assertTrue(h.coord.rejectedReqIds.contains(100L));

        h.coord.onCommit(commitBytes(9999, 101));
        assertTrue(h.coord.closeSent.get());
        assertTrue(h.sock.closed);

        Harness g = newHarness();
        g.coord.onViewportChunk(chunkBytes(9999, 0, 100, 0, 0, 0, 0));
        g.coord.onViewportChunk(chunkBytes(0, 0, 2, 0, 0, 0, 0));
        assertFalse(g.coord.closed.get());
        assertNotNull(g.coord.active.get());
        assertEquals(2, g.coord.active.get().reqId);
        assertEquals(2, g.coord.lastReqIdSeen.get());
    }

    @Test
    void noEvict64Then65thCloses() {
        Harness h = newHarness();
        for (long i = 1; i <= 64; i++) {
            h.coord.onViewportChunk(chunkBytes(9999, 0, i, 0, 0, 0, 0));
            assertFalse(h.coord.closed.get(), "must stay alive while recording " + i);
        }
        assertEquals(64, h.coord.rejectedReqIds.size());
        h.coord.onViewportChunk(chunkBytes(9999, 0, 65, 0, 0, 0, 0));
        assertTrue(h.coord.closeSent.get());
        assertEquals(64, h.coord.rejectedReqIds.size());
    }

    @Test
    void purgeOnStale() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(9999, 0, 100, 0, 0, 0, 0));
        assertTrue(h.coord.rejectedReqIds.contains(100L));
        h.coord.onViewportChunk(chunkBytes(0, 0, 101, 0, 0, 0, 0));
        assertEquals(101, h.coord.lastReqIdSeen.get());
        assertFalse(h.coord.rejectedReqIds.contains(100L));
        h.coord.onViewportChunk(chunkBytes(9999, 0, 100, 0, 0, 0, 0));
        assertFalse(h.coord.closed.get());
        assertFalse(h.coord.closeSent.get());
    }

    @Test
    void historyBeforeValidation() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onViewportChunk(chunkBytes(0, 0, 2, 0, 0, 0, 0));
        assertEquals(2, h.coord.lastReqIdSeen.get());
        h.coord.onViewportChunk(chunkBytes(9999, 0, 1, 0, 0, 0, 0));
        assertFalse(h.coord.closed.get());
        assertFalse(h.coord.closeSent.get());
        assertEquals(2, h.coord.active.get().reqId);
    }

    // ---------- commit lifecycles ----------

    @Test
    void duplicateCommitAfterEndIsStale() throws Exception {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        h.coord.start();
        awaitEnds(h, 1, 10000);
        awaitTrue(() -> h.coord.active.get() == null, 10000, "active cleared after END");
        List<EndSeen> ends = endsSeen(h.rec.bytes());
        assertEquals(1, ends.size());
        assertEquals(1, ends.get(0).reqId());

        h.coord.onCommit(commitBytes(0, 1));
        assertFalse(h.coord.closeSent.get());
        assertFalse(h.coord.closed.get());
        assertEquals(1, endsSeen(h.rec.bytes()).size());
        h.coord.closeSession();
        h.coord.joinThreads(10000);
        assertFalse(h.coord.threadsAlive());
    }

    @Test
    void staleCommitSuperseded() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onViewportChunk(chunkBytes(0, 0, 2, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        assertFalse(h.coord.closed.get());
        assertFalse(h.coord.closeSent.get());
        assertEquals(2, h.coord.active.get().reqId);
    }

    @Test
    void emptyCommitDispatchesEnd00() throws Exception {
        Harness h = newHarness();
        h.coord.onCommit(commitBytes(0, 5));
        assertFalse(h.coord.closed.get());
        assertEquals(5, h.coord.lastReqIdSeen.get());
        assertNotNull(h.coord.active.get());
        assertEquals(-1, h.coord.active.get().zoom);
        h.coord.start();
        awaitEnds(h, 1, 10000);
        List<EndSeen> ends = endsSeen(h.rec.bytes());
        assertEquals(1, ends.size());
        assertEquals(5, ends.get(0).reqId());
        assertEquals(0, ends.get(0).sent());
        assertEquals(0, ends.get(0).skipped());
        awaitTrue(() -> h.coord.active.get() == null, 10000, "sealed-empty cleared");
        assertTrue(tilesSeen(h.rec.bytes()).isEmpty());
        h.coord.closeSession();
        h.coord.joinThreads(10000);
    }

    @Test
    void noReaderSideEndWrite() throws Exception {
        String src = Files.readString(
                Path.of("src/main/java/com/ultratile/ws/SessionCoordinator.java"));
        assertFalse(src.contains("writeBinary"), "END must flow through the dispatcher slot");
        String all = new StringBuilder()
                .append(Files.readString(
                        Path.of("src/main/java/com/ultratile/ws/SessionCoordinator.java")))
                .append(Files.readString(
                        Path.of("src/main/java/com/ultratile/ws/WsWriter.java")))
                .append(Files.readString(Path.of("src/main/java/com/ultratile/ws/WsFrame.java")))
                .append(Files.readString(
                        Path.of("src/main/java/com/ultratile/ws/WsHandshake.java")))
                .append(Files.readString(
                        Path.of("src/main/java/com/ultratile/net/NioHttpServer.java")))
                .toString()
                .toLowerCase(java.util.Locale.ROOT);
        assertFalse(all.contains("queue_cap"), "no dispatch staging structures");
        assertFalse(all.contains("queueempty"), "no dispatch staging structures");
        assertFalse(all.contains("priorityqueue"), "no dispatch staging structures");
        assertFalse(all.contains("priority queue"), "no dispatch staging structures");
    }

    // ---------- teardown / wakeup ----------

    @Test
    void idleCloseTerminatesBoth() throws Exception {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        RecordingChannel rec = new RecordingChannel(events);
        FakeSocket sock = new FakeSocket();
        SessionCoordinator coord = new SessionCoordinator(
                new ByteArrayInputStream(new byte[0]),
                new WsWriter(rec),
                sock,
                (id, zoom, x, y) -> {
                    throw new IOException("no tiles");
                },
                new Lookup());
        coord.start();
        coord.joinThreads(10000);
        assertFalse(coord.threadsAlive());
        assertTrue(sock.closed);
    }

    @Test
    void dispatcherFatalWakesReader() throws Exception {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        RecordingChannel rec = new RecordingChannel(events);
        rec.throwOnWrite = true;
        ServerSocketChannel ssc = ServerSocketChannel.open();
        ssc.bind(new InetSocketAddress("127.0.0.1", 0));
        int port = ((InetSocketAddress) ssc.getLocalAddress()).getPort();
        Socket readerSide = new Socket("127.0.0.1", port);
        SocketChannel accepted = ssc.accept();
        byte[] tiny = new byte[64];
        SessionCoordinator coord = new SessionCoordinator(
                readerSide.getInputStream(),
                new WsWriter(rec),
                readerSide,
                (id, zoom, x, y) -> {
                    FakeTileChannel ch = new FakeTileChannel(tiny.clone());
                    return ch;
                },
                new Lookup());
        try {
            coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
            coord.onCommit(commitBytes(0, 1));
            coord.start();
            coord.joinThreads(10000);
            assertFalse(coord.threadsAlive());
            assertTrue(readerSide.isClosed());
        } finally {
            try {
                readerSide.close();
            } catch (IOException ignored) {
            }
            try {
                accepted.close();
            } catch (IOException ignored) {
            }
            try {
                ssc.close();
            } catch (IOException ignored) {
            }
        }
    }

    @Test
    void noChannelCloseOnCancel() throws Exception {
        Harness h = newHarness();
        FakeTileChannel blocked = new FakeTileChannel(new byte[100]);
        blocked.blockInTransfer = true;
        SessionCoordinator gated = new SessionCoordinator(
                h.sock.in, h.coord.writer, h.sock,
                (id, zoom, x, y) -> blocked,
                h.lookup);
        gated.onViewportChunk(chunkBytes(0, 2, 1, 0, 1, 0, 0));
        gated.onCommit(commitBytes(0, 1));
        gated.start();
        awaitTrue(() -> blocked.entered, 10000, "transfer started");
        gated.onAbort(abortBytes(0, 1));
        blocked.release();
        Thread.sleep(300);
        assertFalse(blocked.closeCalled);
        assertFalse(gated.closed.get());
        assertFalse(gated.closeSent.get());
        gated.closeSession();
        gated.joinThreads(10000);
    }

    // ---------- stale vs invalid ----------

    @Test
    void postSealChunkCloses() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        assertTrue(h.coord.closeSent.get());
    }

    @Test
    void metadataMismatchCloses() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onViewportChunk(chunkBytes(0, 1, 1, 0, 0, 0, 0));
        assertTrue(h.coord.closeSent.get());
    }

    @Test
    void duplicateCommitWhileSealedCloses() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        h.coord.onCommit(commitBytes(0, 1));
        assertTrue(h.coord.closeSent.get());
    }

    @Test
    void unknownAbortIgnored() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onAbort(abortBytes(1, 1));
        assertFalse(h.coord.closed.get());
        assertFalse(h.coord.closeSent.get());
        assertEquals(1, h.coord.active.get().reqId);
        h.coord.onAbort(abortBytes(0, 1));
        assertNull(h.coord.active.get());
        assertFalse(h.coord.closed.get());
    }

    // ---------- transfer fallback ----------

    static Harness activeHarness(byte[] payload, long size, long... script) {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        RecordingChannel rec = new RecordingChannel(events);
        FakeSocket sock = new FakeSocket();
        Lookup lookup = new Lookup();
        FakeTileChannel ch = new FakeTileChannel(payload, script);
        ch.sizeOverride = size;
        SessionCoordinator coord = new SessionCoordinator(
                sock.in, new WsWriter(rec), sock,
                (id, zoom, x, y) -> ch, lookup);
        coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        return new Harness(coord, lookup, rec, sock, events, List.of(ch));
    }

    static void assertTileBytes(Harness h, byte[] payload, UtpMessages.TileHeader header)
            throws Exception {
        List<ServerFrame> frames = parseServerStream(h.rec.bytes());
        assertEquals(1, frames.size());
        assertEquals(WsFrame.OP_BIN, frames.get(0).opcode());
        byte[] body = frames.get(0).payload();
        assertEquals(24 + payload.length, body.length);
        assertTrue(Arrays.equals(
                UtpCodec.encodeTileHeader(header), Arrays.copyOfRange(body, 0, 24)));
        assertTrue(Arrays.equals(payload, Arrays.copyOfRange(body, 24, body.length)));
    }

    @Test
    void fallbackAfterProgress() throws Exception {
        byte[] payload = new byte[100];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i * 3 + 1);
        }
        Harness h = activeHarness(payload, 100, 2, 0, 0, 0, 0);
        FakeTileChannel ch = (FakeTileChannel) h.channels.get(0);
        UtpMessages.TileHeader header =
                new UtpMessages.TileHeader(0, 0, 1, 512, 1, 0, 0, 100);
        TileOutcome o = h.coord.writer.transferTileIf(
                header, ch, 100, h.coord, h.coord.active.get());
        assertEquals(TileOutcome.STARTED, o);
        assertTrue(ch.readCalls > 0);
        assertTileBytes(h, payload, header);
    }

    @Test
    void fallbackPersistentZero() throws Exception {
        byte[] payload = new byte[64];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i + 5);
        }
        Harness h = activeHarness(payload, 64, 0, 0, 0, 0);
        FakeTileChannel ch = (FakeTileChannel) h.channels.get(0);
        UtpMessages.TileHeader header =
                new UtpMessages.TileHeader(0, 0, 1, 512, 1, 0, 0, 64);
        TileOutcome o = h.coord.writer.transferTileIf(
                header, ch, 64, h.coord, h.coord.active.get());
        assertEquals(TileOutcome.STARTED, o);
        assertTrue(ch.readCalls > 0);
        assertTileBytes(h, payload, header);
    }

    @Test
    void zeroThenProgressNoFallback() throws Exception {
        byte[] payload = new byte[10];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i + 9);
        }
        Harness h = activeHarness(payload, 10, 0, 0, 10);
        FakeTileChannel ch = (FakeTileChannel) h.channels.get(0);
        UtpMessages.TileHeader header =
                new UtpMessages.TileHeader(0, 0, 1, 512, 1, 0, 0, 10);
        TileOutcome o = h.coord.writer.transferTileIf(
                header, ch, 10, h.coord, h.coord.active.get());
        assertEquals(TileOutcome.STARTED, o);
        assertEquals(0, ch.readCalls);
        assertTileBytes(h, payload, header);
    }

    @Test
    void eofBeforeAdvertisedIsFatal() {
        byte[] payload = new byte[10];
        Harness h = activeHarness(payload, 100, 0, 0, 0, 0);
        FakeTileChannel ch = (FakeTileChannel) h.channels.get(0);
        UtpMessages.TileHeader header =
                new UtpMessages.TileHeader(0, 0, 1, 512, 1, 0, 0, 100);
        Harness hh = h;
        assertThrows(
                IOException.class,
                () -> hh.coord.writer.transferTileIf(
                        header, ch, 100, hh.coord, hh.coord.active.get()));
    }

    @Test
    void formatNeverTwo() throws Exception {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        h.coord.start();
        awaitEnds(h, 1, 10000);
        for (TileSeen t : tilesSeen(h.rec.bytes())) {
            assertEquals(1, t.format());
        }
        assertFalse(tilesSeen(h.rec.bytes()).isEmpty());
        String writer = Files.readString(
                Path.of("src/main/java/com/ultratile/ws/WsWriter.java"));
        String coord = Files.readString(
                Path.of("src/main/java/com/ultratile/ws/SessionCoordinator.java"));
        assertFalse(writer.contains("FORMAT_WEBP"));
        assertFalse(coord.contains("FORMAT_WEBP"));
        h.coord.closeSession();
        h.coord.joinThreads(10000);
    }

    // ---------- generation cap at session level ----------

    @Test
    void dedupeAtCapSession() {
        Harness h = newHarness();
        // Image 9 at zoom 5 is a 32-wide grid; four 8x8 chunks fill 256.
        h.coord.onViewportChunk(chunkBytes(9, 5, 1, 0, 7, 0, 7));
        h.coord.onViewportChunk(chunkBytes(9, 5, 1, 8, 15, 0, 7));
        h.coord.onViewportChunk(chunkBytes(9, 5, 1, 0, 7, 8, 15));
        h.coord.onViewportChunk(chunkBytes(9, 5, 1, 8, 15, 8, 15));
        assertFalse(h.coord.closed.get());
        assertEquals(256, h.coord.active.get().requested.size());
        h.coord.onViewportChunk(chunkBytes(9, 5, 1, 0, 7, 0, 7));
        assertFalse(h.coord.closed.get());
        assertEquals(256, h.coord.active.get().requested.size());
        h.coord.onViewportChunk(chunkBytes(9, 5, 1, 16, 16, 0, 0));
        assertTrue(h.coord.closeSent.get());
    }

    // ---------- lock admission ----------

    @Test
    void lockAdmissionShutdown() throws Exception {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        SessionCoordinator.GenerationState s = h.coord.active.get();
        assertNotNull(s);
        h.coord.closeSent.set(true);
        FakeTileChannel ch = new FakeTileChannel(new byte[100]);
        UtpMessages.TileHeader header =
                new UtpMessages.TileHeader(0, 0, 1, 512, 1, 0, 0, 100);
        TileOutcome o = h.coord.writer.transferTileIf(header, ch, 100, h.coord, s);
        assertEquals(TileOutcome.SHUTDOWN, o);
        assertEquals(0, h.rec.bytes().length);
    }

    @Test
    void lockOrderingTwin() throws Exception {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        h.coord.writer.writeLock().lock();
        try {
            h.coord.start();
            awaitTrue(
                    () -> h.coord.writer.writeLock().hasQueuedThreads(),
                    10000,
                    "dispatcher queued on writer lock");
            h.coord.failSession(1002, "race");
            assertTrue(h.coord.closeSent.get());
        } finally {
            h.coord.writer.writeLock().unlock();
        }
        h.coord.joinThreads(10000);
        List<ServerFrame> frames = parseServerStream(h.rec.bytes());
        assertEquals(1, frames.size());
        assertEquals(0x8, frames.get(0).opcode());
        assertEquals(1002, closeCodeOf(frames.get(0)));
        assertTrue(h.sock.closed);
    }

    // ---------- coalescing ----------

    @Test
    void coalescedStress20() throws Exception {
        Harness h = newHarness();
        for (long i = 1; i <= 20; i++) {
            h.coord.onViewportChunk(chunkBytes(0, 0, i, 0, 0, 0, 0));
            h.coord.onCommit(commitBytes(0, i));
            assertTrue(
                    h.coord.readyPermit.availablePermits() <= 1,
                    "permits must never accumulate at " + i);
        }
        h.coord.start();
        awaitEnds(h, 1, 10000);
        awaitTrue(
                () -> {
                    try {
                        return tilesSeen(h.rec.bytes()).size() >= 1;
                    } catch (Exception e) {
                        return false;
                    }
                },
                10000,
                "newest tiles dispatched");
        int tilesBefore;
        int endsBefore;
        try {
            tilesBefore = tilesSeen(h.rec.bytes()).size();
            endsBefore = endsSeen(h.rec.bytes()).size();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        Thread.sleep(300);
        List<TileSeen> tiles = tilesSeen(h.rec.bytes());
        assertFalse(tiles.isEmpty());
        for (TileSeen t : tiles) {
            assertEquals(20, t.reqId());
        }
        List<EndSeen> ends = endsSeen(h.rec.bytes());
        assertEquals(1, ends.size());
        assertEquals(20, ends.get(0).reqId());
        assertEquals(tilesBefore, tiles.size());
        assertEquals(endsBefore, ends.size());
        h.coord.closeSession();
        h.coord.joinThreads(10000);
    }

    @Test
    void centerFirstOrder() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 2, 1, 0, 3, 0, 0));
        h.coord.onCommit(commitBytes(0, 1));
        SessionCoordinator.GenerationState s = h.coord.readySlot.get();
        assertNotNull(s);
        List<String> order = new ArrayList<>();
        for (SessionCoordinator.TileReq t : s.work) {
            order.add(t.x() + "," + t.y());
        }
        assertEquals(List.of("1,0", "2,0", "0,0", "3,0"), order);
    }

    // ---------- close frames on the wire ----------

    @Test
    void closeReasonCap() {
        Harness h = newHarness();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 500; i++) {
            sb.append('x');
        }
        h.coord.failSession(1002, sb.toString());
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(0x8, ctrls.get(0).opcode());
        assertTrue(ctrls.get(0).payload().length <= 125);
        assertEquals(1002, closeCodeOf(ctrls.get(0)));
        byte[] reason = Arrays.copyOfRange(ctrls.get(0).payload(), 2, ctrls.get(0).payload().length);
        assertEquals(new String(reason, StandardCharsets.UTF_8).getBytes(StandardCharsets.UTF_8).length,
                reason.length);
        assertTrue(h.sock.closed);
    }

    @Test
    void invalidBinaryIs1002() {
        Harness h = newHarness();
        h.coord.handleEvent(new WsFrame.Event.Binary(new byte[] {0x00, 0x01, 0x02}));
        assertTrue(h.coord.closeSent.get());
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(1002, closeCodeOf(ctrls.get(0)));
        assertEquals(List.of("close"), h.sock.events);
    }

    @Test
    void validTextIs1003() {
        Harness h = newHarness();
        h.coord.handleEvent(new WsFrame.Event.Text("hello".getBytes(StandardCharsets.UTF_8), true));
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(1003, closeCodeOf(ctrls.get(0)));
        assertTrue(h.sock.closed);
    }

    @Test
    void invalidTextIs1007() {
        Harness h = newHarness();
        h.coord.handleEvent(new WsFrame.Event.Text(new byte[] {(byte) 0xC0, (byte) 0xAF}, false));
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(1007, closeCodeOf(ctrls.get(0)));
        assertTrue(h.sock.closed);
    }

    @Test
    void oversizeIs1009() throws Exception {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        RecordingChannel rec = new RecordingChannel(events);
        FakeSocket sock = new FakeSocket();
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        raw.write(new byte[] {(byte) 0x82, (byte) 0xFE, 0x07, (byte) 0xD0, 1, 2, 3, 4});
        SessionCoordinator coord = new SessionCoordinator(
                new ByteArrayInputStream(raw.toByteArray()),
                new WsWriter(rec),
                sock,
                (id, zoom, x, y) -> {
                    throw new IOException("no tiles");
                },
                new Lookup());
        coord.start();
        awaitTrue(() -> !controlFrames(rec.bytes()).isEmpty(), 10000, "1009 close");
        assertEquals(1009, closeCodeOf(controlFrames(rec.bytes()).get(0)));
        coord.joinThreads(10000);
    }

    @Test
    void peerCloseEcho1000() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        h.coord.onPeerClose(OptionalInt.of(1000), new byte[0]);
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(1000, closeCodeOf(ctrls.get(0)));
        assertTrue(h.sock.closed);
    }

    @Test
    void peerCloseEcho4002NoSemantics() {
        Harness h = newHarness();
        h.coord.onViewportChunk(chunkBytes(0, 0, 1, 0, 0, 0, 0));
        long seen = h.coord.lastReqIdSeen.get();
        int rejected = h.coord.rejectedReqIds.size();
        int lookups = h.lookup.calls.get();
        h.coord.onPeerClose(OptionalInt.of(4002), new byte[0]);
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(4002, closeCodeOf(ctrls.get(0)));
        assertEquals(seen, h.coord.lastReqIdSeen.get());
        assertEquals(rejected, h.coord.rejectedReqIds.size());
        assertEquals(lookups, h.lookup.calls.get());
        assertTrue(h.sock.closed);
    }

    @Test
    void peerCloseInvalidEchoes1002() {
        for (int bad : new int[] {1005, 1006, 1015}) {
            Harness h = newHarness();
            h.coord.onPeerClose(OptionalInt.of(bad), new byte[0]);
            List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
            assertEquals(1, ctrls.size(), "code " + bad);
            assertEquals(1002, closeCodeOf(ctrls.get(0)), "code " + bad);
        }
    }

    @Test
    void peerCloseEmptyEchoesEmpty() {
        Harness h = newHarness();
        h.coord.onPeerClose(OptionalInt.empty(), new byte[0]);
        List<ServerFrame> ctrls = controlFrames(h.rec.bytes());
        assertEquals(1, ctrls.size());
        assertEquals(0, ctrls.get(0).payload().length);
        for (ServerFrame f : parseServerStream(h.rec.bytes())) {
            if (f.opcode() == 0x8 && f.payload().length >= 2) {
                assertFalse(closeCodeOf(f) == 1005, "1005 must never appear on the wire");
            }
        }
        assertTrue(h.sock.closed);
    }

    @Test
    void closeSentClosedSplit() {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        RecordingChannel rec = new RecordingChannel(events);
        FakeSocket sock = new FakeSocket();
        SessionCoordinator coord = new SessionCoordinator(
                sock.in,
                new ThrowingWriter(rec),
                sock,
                (id, zoom, x, y) -> {
                    throw new IOException("no tiles");
                },
                new Lookup());
        coord.failSession(1002, "fatal path");
        assertTrue(sock.closed);
        assertTrue(coord.closed.get());
        assertTrue(coord.readyPermit.availablePermits() > 0);
        assertEquals(0, rec.bytes().length);
    }

    @Test
    void peerCloseDuringTransfer() throws Exception {
        Harness h = newHarness();
        FakeTileChannel first = new FakeTileChannel(new byte[100]);
        first.blockInTransfer = true;
        FakeTileChannel second = new FakeTileChannel(new byte[100]);
        AtomicInteger n = new AtomicInteger();
        SessionCoordinator coord = new SessionCoordinator(
                h.sock.in,
                h.coord.writer,
                h.sock,
                (id, zoom, x, y) -> n.getAndIncrement() == 0 ? first : second,
                h.lookup);
        coord.onViewportChunk(chunkBytes(0, 2, 1, 0, 1, 0, 0));
        coord.onCommit(commitBytes(0, 1));
        coord.start();
        awaitTrue(() -> first.entered, 10000, "transfer started");
        Thread peer = new Thread(() -> coord.onPeerClose(OptionalInt.of(1000), new byte[0]));
        peer.start();
        awaitTrue(() -> coord.writer.writeLock().hasQueuedThreads(), 10000, "echo queued");
        first.release();
        peer.join(10000);
        coord.joinThreads(10000);
        List<ServerFrame> frames = parseServerStream(h.rec.bytes());
        int tileIdx = -1;
        int closeIdx = -1;
        for (int i = 0; i < frames.size(); i++) {
            ServerFrame f = frames.get(i);
            if (f.opcode() == WsFrame.OP_BIN && f.payload().length == 124) {
                tileIdx = i;
            }
            if (f.opcode() == 0x8) {
                closeIdx = i;
                assertEquals(1000, closeCodeOf(f));
            }
        }
        assertTrue(tileIdx >= 0, "in-flight tile completes");
        assertTrue(closeIdx > tileIdx, "echo follows the frame boundary");
        assertEquals(1, tilesSeen(h.rec.bytes()).size());
        assertTrue(endsSeen(h.rec.bytes()).isEmpty());
        assertTrue(h.sock.closed);
    }

    // ---------- live handshake singletons ----------

    static String rawHttp(int port, String request) throws Exception {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", port), 3000);
            s.setSoTimeout(5000);
            s.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            s.getOutputStream().flush();
            InputStream in = s.getInputStream();
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] last = new byte[4];
            int filled = 0;
            while (true) {
                int x = in.read();
                if (x < 0) {
                    break;
                }
                b.write(x);
                if (filled < 4) {
                    last[filled++] = (byte) x;
                } else {
                    last[0] = last[1];
                    last[1] = last[2];
                    last[2] = last[3];
                    last[3] = (byte) x;
                }
                if (filled == 4 && last[0] == '\r' && last[1] == '\n'
                        && last[2] == '\r' && last[3] == '\n') {
                    break;
                }
            }
            return b.toString(StandardCharsets.US_ASCII);
        }
    }

    static String handshakeRequest(Map<String, List<String>> extra, boolean withProtocol) {
        StringBuilder sb = new StringBuilder("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\n"
                .replace("PORT", "X"));
        sb.append("Upgrade: websocket\r\nConnection: Upgrade\r\n");
        sb.append("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n");
        sb.append("Sec-WebSocket-Version: 13\r\n");
        if (withProtocol) {
            sb.append("Sec-WebSocket-Protocol: ultratile.utp.v1\r\n");
        }
        for (Map.Entry<String, List<String>> e : extra.entrySet()) {
            for (String v : e.getValue()) {
                sb.append(e.getKey()).append(": ").append(v).append("\r\n");
            }
        }
        sb.append("Connection: close\r\n\r\n");
        return sb.toString();
    }

    @Test
    void handshakeSingletons() throws Exception {
        try (NioHttpServer server = new NioHttpServer("127.0.0.1", 0)) {
            server.start();
            int port = server.getBindAddress().getPort();
            java.util.function.Function<String, String> send = req ->
                    sneaky(port, req.replace("127.0.0.1:X", "127.0.0.1:" + port));

            String ok = send.apply(handshakeRequest(Map.of(), true));
            assertTrue(ok.startsWith("HTTP/1.1 101"), "base handshake 101, got: " + statusOf(ok));
            assertTrue(ok.contains("Sec-WebSocket-Protocol: ultratile.utp.v1"));
            assertTrue(ok.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));

            String dupKey = send.apply(handshakeRequest(
                    Map.of("Sec-WebSocket-Key", List.of("dGhlIHNhbXBsZSBub25jZQ==")), true));
            assertTrue(dupKey.startsWith("HTTP/1.1 400"), "dup-Key, got: " + statusOf(dupKey));

            String dupVer = send.apply(handshakeRequest(
                    Map.of("Sec-WebSocket-Version", List.of("13")), true));
            assertTrue(dupVer.startsWith("HTTP/1.1 400"), "dup-Version, got: " + statusOf(dupVer));

            String dupOrigin = send.apply(handshakeRequest(
                    Map.of("Origin",
                            List.of("http://127.0.0.1:" + port, "http://127.0.0.1:" + port)),
                    true));
            assertTrue(
                    dupOrigin.startsWith("HTTP/1.1 400"), "dup-Origin, got: " + statusOf(dupOrigin));

            String missingProto = send.apply(handshakeRequest(Map.of(), false));
            assertTrue(missingProto.startsWith("HTTP/1.1 400"), "missing subprotocol");

            String dupProto = send.apply(handshakeRequest(
                    Map.of("Sec-WebSocket-Protocol", List.of("ultratile.utp.v1")), true));
            assertTrue(dupProto.startsWith("HTTP/1.1 400"), "dup subprotocol");

            String wrongProto = send.apply(handshakeRequest(
                    Map.of("Sec-WebSocket-Protocol", List.of("other")), false));
            assertTrue(wrongProto.startsWith("HTTP/1.1 400"), "wrong subprotocol");

            String splitConn = send.apply("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: keep-alive\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "Sec-WebSocket-Protocol: ultratile.utp.v1\r\n\r\n");
            assertTrue(
                    splitConn.startsWith("HTTP/1.1 101"), "split Connection, got: "
                            + statusOf(splitConn));

            String ver12 = send.apply("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                    + "Sec-WebSocket-Version: 12\r\n"
                    + "Sec-WebSocket-Protocol: ultratile.utp.v1\r\n\r\n");
            assertTrue(ver12.startsWith("HTTP/1.1 400"), "version 12");
            assertTrue(ver12.contains("Sec-WebSocket-Version: 13"));

            String originOk = send.apply(handshakeRequest(
                    Map.of("Origin", List.of("http://127.0.0.1:" + port)), true));
            assertTrue(
                    originOk.startsWith("HTTP/1.1 101"), "matching Origin, got: "
                            + statusOf(originOk));
        }
    }

    static String sneaky(int port, String req) {
        try {
            return rawHttp(port, req);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static String statusOf(String head) {
        int i = head.indexOf("\r\n");
        return i < 0 ? head : head.substring(0, i);
    }
}
