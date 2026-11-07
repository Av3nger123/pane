'use strict';
// Unit tests for the parts that do not need Electron. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { satisfies, isValidSpec } = require('../lib/version');
const { resolveInside } = require('../lib/safe-path');
const { loadManifest, ManifestError } = require('../lib/manifest');
const { appFiles } = require('../lib/templates');
const { defaultIconPng } = require('../lib/icon');
const { execName, fileName } = require('../lib/launcher');

function tmpApp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-test-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('version specs', () => {
  assert.equal(satisfies('0.1.0', '>=0.1.0'), true);
  assert.equal(satisfies('0.1.0', '>=0.2'), false);
  assert.equal(satisfies('1.4.2', '1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('1.9.0', '^1.2.0'), true);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false, 'caret on 0.x pins the minor');
  assert.equal(satisfies('0.1.5', '^0.1.0'), true);
  assert.equal(satisfies('0.1.0', undefined), true);
  assert.equal(isValidSpec('>=0.1'), true);
  assert.equal(isValidSpec('latest'), false);
});

test('resolveInside keeps paths inside the root', () => {
  const root = path.resolve('/apps/hello/ui');
  assert.equal(resolveInside(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveInside(root, '/css/site%20main.css'), path.join(root, 'css', 'site main.css'));
  assert.equal(resolveInside(root, '/../backend/main.js'), null);
  assert.equal(resolveInside(root, '/%2e%2e/secret'), null);
  assert.equal(resolveInside(root, '/.env'), null);
  assert.equal(resolveInside(root, '/a/.git/config'), null);
  assert.equal(resolveInside(root, '/a%00.html'), null);
  assert.equal(resolveInside(root, '/'), null);
  assert.equal(resolveInside(root, '%E0%A4%A'), null, 'bad percent-encoding');
  assert.equal(resolveInside(root, '/etc/passwd', { decode: false }), null, 'absolute manifest paths are refused');
  assert.equal(resolveInside(root, 'C:\\x', { decode: false }), null);
  assert.equal(resolveInside(root, 'pages\\about.html', { decode: false }), path.join(root, 'pages', 'about.html'));
});

test('manifest: a minimal app gets defaults', () => {
  const dir = tmpApp({ 'pane.json': '{"id":"hello","name":"Hello"}', 'ui/index.html': '<p>hi</p>' });
  const m = loadManifest(dir);
  assert.equal(m.id, 'hello');
  assert.equal(m.version, '0.1.0');
  assert.equal(m.uiDir, path.join(dir, 'ui'));
  assert.equal(m.start, 'index.html');
  assert.equal(m.backend, null);
  assert.deepEqual({ ...m.window }, { width: 1024, height: 700, minWidth: 320, minHeight: 240, titleBar: 'default', background: '#ffffff' });
  assert.deepEqual([...m.permissions], []);
});

test('manifest: reports every problem at once', () => {
  const dir = tmpApp({
    'pane.json': JSON.stringify({
      id: 'Bad Id', backend: '../outside.js', icon: 'icon.jpg', pane: 'soon',
      window: { width: 5, titleBar: 'fancy', background: 'red' }, permissions: ['camera', 'root'],
    }),
    'ui/index.html': '',
  });
  try {
    loadManifest(dir);
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof ManifestError);
    for (const part of ['"id"', '"name"', '"pane"', '"backend"', '"icon"', 'window.width', 'window.titleBar', 'window.background', 'Unknown permission "root"']) {
      assert.ok(err.message.includes(part), `mentions ${part}:\n${err.message}`);
    }
  }
});

test('manifest: missing files and bad JSON', () => {
  assert.throws(() => loadManifest(tmpApp({})), /no pane\.json/);
  assert.throws(() => loadManifest(tmpApp({ 'pane.json': '{oops' })), /not valid JSON/);
  assert.throws(() => loadManifest(tmpApp({ 'pane.json': '{"id":"a","name":"A"}' })), /"ui" folder "ui" does not exist/);
  assert.throws(() => loadManifest(tmpApp({ 'pane.json': '{"id":"a","name":"A","backend":"b.js"}', 'ui/index.html': '' })), /backend file "b.js" does not exist/);
});

test('templates produce a valid app, with and without a backend', () => {
  for (const backend of [true, false]) {
    const dir = tmpApp(appFiles({ id: 'demo', name: 'Demo', backend }));
    fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng({ size: 64 }));
    const m = loadManifest(dir);
    assert.equal(Boolean(m.backend), backend);
    assert.equal(m.window.titleBar, 'hidden');
    const html = fs.readFileSync(path.join(dir, 'ui', 'about.html'), 'utf8');
    assert.ok(!/<script>/.test(html), 'no inline scripts: the template CSP forbids them');
  }
});

test('default icon is a real PNG of the requested size', () => {
  const png = defaultIconPng({ size: 64 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
});

test('launcher names are safe', () => {
  assert.equal(execName('Notes: 2026 / work'), 'Notes 2026 work');
  assert.equal(execName('日本'), 'Pane App');
  assert.equal(fileName('A/B:C?'), 'ABC');
  assert.equal(fileName('Reports...'), 'Reports');
});
