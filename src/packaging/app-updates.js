'use strict';
// Apps updating themselves. The app decides when and shows its own UI
// (pane.updates); Pane only checks, downloads, verifies, and installs the
// update the next time the app starts, never under the running app.
//
// One rule: an update is installed only if it is signed with the key the app
// was installed with. Apps installed unsigned cannot update themselves.
//
//   PANE_HOME/updates/<id>/<id>-<version>.paneapp   a downloaded update
//   record.pendingUpdate                            the update to install on restart

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadManifest, ID_RE } = require('../core/manifest');
const { parseUpdateFile } = require('../core/app-update');
const { verifyApp, fingerprint } = require('../core/app-signature');
const { parse, compare, satisfies } = require('../core/version');
const { RUNTIME_ROOT, paneHome, appsDir } = require('../core/paths');
const { publisherOf, sameKey } = require('./publishers');
const { readRecord, writeRecord, installApp } = require('./apps');
const { installedRuntime, runtimeVersionOf } = require('./runtime');
const { fetchTo } = require('./runtime-download');

class AppUpdateError extends Error {}

const newer = (a, b) => compare(parse(a), parse(b)) > 0;
const updatesDir = (id) => path.join(paneHome(), 'updates', id);

function installed(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new AppUpdateError(`"${id}" is not an app id.`);
  const dir = path.join(appsDir(), id);
  const record = readRecord(dir);
  if (!record) throw new AppUpdateError(`No installed app with the id "${id}".`);
  return { dir, record, manifest: loadManifest(dir) };
}

// The key the app was installed with.
function ownerKey(id, manifest) {
  const owner = publisherOf(id);
  if (!owner) {
    throw new AppUpdateError(`${manifest.name} is not signed, so it cannot update itself. Its developer must build it with pane build --key.`);
  }
  return owner.publicKey;
}

async function readUpdateFile(manifest) {
  if (!manifest.updates) throw new AppUpdateError(`${manifest.name} has no update address ("updates" in its pane.json).`);
  let text;
  try {
    const response = await fetch(manifest.updates, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    text = await response.text();
  } catch (err) {
    throw new AppUpdateError(`Could not read ${manifest.name}'s update file at ${manifest.updates}: ${err.message}`);
  }
  try {
    return parseUpdateFile(text);
  } catch (err) {
    throw new AppUpdateError(`${manifest.name}'s update file at ${manifest.updates} is not usable. ${err.message}`);
  }
}

// { available, version, current, notes }
async function checkAppUpdate(id) {
  const { manifest } = installed(id);
  ownerKey(id, manifest);
  const update = await readUpdateFile(manifest);
  return { available: newer(update.version, manifest.version), version: update.version, current: manifest.version, notes: update.notes };
}

// Downloads the update the app's update file names. Returns the file.
async function downloadAppUpdate(id, { onProgress } = {}) {
  const { manifest } = installed(id);
  ownerKey(id, manifest);
  const update = await readUpdateFile(manifest);
  if (!newer(update.version, manifest.version)) throw new AppUpdateError(`${manifest.name} ${manifest.version} is up to date.`);
  const dir = updatesDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-${update.version}.paneapp`);
  const partial = `${file}.partial`;
  try {
    try {
      await fetchTo(update.url, partial, onProgress);
    } catch (err) {
      throw new AppUpdateError(`Could not download ${manifest.name} ${update.version}: ${err.message}`);
    }
    if (update.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(partial)).digest('hex');
      if (actual !== update.sha256) {
        throw new AppUpdateError(`The download of ${manifest.name} ${update.version} does not match its update file (sha256). Try again later.`);
      }
    }
    fs.renameSync(partial, file);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return file;
}

// Checks a downloaded (or handed-over) update and records it, to be installed
// the next time the app starts. Returns { version }.
async function stageAppUpdate(id, file) {
  const { manifest } = installed(id);
  const key = ownerKey(id, manifest);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-update-'));
  try {
    try {
      execFileSync('tar', ['-xzf', path.resolve(file), '-C', work], { stdio: 'pipe' });
    } catch {
      throw new AppUpdateError(`${manifest.name}'s update could not be unpacked. It is not a .paneapp file.`);
    }
    let incoming;
    try {
      incoming = loadManifest(work);
    } catch (err) {
      throw new AppUpdateError(`${manifest.name}'s update is not a valid app. ${err.message}`);
    }
    if (incoming.id !== id) throw new AppUpdateError(`This update is for ${incoming.id}, not ${manifest.name}. It was refused.`);
    let signer;
    try {
      signer = verifyApp(work, incoming);
    } catch (err) {
      throw new AppUpdateError(`${manifest.name}'s update was refused. ${err.message}`);
    }
    if (!signer) throw new AppUpdateError(`${manifest.name}'s update is unsigned, so it was refused.`);
    if (!sameKey(key, signer.publicKey)) {
      throw new AppUpdateError(`${manifest.name}'s update is not signed by its publisher (key ${fingerprint(key)}). `
        + `It is signed with key ${signer.fingerprint}, so it was refused.`);
    }
    if (!newer(incoming.version, manifest.version)) {
      throw new AppUpdateError(`${manifest.name}'s update (${incoming.version}) is not newer than the installed version (${manifest.version}).`);
    }
    if (incoming.pane) await ensurePane(manifest.name, incoming);

    // Pane keeps its own copy: the app may delete the file it handed over.
    const dir = updatesDir(id);
    fs.mkdirSync(dir, { recursive: true });
    let kept = path.join(dir, `${id}-${incoming.version}.paneapp`);
    if (path.resolve(file) !== kept) fs.copyFileSync(file, kept);
    else kept = path.resolve(file);
    const { dir: appDir, record } = installed(id);
    if (record.pendingUpdate && record.pendingUpdate !== kept) fs.rmSync(record.pendingUpdate, { force: true });
    writeRecord(appDir, { ...record, pendingUpdate: kept });
    return { version: incoming.version };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// An update that needs a newer Pane gets it first, quietly.
async function ensurePane(name, incoming) {
  const current = () => runtimeVersionOf(installedRuntime() || RUNTIME_ROOT);
  if (satisfies(current(), incoming.pane)) return;
  const result = await require('./self-update').selfUpdate({ force: true });
  if (satisfies(current(), incoming.pane)) return;
  const reason = result.error || `the newest Pane is ${result.version || current()}`;
  throw new AppUpdateError(`${name} ${incoming.version} needs Pane ${incoming.pane}, which could not be installed: ${reason}.`);
}

// Installs a staged update (pane launcher-refresh, when the app restarts).
function applyPendingUpdate(id, file) {
  const { dir, record } = installed(id);
  if (record.pendingUpdate) {
    const cleared = { ...record };
    delete cleared.pendingUpdate;
    writeRecord(dir, cleared);
  }
  const next = installApp(file, { requireSigner: true, expectId: id });
  fs.rmSync(file, { force: true });
  return next;
}

module.exports = { checkAppUpdate, downloadAppUpdate, stageAppUpdate, applyPendingUpdate, AppUpdateError };
