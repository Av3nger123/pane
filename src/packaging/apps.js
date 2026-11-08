'use strict';
// Installing, removing and listing apps on this computer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadManifest, ID_RE } = require('../core/manifest');
const { satisfies } = require('../core/version');
const { createLauncher, removeLauncher, fileName } = require('./launchers');
const { verifyApp, AppSignatureError } = require('../core/app-signature');
const { runningApps } = require('../core/running');
const { REOPENED_FLAG } = require('../core/update-state');
const { runtimeVersionOf } = require('./runtime');
const {
  checkPublisher, recordPublisher, forgetPublisher, publisherOf,
} = require('./publishers');
const { RUNTIME_ROOT, RUNTIME_VERSION, paneHome, appsDir, launchersDir, samePath } = require('../core/paths');

const RECORD = '.pane-install.json';
// Never copied when installing or packaging an app. `release` is where
// `pane build` writes installers.
const SKIP_IN_APP = new Set(['.git', 'release', '.DS_Store']);

// Exit code of `pane install` when the app needs a newer Pane. Installers
// react by downloading the Pane version the app was built with.
const EXIT_NEEDS_NEWER_PANE = 3;

// The install script. `gui` makes it report through notifications and dialogs
// (the macOS "Install <App>" app) instead of only the terminal; `packageExpr`
// is where the .paneapp sits relative to the script.
// Installs an app folder or a .paneapp file. Launchers point at the runtime
// running this command.
//
// requireSigner (app updates): the app must be signed with the key already
// recorded for its id, so an update can never be unsigned, switch an
// unsigned app to signed, or change publisher. expectId: the id it must have.
function installApp(source, { requireSigner = false, expectId } = {}) {
  const src = path.resolve(source);
  let unpacked = null;
  let appSource = src;
  if (/\.paneapp$/i.test(src)) {
    unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-install-'));
    execFileSync('tar', ['-xzf', src, '-C', unpacked], { stdio: 'pipe' });
    appSource = unpacked;
  }
  try {
    const incoming = loadManifest(appSource);
    if (!satisfies(RUNTIME_VERSION, incoming.pane)) {
      const err = new Error(`${incoming.name} needs Pane ${incoming.pane}. This computer has Pane ${RUNTIME_VERSION}.`);
      err.code = 'PANE_TOO_OLD';
      throw err;
    }
    // A signed app must match its signature, and an id stays with the key
    // that first installed it. Both are checked before anything changes.
    let signer;
    try {
      signer = verifyApp(appSource, incoming);
    } catch (err) {
      if (err instanceof AppSignatureError) err.message = `${incoming.name} was not installed. ${err.message}`;
      throw err;
    }
    if (expectId !== undefined && incoming.id !== expectId) {
      throw new Error(`This update is for ${incoming.id}, not ${expectId}. Nothing was installed.`);
    }
    if (requireSigner) {
      if (!signer) throw new Error(`${incoming.name}'s update is unsigned. Nothing was installed.`);
      if (!publisherOf(incoming.id)) {
        throw new Error(`${incoming.name} was installed unsigned, so it cannot switch to a signed copy through an update. Nothing was installed.`);
      }
    }
    checkPublisher(incoming.id, signer);
    const dest = path.join(appsDir(), incoming.id);
    const tmp = `${dest}.partial`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.cpSync(appSource, tmp, {
      recursive: true,
      verbatimSymlinks: true, // keep the links exactly as signed
      filter: (p) => !SKIP_IN_APP.has(path.basename(p)),
    });
    const previous = readRecord(dest);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);

    const manifest = loadManifest(dest);
    if (previous && previous.launcher && previous.launcher !== launcherPathFor(manifest)) removeLauncher(previous.launcher);
    let launcher;
    try {
      launcher = createLauncher({
        manifest, appDir: dest, runtimeRoot: RUNTIME_ROOT, home: paneHome(), outDir: launchersDir(),
      });
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true }); // no half-installed apps
      throw new Error(`Could not create the launcher for ${manifest.name}: ${err.message}`);
    }
    recordPublisher(manifest.id, signer);
    const record = {
      id: manifest.id, name: manifest.name, version: manifest.version,
      publisher: signer ? { name: signer.publisher, fingerprint: signer.fingerprint } : null,
      permissions: [...manifest.permissions],
      runtime: RUNTIME_VERSION, runtimeDir: RUNTIME_ROOT, launcher,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dest, RECORD), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    if (unpacked) fs.rmSync(unpacked, { recursive: true, force: true });
  }
}

