package com.ultratile.ws;

import java.io.IOException;
import java.io.InputStream;
import java.io.Closeable;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.WritableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.OptionalInt;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

import com.ultratile.Config;
import com.ultratile.proto.UtpCodec;
import com.ultratile.proto.UtpMessages;
import com.ultratile.tiles.ImageRegistry;
import com.ultratile.tiles.PyramidTileStore;

/**
 * One WS session: a single reader virtual thread plus a single dispatcher
 * virtual thread sharing one serialized {@link WsWriter}. Generations move
 * chunked-requested to sealed to dispatched through one coalesced ready slot;
 * at most the newest sealed generation survives to dispatch. There is no
 * dispatch staging structure anywhere: the dispatcher walks the sealed work
 * list with a local drain index.
 */
public class SessionCoordinator {

    private static final Logger LOG = Logger.getLogger(SessionCoordinator.class.getName());

    /** Close-reason UTF-8 budget (total Close payload stays within 125). */
    static final int CLOSE_REASON_MAX = 123;

    /** One requested tile bound to its generation. */
    public record TileReq(GenerationState state, long x, long y) {}

    /** Per-generation mutable state. Requested-set and bbox are reader-owned
     * pre-seal; work/sealed are published at seal; counters are
     * dispatcher-owned. */
    public static final class GenerationState {
        public final long reqId;
        public final int imageId;
        public final int zoom;
        public final int lodMode;
        public final LinkedHashSet<Long> requested = new LinkedHashSet<>();
        public long loX = Long.MAX_VALUE;
        public long hiX = Long.MIN_VALUE;
        public long loY = Long.MAX_VALUE;
        public long hiY = Long.MIN_VALUE;
        public volatile List<TileReq> work;
        public volatile boolean sealed;
        public volatile boolean canceled;
        public volatile int sent;
        public volatile int skipped;
        public volatile int inFlight;

        public GenerationState(long reqId, int imageId, int zoom, int lodMode) {
            this.reqId = reqId;
            this.imageId = imageId;
            this.zoom = zoom;
            this.lodMode = lodMode;
        }
    }

    /** Registry probe, injectable for tests. */
    public interface ImageLookup {
        ImageRegistry.ImageInfo lookup(int imageId);
    }

    /** Tile channel source, injectable for tests. */
    public interface TileOpener {
        FileChannel openTile(int imageId, int zoom, long x, long y) throws IOException;
    }

    public static ImageLookup defaultLookup() {
        return defaultLookup(PyramidTileStore.defaultRoot());
    }

    /** Lookup against an explicit data root (see {@code --data-root}). */
    public static ImageLookup defaultLookup(Path base) {
        ImageRegistry reg = new ImageRegistry(base);
        return reg::get;
    }

    public static TileOpener defaultOpener() {
        return defaultOpener(PyramidTileStore.defaultRoot());
    }

    /**
     * Tile opener against an explicit data root.
     *
     * <p>The {@code long -> int} narrowing below is deliberate and currently
     * unreachable: coordinates are validated against the protocol bound before
     * a session ever sees them. If it were ever reached, {@code tileRelativePath}
     * rejects the negative value, the serving loop treats it as a skipped tile,
     * and the count surfaces in END {@code skipped} -- it cannot yield a wrong
     * file or a path traversal.
     */
    public static TileOpener defaultOpener(Path base) {
        return (id, zoom, x, y) -> {
            Path p = PyramidTileStore.servePath(base, id, zoom, (int) x, (int) y);
            PyramidTileStore.checkSize(p);
            return FileChannel.open(p, StandardOpenOption.READ);
        };
    }

    final AtomicReference<GenerationState> active = new AtomicReference<>();
    final AtomicLong lastReqIdSeen = new AtomicLong(0);
    final LinkedHashSet<Long> rejectedReqIds = new LinkedHashSet<>();
    final AtomicReference<GenerationState> readySlot = new AtomicReference<>();
    final Semaphore readyPermit = new Semaphore(0);
    final AtomicBoolean closed = new AtomicBoolean(false);
    final AtomicBoolean closeSent = new AtomicBoolean(false);
    final AtomicReference<FileChannel> currentTile = new AtomicReference<>();

    private final InputStream in;
    final WsWriter writer;
    private final Closeable socketToClose;
    private final TileOpener opener;
    private final ImageLookup lookup;
    private final WsFrame.Assembler assembler = new WsFrame.Assembler();
    private volatile Thread readerThread;
    private volatile Thread dispatcherThread;

