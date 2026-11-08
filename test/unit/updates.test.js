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