function launcherPathFor(manifest) {
  if (process.platform === 'darwin') return path.join(launchersDir(), `${fileName(manifest.name)}.app`);
  if (process.platform === 'win32') return path.join(launchersDir(), `${fileName(manifest.name)}.lnk`);
  return path.join(launchersDir(), `pane-${manifest.id}.desktop`);
}

// Removes the app and its launcher. Its data stays unless purge is set.
// With purge, also works for an app that was already uninstalled: its data and
// publisher record may still be there.
function uninstallApp(id, { purge = false } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`"${id}" is not an app id. "pane list" shows the installed apps.`);
  const dest = path.join(appsDir(), id);
  const record = readRecord(dest);
  const dataDir = path.join(paneHome(), 'data', id);
  if (!record) {
    if (purge && (fs.existsSync(dataDir) || publisherOf(id) !== undefined)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      forgetPublisher(id);
      return { id, name: id, removedDataOnly: true };
    }
    throw new Error(`No installed app with the id "${id}".`);
  }
  let manifest = null;
  try { manifest = loadManifest(dest, { requireUi: false }); } catch { /* remove what we can */ }
  removeLauncher(record.launcher, manifest);
  fs.rmSync(dest, { recursive: true, force: true });
  if (purge) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    forgetPublisher(id);
  }
  return record;
}

function listApps() {
  let entries = [];
  try { entries = fs.readdirSync(appsDir()); } catch { return []; }
  return entries
    .filter((e) => !e.endsWith('.partial'))
    .map((e) => readRecord(path.join(appsDir(), e)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readRecord(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')); } catch { return null; }
}

// Moves an installed app's launcher onto another Pane runtime.
function refreshLauncher(id, runtimeDir) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`"${id}" is not an app id.`);
  const dest = path.join(appsDir(), id);
  const record = readRecord(dest);
  if (!record) throw new Error(`No installed app with the id "${id}".`);
  const version = runtimeVersionOf(runtimeDir);
  if (!version || !fs.existsSync(path.join(runtimeDir, 'main.js'))) throw new Error(`${runtimeDir} is not a Pane runtime.`);
  const manifest = loadManifest(dest);
  if (!satisfies(version, manifest.pane)) throw new Error(`${manifest.name} needs Pane ${manifest.pane}, not ${version}.`);
  const launcher = createLauncher({ manifest, appDir: dest, runtimeRoot: runtimeDir, home: paneHome(), outDir: launchersDir() });
  const next = { ...record, runtime: version, runtimeDir, launcher };
  delete next.pendingRuntime;
  writeRecord(dest, next);
  return next;
}

// After a Pane update: idle apps move now, running ones when they next open,
// and apps whose pane.json excludes the new version stay where they are.
function moveAppsOnto(runtimeDir) {
  const version = runtimeVersionOf(runtimeDir);
  const running = new Set(runningApps().map((r) => r.id));
  return listApps().map((record) => {
    const dest = path.join(appsDir(), record.id);
    let manifest;
    try { manifest = loadManifest(dest); } catch { return { id: record.id, result: 'kept' }; }
    if (samePath(record.runtimeDir, runtimeDir) || !satisfies(version, manifest.pane)) return { id: record.id, result: 'kept' };
    if (running.has(record.id)) {
      writeRecord(dest, { ...record, pendingRuntime: runtimeDir });
      return { id: record.id, result: 'pending' };
    }
    try {
      refreshLauncher(record.id, runtimeDir);
      return { id: record.id, result: 'moved' };
    } catch (err) {
      return { id: record.id, result: 'kept', error: err.message };
    }
  });
}

// The app's own arguments, plus the mark that stops it handing over again.
const reopenArgs = (args = []) => [...args.filter((a) => a !== REOPENED_FLAG), REOPENED_FLAG];

// Reopens an installed app as its launcher does, with its arguments (a link,
// a file, Chromium flags) and the reopened mark.
function openInstalledApp(record, extra = []) {
  const args = reopenArgs(extra);
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  if (process.platform === 'darwin') {
    child = spawn('open', [record.launcher, '--args', ...args], { env, detached: true, stdio: 'ignore' });
  } else {
    const { electronBinary } = require('../core/paths');
    child = spawn(electronBinary(record.runtimeDir), [path.join(record.runtimeDir, 'main.js'), `--app=${path.join(appsDir(), record.id)}`, ...args],
      { env, detached: true, stdio: 'ignore', windowsHide: false });
  }
  child.on('error', () => {});
  child.unref();
}

function writeRecord(dir, record) {
  fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

module.exports = {
  moveAppsOnto, refreshLauncher, readRecord, writeRecord, openInstalledApp, reopenArgs, REOPENED_FLAG,
  installApp, uninstallApp, listApps, launcherPathFor, SKIP_IN_APP, EXIT_NEEDS_NEWER_PANE,
};