    public SessionCoordinator(
            InputStream in,
            WritableByteChannel out,
            Closeable socketToClose,
            TileOpener opener,
            ImageLookup lookup) {
        this(in, new WsWriter(out), socketToClose, opener, lookup);
    }

    public SessionCoordinator(
            InputStream in,
            WsWriter writer,
            Closeable socketToClose,
            TileOpener opener,
            ImageLookup lookup) {
        this.in = in;
        this.writer = writer;
        this.socketToClose = socketToClose;
        this.opener = opener;
        this.lookup = lookup;
    }

    // ---- inbound UTP entry points (reader thread, or tests, single caller) ----

    /** Frozen order: parse, rejected-check, history, then full validation. */
    public void onViewportChunk(byte[] raw) {
        UtpMessages.ViewportUpdate v;
        try {
            v = UtpCodec.decodeViewport(raw);
        } catch (IllegalArgumentException e) {
            failSession(1002, "bad chunk shape");
            return;
        }
        purgeStale();
        if (rejectedReqIds.contains(v.reqId())) {
            failSession(1002, "rejected generation");
            return;
        }
        GenerationState cur = active.get();
        if (cur != null && cur.reqId == v.reqId()) {
            if (cur.sealed) {
                failSession(1002, "post-seal chunk");
                return;
            }
            if (cur.imageId != v.imageId() || cur.zoom != v.zoom()) {
                failSession(1002, "chunk metadata mismatch");
                return;
            }
            if (!absorbRange(cur, v)) {
                failSession(1002, "generation tile cap");
                return;
            }
            LOG.fine("append chunk req=" + v.reqId());
            return;
        }
        if (v.reqId() <= lastReqIdSeen.get()) {
            LOG.warning("stale chunk req=" + v.reqId());
            return;
        }
        if (!validateImageRange(v.imageId(), v.zoom(), v.minX(), v.maxX(), v.minY(), v.maxY())) {
            recordReject(v.reqId());
            return;
        }
        if (cur != null) {
            cur.canceled = true;
        }
        GenerationState ns = new GenerationState(v.reqId(), v.imageId(), v.zoom(), v.lodMode());
        if (!absorbRange(ns, v)) {
            recordReject(v.reqId());
            return;
        }
        active.set(ns);
        lastReqIdSeen.set(v.reqId());
        purgeStale();
        LOG.fine("accepted generation req=" + v.reqId());
    }

    /** Frozen order: parse, rejected-check, matching seal, stale, newer-empty. */
    public void onCommit(byte[] raw) {
        UtpMessages.ViewportCommit c;
        try {
            c = UtpCodec.decodeCommit(raw);
        } catch (IllegalArgumentException e) {
            failSession(1002, "bad commit shape");
            return;
        }
        purgeStale();
        if (rejectedReqIds.contains(c.reqId())) {
            failSession(1002, "rejected generation");
            return;
        }
        GenerationState cur = active.get();
        if (cur != null && cur.reqId == c.reqId()) {
            if (cur.imageId != c.imageId()) {
                failSession(1002, "commit metadata mismatch");
                return;
            }
            if (cur.sealed) {
                failSession(1002, "duplicate commit");
                return;
            }
            List<TileReq> work = buildWork(cur);
            cur.work = work;
            cur.sealed = true;
            publishReady(cur);
            LOG.fine("sealed req=" + c.reqId() + " tiles=" + work.size());
            return;
        }
        if (c.reqId() <= lastReqIdSeen.get()) {
            LOG.warning("stale commit req=" + c.reqId());
            return;
        }
        if (lookup.lookup(c.imageId()) == null) {
            failSession(1002, "unknown image commit");
            return;
        }
        if (cur != null) {
            cur.canceled = true;
        }
        GenerationState ns = new GenerationState(c.reqId(), c.imageId(), -1, -1);
        ns.work = List.of();
        ns.sealed = true;
        active.set(ns);
        lastReqIdSeen.set(c.reqId());
        purgeStale();
        publishReady(ns);
        LOG.fine("sealed empty req=" + c.reqId());
    }

    public void onAbort(byte[] raw) {
        UtpMessages.AbortStream a;
        try {
            a = UtpCodec.decodeAbort(raw);
        } catch (IllegalArgumentException e) {
            failSession(1002, "bad abort shape");
            return;
        }
        GenerationState cur = active.get();
        if (cur == null || cur.reqId != a.abortReqId() || cur.imageId != a.imageId()) {
            LOG.warning("stale abort req=" + a.abortReqId());
            return;
        }
        cur.canceled = true;
        active.compareAndSet(cur, null);
        LOG.fine("aborted req=" + a.abortReqId());
    }

