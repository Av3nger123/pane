'use strict';
// Unit tests for the parts that do not need Electron. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { satisfies, isValidSpec } = require('../../src/core/version');
const { resolveInside } = require('../../src/core/safe-path');
const { loadManifest, ManifestError } = require('../../src/core/manifest');
const { appFiles, TEMPLATES } = require('../../src/cli/templates');
const { freePort, waitForUrl } = require('../../src/core/run');
const { defaultIconPng } = require('../../src/core/icon');
const { execName, fileName } = require('../../src/packaging/launchers');

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
  assert.deepEqual({ ...m.window }, { width: 1024, height: 700, minWidth: 320, minHeight: 240, titleBar: 'default', background: { light: '#ffffff', dark: '#1e1e1e' } });
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

test('manifest: publisher', () => {
  const app = (publisher) => tmpApp({ 'pane.json': JSON.stringify({ id: 'a', name: 'A', publisher }), 'ui/index.html': '' });
  assert.equal(loadManifest(app('Acme')).publisher, 'Acme');
  assert.equal(loadManifest(app(undefined)).publisher, null);
  assert.throws(() => loadManifest(app('')), /"publisher" must be text of 1–100 characters/);
  assert.throws(() => loadManifest(app('x'.repeat(101))), /"publisher" must be text of 1–100 characters/);
  assert.throws(() => loadManifest(app('Acme\nInc')), /"publisher"/);
});

const PANE_DEP = { name: 'pane-runtime', spec: '^0.1.0' };

test('every template produces a valid app, with and without a backend', () => {
  for (const template of TEMPLATES) {
    for (const backend of [true, false]) {
      const dir = tmpApp(appFiles({ id: 'demo', name: 'Demo {x}', template, backend, paneDependency: PANE_DEP }));
      fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng({ size: 64 }));
      const m = loadManifest(dir, { requireUi: template === 'vanilla' });
      assert.equal(Boolean(m.backend), backend, `${template} backend=${backend}`);
      assert.equal(m.window.titleBar, 'hidden');
      if (template === 'vanilla') {
        const html = fs.readFileSync(path.join(dir, 'ui', 'about.html'), 'utf8');
        assert.ok(!/<script>/.test(html), 'no inline scripts: the template CSP forbids them');
        assert.equal(m.dev, null);
      } else {
        assert.equal(m.ui, 'dist');
        assert.match(m.dev.url, /\{port\}/);
        assert.equal(m.build.command, 'vite build');
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        assert.equal(pkg.devDependencies['pane-runtime'], '^0.1.0');
        assert.deepEqual(pkg.dependencies, {}, 'frontend libraries are devDependencies');
        const source = fs.readFileSync(path.join(dir, template === 'react' ? 'src/App.jsx' : 'src/App.svelte'), 'utf8');
        assert.ok(!source.includes('Demo {x}'), 'braces in the app name are escaped in markup');
        if (backend) assert.match(fs.readFileSync(path.join(dir, 'backend/main.js'), 'utf8'), /^import pane from 'pane';/m);
      }
    }
  }
  assert.throws(() => appFiles({ id: 'a', name: 'A', template: 'angular' }), /Unknown template/);
});

