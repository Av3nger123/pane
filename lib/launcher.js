'use strict';
// App launchers: what the user double-clicks. Each one gives the app its own
// name, icon and identity while running on the shared Pane runtime.
//
// macOS: "<App>.app" whose 251 MB Chromium framework is an APFS clone of
// Pane's copy (copy-on-write, so it takes almost no disk). A symlink does not
// work: Chromium's sandboxed helpers refuse files outside their bundle.
// Windows: a Start menu shortcut. Linux: a .desktop entry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { electronBinary, electronDist } = require('./paths');
const { installEntries, removeEntries, encodeRegFile } = require('./win-registry');

function createLauncher({ manifest, appDir, runtimeRoot, home, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'darwin') return createMacLauncher({ manifest, appDir, runtimeRoot, home, outDir });
  if (process.platform === 'win32') return createWindowsLauncher({ manifest, appDir, runtimeRoot, home, outDir });
  return createLinuxLauncher({ manifest, appDir, runtimeRoot, outDir });
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// manifest (optional): the installed app's, so Windows registry entries for
// its links, file types and Settings > Apps entry can be removed too.
function removeLauncher(launcherPath, manifest) {
  if (process.platform === 'win32' && manifest) {
    try { regImport(removeEntries(manifest)); } catch { /* best effort */ }
  }
  if (!launcherPath) return;
  // macOS remembers apps (and the links and file types they handle) until told
  // to forget them; deleting the bundle alone leaves a stale entry.
  if (process.platform === 'darwin' && fs.existsSync(launcherPath)) {
    try { execFileSync(LSREGISTER, ['-u', launcherPath], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
  fs.rmSync(launcherPath, { recursive: true, force: true });
}

// ---- macOS ---------------------------------------------------------------

function createMacLauncher({ manifest, appDir, runtimeRoot, home, outDir }) {
  const source = path.join(electronDist(runtimeRoot), 'Electron.app');
  const bundle = path.join(outDir, `${fileName(manifest.name)}.app`);
  const tmp = `${bundle}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  cloneTree(source, tmp);
  try {
    buildMacBundle({ tmp, manifest, appDir, runtimeRoot, home });
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.renameSync(tmp, bundle);
  // Tell Finder and the Dock about the new or changed app.
  try {
    execFileSync(LSREGISTER, ['-f', bundle], { stdio: 'ignore' });
  } catch { /* cosmetic */ }
  return bundle;
}

function buildMacBundle({ tmp, manifest, appDir, runtimeRoot, home }) {
  const contents = path.join(tmp, 'Contents');
  const exe = execName(manifest.name);
  const bundleId = `dev.pane.app.${manifest.id}`;

  fs.renameSync(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', exe));

  // Helper apps must be named "<CFBundleName> Helper (...)" so Electron finds them.
  const frameworks = path.join(contents, 'Frameworks');
  for (const entry of fs.readdirSync(frameworks)) {
    const m = /^Electron Helper(.*)\.app$/.exec(entry);
    if (!m) continue;
    const suffix = m[1];
    const helperName = `${exe} Helper${suffix}`;
    const helper = path.join(frameworks, `${helperName}.app`);
    fs.renameSync(path.join(frameworks, entry), helper);
    fs.renameSync(path.join(helper, 'Contents', 'MacOS', `Electron Helper${suffix}`), path.join(helper, 'Contents', 'MacOS', helperName));
    const plist = path.join(helper, 'Contents', 'Info.plist');
    plistSet(plist, 'CFBundleExecutable', helperName);
    plistSet(plist, 'CFBundleName', helperName);
    plistSet(plist, 'CFBundleDisplayName', helperName);
    const tag = suffix.replace(/[^A-Za-z]/g, '').toLowerCase(); // " (GPU)" -> "gpu"
    plistSet(plist, 'CFBundleIdentifier', `${bundleId}.helper${tag ? `.${tag}` : ''}`);
  }

  const plist = path.join(contents, 'Info.plist');
  plistSet(plist, 'CFBundleExecutable', exe);
  plistSet(plist, 'CFBundleName', exe);
  plistSet(plist, 'CFBundleDisplayName', manifest.name);
  plistSet(plist, 'CFBundleIdentifier', bundleId);
  plistSet(plist, 'CFBundleShortVersionString', manifest.version);
  plistSet(plist, 'CFBundleVersion', manifest.version);
  plistSet(plist, 'LSApplicationCategoryType', 'public.app-category.productivity');
  plistDelete(plist, 'ElectronAsarIntegrity');
  for (const [key, what] of [
    ['NSCameraUsageDescription', 'the camera'],
    ['NSMicrophoneUsageDescription', 'the microphone'],
    ['NSAudioCaptureUsageDescription', 'audio capture'],
    ['NSBluetoothAlwaysUsageDescription', 'Bluetooth'],
    ['NSBluetoothPeripheralUsageDescription', 'Bluetooth'],
  ]) plistSet(plist, key, `${manifest.name} wants to use ${what}.`);

  declareOpenTypes(plist, manifest, bundleId);

  const resources = path.join(contents, 'Resources');
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  if (manifest.icon) {
    makeIcns(manifest.icon, path.join(resources, 'app.icns'));
    plistSet(plist, 'CFBundleIconFile', 'app.icns');
  }

  writeBoot(path.join(resources, 'app'), { manifest, appDir, runtimeRoot, home });

  // Ad-hoc signature: required on Apple silicon, and the Info.plist changed.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', tmp], { stdio: 'pipe' });
}

// The tiny Electron "app" inside the launcher: points at the app's files and
// starts the shared runtime's main.js.
function writeBoot(dir, { manifest, appDir, runtimeRoot, home }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: manifest.id, productName: manifest.name, version: manifest.version, main: 'boot.js',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'boot.js'), `'use strict';
// Written by Pane. Starts ${manifest.name} on the shared Pane runtime.
global.__paneBoot = ${JSON.stringify({ appDir, dev: false, home })};
require(${JSON.stringify(path.join(runtimeRoot, 'main.js'))});
`);
}

function cloneTree(from, to) {
  try {
    execFileSync('cp', ['-cR', from, to], { stdio: 'pipe' }); // APFS clone: no extra disk
  } catch {
    execFileSync('cp', ['-R', from, to], { stdio: 'pipe' }); // other file systems: a real copy
  }
}

function makeIcns(png, out) {
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-icon-')) + '.iconset';
  fs.mkdirSync(set);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = String(size * scale);
        const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
        execFileSync('sips', ['-z', px, px, png, '--out', path.join(set, name)], { stdio: 'pipe' });
      }
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', out], { stdio: 'pipe' });
  } finally {
    fs.rmSync(set, { recursive: true, force: true });
  }
}

// Links (CFBundleURLTypes) and "Open with" file types (CFBundleDocumentTypes),
// so macOS sends them to this app.
function declareOpenTypes(plist, manifest, bundleId) {
  plistDelete(plist, 'CFBundleURLTypes');
  plistDelete(plist, 'CFBundleDocumentTypes');
  const cmds = [];
  if (manifest.protocols.length) {
    cmds.push('Add :CFBundleURLTypes array', 'Add :CFBundleURLTypes:0 dict',
      `Add :CFBundleURLTypes:0:CFBundleURLName string ${quote(bundleId)}`, 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array');
    manifest.protocols.forEach((scheme, i) => cmds.push(`Add :CFBundleURLTypes:0:CFBundleURLSchemes:${i} string ${quote(scheme)}`));
  }
  if (manifest.fileTypes.length) {
    cmds.push('Add :CFBundleDocumentTypes array');
    manifest.fileTypes.forEach((t, i) => {
      const at = `:CFBundleDocumentTypes:${i}`;
      cmds.push(`Add ${at} dict`, `Add ${at}:CFBundleTypeName string ${quote(t.name)}`,
        `Add ${at}:CFBundleTypeRole string ${t.role === 'viewer' ? 'Viewer' : 'Editor'}`,
        `Add ${at}:LSHandlerRank string Alternate`, `Add ${at}:CFBundleTypeExtensions array`);
      t.extensions.forEach((ext, j) => cmds.push(`Add ${at}:CFBundleTypeExtensions:${j} string ${quote(ext)}`));
    });
  }
  if (cmds.length) execFileSync('/usr/libexec/PlistBuddy', [...cmds.flatMap((c) => ['-c', c]), plist], { stdio: 'pipe' });
}

function plistSet(file, key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${quote(value)}`, file], { stdio: 'pipe' });
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${quote(value)}`, file], { stdio: 'pipe' });
  }
}

function plistDelete(file, key) {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, file], { stdio: 'pipe' }); } catch { /* absent */ }
}

const quote = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;

// ---- Windows ---------------------------------------------------------------
//
// A Start menu shortcut whose AppUserModelID matches the one the app sets at
// runtime, so the taskbar shows the app's own name and icon. Links, "Open
// with" and Settings > Apps entries go in the registry (HKCU, no admin).

function createWindowsLauncher({ manifest, appDir, runtimeRoot, home, outDir }) {
  const electron = electronBinary(runtimeRoot);
  const mainJs = path.join(runtimeRoot, 'main.js');
  const ico = path.join(appDir, '.pane-icon.ico');
  const lnk = path.join(outDir, `${fileName(manifest.name)}.lnk`);
  const png = manifest.icon || writeDefaultIcon(appDir);
  runWinHelper(runtimeRoot, {
    icon: { png, out: ico },
    shortcut: {
      path: lnk,
      options: {
        target: electron,
        args: `"${mainJs}" "--app=${appDir}"`,
        cwd: appDir,
        description: manifest.description || manifest.name,
        icon: ico,
        iconIndex: 0,
        appUserModelId: `dev.pane.app.${manifest.id}`,
      },
    },
  });
  regImport(installEntries(manifest, {
    electron, mainJs, appDir, icon: ico, paneCommand: path.join(home, 'bin', 'pane.cmd'), sizeKb: folderSizeKb(appDir),
  }));
  return lnk;
}

// Runs lib/win-helper.js in Electron and returns its result.
function runWinHelper(runtimeRoot, job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-win-'));
  try {
    const jobFile = path.join(dir, 'job.json');
    const out = path.join(dir, 'out.json');
    fs.writeFileSync(jobFile, JSON.stringify({ ...job, out }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(electronBinary(runtimeRoot), [path.join(__dirname, 'win-helper.js'), jobFile], { env, stdio: 'pipe', timeout: 60000 });
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (!result.ok) throw new Error(result.error);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function regImport(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-reg-'));
  try {
    const file = path.join(dir, 'pane.reg');
    fs.writeFileSync(file, encodeRegFile(text));
    execFileSync('reg', ['import', file], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeDefaultIcon(appDir) {
  const file = path.join(appDir, '.pane-icon.png');
  fs.writeFileSync(file, require('./icon').defaultIconPng({ size: 256 }));
  return file;
}

function folderSizeKb(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) bytes += fs.statSync(p).size;
    }
  };
  try { walk(dir); } catch { /* an estimate is fine */ }
  return bytes / 1024;
}

// ---- Linux (not yet tested on Linux) ------------------------------------

function createLinuxLauncher({ manifest, appDir, runtimeRoot, outDir }) {
  const file = path.join(outDir, `pane-${manifest.id}.desktop`);
  const q = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${manifest.name}`,
    `Comment=${manifest.description || ''}`,
    `Exec=${q(electronBinary(runtimeRoot))} ${q(path.join(runtimeRoot, 'main.js'))} ${q(`--app=${appDir}`)}`,
    manifest.icon ? `Icon=${path.join(appDir, path.relative(manifest.dir, manifest.icon))}` : null,
    manifest.protocols.length ? `MimeType=${manifest.protocols.map((p) => `x-scheme-handler/${p};`).join('')}` : null,
    'Terminal=false',
    'Categories=Utility;',
    `StartupWMClass=${manifest.name}`,
    '',
  ].filter((l) => l !== null).join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

// ---- names ---------------------------------------------------------------

// Safe as a file name on every platform.
function fileName(name) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.+$/, '').trim() || 'Pane App';
}

// Executable and CFBundleName: letters, digits, spaces, dots, dashes.
function execName(name) {
  return name.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim() || 'Pane App';
}

module.exports = { createLauncher, removeLauncher, runWinHelper, makeIcns, fileName, execName };
