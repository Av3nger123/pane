'use strict';
// Updates: Pane updating itself, and apps updating themselves. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateReleaseKey } = require('../../src/core/release-signature');

const A = generateReleaseKey();
const B = generateReleaseKey();

// Runs fn with these environment variables set, then restores them.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('latestUrl: https only, localhost for tests, env override', () => withEnv({ PANE_LATEST_URL: undefined }, () => {
  const { latestUrl } = require('../../src/packaging/runtime');
  process.env.PANE_LATEST_URL = 'https://downloads.example.com/pane/latest.json';
  assert.equal(latestUrl(), 'https://downloads.example.com/pane/latest.json');
  process.env.PANE_LATEST_URL = 'http://127.0.0.1:8080/pane-latest.json';
  assert.equal(latestUrl(), 'http://127.0.0.1:8080/pane-latest.json');
  process.env.PANE_LATEST_URL = 'http://downloads.example.com/latest.json';
  assert.throws(() => latestUrl(), /must use https/);
  delete process.env.PANE_LATEST_URL;
  assert.match(latestUrl(), /^https:\/\/github\.com\/Av3nger123\/pane\/releases\/latest\/download\/pane-latest\.json$/);
}));

// One packed 0.1.1, signed with A and trusting A, shared by the tests below.
let packed = null;
async function packedRuntime() {
  if (packed) return packed;
  const { packRuntime } = require('../../src/packaging/runtime');
  const out = tmp('pane-pack-');
  packed = await withEnv({ PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) },
    () => packRuntime({ out, signingKey: A.privatePem, version: '0.1.1' }));
  packed.out = out;
  return packed;
}

test('pack-runtime: latest file, baked keys, other versions', { skip: process.platform === 'win32' }, async () => {
  const result = await packedRuntime();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.out, 'pane-latest.json'), 'utf8')), { version: '0.1.1' });
  assert.equal(result.latest, path.join(result.out, 'pane-latest.json'));
  assert.match(path.basename(result.archive), /^pane-runtime-0\.1\.1-/);
  const unpacked = tmp('pane-unpacked-');
  execFileSync('tar', ['-xzf', result.archive, '-C', unpacked]);
  const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.1');
  assert.deepEqual(pkg.pane.releaseKeys, [A.publicPem.trim()]);
  fs.rmSync(unpacked, { recursive: true, force: true });
});

module.exports = { withEnv, packedRuntime, A, B, tmp };

// ---- Downloading a Pane ---------------------------------------------------

const { serveDir } = require('../e2e/lib/serve');

// A copy of a packed distribution with one change.
function distCopy(src, change) {
  const out = tmp('pane-dist-');
  fs.cpSync(src, out, { recursive: true });
  change(out);
  return out;
}

test('downloadRuntime installs a signed Pane of the asked version', { skip: process.platform === 'win32' }, async () => {
  const { downloadRuntime } = require('../../src/packaging/runtime-download');
  const result = await packedRuntime();
  const server = await serveDir(result.out);
  try {
    await withEnv({ PANE_HOME: tmp('pane-home-') }, async () => {
      const installed = await downloadRuntime({ version: '0.1.1', dist: server.url, keys: [A.publicPem] });
      assert.equal(installed.version, '0.1.1');
      assert.ok(fs.existsSync(path.join(installed.dir, 'main.js')));
      assert.equal(path.basename(installed.dir), '0.1.1');
    });
  } finally {
    server.close();
  }
});

test('downloadRuntime refuses a wrong key, a missing signature, a wrong version', { skip: process.platform === 'win32' }, async () => {
  const { downloadRuntime } = require('../../src/packaging/runtime-download');
  const { packRuntime, runtimeArchiveName } = require('../../src/packaging/runtime');
  const result = await packedRuntime();
  const name = runtimeArchiveName('0.1.1');
  const unsigned = distCopy(result.out, (d) => fs.rmSync(path.join(d, 'v0.1.1', `${name}.sig`)));
  // A correctly signed 0.1.2 served under 0.1.1's name.
  const other = tmp('pane-pack-');
  await withEnv({ PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) }, () => packRuntime({ out: other, signingKey: A.privatePem, version: '0.1.2' }));
  const swapped = distCopy(result.out, (d) => {
    const from = path.join(other, 'v0.1.2', runtimeArchiveName('0.1.2'));
    fs.copyFileSync(from, path.join(d, 'v0.1.1', name));
    fs.copyFileSync(`${from}.sig`, path.join(d, 'v0.1.1', `${name}.sig`));
  });
  const servers = await Promise.all([result.out, unsigned, swapped].map(serveDir));
  try {
    await withEnv({ PANE_HOME: tmp('pane-home-') }, async () => {
      const { runtimesDir } = require('../../src/core/paths');
      const versions = () => (fs.existsSync(runtimesDir()) ? fs.readdirSync(runtimesDir()).filter((v) => /^\d/.test(v)) : []);
      await assert.rejects(downloadRuntime({ version: '0.1.1', dist: servers[0].url, keys: [B.publicPem] }), /not signed by Pane/);
      await assert.rejects(downloadRuntime({ version: '0.1.1', dist: servers[1].url, keys: [A.publicPem] }), /not signed by Pane|signature/);
      await assert.rejects(downloadRuntime({ version: '0.1.1', dist: servers[2].url, keys: [A.publicPem] }), /version 0\.1\.2.*0\.1\.1/);
      assert.deepEqual(versions(), []);
    });
  } finally {
    servers.forEach((s) => s.close());
  }
});
