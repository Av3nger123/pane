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
