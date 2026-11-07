'use strict';
// Windows .ico files built from PNG images (PNG entries are valid since
// Windows Vista). Sizes up to 256 px.

function encodeIco(images) {
  // images: [{ size, png: Buffer }], any order
  const list = [...images].sort((a, b) => a.size - b.size);
  if (!list.length) throw new Error('An icon needs at least one image.');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(list.length, 4);
  const entries = [];
  let offset = 6 + 16 * list.length;
  for (const { size, png } of list) {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`Icon sizes must be 1 to 256 px, not ${size}.`);
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...list.map((i) => i.png)]);
}

// For tests: the sizes and byte lengths inside an .ico.
function readIco(buf) {
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    out.push({ size: buf.readUInt8(at) || 256, length: buf.readUInt32LE(at + 8), offset: buf.readUInt32LE(at + 12) });
  }
  return out;
}

module.exports = { encodeIco, readIco };
