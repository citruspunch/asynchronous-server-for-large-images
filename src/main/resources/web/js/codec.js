/* UltraTile offline viewer: codec (5/10).
 * Wire codec: exact big-endian layouts, validated parses. The sender and the
 * onmessage path MUST both go through these functions (no second hand-rolled
 * encoder in the send path).
 */

// ---- wire codec: exact big-endian layouts, validated parses ----
function encodeViewport(f) {
  const buf = new ArrayBuffer(28);
  const v = new DataView(buf);
  v.setUint8(0, MAGIC);
  v.setUint8(1, T_CHUNK);
  v.setUint16(2, f.imageId);
  v.setUint8(4, f.zoom);
  v.setUint8(5, f.lodMode);
  v.setUint16(6, f.tileSize);
  v.setUint32(8, f.reqId);
  v.setUint32(12, f.minX);
  v.setUint32(16, f.maxX);
  v.setUint32(20, f.minY);
  v.setUint32(24, f.maxY);
  return buf;
}

function encodeCommit(imageId, reqId) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint8(0, MAGIC);
  v.setUint8(1, T_COMMIT);
  v.setUint16(2, imageId);
  v.setUint32(4, reqId);
  return buf;
}

function encodeAbort(imageId, reqId) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint8(0, MAGIC);
  v.setUint8(1, T_ABORT);
  v.setUint16(2, imageId);
  v.setUint32(4, reqId);
  return buf;
}

function tileFrameFatal(reason) {
  tileLenMismatch += 1;
  protocolFatal(reason);
  throw new Error(reason);
}

function parseTileHeader(buffer) {
  if (!buffer || typeof buffer.byteLength !== "number" || buffer.byteLength < 24) {
    tileFrameFatal("short tile");
  }
  const v = new DataView(buffer);
  const magic = v.getUint8(0);
  const type = v.getUint8(1);
  const tileSize = v.getUint16(6);
  const payloadLen = v.getUint32(20);
  if (buffer.byteLength !== 24 + payloadLen) {
    tileFrameFatal("tile length mismatch");
  }
  if (magic !== MAGIC || type !== T_TILE || tileSize !== TILE) {
    tileFrameFatal("bad tile header");
  }
  if (payloadLen < 1 || payloadLen > MAX_TILE_BYTES) {
    tileFrameFatal("bad payload length");
  }
  return {
    imageId: v.getUint16(2),
    zoom: v.getUint8(4),
    format: v.getUint8(5),
    tileSize,
    reqId: v.getUint32(8),
    tileX: v.getUint32(12),
    tileY: v.getUint32(16),
    payloadLen
  };
}

function parseEnd(buffer) {
  if (!buffer || typeof buffer.byteLength !== "number" || buffer.byteLength !== 16) {
    endIdentityFatal += 1;
    protocolFatal("bad end");
    throw new Error("bad end");
  }
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MAGIC || v.getUint8(1) !== T_END) {
    endIdentityFatal += 1;
    protocolFatal("bad end");
    throw new Error("bad end");
  }
  return {
    imageId: v.getUint16(2),
    reqId: v.getUint32(4),
    sent: v.getUint32(8),
    skipped: v.getUint32(12)
  };
}
