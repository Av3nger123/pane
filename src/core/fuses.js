'use strict';
// Electron fuses: switches compiled into Electron's binary.
//
// macOS launchers turn off the ones that would let another program run its
// own code under the app's identity (and its camera, microphone and file
// permissions): running as plain Node, NODE_OPTIONS, and --inspect.
//
// The wire: SENTINEL, a version byte (1), a length byte, then one ASCII byte
// per fuse: '1' on, '0' off, 'r' removed. On macOS it lives in
// "Electron Framework.framework/Electron Framework".
//
// Only the changed bytes are written, in place. Launchers are APFS clones of
// Pane's Electron, and rewriting the whole 160 MB file would give every app
// its own full copy on disk.

const fs = require('fs');

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

const FUSE = Object.freeze({
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
  WasmTrapHandlers: 8,
});

const LAUNCHER_FUSES = Object.freeze({
  [FUSE.RunAsNode]: false,
  [FUSE.EnableNodeOptionsEnvironmentVariable]: false,
  [FUSE.EnableNodeCliInspectArguments]: false,
});

// [{ offset, wire }]: one per copy of the wire (universal binaries have one
// per architecture). offset is where the fuse bytes start.
function readFuses(file) {
  const bytes = fs.readFileSync(file);
  const sentinel = Buffer.from(SENTINEL, 'ascii');
  const found = [];
  for (let at = bytes.indexOf(sentinel); at >= 0; at = bytes.indexOf(sentinel, at + 1)) {
    const version = bytes[at + sentinel.length];
    if (version !== 1) throw new Error(`${file} has Electron fuses of version ${version}; this Pane knows version 1.`);
    const length = bytes[at + sentinel.length + 1];
    const offset = at + sentinel.length + 2;
    found.push({ offset, wire: bytes.subarray(offset, offset + length).toString('latin1') });
  }
  if (!found.length) throw new Error(`${file} has no Electron fuses.`);
  return found;
}

// changes: { <fuse index>: true | false }
function setFuses(file, changes) {
  const wires = readFuses(file);
  const writes = [];
  for (const { offset, wire } of wires) {
    for (const [key, on] of Object.entries(changes)) {
      const index = Number(key);
      if (index >= wire.length) throw new Error(`${file} has no fuse ${index}.`);
      if (wire[index] === 'r') throw new Error(`Fuse ${index} was removed from this Electron.`);
      const value = on ? '1' : '0';
      if (wire[index] !== value) writes.push({ position: offset + index, value });
    }
  }
  if (!writes.length) return;
  const fd = fs.openSync(file, 'r+');
  try {
    for (const { position, value } of writes) fs.writeSync(fd, Buffer.from(value, 'latin1'), 0, 1, position);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { SENTINEL, FUSE, LAUNCHER_FUSES, readFuses, setFuses };