test('template engine: placeholders and sections', () => {
  const { render } = require('../../src/cli/templates');
  const vars = { backend: true, esm: false, 'name.html': 'A &amp; B', paneName: 'pane-runtime' };
  assert.equal(render('<h1>{{name.html}}</h1>', vars), '<h1>A &amp; B</h1>');
  assert.equal(render('a{{#backend}}B{{/backend}}c{{^backend}}D{{/backend}}', vars), 'aBc');
  assert.equal(render('{{#esm}}import{{/esm}}{{^esm}}require{{/esm}}', vars), 'require');
  assert.equal(render('{{unknown}} {single} {#if x}', vars), '{{unknown}} {single} {#if x}', 'leaves Svelte/JSX braces alone');
  for (const template of TEMPLATES) {
    for (const backend of [true, false]) {
      for (const [file, text] of Object.entries(appFiles({ id: 'demo', name: 'Demo', template, backend, paneDependency: PANE_DEP }))) {
        assert.ok(!/\{\{[#^/]?[\w.]+\}\}/.test(text), `${template}/${file} has an unfilled placeholder`);
      }
    }
  }
});

test('manifest: dev and build commands', () => {
  const base = { id: 'a', name: 'A', ui: 'dist' };
  const write = (extra) => tmpApp({ 'pane.json': JSON.stringify({ ...base, ...extra }) });
  const ok = loadManifest(write({
    dev: { command: 'vite --port {port}', url: 'http://localhost:{port}' }, build: { command: 'vite build' },
  }), { requireUi: false });
  assert.deepEqual({ ...ok.dev }, { command: 'vite --port {port}', url: 'http://localhost:{port}' });
  assert.deepEqual({ ...ok.build }, { command: 'vite build' });

  const urlOnly = loadManifest(write({ dev: { url: 'http://127.0.0.1:3000/' } }), { requireUi: false });
  assert.equal(urlOnly.dev.command, null, 'a dev server you start yourself');

  assert.throws(() => loadManifest(write({ dev: { command: 'x', url: 'https://example.com' } }), { requireUi: false }), /local address/);
  assert.throws(() => loadManifest(write({ dev: { command: 'x', url: 'http://192.168.1.4:3000' } }), { requireUi: false }), /local address/);
  assert.throws(() => loadManifest(write({ dev: { command: 'vite', url: 'http://localhost:{port}' } }), { requireUi: false }), /must pass \{port\}/);
  assert.throws(() => loadManifest(write({ build: 'vite build' }), { requireUi: false }), /"build" must be an object/);
  assert.throws(() => loadManifest(write({ build: { command: 'vite build' } })), /Run `pane build`/, 'missing ui folder mentions the build');
});

test('run helpers: free port and waiting for a server', async () => {
  const port = await freePort();
  assert.ok(port > 0 && port < 65536);
  const http = require('http');
  const server = http.createServer((_q, r) => r.end('ok')).listen(port, '127.0.0.1');
  await waitForUrl(`http://127.0.0.1:${port}/`, { timeout: 3000 });
  server.close();
  await assert.rejects(waitForUrl(`http://127.0.0.1:${port}/`, { timeout: 400 }), /did not answer/);
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

test('distribution address: https only (or a local test server)', () => {
  const { distributionUrl } = require('../../src/packaging/runtime');
  const saved = process.env.PANE_DIST_URL;
  try {
    process.env.PANE_DIST_URL = 'https://downloads.example.com/pane/';
    assert.equal(distributionUrl(), 'https://downloads.example.com/pane');
    process.env.PANE_DIST_URL = 'http://127.0.0.1:8080';
    assert.equal(distributionUrl(), 'http://127.0.0.1:8080');
    process.env.PANE_DIST_URL = 'http://downloads.example.com/pane';
    assert.throws(() => distributionUrl(), /must use https/);
  } finally {
    if (saved === undefined) delete process.env.PANE_DIST_URL; else process.env.PANE_DIST_URL = saved;
  }
});

test('pane build writes installers that know the Pane version and address', { skip: process.platform === 'win32' }, async () => {
  const { buildInstaller } = require('../../src/packaging/build');
  const { RUNTIME_VERSION } = require('../../src/core/paths');
  const { execFileSync } = require('child_process');
  const dir = tmpApp(appFiles({ id: 'demo', name: "Demo's App", template: 'vanilla', backend: true }));
  fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng({ size: 64 }));
  const saved = process.env.PANE_DIST_URL;
  const savedKeys = process.env.PANE_RELEASE_KEYS;
  const releaseKey = require('../../src/core/release-signature').generateReleaseKey();
  process.env.PANE_DIST_URL = 'https://downloads.example.com/pane';
  process.env.PANE_RELEASE_KEYS = JSON.stringify([releaseKey.publicPem]);
  try {
    const result = await buildInstaller(dir);
    assert.ok(!result.warnings.some((w) => /release key/i.test(w)), result.warnings.join('\n'));
    assert.ok(!result.warnings.some((w) => /distribution address/.test(w)), result.warnings.join('\n'));
    const shPath = result.installers.find((f) => f.endsWith('install.sh'));
    const sh = fs.readFileSync(shPath, 'utf8');
    assert.ok(sh.includes(`PANE_VERSION='${RUNTIME_VERSION}'`));
    assert.ok(sh.includes('DIST_URL="${PANE_DIST_URL:-https://downloads.example.com/pane}"'));
    assert.ok(sh.includes("APP_NAME='Demo'\\''s App'"), 'quotes in the app name are escaped');
    assert.ok(sh.includes(releaseKey.publicPem.trim()), "Pane's public key is in the script");
    assert.ok(sh.includes('openssl dgst -sha256 -verify'), 'the script checks the signature');
    assert.ok(!sh.includes('PANE_RELEASE_KEYS'), 'nothing at install time can add keys');
    execFileSync('sh', ['-n', shPath]); // valid shell syntax
    if (process.platform === 'darwin') {
      const dmg = result.installers.find((f) => f.endsWith('.dmg'));
      assert.ok(dmg && fs.statSync(dmg).size > 0, 'a .dmg on macOS');
    }
    assert.ok(!fs.readdirSync(result.outDir).some((f) => f.startsWith('pane-runtime')), 'Pane itself is never bundled');
  } finally {
    if (saved === undefined) delete process.env.PANE_DIST_URL; else process.env.PANE_DIST_URL = saved;
    if (savedKeys === undefined) delete process.env.PANE_RELEASE_KEYS; else process.env.PANE_RELEASE_KEYS = savedKeys;
  }
});

test('pane build signs the app with --key, and warns without one', { skip: process.platform === 'win32' }, async () => {
  const { buildInstaller } = require('../../src/packaging/build');
  const { generateAppKey, fingerprint, verifyApp, SIGNATURE_FILE } = require('../../src/core/app-signature');
  const { execFileSync } = require('child_process');
  const dir = tmpApp(appFiles({ id: 'signed-demo', name: 'Signed Demo', template: 'vanilla', backend: false }));
  fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng({ size: 64 }));
  const key = generateAppKey();
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-key-')), 'app.pem');
  fs.writeFileSync(keyFile, key.privatePem);
  const unpack = (pkg) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-unpack-'));
    execFileSync('tar', ['-xzf', pkg, '-C', out]);
    return out;
  };

  const signed = await buildInstaller(dir, { key: keyFile });
  assert.equal(signed.publisher.fingerprint, fingerprint(key.publicPem));
  assert.ok(!signed.warnings.some((w) => /unsigned/.test(w)), signed.warnings.join('\n'));
  const signer = verifyApp(unpack(signed.package), { id: 'signed-demo', version: '0.1.0' });
  assert.equal(signer.fingerprint, fingerprint(key.publicPem));

  const unsigned = await buildInstaller(dir);
  assert.equal(unsigned.publisher, null);
  assert.ok(unsigned.warnings.some((w) => /unsigned/.test(w)), unsigned.warnings.join('\n'));
  assert.ok(!fs.existsSync(path.join(unpack(unsigned.package), SIGNATURE_FILE)));
});
