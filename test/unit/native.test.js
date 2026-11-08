'use strict';
// Unit tests for the checks and storage behind pane.menu, pane.dialog,
// pane.notify, pane.store and pane.secrets. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  checkShortcut, normalizeMenu, normalizeAppMenus, normalizeDialog, normalizeNotification,
} = require('../../src/core/validate');
const { createStore, createSecrets } = require('../../src/core/stores');

test('keyboard shortcuts', () => {
  for (const ok of ['CmdOrCtrl+N', 'CmdOrCtrl+Shift+E', 'Alt+F4', 'F5', 'Ctrl+Plus', 'CmdOrCtrl++', 'Shift+/', 'CmdOrCtrl+Backspace']) {
    assert.equal(checkShortcut(ok), ok);
  }
  for (const bad of ['', 'Hyper+N', 'CmdOrCtrl+', 'CmdOrCtrl+NN', 'F25', 42]) {
    assert.throws(() => checkShortcut(bad), /keyboard shortcut|unknown/);
  }
});

test('menus: clean copies, clear errors', () => {
  const menu = normalizeMenu([
    { label: 'New', id: 'new', shortcut: 'CmdOrCtrl+N', extra: 'dropped' },
    { type: 'separator' },
    { label: 'Recent', items: [{ label: 'a.md', id: 'recent:a', enabled: 0 }] },
    { label: 'Wrap', id: 'wrap', checked: 1 },
  ]);
  assert.deepEqual(menu, [
    { label: 'New', id: 'new', shortcut: 'CmdOrCtrl+N' },
    { type: 'separator' },
    { label: 'Recent', items: [{ label: 'a.md', id: 'recent:a', enabled: false }] },
    { label: 'Wrap', id: 'wrap', checked: true },
  ]);
  assert.throws(() => normalizeMenu([{ label: 'No id' }]), /needs an "id"/);
  assert.throws(() => normalizeMenu([{ id: 'x' }]), /needs a "label"/);
  assert.throws(() => normalizeMenu([{ label: 'x', id: 'x', shortcut: 'Bad+Q' }]), /unknown modifier/);
  assert.throws(() => normalizeMenu('nope'), /list of items/);
  const deep = (n) => (n === 0 ? [{ label: 'leaf', id: 'leaf' }] : [{ label: `l${n}`, items: deep(n - 1) }]);
  assert.throws(() => normalizeMenu(deep(5)), /nested too deeply/);
  assert.throws(() => normalizeMenu(Array.from({ length: 301 }, (_, i) => ({ label: `i${i}`, id: `i${i}` }))), /more than 300/);
  assert.throws(() => normalizeAppMenus([{ label: 'File', id: 'file' }]), /needs "items"/);
});

test('dialogs', () => {
  assert.deepEqual(normalizeDialog('open', { multiple: true, filters: [{ name: 'Notes', extensions: ['.md', 'txt'] }] }).filters,
    [{ name: 'Notes', extensions: ['md', 'txt'] }]);
  assert.deepEqual(normalizeDialog('open', { directory: true, multiple: true }).properties, ['openDirectory', 'createDirectory', 'multiSelections']);
  assert.ok(normalizeDialog('save', {}).properties.includes('showOverwriteConfirmation'));
  const msg = normalizeDialog('message', { message: 'Delete?', buttons: ['Delete', 'Cancel'], type: 'warning' });
  assert.equal(msg.cancelId, 1);
  assert.equal(msg.defaultId, 0);
  assert.equal(msg.type, 'warning');
  assert.throws(() => normalizeDialog('message', {}), /needs a "message"/);
  assert.throws(() => normalizeDialog('message', { message: 'x', buttons: [] }), /1 to 6/);
  assert.throws(() => normalizeDialog('open', { filters: [{ name: 'x', extensions: ['../evil'] }] }), /not a file extension/);
  assert.throws(() => normalizeDialog('format-disk', {}), /Unknown dialog/);
});

test('notifications', () => {
  assert.deepEqual(normalizeNotification({ title: 'Done', body: 'Saved', id: 'n1' }), { title: 'Done', body: 'Saved', silent: false, id: 'n1' });
  assert.throws(() => normalizeNotification({ body: 'x' }), /needs a "title"/);
});

test('pane.store: JSON values that persist', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-store-')), 'store.json');
  const store = createStore(file);
  assert.equal(store.get('theme'), undefined);
  store.set('theme', { dark: true, size: 14 });
  store.set('recent', ['a', 'b']);
  assert.deepEqual(createStore(file).get('theme'), { dark: true, size: 14 }, 'survives a restart');
  store.delete('recent');
  assert.deepEqual(Object.keys(store.all()), ['theme']);
  assert.throws(() => store.set('fn', () => 1), /JSON values/);
  assert.throws(() => store.set('../x', 1), /not a valid key/);
  assert.throws(() => store.set('big', 'x'.repeat(1024 * 1024 + 10)), /full/);
});

test('pane.secrets: stored encrypted, refused without a keychain', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-secrets-')), 'secrets.json');
  // Fake keychain crypto: reverses and base64s, enough to prove nothing is stored in clear text.
  const crypto = {
    available: () => true,
    encrypt: (t) => Buffer.from(`enc:${[...t].reverse().join('')}`),
    decrypt: (b) => [...b.toString().slice(4)].reverse().join(''),
  };
  const secrets = createSecrets(file, crypto);
  secrets.set('token', 'abc123');
  assert.equal(secrets.get('token'), 'abc123');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('abc123'), 'not stored in clear text');
  assert.equal(secrets.get('missing'), null);
  secrets.delete('token');
  assert.equal(secrets.get('token'), null);

  const none = createSecrets(file, { ...crypto, available: () => false });
  assert.throws(() => none.set('token', 'x'), /not available/);
  const broken = createSecrets(file, { ...crypto, decrypt: () => { throw new Error('bad'); } });
  secrets.set('token', 'x');
  assert.throws(() => broken.get('token'), /could not be decrypted/);
});

test('links and files the system opens the app with', () => {
  const { checkProtocols, checkFileTypes, fromArgv } = require('../../src/core/open-requests');
  const errors = [];
  assert.deepEqual(checkProtocols(['notes', 'notes'], errors), ['notes']);
  checkProtocols(['https', 'Bad Name', 'pane-app'], errors);
  assert.equal(errors.length, 3);
  const types = checkFileTypes([{ name: 'Markdown', extensions: ['.MD', 'markdown'] }], []);
  assert.deepEqual([...types[0].extensions], ['md', 'markdown']);
  assert.equal(types[0].role, 'editor');
  const typeErrors = [];
  checkFileTypes([{ name: 'x', extensions: ['../x'] }, { extensions: ['md'] }], typeErrors);
  assert.equal(typeErrors.length, 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-open-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '# a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const manifest = { protocols: ['notes'], fileTypes: types };
  const argv = ['/electron', '/pane/main.js', '--app=/x', '--dev', 'notes://open/42', 'NOTES://Caps', 'other://x', 'a.md', 'b.txt', 'missing.md', '--flag'];
  assert.deepEqual(fromArgv(argv, manifest, dir), [
    { kind: 'url', url: 'notes://open/42' },
    { kind: 'url', url: 'NOTES://Caps' },
    { kind: 'file', path: path.join(dir, 'a.md') },
  ]);
  assert.deepEqual(fromArgv(argv, { protocols: [], fileTypes: [] }, dir), [], 'apps that declare nothing get nothing');
});
