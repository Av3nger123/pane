'use strict';
// The Windows installer is one generic program (installer/windows/PaneSetup.exe)
// with the app attached to its end, so `pane build` can make it on any OS:
//
//   [PaneSetup.exe][config length: 4 bytes LE][config: UTF-8 key=value lines]
//   [app.paneapp bytes][payload length: 8 bytes LE]["PANESET1"]
//
// installer/windows/PaneSetup.cs reads it back the same way.
//
// Signing the installer (Authenticode) appends a certificate table after the
// trailer, padded to 8 bytes, and points the PE header's security directory
// at it. The payload then ends where that table starts (payloadEnd).

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

// Where the payload's trailer ends: the start of the certificate table when
// the file is signed (minus signtool's zero padding), else the end of the file.
function payloadEnd(exe) {
  let end = exe.length;
  if (exe.length >= 0x40 && exe.toString('latin1', 0, 2) === 'MZ') {
    const pe = exe.readUInt32LE(0x3c);
    if (pe + 24 + 2 <= exe.length && exe.toString('latin1', pe, pe + 4) === 'PE\0\0') {
      const optional = pe + 24;
      const magic = exe.readUInt16LE(optional);
      const directories = optional + (magic === 0x20b ? 112 : 96);
      const security = directories + 4 * 8;
      if (security + 8 <= exe.length) {
        const offset = exe.readUInt32LE(security);
        const size = exe.readUInt32LE(security + 4);
        if (size > 0 && offset <= exe.length) end = offset;
      }
    }
  }
  for (let i = 0; i < 7 && end > 0 && exe[end - 1] === 0; i++) end--;
  return end;
}

// For tests: what PaneSetup.exe will read.
function readPayload(exe) {
  const end = payloadEnd(exe);
  if (end < 16 || !exe.subarray(end - 8, end).equals(MAGIC)) throw new Error('No Pane installer payload.');
  const size = Number(exe.readBigUInt64LE(end - 16));
  const start = end - 16 - size;
  const textLen = exe.readUInt32LE(start);
  const text = exe.subarray(start + 4, start + 4 + textLen).toString('utf8');
  const config = Object.fromEntries(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { config, paneapp: exe.subarray(start + 4 + textLen, end - 16), stubLength: start };
}

module.exports = { attachPayload, readPayload, payloadEnd };
