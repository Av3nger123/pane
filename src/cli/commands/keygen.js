'use strict';
// pane keygen --release <file>   Pane's release key (for whoever publishes Pane)

const fs = require('fs');
const path = require('path');
const { generateReleaseKey } = require('../../core/release-signature');
const { UsageError } = require('../util');

function keygen(file, flags) {
  if (!file || !flags.release) throw new UsageError('pane keygen --release <file>');
  const target = path.resolve(file);
  const { privatePem, publicPem } = generateReleaseKey();
  writeSecret(target, privatePem);
  console.log(`Wrote Pane's private release key to ${target}\n`);
  console.log(publicPem.trim());
  console.log('\nAdd this public key to "pane.releaseKeys" in package.json. Store the private key as the GitHub secret');
  console.log('PANE_RELEASE_SIGNING_KEY, then delete this file.');
  return 0;
}

// Never overwrites: a lost or replaced key cannot be recovered.
function writeSecret(target, pem) {
  if (fs.existsSync(target)) throw new Error(`${target} already exists. Choose another file; keys are never overwritten.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pem, { mode: 0o600, flag: 'wx' });
}

module.exports = { keygen, writeSecret };
