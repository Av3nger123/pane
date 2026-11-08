'use strict';
// Keeps a Mach-O file's ad-hoc signature valid after a few bytes change.
//
// A code signature lists a hash for every page of the file. When Pane
// changes Electron's fuse bytes in a launcher, only the pages holding them
// need new hashes. Writing those hashes in place keeps the launcher's APFS
// clone of Pane's Electron shared; `codesign` would rewrite the whole file
// (about 200 MB per app).
//
// For ad-hoc signatures only (no certificate, so nothing else signs the code
// directory). Developer ID signing happens elsewhere, with codesign.

const crypto = require('crypto');
const fs = require('fs');

const MH_MAGIC_64 = 0xfeedfacf;
const LC_CODE_SIGNATURE = 0x1d;
const SUPERBLOB = 0xfade0cc0;
const CODEDIRECTORY = 0xfade0c02;
const HASHES = { 1: 'sha1', 2: 'sha256', 3: 'sha256', 4: 'sha384' };

// positions: file offsets that changed. Rewrites the page hashes covering them
// in every code directory of the signature.
function repairPageHashes(file, positions) {
  const fd = fs.openSync(file, 'r+');
  try {
    const read = (offset, length) => {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return buf;
    };
    const header = read(0, 32);
    if (header.readUInt32LE(0) !== MH_MAGIC_64) {
      throw new Error(`${file} is not a single-architecture 64-bit Mach-O file.`);
    }
    const ncmds = header.readUInt32LE(16);
    const commands = read(32, header.readUInt32LE(20));
    let sig = null;
    for (let i = 0, at = 0; i < ncmds; i++) {
      const cmd = commands.readUInt32LE(at);
      if (cmd === LC_CODE_SIGNATURE) sig = { offset: commands.readUInt32LE(at + 8), size: commands.readUInt32LE(at + 12) };
      at += commands.readUInt32LE(at + 4);
    }
    if (!sig) throw new Error(`${file} has no code signature.`);

    const blob = read(sig.offset, sig.size);
    if (blob.readUInt32BE(0) !== SUPERBLOB) throw new Error(`${file} has a code signature Pane cannot read.`);
    const count = blob.readUInt32BE(8);
    let directories = 0;
    for (let i = 0; i < count; i++) {
      const cd = blob.readUInt32BE(12 + i * 8 + 4);
      if (blob.readUInt32BE(cd) !== CODEDIRECTORY) continue;
      directories++;
      const flags = blob.readUInt32BE(cd + 12);
      if (!(flags & 0x2)) throw new Error(`${file} is signed with a certificate; re-sign it with codesign instead.`);
      const hashOffset = blob.readUInt32BE(cd + 16);
      const nCodeSlots = blob.readUInt32BE(cd + 28);
      const codeLimit = blob.readUInt32BE(cd + 32);
      const hashSize = blob[cd + 36];
      const algorithm = HASHES[blob[cd + 37]];
      if (!algorithm) throw new Error(`${file} uses a signature hash Pane does not know.`);
      const pageSize = blob[cd + 39] ? 2 ** blob[cd + 39] : codeLimit;
      for (const page of new Set(positions.map((p) => Math.floor(p / pageSize)))) {
        if (page >= nCodeSlots) throw new Error(`Offset ${page * pageSize} of ${file} is outside its signed code.`);
        const start = page * pageSize;
        const bytes = read(start, Math.min(pageSize, codeLimit - start));
        const hash = crypto.createHash(algorithm).update(bytes).digest().subarray(0, hashSize);
        fs.writeSync(fd, hash, 0, hashSize, sig.offset + cd + hashOffset + page * hashSize);
      }
    }
    if (!directories) throw new Error(`${file} has a code signature without a code directory.`);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { repairPageHashes };
