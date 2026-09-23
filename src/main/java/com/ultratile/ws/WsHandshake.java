package com.ultratile.ws;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.ultratile.proto.UtpMessages;

/**
 * WebSocket opening-handshake validation for {@code /ws}. UltraTile requires
 * exactly one subprotocol line carrying the frozen token; that
 * exactly-one rule is a handshake-profile restriction of this server and is
 * labeled as such in every 400 it produces.
 */
public final class WsHandshake {
    private WsHandshake() {}

    static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    /** Successful validation carries the request key for the Accept derivation. */
    public record Success(String key) {}

    /** Failure carries the HTTP status plus any extra response headers. */
    public record Failure(int status, Map<String, String> headers, String message) {}

    /** Either a {@link Success} or a {@link Failure}. */
    public sealed interface Result permits Result.Ok, Result.Err {
        record Ok(Success success) implements Result {}

        record Err(Failure failure) implements Result {}
    }

    public static Result evaluate(Map<String, List<String>> headers, String host) {
        Result r;
        r = checkKey(headers);
        if (r != null) {
            return r;
        }
        r = checkVersion(headers);
        if (r != null) {
            return r;
        }
        r = checkOrigin(headers, host);
        if (r != null) {
            return r;
        }
        r = checkProtocol(headers);
        if (r != null) {
            return r;
        }
        r = checkConnection(headers);
        if (r != null) {
            return r;
        }
        return checkUpgrade(headers);
    }

    private static Result checkKey(Map<String, List<String>> headers) {
        List<String> keys = headers.getOrDefault("sec-websocket-key", List.of());
        if (keys.size() != 1) {
            return err(400, "handshake-profile: exactly one Sec-WebSocket-Key required");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(keys.get(0).trim());
        } catch (IllegalArgumentException e) {
            return err(400, "Sec-WebSocket-Key must be base64 of 16 bytes");
        }
        if (decoded.length != 16) {
            return err(400, "Sec-WebSocket-Key must decode to exactly 16 bytes");
        }
        return null;
    }

    private static Result checkVersion(Map<String, List<String>> headers) {
        List<String> vers = headers.getOrDefault("sec-websocket-version", List.of());
        if (vers.size() != 1) {
            return err(400, "exactly one Sec-WebSocket-Version required");
        }
        if (!"13".equals(vers.get(0).trim())) {
            Map<String, String> extra = new LinkedHashMap<>();
            extra.put("Sec-WebSocket-Version", "13");
            return new Result.Err(new Failure(400, extra, "unsupported version"));
        }
        return null;
    }

    private static Result checkOrigin(Map<String, List<String>> headers, String host) {
        List<String> origins = headers.getOrDefault("origin", List.of());
        if (origins.size() > 1) {
            return err(400, "at most one Origin allowed");
        }
        if (origins.size() == 1 && !sameOriginHttp(origins.get(0), host)) {
            return err(403, "origin mismatch");
        }
        return null;
    }

    private static Result checkProtocol(Map<String, List<String>> headers) {
        List<String> protos = headers.getOrDefault("sec-websocket-protocol", List.of());
        if (protos.size() != 1 || !UtpMessages.SUBPROTOCOL.equals(protos.get(0).trim())) {
            return err(400, "handshake-profile: exactly one Sec-WebSocket-Protocol line with "
                    + UtpMessages.SUBPROTOCOL);
        }
        return null;
    }

    private static Result checkConnection(Map<String, List<String>> headers) {
        ArrayList<String> tokens = new ArrayList<>();
        for (String line : headers.getOrDefault("connection", List.of())) {
            for (String part : line.split(",", -1)) {
                tokens.add(part.strip().toLowerCase(java.util.Locale.ROOT));
            }
        }
        if (!tokens.contains("upgrade")) {
            return err(400, "Connection must contain upgrade");
        }
        return null;
    }

    private static Result checkUpgrade(Map<String, List<String>> headers) {
        ArrayList<String> tokens = new ArrayList<>();
        for (String line : headers.getOrDefault("upgrade", List.of())) {
            for (String part : line.split(",", -1)) {
                String t = part.strip();
                if (!t.isEmpty()) {
                    tokens.add(t);
                }
            }
        }
        if (tokens.size() != 1 || !"websocket".equalsIgnoreCase(tokens.get(0))) {
            return err(400, "Upgrade must be exactly websocket");
        }
        return null;
    }

    /** Normalized authority comparison of an http Origin against Host. */
    public static boolean sameOriginHttp(String origin, String host) {
        if (origin == null || host == null) {
            return false;
        }
        String o = origin.strip();
        int scheme = o.indexOf("://");
        if (scheme < 0) {
            return false;
        }
        String rest = o.substring(scheme + 3);
        int slash = rest.indexOf('/');
        String authority = slash < 0 ? rest : rest.substring(0, slash);
        if (authority.isEmpty()) {
            return false;
        }
        return authority.equalsIgnoreCase(host);
    }

    /** RFC 6455 section 1.3 Accept derivation from the request key. */
    public static String acceptFor(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] hash = sha1.digest(
                    (key.trim() + GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Result err(int status, String message) {
        return new Result.Err(new Failure(status, Map.of(), message));
    }
}