    /** Reassembled message dispatch (binary/text/ping/pong/close). */
    public void handleEvent(WsFrame.Event ev) {
        if (ev instanceof WsFrame.Event.Binary b) {
            onBinaryMessage(b.payload());
        } else if (ev instanceof WsFrame.Event.Text t) {
            if (t.validUtf8()) {
                failSession(1003, "text unsupported");
            } else {
                failSession(1007, "bad utf-8");
            }
        } else if (ev instanceof WsFrame.Event.Ping p) {
            try {
                writer.writeControl(WsFrame.OP_PONG, p.payload());
            } catch (IOException e) {
                readerFatal(e);
            }
        } else if (ev instanceof WsFrame.Event.Pong) {
            // No-op.
        } else if (ev instanceof WsFrame.Event.Close c) {
            if (c.code().isEmpty()) {
                onPeerClose(OptionalInt.empty(), c.reason());
            } else if (!c.reasonValid() && WsFrame.isValidPeerCode(c.code().getAsInt())) {
                failSession(1007, "bad close reason");
            } else {
                onPeerClose(c.code(), c.reason());
            }
        }
    }

    void onBinaryMessage(byte[] p) {
        if (p.length == UtpCodec.LEN_VIEWPORT && p[0] == (byte) UtpMessages.MAGIC
                && p[1] == (byte) UtpMessages.T_VIEWPORT) {
            onViewportChunk(p);
            return;
        }
        if (p.length == UtpCodec.LEN_COMMIT && p[0] == (byte) UtpMessages.MAGIC
                && (p[1] == (byte) UtpMessages.T_COMMIT || p[1] == (byte) UtpMessages.T_ABORT)) {
            if (p[1] == (byte) UtpMessages.T_COMMIT) {
                onCommit(p);
            } else {
                onAbort(p);
            }
            return;
        }
        failSession(1002, "bad utp message");
    }

    private boolean absorbRange(GenerationState s, UtpMessages.ViewportUpdate v) {
        for (long y = v.minY(); y <= v.maxY(); y++) {
            for (long x = v.minX(); x <= v.maxX(); x++) {
                long key = (x << 32) | (y & 0xFFFFFFFFL);
                if (!UtpCodec.admitTileKey(s.requested, key)) {
                    return false;
                }
            }
        }
        if (v.minX() < s.loX) {
            s.loX = v.minX();
        }
        if (v.maxX() > s.hiX) {
            s.hiX = v.maxX();
        }
        if (v.minY() < s.loY) {
            s.loY = v.minY();
        }
        if (v.maxY() > s.hiY) {
            s.hiY = v.maxY();
        }
        return true;
    }

    private boolean validateImageRange(
            int imageId, int zoom, long minX, long maxX, long minY, long maxY) {
        ImageRegistry.ImageInfo info = lookup.lookup(imageId);
        if (info == null) {
            return false;
        }
        int max;
        try {
            max = PyramidTileStore.maxLevel(info.w(), info.h());
        } catch (IllegalArgumentException e) {
            return false;
        }
        if (zoom < 0 || zoom > max) {
            return false;
        }
        int cols = PyramidTileStore.cols(info.w(), info.h(), zoom);
        int rows = PyramidTileStore.rows(info.w(), info.h(), zoom);
        return minX < cols && maxX < cols && minY < rows && maxY < rows;
    }

    /** Builds the complete immutable center-first work list off any staging. */
    static List<TileReq> buildWork(GenerationState s) {
        double ccx = (s.loX + s.hiX) / 2.0;
        double ccy = (s.loY + s.hiY) / 2.0;
        ArrayList<long[]> keys = new ArrayList<>(s.requested.size());
        for (long key : s.requested) {
            long x = key >>> 32;
            long y = key & 0xFFFFFFFFL;
            keys.add(new long[] {x, y});
        }
        keys.sort(Comparator.comparingDouble((long[] k) -> Math.abs(k[0] - ccx) + Math.abs(k[1] - ccy))
                .thenComparingLong(k -> k[1])
                .thenComparingLong(k -> k[0]));
        ArrayList<TileReq> work = new ArrayList<>(keys.size());
        for (long[] k : keys) {
            work.add(new TileReq(s, k[0], k[1]));
        }
        return List.copyOf(work);
    }

