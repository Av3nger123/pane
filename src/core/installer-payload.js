'use strict';
// The Windows installer is one generic program (installer/windows/PaneSetup.exe)
// with the app attached to its end, so `pane build` can make it on any OS:
//
//   [PaneSetup.exe][config length: 4 bytes LE][config: UTF-8 key=value lines]
//   [app.paneapp bytes][payload length: 8 bytes LE]["PANESET1"]
//
// installer/windows/PaneSetup.cs reads it back the same way.

const MAGIC = Buffer.from('PANESET1', 'ascii');

function configText(config) {
  return Object.entries(config).map(([k, v]) => {
    const value = String(v);
    if (/[\r\n]/.test(value) || /[=\r\n]/.test(k)) throw new Error(`Installer setting "${k}" cannot contain line breaks or "=".`);
    return `${k}=${value}`;
  }).join('\n');
}

function attachPayload(stub, config, paneapp) {
  const text = Buffer.from(configText(config), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(text.length);
  const payload = Buffer.concat([len, text, paneapp]);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(payload.length));
  return Buffer.concat([stub, payload, size, MAGIC]);
}

// For tests: what PaneSetup.exe will read.
function readPayload(exe) {
  if (!exe.subarray(exe.length - 8).equals(MAGIC)) throw new Error('No Pane installer payload.');
  const size = Number(exe.readBigUInt64LE(exe.length - 16));
  const start = exe.length - 16 - size;
  const textLen = exe.readUInt32LE(start);
  const text = exe.subarray(start + 4, start + 4 + textLen).toString('utf8');
  const config = Object.fromEntries(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { config, paneapp: exe.subarray(start + 4 + textLen, exe.length - 16), stubLength: start };
}

module.exports = { attachPayload, readPayload };
