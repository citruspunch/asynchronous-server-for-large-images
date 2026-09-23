package com.ultratile.net;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;

/**
 * Strict lexical HTTP server (stub in phase 01: accepts and closes).
 *
 * <p>Transport lives here plus {@code ws/} only: a mandated async transport
 * swaps these files, not the protocol layers above them.
 */
public final class NioHttpServer implements AutoCloseable {

    private final String bind;
    private final int port;

    private volatile ServerSocketChannel serverChannel;
    private volatile Thread acceptThread;
    private volatile boolean started;

    public NioHttpServer(String bind, int port) {
        if (bind == null || bind.isEmpty()) {
            throw new IllegalArgumentException("bind must be non-empty");
        }
        this.bind = bind;
        this.port = port;
    }

    /** Binds {@code bind:port} and starts the accept loop. */
    public synchronized void start() throws IOException {
        if (started) {
            throw new IllegalStateException("already started");
        }
        ServerSocketChannel sc = ServerSocketChannel.open();
        sc.configureBlocking(true);
        sc.bind(new InetSocketAddress(bind, port));
        this.serverChannel = sc;
        this.started = true;
        Thread t = Thread.ofVirtual().start(this::acceptLoop);
        this.acceptThread = t;
    }

    private void acceptLoop() {
        ServerSocketChannel sc = serverChannel;
        while (sc != null && sc.isOpen()) {
            try {
                SocketChannel ch = sc.accept();
                if (ch == null) {
                    continue;
                }
                Thread.ofVirtual().start(() -> handle(ch));
            } catch (ClosedChannelException e) {
                // NORMAL shutdown: close() closed the ServerSocketChannel,
                // the blocked accept() terminates (AsynchronousCloseException
                // subclasses this). Never logged as an error.
                break;
            } catch (IOException e) {
                ServerSocketChannel cur = serverChannel;
                if (cur == null || !cur.isOpen()) {
                    break;
                }
                // Transient accept failure; loop again.
            }
        }
    }

    private void handle(SocketChannel ch) {
        try (SocketChannel c = ch) {
            // Stub: strict lexical logic arrives in phase 04, WS branch in phase 05.
        } catch (IOException ignored) {
        }
    }

    /**
     * Returns the local socket address the server is bound to.
     */
    public InetSocketAddress getBindAddress() throws IOException {
        ServerSocketChannel sc = serverChannel;
        if (sc == null) {
            throw new IllegalStateException("not started");
        }
        return (InetSocketAddress) sc.getLocalAddress();
    }

    /** Test-visible: whether the accept thread is still alive. */
    public boolean isAcceptAlive() {
        Thread t = acceptThread;
        return t != null && t.isAlive();
    }

    @Override
    public synchronized void close() throws IOException {
        ServerSocketChannel sc = serverChannel;
        if (sc != null && sc.isOpen()) {
            try {
                sc.close();
            } catch (IOException e) {
                // Best effort; still join below.
            }
        }
        Thread t = acceptThread;
        if (t != null) {
            try {
                t.join(5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
