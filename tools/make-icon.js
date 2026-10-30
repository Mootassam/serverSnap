'use strict';
// Draws the ServerSnap icon (blue tile, two server racks, green check) and writes
// assets/icon.png (256 px) and assets/icon.ico (16–256 px). Run: node tools/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to a rounded box centred at (cx, cy).
function box(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function segment(x, y, ax, ay, bx, by, r) {
  const pax = x - ax; const pay = y - ay; const bax = bx - ax; const bay = by - ay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * t, pay - bay * t) - r;
}

// Colour of one point in a 1x1 unit square, as [r, g, b, a] (0..1), by layering shapes.
function shade(x, y, px) {
  const layers = [];
  const aa = (d) => Math.max(0, Math.min(1, 0.5 - d / px));
  // tile with a vertical gradient
  const t = y;
  layers.push([aa(box(x, y, 0.5, 0.5, 0.46, 0.46, 0.2)), [0.31 - 0.12 * t, 0.55 - 0.18 * t, 1.0 - 0.15 * t]]);
  // two racks
  for (const cy of [0.36, 0.6]) {
    layers.push([aa(box(x, y, 0.45, cy, 0.25, 0.085, 0.04)), [1, 1, 1]]);
    layers.push([aa(circle(x, y, 0.29, cy, 0.03)), [0.31, 0.55, 1]]);
    layers.push([aa(box(x, y, 0.52, cy, 0.1, 0.018, 0.018)), [0.75, 0.82, 0.95]]);
  }
  // green badge with a check
  layers.push([aa(circle(x, y, 0.72, 0.74, 0.17)), [1, 1, 1]]);
  layers.push([aa(circle(x, y, 0.72, 0.74, 0.14)), [0.18, 0.75, 0.44]]);
  const check = Math.min(segment(x, y, 0.655, 0.745, 0.705, 0.795, 0.022), segment(x, y, 0.705, 0.795, 0.79, 0.69, 0.022));
  layers.push([aa(check), [1, 1, 1]]);

  let r = 0; let g = 0; let b = 0; let a = 0;
  for (const [alpha, c] of layers) {
    if (alpha <= 0) continue;
    r = c[0] * alpha + r * (1 - alpha);
    g = c[1] * alpha + g * (1 - alpha);
    b = c[2] * alpha + b * (1 - alpha);
    a = alpha + a * (1 - alpha);
  }
  return a > 0 ? [r / a * a, g / a * a, b / a * a, a] : [0, 0, 0, 0];
}

function render(size) {
  const ss = 4; // supersampling per axis
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, 1 / size);
          r += pr; g += pg; b += pb; a += pa;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const A = a / n;
      buf[i] = A ? Math.round((r / n / A) * 255) : 0;
      buf[i + 1] = A ? Math.round((g / n / A) * 255) : 0;
      buf[i + 2] = A ? Math.round((b / n / A) * 255) : 0;
      buf[i + 3] = Math.round(A * 255);
    }
  }
  return png(size, buf);
}

function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: render(size) }));
fs.writeFileSync(path.join(out, 'icon.png'), pngs[pngs.length - 1].data);
fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs));
console.log('wrote assets/icon.png and assets/icon.ico');
