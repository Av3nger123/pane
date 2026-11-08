'use strict';
// A signing identity of this computer's own, for macOS app launchers.
//
// macOS lets an app read its keychain items (what pane.secrets uses) only
// while its signature still matches the one that created them. An ad hoc
// signature changes every time a launcher is rebuilt, for example when Pane
// updates, and the app then asks for the user's password. A launcher signed
// with one stable certificate keeps that access.
//
// The certificate is self-signed, made on first use, and kept in a keychain
// of Pane's own (PANE_HOME/signing/pane.keychain-db) whose random password
// is stored next to it (mode 0600). codesign finds identities only in
// keychains on the user's search list, so Pane's keychain is appended there;
// every existing entry is kept. The login keychain is never touched, and the
// user's password is never asked for.
//
// Accepted risk: a program already running as the user could read the
// password file and sign as "Pane Local Signing". Such a program can already
// change the apps' own files in PANE_HOME/apps, so this adds no new exposure.
//
// PANE_LAUNCHER_SIGNING=adhoc turns this off (tests that don't concern signing).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { paneHome } = require('../../core/paths');
const { takeLock } = require('../../core/update-state');

const NAME = 'Pane Local Signing';

class LocalIdentityError extends Error {}

function security(...args) {
  try {
    return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}`.trim();
    throw new LocalIdentityError(`The macOS security tool failed (${args[0]}).${output ? `\n${output}` : ''}`);
  }
}

const signingDir = () => path.join(paneHome(), 'signing');

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function searchList() {
  return security('list-keychains', '-d', 'user').split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

// Appends the keychain to the user's search list unless it is already there.
function addToSearchList(keychain) {
  const list = searchList();
  const want = realpath(keychain);
  if (list.some((entry) => realpath(entry) === want)) return;
  security('list-keychains', '-d', 'user', '-s', ...list, keychain);
}

function findIdentity(keychain) {
  const match = new RegExp(`\\b([0-9A-F]{40})\\b "${NAME}`).exec(security('find-identity', '-p', 'codesigning', keychain));
  return match ? match[1] : null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Creates the keychain and the certificate. Called with the signing lock held.
function create(dir, keychain, passwordFile) {
  // A keychain without its password (or the reverse) is useless: start over.
  if (fs.existsSync(keychain)) {
    try { security('delete-keychain', keychain); } catch { fs.rmSync(keychain, { force: true }); }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });

  const work = fs.mkdtempSync(path.join(dir, 'new-'));
  try {
    const key = path.join(work, 'key.pem');
    const cert = path.join(work, 'cert.pem');
    const p12 = path.join(work, 'identity.p12');
    const host = os.hostname().replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) || 'this Mac';
    const transfer = crypto.randomBytes(16).toString('hex');
    const openssl = (args) => execFileSync('openssl', args, { stdio: 'pipe' });
    try {
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7300', '-subj', `/CN=${NAME} (${host})`,
        '-addext', 'extendedKeyUsage=critical,codeSigning', '-addext', 'keyUsage=critical,digitalSignature',
        '-addext', 'basicConstraints=critical,CA:FALSE', '-keyout', key, '-out', cert]);
      openssl(['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `pass:${transfer}`,
        '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']);
    } catch (err) {
      throw new LocalIdentityError(`Could not make Pane's signing certificate with openssl.\n${`${err.stderr || ''}`.trim()}`);
    }
    security('create-keychain', '-p', password, keychain);
    security('unlock-keychain', '-p', password, keychain);
    security('set-keychain-settings', keychain); // no auto-lock
    security('import', p12, '-k', keychain, '-P', transfer, '-T', '/usr/bin/codesign');
    security('set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// { identity: SHA-1 of the certificate, keychain } or null when launchers
// are signed ad hoc (not macOS, or PANE_LAUNCHER_SIGNING=adhoc).
function ensureLocalIdentity({ env = process.env } = {}) {
  if (process.platform !== 'darwin' || env.PANE_LAUNCHER_SIGNING === 'adhoc') return null;
  const dir = signingDir();
  const keychain = path.join(dir, 'pane.keychain-db');
  const passwordFile = path.join(dir, 'password');
  const readPassword = () => { try { return fs.readFileSync(passwordFile, 'utf8').trim(); } catch { return null; } };

  let release = null;
  for (let waited = 0; !(release = takeLock('signing')); waited += 200) {
    if (waited >= 30000) throw new LocalIdentityError('Another Pane is still setting up launcher signing. Try again in a minute.');
    sleep(200);
  }
  try {
    const password = readPassword();
    let identity = null;
    if (password && fs.existsSync(keychain)) {
      try {
        security('unlock-keychain', '-p', password, keychain);
        identity = findIdentity(keychain);
      } catch { identity = null; }
    }
    if (!identity) {
      create(dir, keychain, passwordFile);
      identity = findIdentity(keychain);
      if (!identity) throw new LocalIdentityError("Pane's signing certificate was made but macOS does not list it.");
    }
    addToSearchList(keychain);
    return { identity, keychain };
  } finally {
    release();
  }
}

module.exports = { ensureLocalIdentity, LocalIdentityError };
