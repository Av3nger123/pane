'use strict';
// Signatures on apps.
//
// `pane build --key <file>` signs the app with its developer's Ed25519 key:
// a list of every file's SHA-256 (and every symlink's target), with the app's
// id and version, signed and stored in .pane-signature.json at the app's root.
// `pane install` checks it, and an app id then belongs to the key that first
// installed it (src/packaging/publishers.js).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SIGNATURE_FILE = '.pane-signature.json';

class AppSignatureError extends Error {}

function generateAppKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

const spkiDer = (key) => (key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key))
  .export({ type: 'spki', format: 'der' });

// "3f9a 1c22 0b7e 91d4": the first 64 bits of the key's SHA-256.
function fingerprint(publicKey) {
  const hex = crypto.createHash('sha256').update(spkiDer(publicKey)).digest('hex').slice(0, 16);
  return hex.match(/.{4}/g).join(' ');
}

// [[path, "sha256:<hex>" | "link:<target>" | "dir"]], sorted by path.
function hashTree(dir) {
  const out = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    if (rel && !entries.length) out.push([rel, 'dir']);
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (child === SIGNATURE_FILE) continue;
      const full = path.join(dir, child);
      if (e.isSymbolicLink()) out.push([child, `link:${fs.readlinkSync(full)}`]);
      else if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push([child, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`]);
      else throw new AppSignatureError(`${child} is not a file, folder or link, so it cannot be signed.`);
    }
  };
  walk('');
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function signApp(dir, { id, version, publisher }, privatePem) {
  const privateKey = crypto.createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new AppSignatureError('App signing keys must be Ed25519 keys (create one with "pane keygen <file>").');
  const signed = JSON.stringify({ format: 1, id, version, publisher: publisher || null, files: hashTree(dir) });
  const record = {
    format: 1,
    publicKey: spkiDer(privateKey).toString('base64'),
    signed,
    signature: crypto.sign(null, Buffer.from(signed), privateKey).toString('base64'),
  };
  fs.writeFileSync(path.join(dir, SIGNATURE_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// null when the app is unsigned; the signer when everything matches; throws
// AppSignatureError otherwise.
function verifyApp(dir, { id, version }) {
  const file = path.join(dir, SIGNATURE_FILE);
  if (!fs.existsSync(file)) return null;
  let record;
  let signed;
  let publicKey;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
    publicKey = crypto.createPublicKey({ key: Buffer.from(record.publicKey, 'base64'), format: 'der', type: 'spki' });
    signed = JSON.parse(record.signed);
  } catch {
    throw new AppSignatureError(`The app's signature file (${SIGNATURE_FILE}) is damaged.`);
  }
  if (record.format !== 1 || signed.format !== 1) throw new AppSignatureError('The app is signed in a format this Pane does not know. Update Pane.');
  if (!crypto.verify(null, Buffer.from(record.signed), publicKey, Buffer.from(String(record.signature), 'base64'))) {
    throw new AppSignatureError("The app's signature is not valid. It was changed after it was signed.");
  }
  if (signed.id !== id || signed.version !== version) {
    throw new AppSignatureError(`The signature is for ${signed.id} ${signed.version}, but this app is ${id} ${version} (its id or version was changed after signing).`);
  }
  const expected = new Map(signed.files);
  const actual = new Map(hashTree(dir));
  const differences = [];
  for (const [p, h] of actual) if (expected.get(p) !== h) differences.push(expected.has(p) ? `changed: ${p}` : `added: ${p}`);
  for (const p of expected.keys()) if (!actual.has(p)) differences.push(`missing: ${p}`);
  if (differences.length) {
    const more = differences.length > 5 ? ` and ${differences.length - 5} more` : '';
    throw new AppSignatureError(`The app's files do not match its signature (${differences.slice(0, 5).join(', ')}${more}).`);
  }
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), fingerprint: fingerprint(publicKey), publisher: signed.publisher || null };
}

module.exports = {
  SIGNATURE_FILE, AppSignatureError, generateAppKey, fingerprint, hashTree, signApp, verifyApp,
};
