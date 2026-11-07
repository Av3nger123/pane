'use strict';
// Installing Pane itself, installing apps, and building an app's installer.
// No Electron imports: runs in the CLI (plain Node, or Pane's Electron as Node).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadManifest } = require('./manifest');
const { satisfies } = require('./version');
const { createLauncher, removeLauncher, fileName } = require('./launcher');
const {
  RUNTIME_ROOT, RUNTIME_VERSION, paneHome, appsDir, runtimesDir, binDir, launchersDir, electronBinary,
} = require('./paths');

const RECORD = '.pane-install.json';
// What a runtime folder needs. Everything else in the repo stays behind.
const RUNTIME_FILES = ['main.js', 'preload.js', 'package.json', 'lib', 'bin', 'backend-modules', path.join('node_modules', 'electron')];
const SKIP_IN_APP = new Set(['.git', 'dist', '.DS_Store']);

// ---- Pane itself -----------------------------------------------------------

// Copies this runtime into PANE_HOME/runtime/<version> and adds the `pane`
// command at PANE_HOME/bin/pane. This is "installing Pane".
function setupRuntime({ from = RUNTIME_ROOT } = {}) {
  const dest = path.join(runtimesDir(), RUNTIME_VERSION);
  if (path.resolve(from) !== path.resolve(dest)) {
    const tmp = `${dest}.partial`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const rel of RUNTIME_FILES) {
      const src = path.join(from, rel);
      if (!fs.existsSync(src)) throw new Error(`The runtime is incomplete: ${rel} is missing.`);
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      copyTree(src, path.join(tmp, rel));
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  }
  fs.writeFileSync(path.join(runtimesDir(), 'current'), `${dest}\n`);
  const command = writeCommand(dest);
  return { dir: dest, version: RUNTIME_VERSION, command };
}

// PANE_HOME/bin/pane runs the CLI with Pane's own Electron in Node mode, so the
// user never needs Node installed.
function writeCommand(runtimeDir) {
  fs.mkdirSync(binDir(), { recursive: true });
  const electron = electronBinary(runtimeDir);
  const cli = path.join(runtimeDir, 'bin', 'pane.js');
  if (process.platform === 'win32') {
    const file = path.join(binDir(), 'pane.cmd');
    fs.writeFileSync(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electron}" "${cli}" %*\r\n`);
    return file;
  }
  const file = path.join(binDir(), 'pane');
  const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${sh(electron)} ${sh(cli)} "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function installedRuntime() {
  try {
    const dir = fs.readFileSync(path.join(runtimesDir(), 'current'), 'utf8').trim();
    return fs.existsSync(path.join(dir, 'main.js')) ? dir : null;
  } catch {
    return null;
  }
}

// ---- apps ------------------------------------------------------------------

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
      throw new Error(`${incoming.name} needs Pane ${incoming.pane}. This computer has Pane ${RUNTIME_VERSION}. Update Pane first.`);
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
  removeLauncher(record.launcher);
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

// ---- building an installer ------------------------------------------------

// dist/<Name> <version>/
//   <id>-<version>.paneapp                 the app (tar.gz)
//   Install <Name>.command                 macOS / Linux: installs Pane if missing, then the app
//   Install <Name>.cmd                     Windows (not yet tested)
//   pane-runtime-<v>-<os>-<arch>.tar.gz    only with --with-runtime (offline installer)
function buildInstaller(appDir, { out, withRuntime = false } = {}) {
  const manifest = loadManifest(appDir);
  const outDir = path.resolve(out || path.join(manifest.dir, 'dist', `${fileName(manifest.name)} ${manifest.version}`));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const pkgName = `${manifest.id}-${manifest.version}.paneapp`;
  const pkg = path.join(outDir, pkgName);
  const entries = fs.readdirSync(manifest.dir).filter((e) => !SKIP_IN_APP.has(e));
  execFileSync('tar', ['-czf', pkg, '-C', manifest.dir, ...entries], { stdio: 'pipe' });

  let runtimeArchive = null;
  if (withRuntime) {
    runtimeArchive = path.join(outDir, `pane-runtime-${RUNTIME_VERSION}-${process.platform}-${process.arch}.tar.gz`);
    execFileSync('tar', ['-czf', runtimeArchive, '-C', RUNTIME_ROOT, ...RUNTIME_FILES], { stdio: 'pipe' });
  }

  const sh = path.join(outDir, `Install ${fileName(manifest.name)}.command`);
  fs.writeFileSync(sh, unixInstaller({ name: manifest.name, pkgName, minimum: manifest.pane }));
  fs.chmodSync(sh, 0o755);
  const cmd = path.join(outDir, `Install ${fileName(manifest.name)}.cmd`);
  fs.writeFileSync(cmd, windowsInstaller({ name: manifest.name, pkgName }));

  return { outDir, package: pkg, installers: [sh, cmd], runtimeArchive };
}

