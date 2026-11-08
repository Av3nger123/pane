'use strict';
// Who owns an app id on this computer.
//
// The first install of an id records its signing key (or that it was
// unsigned). After that, only apps signed with that key can replace it, so
// another publisher cannot ship an app with the same id and take over its
// data, store and secrets. `pane uninstall <id> --purge` deletes the data and
// forgets the key.
//
// PANE_HOME/publishers.json: { "<id>": { publicKey, name, since } | null }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { paneHome } = require('../core/paths');
const { fingerprint } = require('../core/app-signature');

class PublisherError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PUBLISHER_CHANGED';
  }
}

const file = () => path.join(paneHome(), 'publishers.json');

// Only a missing file means "nothing recorded". Anything else stops the
// install: treating a damaged file as empty would forget every owner.
function readAll() {
  let text;
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${file()}: ${err.message}`);
  }
  let all;
  try { all = JSON.parse(text); } catch { all = null; }
  const valid = all && typeof all === 'object' && !Array.isArray(all)
    && Object.values(all).every((r) => r === null || (r && typeof r.publicKey === 'string'));
  if (!valid) throw new Error(`${file()} is damaged, so Pane cannot tell who owns each app. Fix or remove it, then try again.`);
  return all;
}

const sameKey = (a, b) => {
  const der = (pem) => crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return der(a).equals(der(b));
};

function writeAll(all) {
  fs.mkdirSync(paneHome(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file());
}

// undefined: never installed; null: installed unsigned; else the record.
function publisherOf(id) {
  const all = readAll();
  return Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
}

// signer: what verifyApp returned (null for an unsigned app).
function checkPublisher(id, signer) {
  const known = publisherOf(id);
  if (!known) return;
  const fp = fingerprint(known.publicKey);
  if (!signer) {
    throw new PublisherError(`${id} is installed from a signed publisher (key ${fp}), and this copy is unsigned. Nothing was installed.`);
  }
  if (!sameKey(known.publicKey, signer.publicKey)) {
    throw new PublisherError(`${id} is installed from a different publisher (key ${fp}). This copy is signed with key ${signer.fingerprint}. `
      + `Nothing was installed. To replace it and delete its data, run: pane uninstall ${id} --purge`);
  }
}

// Never replaces a recorded key; may replace "unsigned" with a key.
function recordPublisher(id, signer) {
  const all = readAll();
  if (all[id]) return;
  if (!signer && Object.prototype.hasOwnProperty.call(all, id)) return;
  all[id] = signer ? { publicKey: signer.publicKey, name: signer.publisher || null, since: new Date().toISOString() } : null;
  writeAll(all);
}

function forgetPublisher(id) {
  const all = readAll();
  if (!Object.prototype.hasOwnProperty.call(all, id)) return;
  delete all[id];
  writeAll(all);
}

module.exports = {
  PublisherError, checkPublisher, recordPublisher, forgetPublisher, publisherOf,
};