    /** Coalesced publish: only a null to non-null transition banks a permit. */
    void publishReady(GenerationState s) {
        GenerationState old = readySlot.getAndSet(s);
        if (old == null) {
            readyPermit.release();
        }
    }

    void purgeStale() {
        long seen = lastReqIdSeen.get();
        rejectedReqIds.removeIf(id -> id <= seen);
    }

    private void recordReject(long reqId) {
        purgeStale();
        if (rejectedReqIds.size() >= Config.REJECTED_CAP) {
            failSession(1002, "rejected overflow");
            return;
        }
        rejectedReqIds.add(reqId);
        LOG.warning("recorded rejected req=" + reqId);
    }

    // ---- closing sequences ----

    /**
     * The only way a deterministic protocol violation tears down a healthy
     * socket: cancel work, emit one Close frame, then close. Never touches
     * the closed flag (owned solely by closeSession).
     */
    public void failSession(int code, String reason) {
        GenerationState cur = active.get();
        if (cur != null) {
            cur.canceled = true;
        }
        GenerationState ready = readySlot.get();
        if (ready != null) {
            ready.canceled = true;
        }
        if (!closeSent.compareAndSet(false, true)) {
            closeSession();
            return;
        }
        try {
            writer.writeControl(WsFrame.OP_CLOSE, closePayload(code, reason));
        } catch (Exception e) {
            LOG.fine("close frame impossible: " + e.getMessage());
        }
        closeSession();
    }

    /**
     * Peer Close: cancel first (no new tile starts; the in-flight frame may
     * complete), echo by the frozen three-way rule (valid code echoes itself,
     * an invalid code echoes 1002, an empty Close echoes empty), then tear
     * down. 1005 never appears on the wire in either direction.
     */
    public void onPeerClose(OptionalInt code, byte[] reason) {
        GenerationState cur = active.get();
        if (cur != null) {
            cur.canceled = true;
        }
        if (closeSent.compareAndSet(false, true)) {
            try {
                if (code.isEmpty()) {
                    writer.writeControl(WsFrame.OP_CLOSE, new byte[0]);
                } else if (WsFrame.isValidPeerCode(code.getAsInt())) {
                    writer.writeControl(
                            WsFrame.OP_CLOSE, closePayload(code.getAsInt(), ""));
                } else {
                    writer.writeControl(WsFrame.OP_CLOSE, closePayload(1002, "bad close code"));
                }
            } catch (Exception e) {
                LOG.fine("close echo impossible: " + e.getMessage());
            }
        }
        closeSession();
    }

    /** Sole owner of closed: socket close plus dispatcher wake, exactly once. */
    public void closeSession() {
        if (closed.compareAndSet(false, true)) {
            try {
                socketToClose.close();
            } catch (Exception ignored) {
            }
            FileChannel tc = currentTile.getAndSet(null);
            if (tc != null) {
                try {
                    tc.close();
                } catch (Exception ignored) {
                }
            }
            readyPermit.release();
        }
    }

    static byte[] closePayload(int code, String reason) {
        byte[] rb = reason == null ? new byte[0] : reason.getBytes(StandardCharsets.UTF_8);
        int cut = Math.min(rb.length, CLOSE_REASON_MAX);
        while (cut > 0 && (rb[cut - 1] & 0xC0) == 0x80) {
            cut--;
        }
        if (cut > 0 && cut < rb.length) {
            int lead = rb[cut - 1] & 0xFF;
            int need;
            if ((lead & 0x80) == 0) {
                need = 1;
            } else if ((lead & 0xE0) == 0xC0) {
                need = 2;
            } else if ((lead & 0xF0) == 0xE0) {
                need = 3;
            } else {
                need = 4;
            }
            int have = 0;
            for (int i = cut - 1; i >= 0 && (rb[i] & 0xC0) == 0x80; i--) {
                have++;
            }
            have++;
            if (have < need) {
                cut -= have;
                while (cut > 0 && (rb[cut - 1] & 0xC0) == 0x80) {
                    cut--;
                }
            }
        }
        byte[] out = new byte[2 + cut];
        out[0] = (byte) (code >> 8);
        out[1] = (byte) code;
        System.arraycopy(rb, 0, out, 2, cut);
        return out;
    }

    // ---- threads ----

    public void start() {
        readerThread = Thread.ofVirtual().start(this::readerLoop);
        dispatcherThread = Thread.ofVirtual().start(this::dispatcherLoop);
    }

