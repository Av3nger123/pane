'use strict';
// Installing, removing and listing apps on this computer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadManifest } = require('../core/manifest');
const { satisfies } = require('../core/version');
const { createLauncher, removeLauncher, fileName } = require('./launchers');
const { RUNTIME_ROOT, RUNTIME_VERSION, paneHome, appsDir, launchersDir } = require('../core/paths');

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
function installApp(source) {
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
    const dest = path.join(appsDir(), incoming.id);
    const tmp = `${dest}.partial`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.cpSync(appSource, tmp, {
      recursive: true,
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
    const record = {
      id: manifest.id, name: manifest.name, version: manifest.version,
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
function uninstallApp(id, { purge = false } = {}) {
  const dest = path.join(appsDir(), id);
  const record = readRecord(dest);
  if (!record) throw new Error(`No installed app with the id "${id}".`);
  let manifest = null;
  try { manifest = loadManifest(dest, { requireUi: false }); } catch { /* remove what we can */ }
  removeLauncher(record.launcher, manifest);
  fs.rmSync(dest, { recursive: true, force: true });
  if (purge) fs.rmSync(path.join(paneHome(), 'data', id), { recursive: true, force: true });
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

module.exports = {
  installApp, uninstallApp, listApps, launcherPathFor, SKIP_IN_APP, EXIT_NEEDS_NEWER_PANE,
};
