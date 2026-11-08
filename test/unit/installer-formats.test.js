'use strict';
// The byte formats Windows reads: the installer payload, .ico files and .reg
// files. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPayload, readPayload } = require('../../src/core/installer-payload');
const { encodeIco, readIco } = require('../../src/core/ico');
const { installEntries, removeEntries, encodeRegFile, regString } = require('../../src/core/win-registry');

test('installer payload round-trips (what PaneSetup.cs reads)', () => {
  const stub = Buffer.from('MZ...pretend program...');
  const app = Buffer.from([1, 2, 3, 250, 0, 9]);
  const exe = attachPayload(stub, { name: 'Notes', paneVersion: '0.1.0', distUrl: 'https://x/y', package: 'notes-0.1.0.paneapp' }, app);
  const back = readPayload(exe);
  assert.equal(back.stubLength, stub.length);
  assert.deepEqual(back.paneapp, app);
  assert.deepEqual(back.config, { name: 'Notes', paneVersion: '0.1.0', distUrl: 'https://x/y', package: 'notes-0.1.0.paneapp' });
  assert.equal(exe.subarray(-8).toString('ascii'), 'PANESET1');
  assert.throws(() => attachPayload(stub, { name: 'two\nlines' }, app), /line breaks/);
  assert.throws(() => readPayload(stub), /No Pane installer payload/);
});

// The smallest PE32 header readPayload needs: DOS header, "PE\0\0", COFF
// header, and an optional header whose data directory has the security entry.
function fakePe32() {
  const pe = Buffer.alloc(64 + 4 + 20 + 224);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(64, 0x3c);
  pe.write('PE\0\0', 64, 'latin1');
  pe.writeUInt16LE(224, 64 + 4 + 16); // SizeOfOptionalHeader
  pe.writeUInt16LE(0x10b, 64 + 4 + 20); // PE32
  return pe;
}

test('installer payload is found in front of a signature', () => {
  const app = Buffer.from([9, 8, 7, 6, 5]);
  const config = { name: 'Notes', package: 'notes.paneapp' };
  const unsigned = attachPayload(fakePe32(), config, app);
  // What signtool does: pad to 8 bytes, append the certificate table, and
  // point the security directory entry (data directory index 4) at it.
  const padding = Buffer.alloc(5);
  const certificates = Buffer.alloc(200, 0xab);
  const signed = Buffer.concat([unsigned, padding, certificates]);
  const securityEntry = 64 + 4 + 20 + 96 + 4 * 8;
  signed.writeUInt32LE(unsigned.length + padding.length, securityEntry);
  signed.writeUInt32LE(certificates.length, securityEntry + 4);
  const back = readPayload(signed);
  assert.deepEqual(back.config, config);
  assert.deepEqual(back.paneapp, app);
  assert.deepEqual(readPayload(unsigned).paneapp, app);
});

test('.ico files', () => {
  const png = (n) => Buffer.alloc(n, 7);
  const ico = encodeIco([{ size: 256, png: png(300) }, { size: 16, png: png(40) }, { size: 32, png: png(90) }]);
  assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 3, 0]);
  const entries = readIco(ico);
  assert.deepEqual(entries.map((e) => e.size), [16, 32, 256]);
  assert.equal(entries[0].offset, 6 + 16 * 3);
  assert.equal(entries[2].offset + entries[2].length, ico.length);
  assert.throws(() => encodeIco([{ size: 512, png: png(1) }]), /1 to 256/);
});

test('.reg files: links, Open with, Settings > Apps', () => {
  const manifest = {
    id: 'notes', name: 'Notes', version: '0.1.0', protocols: ['pane-notes'],
    fileTypes: [{ name: 'Markdown document', extensions: ['md', 'markdown'], role: 'editor' }],
  };
  const text = installEntries(manifest, {
    electron: 'C:\\Users\\A B\\AppData\\Local\\Pane\\runtime\\0.1.0\\node_modules\\electron\\dist\\electron.exe',
    mainJs: 'C:\\Pane\\main.js', appDir: 'C:\\Pane\\apps\\notes', icon: 'C:\\Pane\\apps\\notes\\.pane-icon.ico',
    paneCommand: 'C:\\Pane\\bin\\pane.cmd', sizeKb: 98.4,
  });
  assert.ok(text.startsWith('Windows Registry Editor Version 5.00\r\n'));
  assert.ok(text.includes('[HKEY_CURRENT_USER\\Software\\Classes\\pane-notes]\r\n@="URL:Notes"\r\n"URL Protocol"=""'));
  // The open command: every part quoted, backslashes and quotes escaped for .reg
  assert.ok(text.includes('@="\\"C:\\\\Users\\\\A B\\\\AppData'), text);
  assert.ok(text.includes('\\"--app=C:\\\\Pane\\\\apps\\\\notes\\" \\"%1\\""'));
  assert.ok(text.includes('[HKEY_CURRENT_USER\\Software\\Classes\\.md\\OpenWithProgids]\r\n"Pane.notes.1"=""'));
  assert.ok(text.includes('[HKEY_CURRENT_USER\\Software\\Classes\\.markdown\\OpenWithProgids]'));
  assert.ok(!/Classes\\.md\]\r\n@=/.test(text), 'never takes over the default app for .md');
  assert.ok(text.includes('"NoModify"=dword:00000001'));
  assert.ok(text.includes('"EstimatedSize"=dword:00000062'));
  assert.ok(text.includes('"UninstallString"="cmd.exe /c \\"\\"C:\\\\Pane\\\\bin\\\\pane.cmd\\" uninstall notes\\""'));

  const removal = removeEntries(manifest);
  assert.ok(removal.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\pane-notes]'));
  assert.ok(removal.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\Pane.notes.1]'));
  assert.ok(removal.includes('[HKEY_CURRENT_USER\\Software\\Classes\\.md\\OpenWithProgids]\r\n"Pane.notes.1"=-'));
  assert.ok(removal.includes('[-HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Pane.notes]'));
  assert.ok(!removal.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\.md]'), 'leaves .md itself alone');

  const encoded = encodeRegFile('ab');
  assert.deepEqual([...encoded], [0xff, 0xfe, 0x61, 0, 0x62, 0]);
  assert.equal(regString('a"b\\c'), '"a\\"b\\\\c"');
});