function unixInstaller({ name, pkgName }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Installs ${name}. If Pane is not on this computer yet, installs Pane first.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP_NAME=${q(name)}
PACKAGE="$HERE/"${q(pkgName)}

case "$(uname -s)" in
  Darwin) DEFAULT_HOME="$HOME/Library/Application Support/Pane" ;;
  *) DEFAULT_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}/pane" ;;
esac
PANE_HOME="\${PANE_HOME:-$DEFAULT_HOME}"
export PANE_HOME
PANE="$PANE_HOME/bin/pane"

if [ ! -x "$PANE" ]; then
  ARCHIVE=$(ls "$HERE"/pane-runtime-*.tar.gz 2>/dev/null | head -n 1 || true)
  if [ -z "$ARCHIVE" ]; then
    if [ -z "$PANE_DOWNLOAD_URL" ]; then
      echo "$APP_NAME needs Pane, which is not installed, and this installer does not include it."
      echo "Use the installer that includes Pane, or set PANE_DOWNLOAD_URL."
      exit 1
    fi
    ARCHIVE="$(mktemp -d)/pane-runtime.tar.gz"
    echo "Downloading Pane..."
    curl -fL --progress-bar "$PANE_DOWNLOAD_URL" -o "$ARCHIVE"
  fi
  echo "Installing Pane..."
  TMP=$(mktemp -d)
  tar -xzf "$ARCHIVE" -C "$TMP"
  case "$(uname -s)" in
    Darwin) ELECTRON="$TMP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ;;
    *) ELECTRON="$TMP/node_modules/electron/dist/electron" ;;
  esac
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$TMP/bin/pane.js" setup
  rm -rf "$TMP"
else
  echo "Pane is already installed."
fi

echo "Installing $APP_NAME..."
"$PANE" install "$PACKAGE" --open
`;
}

function windowsInstaller({ name, pkgName }) {
  return [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    `rem Installs ${name}. If Pane is not on this computer yet, installs Pane first. (Not yet tested on Windows.)`,
    'set "HERE=%~dp0"',
    'if "%PANE_HOME%"=="" set "PANE_HOME=%LOCALAPPDATA%\\Pane"',
    'if not exist "%PANE_HOME%\\bin\\pane.cmd" (',
    '  set "ARCHIVE="',
    '  for %%f in ("%HERE%pane-runtime-*.tar.gz") do set "ARCHIVE=%%f"',
    '  if not defined ARCHIVE (',
    `    echo ${name} needs Pane, which is not installed, and this installer does not include it.`,
    '    exit /b 1',
    '  )',
    '  echo Installing Pane...',
    '  set "UNPACK=%TEMP%\\pane-setup-%RANDOM%"',
    '  mkdir "!UNPACK!"',
    '  tar -xzf "!ARCHIVE!" -C "!UNPACK!"',
    '  set ELECTRON_RUN_AS_NODE=1',
    '  "!UNPACK!\\node_modules\\electron\\dist\\electron.exe" "!UNPACK!\\bin\\pane.js" setup',
    '  set ELECTRON_RUN_AS_NODE=',
    '  rmdir /s /q "!UNPACK!"',
    ')',
    `echo Installing ${name}...`,
    `call "%PANE_HOME%\\bin\\pane.cmd" install "%HERE%${pkgName}" --open`,
    '',
  ].join('\r\n');
}

function copyTree(from, to) {
  if (process.platform === 'darwin') {
    try { execFileSync('cp', ['-cR', from, to], { stdio: 'pipe' }); return; } catch { /* fall through */ }
  }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

module.exports = {
  setupRuntime, installedRuntime, installApp, uninstallApp, listApps, buildInstaller, launcherPathFor,
};
