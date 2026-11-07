'use strict';
// Installing Pane itself, installing apps, and building an app's installer.
// No Electron imports: runs in the CLI (plain Node, or Pane's Electron as Node).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadManifest } = require('./manifest');
const { runCommand, projectEnv } = require('./run');
const { satisfies, parse, compare } = require('./version');
const { createLauncher, removeLauncher, fileName, makeIcns } = require('./launcher');
const { attachPayload } = require('./installer-payload');
const {
  RUNTIME_ROOT, RUNTIME_VERSION, paneHome, appsDir, runtimesDir, binDir, launchersDir, electronBinary, electronPackageDir,
} = require('./paths');

const RECORD = '.pane-install.json';
// What a runtime folder needs, besides Electron. Everything else stays behind.
const RUNTIME_FILES = ['main.js', 'preload.js', 'package.json', 'lib', 'bin', 'backend-modules'];
// Never copied when installing or packaging an app. `release` is where
// `pane build` writes installers.
const SKIP_IN_APP = new Set(['.git', 'release', '.DS_Store']);

// ---- Pane itself -----------------------------------------------------------

// Copies this runtime into PANE_HOME/runtime/<version> and adds the `pane`
// command at PANE_HOME/bin/pane. This is "installing Pane".
function setupRuntime({ from = RUNTIME_ROOT } = {}) {
  const dest = path.join(runtimesDir(), RUNTIME_VERSION);
  if (path.resolve(from) !== path.resolve(dest)) {
    const tmp = `${dest}.partial`;
    stageRuntime(from, tmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  }
  // Several versions can sit side by side; "current" (and the pane command)
  // only ever moves forward.
  const currentDir = installedRuntime();
  const currentVersion = currentDir ? runtimeVersionOf(currentDir) : null;
  const becomesCurrent = !currentVersion || compare(parse(RUNTIME_VERSION), parse(currentVersion)) >= 0;
  if (becomesCurrent) {
    fs.writeFileSync(path.join(runtimesDir(), 'current'), `${dest}\n`);
    writeCommand(dest);
  }
  return { dir: dest, version: RUNTIME_VERSION, current: becomesCurrent ? RUNTIME_VERSION : currentVersion, command: commandPath() };
}

function runtimeVersionOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; }
}

const commandPath = () => path.join(binDir(), process.platform === 'win32' ? 'pane.cmd' : 'pane');

// A self-contained runtime folder: Pane's files plus node_modules/electron.
function stageRuntime(from, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of RUNTIME_FILES) {
    const src = path.join(from, rel);
    if (!fs.existsSync(src)) throw new Error(`The runtime is incomplete: ${rel} is missing.`);
    copyTree(src, path.join(dest, rel));
  }
  fs.mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
  electronBinary(from); // downloads Electron if it is not there yet
  copyTree(electronPackageDir(from), path.join(dest, 'node_modules', 'electron'));
  return dest;
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

// ---- Pane's distribution -------------------------------------------------
//
// App installers never contain Pane. When a computer lacks the Pane version an
// app was built with (or anything newer), the installer downloads it from the
// distribution server:
//
//   <distribution>/v<version>/pane-runtime-<version>-<os>-<arch>.tar.gz
//   <distribution>/v<version>/pane-runtime-<version>-<os>-<arch>.tar.gz.sha256
//
// `pane pack-runtime` makes those files. The address comes from "pane.
// distributionUrl" in Pane's package.json; PANE_DIST_URL overrides it.

const PACKAGE = require('../package.json');

function distributionUrl() {
  const url = (process.env.PANE_DIST_URL || (PACKAGE.pane && PACKAGE.pane.distributionUrl) || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  // https only, except a local server for testing.
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
    throw new Error(`Pane's distribution address must use https: ${url}`);
  }
  return url;
}

const runtimeArchiveName = (version, platform = process.platform, arch = process.arch) =>
  `pane-runtime-${version}-${platform}-${arch}.tar.gz`;

