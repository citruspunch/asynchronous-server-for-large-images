/* UltraTile offline viewer: constants (1/10).
 * Shared tunables duplicate Config.java/UtpMessages.java values and are pinned
 * by scripts/check_const_parity.py (change all three together).
 * Loaded via classic <script defer> tags in load order; no imports, no
 * build step. Top-level let/const are shared across scripts through the
 * global lexical environment.
 */

// ---- shared tunables (parity-pinned against Config.java) ----
const TILE=512;
const MAX_CACHE=40;
const MAX_DECODE=6;
const DECODE_QUEUE_MAX_JOBS=24;
const DECODE_QUEUE_MAX_BYTES=4*1024*1024;
const MAX_TILE_BYTES=2097152;
const BATCH_CAP=30;
const AVG_TILE_SEED=131072;
const SCALE_MIN=1e-3;
const SCALE_MAX=32;
// ---- shared wire values (parity-pinned against UtpMessages.java) ----
const MAGIC=0xAA;
const T_CHUNK=0x01;
const T_TILE=0x02;
const T_ABORT=0x03;
const T_END=0x04;
const T_COMMIT=0x05;
const LOD_NEAREST=0;
const FORMAT_JPEG=1;
const SPAN_CAP=128;
const GEN_TILE_CAP=256;
// ---- viewer-local policy (deliberately outside the parity map) ----
const PLAN_FLOOR=65536;
const CLOSE_UTP_ERROR=4002;
const TAU=Math.PI*2;
const UNION_CAP=36;
const INTENT_DEBOUNCE_MS=80;
const REQ_ID_MAX=0xFFFFFFFE;
