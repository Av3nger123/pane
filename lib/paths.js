'use strict';
// Where Pane keeps things on this computer. No Electron imports: the CLI uses
// this too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNTIME_ROOT = path.resolve(__dirname, '..');
const RUNTIME_VERSION = require('../package.json').version;

function paneHome() {
  if (process.env.PANE_HOME) return path.resolve(process.env.PANE_HOME);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Pane');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Pane');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'pane');
}

const appsDir = () => path.join(paneHome(), 'apps');
const runtimesDir = () => path.join(paneHome(), 'runtime');
const binDir = () => path.join(paneHome(), 'bin');

// Electron's per-app profile (caches, storage). Dev runs get their own so a
// half-built app never touches the installed copy's data.
const dataDir = (id, dev) => path.join(paneHome(), 'data', dev ? `${id}.dev` : id);

// Where app launchers go: what the user sees in Finder, Start menu, app grid.
function launchersDir() {
  if (process.env.PANE_LAUNCHERS_DIR) return path.resolve(process.env.PANE_LAUNCHERS_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Applications', 'Pane Apps');
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Pane Apps');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
}

// The electron npm package used by a runtime. Found the way Node finds
// modules, so it also works when npm hoisted electron next to Pane.
function electronPackageDir(runtimeRoot = RUNTIME_ROOT) {
  try {
    return path.dirname(require.resolve('electron/package.json', { paths: [runtimeRoot] }));
  } catch {
    throw new Error(`Electron is missing for ${runtimeRoot}. Run "npm install" there.`);
  }
}

// The electron package downloads its binary on first use (since Electron 45
// there is no install script), and Pane starts the binary directly, so Pane
// triggers that download itself. Returns the binary's path inside dist/.
function ensureElectron(pkg) {
  const installed = () => {
    try {
      const rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
      return rel && fs.existsSync(path.join(pkg, 'dist', rel)) ? rel : null;
    } catch {
      return null;
    }
  };
  let rel = installed();
  if (rel) return rel;
  process.stderr.write('Downloading Electron (only the first time)...\n');
  const res = spawnSync(process.execPath, [path.join(pkg, 'install.js')], { stdio: ['ignore', 'inherit', 'inherit'] });
  rel = installed();
  if (res.status !== 0 || !rel) throw new Error(`Could not download Electron into ${pkg}. Check the network and try again.`);
  return rel;
}

function electronDist(runtimeRoot = RUNTIME_ROOT) {
  const pkg = electronPackageDir(runtimeRoot);
  ensureElectron(pkg);
  return path.join(pkg, 'dist');
}

// The Electron executable.
function electronBinary(runtimeRoot = RUNTIME_ROOT) {
  const pkg = electronPackageDir(runtimeRoot);
  return path.join(pkg, 'dist', ensureElectron(pkg));
}

module.exports = {
  RUNTIME_ROOT, RUNTIME_VERSION,
  paneHome, appsDir, runtimesDir, binDir, dataDir, launchersDir, electronPackageDir, electronDist, electronBinary,
};
