package com.ultratile.ws;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.WritableByteChannel;
import java.util.concurrent.locks.ReentrantLock;

import com.ultratile.proto.UtpCodec;
import com.ultratile.proto.UtpMessages;

/**
 * One serialized writer per WS session on a {@link ReentrantLock}. The lock
 * makes the Close-vs-data admission check and the first byte one critical
 * section: no data frame starts after a Close and no Close interleaves a
 * frame. Pure byte pump otherwise: it reads (never mutates) generation state
 * only for the admission predicate.
 */
public class WsWriter {

    /** Tile dispatch verdict from the lock-admission check. */
    public enum TileOutcome {
        STARTED,
        SKIPPED,
        SHUTDOWN
    }

    private final ReentrantLock writeLock = new ReentrantLock();
    private final WritableByteChannel out;

    public WsWriter(WritableByteChannel out) {
        if (out == null) {
            throw new IllegalArgumentException("out must not be null");
        }
        this.out = out;
    }

    /** Test/latch hook for the Close-vs-data ordering vectors. */
    public ReentrantLock writeLock() {
        return writeLock;
    }

    /** Primitive: loop until the buffer drains (partial writes are normal). */
    public void writeFully(ByteBuffer src) throws IOException {
        while (src.hasRemaining()) {
            int n = out.write(src);
            if (n < 0) {
                throw new IOException("channel closed during write");
            }
            if (n == 0) {
                Thread.yield();
            }
        }
    }

    /** Unmasked server binary frame with minimal-length encoding. */
    public void writeBinary(byte[] payload) throws IOException {
        writeLock.lock();
        try {
            writeFrame(WsFrame.OP_BIN, payload);
        } finally {
            writeLock.unlock();
        }
    }

    /** Unmasked server control frame (payload room capped at 125). */
    public void writeControl(int opcode, byte[] payload) throws IOException {
        if (payload.length > 125) {
            throw new IllegalArgumentException("control payload over 125");
        }
        writeLock.lock();
        try {
            writeFrame(opcode, payload);
        } finally {
            writeLock.unlock();
        }
    }

    private void writeFrame(int opcode, byte[] payload) throws IOException {
        writeFrameHeader(opcode, payload.length);
        if (payload.length > 0) {
            writeFully(ByteBuffer.wrap(payload));
        }
    }

    private void writeFrameHeader(int opcode, long len) throws IOException {
        ByteBuffer h;
        if (len <= 125) {
            h = ByteBuffer.allocate(2);
            h.put((byte) (0x80 | opcode));
            h.put((byte) len);
        } else if (len <= 65535) {
            h = ByteBuffer.allocate(4);
            h.put((byte) (0x80 | opcode));
            h.put((byte) 126);
            h.putShort((short) len);
        } else {
            h = ByteBuffer.allocate(10);
            h.put((byte) (0x80 | opcode));
            h.put((byte) 127);
            h.putLong(len);
        }
        h.flip();
        writeFully(h);
    }

    /**
     * Authoritative per-tile admission plus zero-copy pump. Declares a WS
     * payload of 24 UTP header bytes plus the file size, emits the 24B UTP
     * header, then loops {@code transferTo} over an explicit offset with a
     * bounded zero-progress positional fallback ({@code transferTo} never
     * moves the channel position, so a plain positional-oblivious read would
     * resend from the stale offset). EOF before the advertised length is
     * fatal. Never closes the tile channel: lifecycle is teardown-only.
     */
    public TileOutcome transferTileIf(
            UtpMessages.TileHeader header,
            FileChannel src,
            long size,
            SessionCoordinator coord,
            SessionCoordinator.GenerationState state)
            throws IOException {
        byte[] utp = UtpCodec.encodeTileHeader(header);
        long total = (long) utp.length + size;
        writeLock.lock();
        try {
            if (coord.closeSent.get() || coord.closed.get()) {
                return TileOutcome.SHUTDOWN;
            }
            if (state.canceled || coord.active.get() != state) {
                return TileOutcome.SKIPPED;
            }
            writeFrameHeader(WsFrame.OP_BIN, total);
            writeFully(ByteBuffer.wrap(utp));
            long transferred = 0;
            int zeroStreak = 0;
            while (transferred < size) {
                long n = src.transferTo(transferred, size - transferred, out);
                if (n < 0) {
                    throw new IOException("tile channel EOF");
                }
                if (n > 0) {
                    transferred += n;
                    zeroStreak = 0;
                    continue;
                }
                zeroStreak++;
                if (zeroStreak <= 3) {
                    continue;
                }
                ByteBuffer dst = ByteBuffer.allocate(64 * 1024);
                while (transferred < size) {
                    dst.clear();
                    int want = (int) Math.min(dst.capacity(), size - transferred);
                    dst.limit(want);
                    int r = src.read(dst, transferred);
                    if (r < 0) {
                        throw new IOException("tile channel EOF before advertised length");
                    }
                    if (r == 0) {
                        Thread.yield();
                        continue;
                    }
                    dst.flip();
                    writeFully(dst);
                    transferred += r;
                }
            }
            return TileOutcome.STARTED;
        } finally {
            writeLock.unlock();
        }
    }

    /**
     * Authoritative END admission: emits {@code 0x04} only if the full END
     * rule still holds under the lock.
     */
    public boolean writeEndIf(
            SessionCoordinator coord,
            SessionCoordinator.GenerationState state,
            int nextIndex,
            long sent,
            long skipped)
            throws IOException {
        writeLock.lock();
        try {
            if (coord.closeSent.get() || coord.closed.get()) {
                return false;
            }
            if (!state.sealed || state.canceled || coord.active.get() != state) {
                return false;
            }
            if (state.work == null || nextIndex != state.work.size()) {
                return false;
            }
            if (state.inFlight != 0) {
                return false;
            }
            byte[] end = UtpCodec.encodeEnd(
                    new UtpMessages.GenerationEnd(state.imageId, state.reqId, sent, skipped));
            writeFrame(WsFrame.OP_BIN, end);
            return true;
        } finally {
            writeLock.unlock();
        }
    }
}
