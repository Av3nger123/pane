'use strict';
// Signatures on Pane's runtime archives.
//
// App installers download Pane on computers that lack it. Before installing
// it they check <archive>.sig against Pane's public keys, which `pane build`
// writes into each installer. The check runs before any Pane exists: in
// install.sh with the system's openssl, and in PaneSetup.exe with .NET
// Framework. Both verify RSA PKCS#1 v1.5 with SHA-256, so that is the format.

const crypto = require('crypto');

const MIN_BITS = 3072;

function generateReleaseKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: MIN_BITS });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

// Raw signature bytes (384 for a 3072-bit key): what openssl dgst -signature reads.
function signRelease(data, privatePem) {
  return crypto.sign('sha256', data, privatePem);
}

function verifyRelease(data, signature, publicPems) {
  return publicPems.some((pem) => {
    try { return crypto.verify('sha256', data, pem, signature); } catch { return false; }
  });
}

function checkReleaseKeys(publicPems) {
  if (!Array.isArray(publicPems)) throw new Error("Pane's release keys must be a list of public keys (PEM).");
  return publicPems.map((pem, i) => {
    let key;
    try { key = crypto.createPublicKey(String(pem)); } catch {
      throw new Error(`Release key ${i + 1} is not a public key in PEM format.`);
    }
    if (key.asymmetricKeyType !== 'rsa') throw new Error(`Release key ${i + 1} must be an RSA key; installers can only check RSA signatures.`);
    const bits = key.asymmetricKeyDetails.modulusLength;
    if (bits < MIN_BITS) throw new Error(`Release key ${i + 1} has ${bits} bits; it needs at least ${MIN_BITS}.`);
    return String(pem).trim();
  });
}

// "<n>.<e>" in base64url: how PaneSetup.exe receives a key.
function jwkParts(publicPem) {
  const { n, e } = crypto.createPublicKey(publicPem).export({ format: 'jwk' });
  return `${n}.${e}`;
}

// The keys installers trust, decided when an app is built: PANE_RELEASE_KEYS
// (a JSON list, for testing) or "pane.releaseKeys" in Pane's package.json.
function releaseKeys({ env = process.env } = {}) {
  if (env.PANE_RELEASE_KEYS) {
    let list;
    try { list = JSON.parse(env.PANE_RELEASE_KEYS); } catch {
      throw new Error('PANE_RELEASE_KEYS must be a JSON list of public keys (PEM).');
    }
    return checkReleaseKeys(list);
  }
  const pkg = require('../../package.json');
  return checkReleaseKeys((pkg.pane && pkg.pane.releaseKeys) || []);
}

module.exports = {
  generateReleaseKey, signRelease, verifyRelease, checkReleaseKeys, jwkParts, releaseKeys,
};
