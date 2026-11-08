'use strict';
// pane keygen <file>             a key for signing your apps (pane build --key)
// pane keygen --release <file>   Pane's release key (for whoever publishes Pane)

const fs = require('fs');
const path = require('path');
const { generateReleaseKey } = require('../../core/release-signature');
const { generateAppKey, fingerprint } = require('../../core/app-signature');
const { UsageError } = require('../util');

function keygen(file, flags) {
  if (!file) throw new UsageError('pane keygen <file>   (or: pane keygen --release <file>)');
  const target = path.resolve(file);
  if (flags.release) {
    const { privatePem, publicPem } = generateReleaseKey();
    writeSecret(target, privatePem);
    console.log(`Wrote Pane's private release key to ${target}\n`);
    console.log(publicPem.trim());
    console.log('\nAdd this public key to "pane.releaseKeys" in package.json. Store the private key as the GitHub secret');
    console.log('PANE_RELEASE_SIGNING_KEY, then delete this file.');
    return 0;
  }
  const { privatePem } = generateAppKey();
  writeSecret(target, privatePem);
  console.log(`Wrote your signing key to ${target}`);
  console.log(`  key: ${fingerprint(privatePem)}\n`);
  console.log('Build with: pane build --key <file>   (in CI: put the file\'s contents in PANE_SIGNING_KEY)');
  console.log('Keep this file secret and backed up. Every update to your apps must be signed with it;');
  console.log('without it, users cannot update them.');
  return 0;
}

// Never overwrites: a lost or replaced key cannot be recovered.
function writeSecret(target, pem) {
  if (fs.existsSync(target)) throw new Error(`${target} already exists. Choose another file; keys are never overwritten.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pem, { mode: 0o600, flag: 'wx' });
}

module.exports = { keygen, writeSecret };
