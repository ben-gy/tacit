#!/usr/bin/env node
/**
 * gen-icons.mjs — the PWA / home-screen icon set from the same identity as public/favicon.svg: a lit
 * card standing on the dark stage, an ink pip on its face, a gold chevron of light above it. No
 * native deps (sharp/canvas break CI): plots pixels into an RGBA buffer and emits the PNG itself,
 * with SDF anti-aliasing. Deterministic.
 *
 *   node scripts/gen-icons.mjs
 *
 * Outputs (public/icons/): icon-192.png, icon-512.png (any-purpose, transparent corners),
 * icon-512-maskable.png (art inside the centre-80% safe zone), and apple-touch-icon.png (180x180,
 * FULLY OPAQUE — iOS composites on black).
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// palette — must match public/favicon.svg AND the app theme colour in index.html
const GROUND = [0x0b, 0x14, 0x18];
const FACE = [0xf2, 0xed, 0xe3];
const ACCENT = [0xe8, 0xb0, 0x4b];
const INK = [0x16, 0x23, 0x2a];

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing (authored in 64x64 space, sampled per pixel, AA via SDF) ─────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}
/** Signed distance to a round-capped segment — one arm of the chevron. */
function sdSegment(px, py, ax, ay, bx, by, width) {
  const ex = bx - ax;
  const ey = by - ay;
  const t = clamp01(((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey));
  return Math.hypot(px - ax - ex * t, py - ay - ey * t) - width / 2;
}
/** Signed distance to a diamond (the suit pip on the card face). */
function sdDiamond(px, py, cx, cy, r) {
  return (Math.abs(px - cx) + Math.abs(py - cy) - r) / Math.SQRT2;
}

function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  return {
    size,
    buf,
    blend(i, [r, g, b], a) {
      if (a <= 0) return;
      const dr = buf[i];
      const dg = buf[i + 1];
      const db = buf[i + 2];
      const da = buf[i + 3] / 255;
      const outA = a + da * (1 - a);
      if (outA <= 0) return;
      buf[i] = Math.round((r * a + dr * da * (1 - a)) / outA);
      buf[i + 1] = Math.round((g * a + dg * da * (1 - a)) / outA);
      buf[i + 2] = Math.round((b * a + db * da * (1 - a)) / outA);
      buf[i + 3] = Math.round(outA * 255);
    },
  };
}

// the chevron of light: apex up, arms falling to either side of the card's top edge
const CHEVRON = { apex: [32, 12], left: [24, 19.5], right: [40, 19.5], width: 4.2 };
// the lit card, standing upright on the stage
const CARD = { x: 20, y: 23, w: 24, h: 32, r: 4.5 };
const PIP = { cx: 32, cy: 39, r: 5 };

function render(size, opts = {}) {
  const { maskable = false, opaque = false } = opts;
  const canvas = makeCanvas(size);
  const scale = maskable ? 0.78 : 1;
  const toArt = (p) => (((p + 0.5) / size - 0.5) * 64) / scale + 32;
  const pxPerUnit = (size * scale) / 64;
  const cover = (d) => clamp01(0.5 - d * pxPerUnit);
  const bleed = maskable || opaque;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = toArt(x);
      const v = toArt(y);

      if (bleed) canvas.blend(i, GROUND, 1);
      else canvas.blend(i, GROUND, cover(sdRoundRect(u, v, 0, 0, 64, 64, 14)));

      const clip = bleed ? -1 : sdRoundRect(u, v, 0, 0, 64, 64, 14);
      if (clip >= 0.5) continue;
      const clipA = bleed ? 1 : cover(clip);

      // the light cue above the table
      const { apex, left, right, width } = CHEVRON;
      const arm = Math.min(
        sdSegment(u, v, left[0], left[1], apex[0], apex[1], width),
        sdSegment(u, v, apex[0], apex[1], right[0], right[1], width),
      );
      canvas.blend(i, ACCENT, cover(arm) * clipA);
      // the card itself, and the pip that makes it read as one
      canvas.blend(i, FACE, cover(sdRoundRect(u, v, CARD.x, CARD.y, CARD.w, CARD.h, CARD.r)) * clipA);
      canvas.blend(i, INK, cover(sdDiamond(u, v, PIP.cx, PIP.cy, PIP.r)) * clipA);
    }
  }
  return encodePng(canvas.buf, size);
}

mkdirSync(OUT_DIR, { recursive: true });
const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-512-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { opaque: true }],
];
for (const [name, size, opts] of jobs) {
  writeFileSync(join(OUT_DIR, name), render(size, opts));
  // eslint-disable-next-line no-console
  console.log(`wrote ${name} (${size}x${size})`);
}
