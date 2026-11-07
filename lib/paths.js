'use strict';
// Where Pane keeps things on this computer. No Electron imports: the CLI uses
// this too.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function electronDist(runtimeRoot = RUNTIME_ROOT) {
  return path.join(electronPackageDir(runtimeRoot), 'dist');
}

// The Electron executable.
function electronBinary(runtimeRoot = RUNTIME_ROOT) {
  const pkg = electronPackageDir(runtimeRoot);
  let rel;
  try {
    rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
  } catch {
    throw new Error(`Electron's download did not finish (${pkg}). Run "npm rebuild electron".`);
  }
  return path.join(pkg, 'dist', rel);
}

module.exports = {
  RUNTIME_ROOT, RUNTIME_VERSION,
  paneHome, appsDir, runtimesDir, binDir, dataDir, launchersDir, electronPackageDir, electronDist, electronBinary,
};