// Writes this runtime, for this OS and CPU, as files to upload to the
// distribution server: <out>/v<version>/<archive> and <archive>.sha256.
function packRuntime({ out }) {
  const dir = path.join(path.resolve(out), `v${RUNTIME_VERSION}`);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, runtimeArchiveName(RUNTIME_VERSION));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runtime-'));
  try {
    stageRuntime(RUNTIME_ROOT, path.join(stage, 'runtime'));
    execFileSync('tar', ['-czf', archive, '-C', path.join(stage, 'runtime'), '.'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
  return { dir, archive, sha256 };
}

// ---- building an installer ------------------------------------------------

// release/<Name> <version>/
//   <id>-<version>.paneapp      the app (tar.gz), production dependencies only
//   <Name> <version>.dmg        macOS: "Install <Name>.app" (built on a Mac)
//   <Name> Setup <version>.exe  Windows: PaneSetup.exe with the app attached
//   install.sh                  macOS / Linux terminal install
// Each gets Pane first when needed, then installs the app.
async function buildInstaller(appDir, { out } = {}) {
  const dir = path.resolve(appDir);
  const draft = loadManifest(dir, { requireUi: false });
  if (draft.build) await runCommand(draft.build.command, { cwd: dir, label: 'The build command' });
  const manifest = loadManifest(dir);
  const outDir = path.resolve(out || path.join(manifest.dir, 'release', `${fileName(manifest.name)} ${manifest.version}`));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const warnings = [];
  const dist = distributionUrl();
  if (!dist) {
    warnings.push('Pane has no distribution address, so this installer cannot download Pane on computers that lack it. '
      + 'Set "pane.distributionUrl" in Pane\'s package.json (or PANE_DIST_URL) and build again.');
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-build-'));
  try {
    // The app without dev tooling: copy it, then install production
    // dependencies only (frontend build tools are not needed at runtime).
    fs.cpSync(manifest.dir, stage, {
      recursive: true,
      filter: (p) => !SKIP_IN_APP.has(path.basename(p)) && !(path.basename(p) === 'node_modules' && path.dirname(p) === manifest.dir),
    });
    if (hasProductionDeps(stage)) {
      const lock = fs.existsSync(path.join(stage, 'package-lock.json'));
      execFileSync('npm', [lock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: stage, env: projectEnv(stage), stdio: 'pipe', shell: process.platform === 'win32',
      });
      const native = findNativeModules(path.join(stage, 'node_modules'));
      if (native.length) {
        warnings.push(`Native modules found (${native.join(', ')}). They are built for your Node, not Pane's Electron, `
          + 'and may fail to load. Rebuild them with @electron/rebuild, or use a pure-JS alternative.');
      }
    }
    const pkgName = `${manifest.id}-${manifest.version}.paneapp`;
    const pkg = path.join(outDir, pkgName);
    execFileSync('tar', ['-czf', pkg, '-C', stage, ...fs.readdirSync(stage)], { stdio: 'pipe' });

    const opts = { name: manifest.name, pkgName, paneVersion: RUNTIME_VERSION, dist: dist || '' };
    const installers = [];

    // macOS: a disk image with an "Install <App>" app (needs hdiutil, so only
    // when building on a Mac).
    if (process.platform === 'darwin') installers.push(buildMacInstaller({ manifest, pkg, pkgName, outDir, opts }));
    else warnings.push('No macOS installer (.dmg): build on a Mac to make one.');

    // Windows: PaneSetup.exe with the app attached (works from any OS once the
    // compiled PaneSetup.exe is available).
    const stub = windowsStub();
    if (stub) {
      const exe = path.join(outDir, `${fileName(manifest.name)} Setup ${manifest.version}.exe`);
      fs.writeFileSync(exe, attachPayload(fs.readFileSync(stub), {
        name: manifest.name, id: manifest.id, version: manifest.version,
        paneVersion: RUNTIME_VERSION, distUrl: dist || '', package: pkgName,
      }, fs.readFileSync(pkg)));
      installers.push(exe);
    } else {
      warnings.push('No Windows installer (.exe): it needs the compiled PaneSetup.exe, which Pane releases include. '
        + 'In a checkout, run `node installer/windows/build.js` on Windows.');
    }

    // Terminal installs on macOS and Linux.
    const sh = path.join(outDir, 'install.sh');
    fs.writeFileSync(sh, unixInstaller(opts));
    fs.chmodSync(sh, 0o755);
    installers.push(sh);
    return { outDir, package: pkg, installers, paneVersion: RUNTIME_VERSION, distributionUrl: dist, warnings };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function hasProductionDeps(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Boolean(pkg.dependencies && Object.keys(pkg.dependencies).length);
  } catch {
    return false;
  }
}

// Packages that contain compiled .node files.
function findNativeModules(nodeModules) {
  const found = new Set();
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 8) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.node')) {
        const rel = path.relative(nodeModules, p).split(path.sep);
        found.add(rel[0].startsWith('@') ? `${rel[0]}/${rel[1]}` : rel[0]);
      }
    }
  };
  walk(nodeModules, 0);
  return [...found];
}

