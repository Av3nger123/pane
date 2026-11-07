'use strict';
// Draws the Pane icon as a PNG, without dependencies: a dark rounded tile with
// the "P" mark, a tall solid bar beside a small outlined square. Used as the
// default icon of new apps. assets/icon.svg is the same drawing.

const zlib = require('zlib');

// The mark, as fractions of the tile.
const MARK = {
  bar: { x: 0.228, y: 0.263, w: 0.226, h: 0.455, r: 0.075 },
  box: { x: 0.536, y: 0.263, s: 0.236, r: 0.065, stroke: 0.048 },
  tileRadius: 0.22,
};

function defaultIconPng({ size = 512, from = '#2a2f36', to = '#14171b' } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const [r1, g1, b1] = rgb(from);
  const [r2, g2, b2] = rgb(to);
  const S = size;
  const { bar, box } = MARK;
  const t = box.stroke * S;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const tile = cover(cx, cy, 0, 0, S, S, MARK.tileRadius * S);
      if (tile <= 0) continue;
      const k = (cx + cy) / (2 * S);
      let r = r1 + (r2 - r1) * k;
      let g = g1 + (g2 - g1) * k;
      let b = b1 + (b2 - b1) * k;
      const solid = cover(cx, cy, bar.x * S, bar.y * S, bar.w * S, bar.h * S, bar.r * S);
      const outer = cover(cx, cy, box.x * S, box.y * S, box.s * S, box.s * S, box.r * S);
      const inner = cover(cx, cy, box.x * S + t, box.y * S + t, box.s * S - 2 * t, box.s * S - 2 * t, Math.max(box.r * S - t, 0.01 * S));
      const mark = Math.min(1, solid + Math.max(0, outer - inner));
      r += (255 - r) * mark;
      g += (255 - g) * mark;
      b += (255 - b) * mark;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(255 * tile);
    }
  }
  return encodePng(size, size, px);
}

// The same drawing as SVG.
function iconSvg({ size = 512, from = '#2a2f36', to = '#14171b' } = {}) {
  const S = size;
  const { bar, box } = MARK;
  const t = box.stroke * S;
  const n = (v) => Math.round(v * 10) / 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="${S}" height="${S}" rx="${n(MARK.tileRadius * S)}" fill="url(#g)"/>
  <rect x="${n(bar.x * S)}" y="${n(bar.y * S)}" width="${n(bar.w * S)}" height="${n(bar.h * S)}" rx="${n(bar.r * S)}" fill="#fff"/>
  <rect x="${n(box.x * S + t / 2)}" y="${n(box.y * S + t / 2)}" width="${n(box.s * S - t)}" height="${n(box.s * S - t)}" rx="${n(box.r * S - t / 2)}" fill="none" stroke="#fff" stroke-width="${n(t)}"/>
</svg>
`;
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

module.exports = { defaultIconPng, iconSvg };
