'use strict';
// Signatures: Pane's runtime releases, app packages, and Electron fuses.
// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  generateReleaseKey, signRelease, verifyRelease, checkReleaseKeys, jwkParts, releaseKeys,
} = require('../../src/core/release-signature');

const A = generateReleaseKey();
const B = generateReleaseKey();

test('release signatures: sign, verify, reject', () => {
  const data = Buffer.from('runtime');
  const sig = signRelease(data, A.privatePem);
  assert.equal(sig.length, 384);
  assert.equal(verifyRelease(data, sig, [A.publicPem]), true);
  assert.equal(verifyRelease(data, sig, [B.publicPem, A.publicPem]), true);
  assert.equal(verifyRelease(data, sig, [B.publicPem]), false);
  const changed = Buffer.from(data);
  changed[0] ^= 1;
  assert.equal(verifyRelease(changed, sig, [A.publicPem]), false);
  assert.equal(verifyRelease(data, sig.subarray(0, 100), [A.publicPem]), false);
});

test('release keys: only RSA of 3072 bits or more', () => {
  const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => checkReleaseKeys([ed]), /RSA/);
  assert.throws(() => checkReleaseKeys([small]), /3072/);
  assert.throws(() => checkReleaseKeys('not a list'), /list/);
  assert.deepEqual(releaseKeys({ env: { PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) } }), [A.publicPem.trim()]);
});

test('jwkParts matches the key', () => {
  const [n, e] = jwkParts(A.publicPem).split('.');
  const rebuilt = crypto.createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' });
  const spki = (k) => k.export({ type: 'spki', format: 'der' });
  assert.deepEqual(spki(rebuilt), spki(crypto.createPublicKey(A.publicPem)));
});

test('pack-runtime writes a signature that verifies', { skip: process.platform === 'win32' }, () => {
  const { packRuntime } = require('../../src/packaging/runtime');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-pack-'));
  const saved = process.env.PANE_RELEASE_SIGNING_KEY;
  delete process.env.PANE_RELEASE_SIGNING_KEY;
  try {
    const result = packRuntime({ out, signingKey: A.privatePem });
    assert.equal(result.signature, `${result.archive}.sig`);
    assert.equal(verifyRelease(fs.readFileSync(result.archive), fs.readFileSync(result.signature), [A.publicPem]), true);
    assert.throws(() => packRuntime({ out }), /release signing key is missing/);
  } finally {
    if (saved !== undefined) process.env.PANE_RELEASE_SIGNING_KEY = saved;
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 });
  }
});

// ---- App signatures -------------------------------------------------------

const {
  SIGNATURE_FILE, generateAppKey, fingerprint, signApp, verifyApp,
} = require('../../src/core/app-signature');
const { execFileSync } = require('child_process');

const appKeyA = generateAppKey();
const appKeyB = generateAppKey();

function signedAppDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-sign-'));
  fs.writeFileSync(path.join(dir, 'pane.json'), '{"id":"notes","name":"Notes","version":"1.2.0"}');
  fs.mkdirSync(path.join(dir, 'ui'));
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<p>notes</p>');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'cli.js'), 'console.log(1)');
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
  fs.symlinkSync('../x/cli.js', path.join(dir, 'node_modules', '.bin', 'x'));
  fs.mkdirSync(path.join(dir, 'data'));
  signApp(dir, { id: 'notes', version: '1.2.0', publisher: 'Acme' }, appKeyA.privatePem);
  return dir;
}

// What `pane install` sees: the package unpacked from a tar.gz.
function roundTrip(dir) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-unpacked-'));
  const tgz = path.join(os.tmpdir(), `pane-sign-${process.pid}-${Date.now()}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, ...fs.readdirSync(dir)]);
  execFileSync('tar', ['-xzf', tgz, '-C', out]);
  fs.rmSync(tgz);
  return out;
}

test('app signatures: sign, verify, detect changes', { skip: process.platform === 'win32' }, () => {
  const dir = roundTrip(signedAppDir());
  const id = { id: 'notes', version: '1.2.0' };
  const signer = verifyApp(dir, id);
  assert.equal(signer.fingerprint, fingerprint(appKeyA.publicPem));
  assert.equal(signer.publisher, 'Acme');

  const changed = roundTrip(dir);
  fs.appendFileSync(path.join(changed, 'ui', 'index.html'), 'x');
  assert.throws(() => verifyApp(changed, id), /do not match/);
  const added = roundTrip(dir);
  fs.writeFileSync(path.join(added, 'ui', 'extra.js'), '');
  assert.throws(() => verifyApp(added, id), /do not match/);
  const removed = roundTrip(dir);
  fs.rmSync(path.join(removed, 'ui', 'index.html'));
  assert.throws(() => verifyApp(removed, id), /do not match/);

  assert.throws(() => verifyApp(dir, { id: 'other', version: '1.2.0' }), /id/);

  const forged = roundTrip(dir);
  const file = path.join(forged, SIGNATURE_FILE);
  const sig = JSON.parse(fs.readFileSync(file, 'utf8'));
  sig.signature = crypto.sign(null, Buffer.from(sig.signed), appKeyB.privatePem).toString('base64');
  fs.writeFileSync(file, JSON.stringify(sig));
  assert.throws(() => verifyApp(forged, id), /signature/);

  const unsigned = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-unsigned-'));
  assert.equal(verifyApp(unsigned, id), null);
});

test('fingerprint format', () => {
  const fp = fingerprint(appKeyA.publicPem);
  assert.match(fp, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  assert.equal(fingerprint(appKeyA.publicPem), fp);
  assert.notEqual(fingerprint(appKeyB.publicPem), fp);
});