// Exit code of `pane install` when the app needs a newer Pane. Installers
// react by downloading the Pane version the app was built with.
const EXIT_NEEDS_NEWER_PANE = 3;

// The install script. `gui` makes it report through notifications and dialogs
// (the macOS "Install <App>" app) instead of only the terminal; `packageExpr`
// is where the .paneapp sits relative to the script.
function unixInstaller({ name, pkgName, paneVersion, dist, gui = false, packageExpr = '"$HERE/"' }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Installs ${name}.
# If this computer does not have Pane ${paneVersion} or newer, downloads it first.
HERE=$(cd "$(dirname "$0")" && pwd)
APP_NAME=${q(name)}
PACKAGE=${packageExpr}${q(pkgName)}
PANE_VERSION=${q(paneVersion)}
DIST_URL="\${PANE_DIST_URL:-${dist.replace(/[\\"`$]/g, '\\$&')}}"
GUI=${gui ? '"${PANE_INSTALLER_GUI:-1}"' : '0'}
OPEN=--open
[ "\${PANE_INSTALLER_OPEN:-1}" = 0 ] && OPEN=

say() {
  echo "$1"
  if [ "$GUI" = 1 ]; then
    osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' "$1" "Install $APP_NAME" >/dev/null 2>&1 || true
  fi
}
fail() {
  echo "$1" >&2
  if [ "$GUI" = 1 ]; then
    osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1 with icon stop' -e 'end run' "$1" "Install $APP_NAME" >/dev/null 2>&1 || true
  fi
  exit 1
}

case "$(uname -s)" in
  Darwin) OS=darwin; DEFAULT_HOME="$HOME/Library/Application Support/Pane" ;;
  Linux) OS=linux; DEFAULT_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}/pane" ;;
  *) fail "This installer supports macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
PANE_HOME="\${PANE_HOME:-$DEFAULT_HOME}"
export PANE_HOME
PANE="$PANE_HOME/bin/pane"

install_pane() {
  [ -n "$DIST_URL" ] || fail "$APP_NAME needs Pane $PANE_VERSION, and this installer does not know where to download it."
  FILE="pane-runtime-$PANE_VERSION-$OS-$ARCH.tar.gz"
  URL="$DIST_URL/v$PANE_VERSION/$FILE"
  TMP=$(mktemp -d) || fail "Could not create a temporary folder."
  say "Downloading Pane $PANE_VERSION, which $APP_NAME runs on…"
  curl -fL --progress-bar "$URL" -o "$TMP/$FILE" || { rm -rf "$TMP"; fail "Could not download Pane from $URL"; }
  curl -fsSL "$URL.sha256" -o "$TMP/$FILE.sha256" || { rm -rf "$TMP"; fail "Could not download Pane's checksum from $URL.sha256"; }
  EXPECTED=$(cut -d ' ' -f 1 < "$TMP/$FILE.sha256")
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$TMP/$FILE" | cut -d ' ' -f 1)
  else
    ACTUAL=$(sha256sum "$TMP/$FILE" | cut -d ' ' -f 1)
  fi
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    rm -rf "$TMP"
    fail "The Pane download is damaged or was changed (checksum mismatch). Nothing was installed."
  fi
  say "Installing Pane $PANE_VERSION…"
  mkdir "$TMP/runtime" && tar -xzf "$TMP/$FILE" -C "$TMP/runtime" || { rm -rf "$TMP"; fail "Could not unpack Pane."; }
  if [ "$OS" = darwin ]; then
    ELECTRON="$TMP/runtime/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  else
    ELECTRON="$TMP/runtime/node_modules/electron/dist/electron"
  fi
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$TMP/runtime/bin/pane.js" setup || { rm -rf "$TMP"; fail "Could not install Pane."; }
  rm -rf "$TMP"
}

if [ -x "$PANE" ]; then
  echo "Pane is already installed."
else
  install_pane
fi

say "Installing $APP_NAME…"
STATUS=0
OUTPUT=$("$PANE" install "$PACKAGE" $OPEN 2>&1) || STATUS=$?
echo "$OUTPUT"
if [ "$STATUS" -eq ${EXIT_NEEDS_NEWER_PANE} ]; then
  say "$APP_NAME needs a newer Pane."
  install_pane
  STATUS=0
  OUTPUT=$("$PANE" install "$PACKAGE" $OPEN 2>&1) || STATUS=$?
  echo "$OUTPUT"
fi
[ "$STATUS" -eq 0 ] || fail "$APP_NAME could not be installed. $OUTPUT"
`;
}