    public void joinThreads(long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        Thread r = readerThread;
        Thread d = dispatcherThread;
        if (r != null) {
            r.join(Math.max(1, deadline - System.currentTimeMillis()));
        }
        if (d != null) {
            d.join(Math.max(1, deadline - System.currentTimeMillis()));
        }
    }

    public boolean threadsAlive() {
        Thread r = readerThread;
        Thread d = dispatcherThread;
        return (r != null && r.isAlive()) || (d != null && d.isAlive());
    }

    private void readerLoop() {
        try {
            for (;;) {
                if (closed.get()) {
                    return;
                }
                WsFrame.Event ev;
                try {
                    ev = nextEvent();
                } catch (WsFrame.WsProtocolException e) {
                    failSession(e.closeCode, e.getMessage());
                    return;
                } catch (IOException e) {
                    closeSession();
                    return;
                }
                if (ev == null) {
                    continue;
                }
                handleEvent(ev);
                if (closed.get() || closeSent.get()) {
                    return;
                }
            }
        } catch (RuntimeException e) {
            LOG.fine("reader failed: " + e.getMessage());
            closeSession();
        }
    }

    private WsFrame.Event nextEvent() throws IOException, WsFrame.WsProtocolException {
        WsFrame.Header h = WsFrame.readFrameHeader(in);
        int op = h.opcode();
        if (op == WsFrame.OP_BIN || op == WsFrame.OP_TEXT || op == WsFrame.OP_CONT) {
            if (assembler.pendingBytes() + h.payloadLen() > WsFrame.INBOUND_CAP) {
                throw new WsFrame.WsProtocolException(1009, "message over cap");
            }
        }
        byte[] payload = WsFrame.readFramePayload(in, h);
        return assembler.accept(h, payload);
    }

    private void readerFatal(IOException e) {
        LOG.fine("reader fatal: " + e.getMessage());
        try {
            socketToClose.close();
        } catch (Exception ignored) {
        }
        closeSession();
    }

    private void dispatcherLoop() {
        try {
            for (;;) {
                readyPermit.acquire();
                if (closed.get()) {
                    return;
                }
                GenerationState s = readySlot.getAndSet(null);
                if (s == null) {
                    continue;
                }
                dispatchState(s);
                if (closed.get() || closeSent.get()) {
                    return;
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    void dispatchState(GenerationState s) {
        List<TileReq> work = s.work;
        if (work == null) {
            return;
        }
        int nextIndex = 0;
        int sent = 0;
        int skipped = 0;
        for (; nextIndex < work.size(); nextIndex++) {
            if (closed.get() || closeSent.get()) {
                return;
            }
            TileReq t = work.get(nextIndex);
            if (!(s.sealed && !s.canceled && active.get() == s)) {
                skipped++;
                continue;
            }
            FileChannel ch;
            try {
                ch = opener.openTile(s.imageId, s.zoom, t.x(), t.y());
            } catch (Exception e) {
                skipped++;
                continue;
            }
            long size;
            try {
                size = ch.size();
            } catch (IOException e) {
                skipped++;
                continue;
            }
            if (size <= 0 || size > Config.MAX_TILE_BYTES) {
                skipped++;
                continue;
            }
            UtpMessages.TileHeader header = new UtpMessages.TileHeader(
                    s.imageId, s.zoom, UtpMessages.FORMAT_JPEG,
                    PyramidTileStore.TILE, s.reqId, t.x(), t.y(), size);
            currentTile.set(ch);
            WsWriter.TileOutcome outcome;
            try {
                outcome = writer.transferTileIf(header, ch, size, this, s);
            } catch (IOException e) {
                dispatcherFatal(e);
                return;
            } finally {
                currentTile.compareAndSet(ch, null);
            }
            if (outcome == WsWriter.TileOutcome.STARTED) {
                sent++;
            } else if (outcome == WsWriter.TileOutcome.SKIPPED) {
                skipped++;
            } else {
                return;
            }
        }
        s.sent = sent;
        s.skipped = skipped;
        boolean ended;
        try {
            ended = writer.writeEndIf(this, s, nextIndex, sent, skipped);
        } catch (IOException e) {
            dispatcherFatal(e);
            return;
        }
        if (ended) {
            active.compareAndSet(s, null);
        }
    }

    private void dispatcherFatal(IOException e) {
        LOG.fine("dispatcher fatal: " + e.getMessage());
        try {
            socketToClose.close();
        } catch (Exception ignored) {
        }
        closeSession();
    }
}
