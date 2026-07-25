'use strict';
/**
 * Generates dashboard.ico (a bar-chart tile in the app's blue) with no image
 * libraries — draws into an RGBA buffer, encodes a PNG by hand, and wraps it
 * in an ICO container. Run once; the .ico is committed so it ships with a
 * clone. Regenerate with:  node scripts/make-icon.js
 *
 * Optional: pass a path to also write a PNG preview, e.g.
 *   node scripts/make-icon.js /tmp/preview.png
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 256, H = 256;
const buf = Buffer.alloc(W * H * 4); // transparent

const BLUE = [42, 120, 214];
const WHITE = [255, 255, 255];

// Signed-distance coverage for a rounded rectangle (≈1px anti-aliasing).
function roundRectCoverage(px, py, x, y, w, h, r) {
  const halfW = w / 2, halfH = h / 2;
  const cx = x + halfW, cy = y + halfH;
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

// Source-over composite of one color at coverage cov onto pixel (x,y).
function paint(x, y, color, cov) {
  if (cov <= 0) return;
  const i = (y * W + x) * 4;
  const sa = cov; // color alpha is 1
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  for (let c = 0; c < 3; c++) {
    const s = color[c], dd = buf[i + c];
    buf[i + c] = oa === 0 ? 0 : Math.round((s * sa + dd * da * (1 - sa)) / oa);
  }
  buf[i + 3] = Math.round(oa * 255);
}

function fillRoundRect(x, y, w, h, r, color) {
  const x0 = Math.max(0, Math.floor(x - 1)), x1 = Math.min(W, Math.ceil(x + w + 1));
  const y0 = Math.max(0, Math.floor(y - 1)), y1 = Math.min(H, Math.ceil(y + h + 1));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      paint(px, py, color, roundRectCoverage(px + 0.5, py + 0.5, x, y, w, h, r));
    }
  }
}

// Blue rounded tile background, then three ascending white bars.
fillRoundRect(8, 8, 240, 240, 44, BLUE);
const baseline = 200;
const bars = [
  { x: 45, h: 64 },
  { x: 109, h: 104 },
  { x: 173, h: 150 },
];
for (const b of bars) {
  fillRoundRect(b.x, baseline - b.h, 38, b.h, 8, WHITE);
}

// ---- PNG encoder -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = encodePNG(W, H, buf);

// ---- ICO container (single PNG-compressed 256×256 entry) -------------------

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; // 0 => 256px
entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4);   // planes
entry.writeUInt16LE(32, 6);  // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12); // offset
const ico = Buffer.concat([dir, entry, png]);

const outPath = path.join(__dirname, '..', 'dashboard.ico');
fs.writeFileSync(outPath, ico);
console.log('Wrote', outPath, `(${ico.length} bytes)`);

if (process.argv[2]) {
  fs.writeFileSync(process.argv[2], png);
  console.log('Wrote preview', process.argv[2]);
}
