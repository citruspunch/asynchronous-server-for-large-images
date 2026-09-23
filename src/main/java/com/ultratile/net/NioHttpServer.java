package com.ultratile.net;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;
import java.util.regex.Pattern;

import com.ultratile.tiles.ImageRegistry;
import com.ultratile.tiles.PyramidTileStore;
import com.ultratile.ws.SessionCoordinator;
import com.ultratile.ws.WsHandshake;

/**
 * Strict lexical HTTP server plus live metadata.
 *
 * <p>Transport lives here plus {@code ws/} only: a mandated async transport
 * swaps these files, not the protocol layers above them.
 */
public final class NioHttpServer implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(NioHttpServer.class.getName());

    private static final int HEAD_CAP = 16 * 1024;

    private static final Pattern TOKEN = Pattern.compile("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$");
    private static final Pattern CL_STRICT = Pattern.compile("^[0-9]+$");
    private static final Pattern CANON_ID = Pattern.compile("^[0-9]+$");
    private static final Pattern HOST_OK =
            Pattern.compile("^[A-Za-z0-9.\\-_\\[\\]:]+$");

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
        try {
            ImageRegistry.ensureStartup(Path.of("data", "images"));
        } catch (Exception e) {
            LOG.warning("demo ensure failed: " + e.getMessage());
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
        boolean[] owned = {false};
        try {
            ch.configureBlocking(true);
            try {
                ch.socket().setSoTimeout(5000);
            } catch (IOException ignored) {
            }
            InputStream in = ch.socket().getInputStream();
            byte[] head = readHead(in, ch);
            if (head == null) {
                return;
            }
            if (head.length == 0) {
                // Bare-LF marker from readHead.
                sendSimple(ch, 400, "Bad Request", "text/plain",
                        "bad request".getBytes(StandardCharsets.UTF_8));
                return;
            }
            owned[0] = false;
            dispatch(ch, head, in, owned);
        } catch (Exception e) {
            LOG.fine("handle failed: " + e.getMessage());
        } finally {
            if (!owned[0]) {
                try {
                    ch.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /**
     * Reads bytes through CRLF CRLF. Returns null on EOF/timeout (close
     * silently), empty array on bare-LF (caller sends 400), else head bytes
     * including the terminator.
     */
    private byte[] readHead(InputStream in, SocketChannel c) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int prev = -1;
        int total = 0;
        byte[] last4 = new byte[4];
        int n4 = 0;
        while (true) {
            int b;
            try {
                b = in.read();
            } catch (java.net.SocketTimeoutException e) {
                return null;
            }
            if (b < 0) {
                return null;
            }
            if (b == '\n' && prev != '\r') {
                return new byte[0];
            }
            prev = b;
            buf.write(b);
            total++;
            if (total > HEAD_CAP) {
                byte[] tooLarge = buf.toByteArray();
                // Respond 431 then close.
                try {
                    sendSimple(c, 431, "Request Header Fields Too Large", "text/plain",
                            "head too large".getBytes(StandardCharsets.UTF_8));
                } catch (IOException ignored) {
                }
                try {
                    c.close();
                } catch (IOException ignored) {
                }
                return null;
            }
            if (n4 < 4) {
                last4[n4++] = (byte) b;
            } else {
                last4[0] = last4[1];
                last4[1] = last4[2];
                last4[2] = last4[3];
                last4[3] = (byte) b;
            }
            if (n4 == 4 && last4[0] == '\r' && last4[1] == '\n'
                    && last4[2] == '\r' && last4[3] == '\n') {
                break;
            }
        }
        return buf.toByteArray();
    }

    /**
     * Routes one request. Sets owned[0] when a WS session takes ownership of
     * the socket (caller must not close it).
     */
    private void dispatch(SocketChannel c, byte[] head, InputStream in, boolean[] owned)
            throws IOException {
        String hs = new String(head, StandardCharsets.ISO_8859_1);
        if (!hs.endsWith("\r\n\r\n")) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad request".getBytes(StandardCharsets.UTF_8));
            return;
        }
        String inner = hs.substring(0, hs.length() - 4);
        // Any line not CRLF-terminated inside the head is a 400.
        // After stripping the terminator, no bare CR or LF may remain
        // outside CRLF pairs; splitting must round-trip.
        String[] lines = inner.split("\r\n", -1);
        for (String ln : lines) {
            if (ln.indexOf('\r') >= 0 || ln.indexOf('\n') >= 0) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "bad request".getBytes(StandardCharsets.UTF_8));
                return;
            }
        }
        if (lines.length == 0) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad request".getBytes(StandardCharsets.UTF_8));
            return;
        }
        ParsedRequest req = parseRequestLine(lines[0]);
        if (req == null) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad request".getBytes(StandardCharsets.UTF_8));
            return;
        }
        Map<String, List<String>> headers = parseHeaders(lines, 1);
        if (headers == null) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad request".getBytes(StandardCharsets.UTF_8));
            return;
        }
        List<String> hosts = headers.get("host");
        if (hosts == null || hosts.size() != 1) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad host".getBytes(StandardCharsets.UTF_8));
            return;
        }
        String host = hosts.get(0);
        if (host.isEmpty() || !HOST_OK.matcher(host).matches()) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad host".getBytes(StandardCharsets.UTF_8));
            return;
        }
        // Global body-framing gate BEFORE the method gate.
        if (headers.containsKey("transfer-encoding")) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "body framing".getBytes(StandardCharsets.UTF_8));
            return;
        }
        List<String> cls = headers.get("content-length");
        if (cls != null) {
            if (cls.size() != 1) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "body framing".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String v = cls.get(0);
            if (!CL_STRICT.matcher(v).matches()) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "body framing".getBytes(StandardCharsets.UTF_8));
                return;
            }
            long n;
            try {
                n = Long.parseLong(v);
            } catch (NumberFormatException e) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "body framing".getBytes(StandardCharsets.UTF_8));
                return;
            }
            if (n != 0) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "body framing".getBytes(StandardCharsets.UTF_8));
                return;
            }
        }
        // Method gate: every syntactically-valid non-GET token maps to 405.
        // Intentional subset decision (RFC 9110 would use 501 for unknown).
        if (!"GET".equals(req.method)) {
            sendMethodNotAllowed(c);
            return;
        }
        // Absolute-form profile.
        String path = req.target;
        if (path.indexOf('#') >= 0) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad target".getBytes(StandardCharsets.UTF_8));
            return;
        }
        int schemeIdx = path.indexOf("://");
        if (schemeIdx >= 0) {
            int colon = path.indexOf(':');
            String scheme = colon >= 0 ? path.substring(0, colon) : "";
            if (!"http".equals(scheme)) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "bad scheme".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String rest = path.substring(schemeIdx + 3);
            String authority;
            String apath;
            int slash = rest.indexOf('/');
            if (slash < 0) {
                int q = rest.indexOf('?');
                if (q >= 0) {
                    authority = rest.substring(0, q);
                    apath = "/";
                } else {
                    authority = rest;
                    apath = "/";
                }
            } else {
                authority = rest.substring(0, slash);
                apath = rest.substring(slash);
            }
            if (authority.isEmpty() || authority.indexOf('@') >= 0) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "bad authority".getBytes(StandardCharsets.UTF_8));
                return;
            }
            if (!validAuthority(authority)) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "bad authority".getBytes(StandardCharsets.UTF_8));
                return;
            }
            if (!authority.equalsIgnoreCase(host)) {
                sendSimple(c, 400, "Bad Request", "text/plain",
                        "authority mismatch".getBytes(StandardCharsets.UTF_8));
                return;
            }
            path = apath;
        }
        int qm = path.indexOf('?');
        if (qm >= 0) {
            path = path.substring(0, qm);
        }
        if (path.isEmpty()) {
            sendSimple(c, 400, "Bad Request", "text/plain",
                    "bad target".getBytes(StandardCharsets.UTF_8));
            return;
        }
        route(c, path, headers, host, in, owned);
    }

    private static final class ParsedRequest {
        final String method;
        final String target;
        ParsedRequest(String m, String t) {
            method = m;
            target = t;
        }
    }

    private ParsedRequest parseRequestLine(String line) {
        if (line.startsWith(" ") || line.endsWith(" ")) {
            return null;
        }
        if (line.contains("  ")) {
            return null;
        }
        String[] parts = line.split(" ", -1);
        if (parts.length != 3) {
            return null;
        }
        String method = parts[0];
        String target = parts[1];
        String version = parts[2];
        if (method.isEmpty() || target.isEmpty()) {
            return null;
        }
        if (!TOKEN.matcher(method).matches()) {
            return null;
        }
        if (!"HTTP/1.1".equals(version)) {
            return null;
        }
        return new ParsedRequest(method, target);
    }

    private Map<String, List<String>> parseHeaders(String[] lines, int from) {
        Map<String, List<String>> map = new LinkedHashMap<>();
        for (int i = from; i < lines.length; i++) {
            String ln = lines[i];
            if (ln.isEmpty()) {
                return null;
            }
            char c0 = ln.charAt(0);
            if (c0 == ' ' || c0 == '\t') {
                return null;
            }
            int colon = ln.indexOf(':');
            if (colon <= 0) {
                return null;
            }
            char before = ln.charAt(colon - 1);
            if (before == ' ' || before == '\t') {
                return null;
            }
            String name = ln.substring(0, colon);
            String rawVal = ln.substring(colon + 1);
            if (!TOKEN.matcher(name).matches()) {
                return null;
            }
            String val = trimOws(rawVal);
            if (!cleanField(name) || !cleanField(rawVal)) {
                return null;
            }
            String lower = name.toLowerCase(java.util.Locale.ROOT);
            map.computeIfAbsent(lower, k -> new ArrayList<>()).add(val);
        }
        return map;
    }

    private static String trimOws(String s) {
        int a = 0;
        int b = s.length();
        while (a < b && (s.charAt(a) == ' ' || s.charAt(a) == '\t')) {
            a++;
        }
        while (b > a && (s.charAt(b - 1) == ' ' || s.charAt(b - 1) == '\t')) {
            b--;
        }
        return s.substring(a, b);
    }

    /** Rejects NUL and CTLs other than HTAB (SP is not a CTL). */
    private static boolean cleanField(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == 0) {
                return false;
            }
            if (c < 0x20 && c != '\t') {
                return false;
            }
            if (c == 0x7F) {
                return false;
            }
        }
        return true;
    }

    private static boolean validAuthority(String a) {
        if (a.isEmpty() || a.indexOf('/') >= 0 || a.indexOf('?') >= 0
                || a.indexOf('#') >= 0 || a.indexOf('@') >= 0
                || a.indexOf(' ') >= 0) {
            return false;
        }
        if (a.startsWith("[")) {
            int close = a.indexOf(']');
            if (close < 0) {
                return false;
            }
            String after = a.substring(close + 1);
            if (!after.isEmpty()) {
                if (!after.startsWith(":") || after.length() == 1) {
                    return false;
                }
                if (!after.substring(1).matches("^[0-9]+$")) {
                    return false;
                }
            }
            return true;
        }
        int colon = a.lastIndexOf(':');
        if (colon >= 0) {
            String hostPart = a.substring(0, colon);
            String portPart = a.substring(colon + 1);
            if (hostPart.isEmpty() || !portPart.matches("^[0-9]+$")) {
                return false;
            }
        }
        return HOST_OK.matcher(a).matches();
    }

    private void route(
            SocketChannel c,
            String path,
            Map<String, List<String>> headers,
            String host,
            InputStream in,
            boolean[] owned)
            throws IOException {
        LOG.fine("GET " + path);
        if (path.contains("..")) {
            sendSimple(c, 404, "Not Found", "text/plain",
                    "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        switch (path) {
            case "/" -> sendWeb(c, "index.html", "text/html; charset=utf-8", true);
            case "/styles.css" -> sendWeb(c, "styles.css",
                    "text/css; charset=utf-8", true);
            case "/healthz" -> sendHealth(c);
            case "/api/images" -> sendImages(c);
            case "/ws" -> {
                if (handshakeWs(c, headers, host, in)) {
                    owned[0] = true;
                }
            }
            default -> {
                if (path.startsWith("/js/") && path.endsWith(".js")) {
                    sendWeb(c, path.substring(1),
                            "application/javascript; charset=utf-8", true);
                } else if (path.startsWith("/api/images/") && path.endsWith("/info")) {
                    sendInfo(c, path);
                } else {
                    sendSimple(c, 404, "Not Found", "text/plain",
                            "not found".getBytes(StandardCharsets.UTF_8));
                }
            }
        }
    }

    /**
     * WS opening handshake. GET, lexical head, Host, and the body gate were
     * already enforced by dispatch. Returns true on 101 (session owns the
     * socket afterwards). Post-header bytes are never over-read (the head
     * reader stops exactly at CRLF CRLF), so the session continues on the
     * same stream.
     */
    private boolean handshakeWs(
            SocketChannel c,
            Map<String, List<String>> headers,
            String host,
            InputStream in)
            throws IOException {
        WsHandshake.Result result = WsHandshake.evaluate(headers, host);
        if (result instanceof WsHandshake.Result.Err err) {
            StringBuilder head = new StringBuilder("HTTP/1.1 ")
                    .append(err.failure().status())
                    .append(' ')
                    .append(err.failure().status() == 403 ? "Forbidden" : "Bad Request")
                    .append("\r\nContent-Type: text/plain\r\n");
            for (Map.Entry<String, String> e : err.failure().headers().entrySet()) {
                head.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            byte[] body = err.failure().message().getBytes(StandardCharsets.UTF_8);
            head.append("Content-Length: ").append(body.length).append("\r\n")
                    .append("Connection: close\r\n\r\n");
            writeFully(c, head.toString().getBytes(StandardCharsets.US_ASCII));
            writeFully(c, body);
            return false;
        }
        WsHandshake.Result.Ok ok = (WsHandshake.Result.Ok) result;
        String key = headers.get("sec-websocket-key").get(0).trim();
        String accept = WsHandshake.acceptFor(key);
        String head = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n"
                + "Sec-WebSocket-Protocol: ultratile.utp.v1\r\n"
                + "\r\n";
        writeFully(c, head.getBytes(StandardCharsets.US_ASCII));
        LOG.fine("ws upgrade 101");
        try {
            c.socket().setSoTimeout(0);
        } catch (IOException ignored) {
        }
        SessionCoordinator session = new SessionCoordinator(
                in,
                c,
                c,
                SessionCoordinator.defaultOpener(),
                SessionCoordinator.defaultLookup());
        session.start();
        return true;
    }

    private void sendHealth(SocketChannel c) throws IOException {
        ImageRegistry reg = new ImageRegistry();
        boolean ok = reg.get(0) != null && reg.get(1) != null;
        if (!ok) {
            sendSimple(c, 503, "Service Unavailable", "text/plain",
                    "not ready".getBytes(StandardCharsets.UTF_8), "no-store");
            return;
        }
        sendSimple(c, 200, "OK", "text/plain",
                "OK".getBytes(StandardCharsets.UTF_8), "no-store");
    }

    private void sendImages(SocketChannel c) throws IOException {
        ImageRegistry reg = new ImageRegistry();
        List<ImageRegistry.ImageInfo> list = reg.list();
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            ImageRegistry.ImageInfo e = list.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append("{\"id\":").append(e.id())
                    .append(",\"name\":\"").append(jsonEscape(e.name())).append('"')
                    .append(",\"w\":").append(e.w())
                    .append(",\"h\":").append(e.h())
                    .append(",\"levels\":").append(e.levels())
                    .append('}');
        }
        sb.append(']');
        sendSimple(c, 200, "OK", "application/json",
                sb.toString().getBytes(StandardCharsets.UTF_8), "no-store");
    }

    private void sendInfo(SocketChannel c, String path) throws IOException {
        String prefix = "/api/images/";
        String suffix = "/info";
        String idStr = path.substring(prefix.length(), path.length() - suffix.length());
        if (!isCanonicalId(idStr)) {
            sendSimple(c, 404, "Not Found", "text/plain",
                    "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        int id = Integer.parseInt(idStr);
        ImageRegistry reg = new ImageRegistry();
        ImageRegistry.ImageInfo e = reg.get(id);
        if (e == null) {
            sendSimple(c, 404, "Not Found", "text/plain",
                    "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"id\":").append(e.id())
                .append(",\"name\":\"").append(jsonEscape(e.name())).append('"')
                .append(",\"w\":").append(e.w())
                .append(",\"h\":").append(e.h())
                .append(",\"levels\":").append(e.levels())
                .append(",\"tile\":").append(PyramidTileStore.TILE)
                .append(",\"levelsDetail\":[");
        int n = PyramidTileStore.maxLevel(e.w(), e.h());
        for (int z = 0; z <= n; z++) {
            if (z > 0) {
                sb.append(',');
            }
            int lw = PyramidTileStore.levelW(e.w(), e.h(), z);
            int lh = PyramidTileStore.levelH(e.w(), e.h(), z);
            int cols = PyramidTileStore.cols(e.w(), e.h(), z);
            int rows = PyramidTileStore.rows(e.w(), e.h(), z);
            sb.append("{\"z\":").append(z)
                    .append(",\"w\":").append(lw)
                    .append(",\"h\":").append(lh)
                    .append(",\"cols\":").append(cols)
                    .append(",\"rows\":").append(rows)
                    .append('}');
        }
        sb.append("]}");
        sendSimple(c, 200, "OK", "application/json",
                sb.toString().getBytes(StandardCharsets.UTF_8), "no-store");
    }

    static boolean isCanonicalId(String s) {
        if (s == null || !CANON_ID.matcher(s).matches()) {
            return false;
        }
        int v;
        try {
            v = Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return false;
        }
        if (v < 0 || v > 65535) {
            return false;
        }
        return s.equals(Integer.toString(v));
    }

    /**
     * One shared JSON string escaper: quotes/backslash/CTL become backslash-u
     * hex escapes; DEL stays literal; non-ASCII passes through as UTF-8.
     */
    static String jsonEscape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') {
                sb.append("\\\"");
            } else if (c == '\\') {
                sb.append("\\\\");
            } else if (c < 0x20) {
                sb.append(String.format("\\u%04x", (int) c));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private void sendWeb(SocketChannel c, String name, String mime, boolean cacheable)
            throws IOException {
        byte[] body = loadWeb(name);
        if (body == null) {
            sendSimple(c, 404, "Not Found", "text/plain",
                    "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        String cache = cacheable ? "public, max-age=3600" : "no-store";
        sendSimple(c, 200, "OK", mime, body, cache);
    }

    private byte[] loadWeb(String name) {
        try (InputStream in = NioHttpServer.class.getResourceAsStream("/web/" + name)) {
            if (in != null) {
                return in.readAllBytes();
            }
        } catch (IOException ignored) {
        }
        // Filesystem fallback for direct class-dir runs.
        for (Path p : new Path[]{
                Path.of("src/main/resources/web", name),
                Path.of("target/classes/web", name)}) {
            try {
                if (java.nio.file.Files.isRegularFile(p)) {
                    return java.nio.file.Files.readAllBytes(p);
                }
            } catch (IOException ignored) {
            }
        }
        return null;
    }

    private void sendMethodNotAllowed(SocketChannel c) throws IOException {
        byte[] body = "method not allowed".getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 405 Method Not Allowed\r\n"
                + "Content-Type: text/plain\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Allow: GET\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        writeFully(c, head.getBytes(StandardCharsets.US_ASCII));
        writeFully(c, body);
    }

    private void sendSimple(SocketChannel c, int code, String reason, String mime, byte[] body)
            throws IOException {
        sendSimple(c, code, reason, mime, body, "no-store");
    }

    private void sendSimple(SocketChannel c, int code, String reason, String mime,
            byte[] body, String cache) throws IOException {
        String head = "HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: " + mime + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: " + cache + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        writeFully(c, head.getBytes(StandardCharsets.US_ASCII));
        writeFully(c, body);
    }

    /** Serialized writer loop: no data frame starts after a Close. */
    static void writeFully(SocketChannel c, byte[] data) throws IOException {
        ByteBuffer buf = ByteBuffer.wrap(data);
        while (buf.hasRemaining()) {
            int n = c.write(buf);
            if (n < 0) {
                throw new IOException("closed during write");
            }
            if (n == 0) {
                Thread.yield();
            }
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