// "<Name> <version>.dmg" holding "Install <Name>.app": a tiny app whose
// program is the install script, with the .paneapp in its Resources.
function buildMacInstaller({ manifest, pkg, pkgName, outDir, opts }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-dmg-'));
  try {
    const appName = `Install ${fileName(manifest.name)}`;
    const contents = path.join(stage, `${appName}.app`, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    const script = path.join(contents, 'MacOS', 'install');
    fs.writeFileSync(script, unixInstaller({ ...opts, gui: true, packageExpr: '"$HERE/../Resources/"' }));
    fs.chmodSync(script, 0o755);
    fs.copyFileSync(pkg, path.join(contents, 'Resources', pkgName));
    let iconKey = '';
    if (manifest.icon) {
      makeIcns(manifest.icon, path.join(contents, 'Resources', 'app.icns'));
      iconKey = '  <key>CFBundleIconFile</key><string>app.icns</string>\n';
    }
    const x = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>install</string>
  <key>CFBundleIdentifier</key><string>dev.pane.installer.${x(manifest.id)}</string>
  <key>CFBundleName</key><string>${x(appName)}</string>
  <key>CFBundleDisplayName</key><string>${x(appName)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${x(manifest.version)}</string>
  <key>CFBundleVersion</key><string>${x(manifest.version)}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
${iconKey}</dict>
</plist>
`);
    const dmg = path.join(outDir, `${fileName(manifest.name)} ${manifest.version}.dmg`);
    fs.rmSync(dmg, { force: true });
    execFileSync('hdiutil', ['create', '-volname', fileName(manifest.name), '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg], { stdio: 'pipe' });
    return dmg;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// The compiled Windows installer: shipped in Pane releases, or built here on
// Windows.
function windowsStub() {
  const { STUB, buildStub } = require('../installer/windows/build');
  if (fs.existsSync(STUB)) return STUB;
  if (process.platform === 'win32') {
    try { return buildStub(); } catch { return null; }
  }
  return null;
}

function copyTree(from, to) {
  if (process.platform === 'darwin') {
    try { execFileSync('cp', ['-cR', from, to], { stdio: 'pipe' }); return; } catch { /* fall through */ }
  }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

module.exports = {
  setupRuntime, installedRuntime, installApp, uninstallApp, listApps, buildInstaller, launcherPathFor,
  packRuntime, distributionUrl, runtimeArchiveName, EXIT_NEEDS_NEWER_PANE,
};
