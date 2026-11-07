'use strict';
// Draws a default app icon as a PNG, without dependencies: a rounded tile with
// the Pane "split" mark (one solid pane next to an outlined one).

const zlib = require('zlib');

function defaultIconPng({ size = 512, from = '#2c323a', to = '#121417' } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const [r1, g1, b1] = rgb(from);
  const [r2, g2, b2] = rgb(to);
  // The mark is drawn on a 24-unit grid, scaled into the middle 58% of the tile.
  const glyph = 0.58 * size;
  const off = (size - glyph) / 2;
  const g = (u) => off + (u / 24) * glyph;
  const gs = glyph / 24;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const tile = cover(cx, cy, 0, 0, size, size, size * 0.23);
      if (tile <= 0) continue;
      const t = (cx + cy) / (2 * size);
      let r = r1 + (r2 - r1) * t;
      let gg = g1 + (g2 - g1) * t;
      let b = b1 + (b2 - b1) * t;
      // left pane, solid
      const left = cover(cx, cy, g(3.5), g(5), 7 * gs, 14 * gs, 2 * gs);
      // right pane, outlined: outer minus inner
      const outer = cover(cx, cy, g(12.5), g(5), 8 * gs, 14 * gs, 2.35 * gs);
      const inner = cover(cx, cy, g(14), g(6.5), 5 * gs, 11 * gs, 0.85 * gs);
      const mark = Math.min(1, left + Math.max(0, outer - inner));
      r += (255 - r) * mark;
      gg += (255 - gg) * mark;
      b += (255 - b) * mark;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(gg);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(255 * tile);
    }
  }
  return encodePng(size, size, px);
}

// Anti-aliased coverage of a rounded rectangle at a pixel centre.
function cover(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.min(1, Math.max(0, 0.5 - d));
}

function rgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

module.exports = { defaultIconPng };
