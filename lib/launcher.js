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

function createLauncher({ manifest, appDir, runtimeRoot, home, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'darwin') return createMacLauncher({ manifest, appDir, runtimeRoot, home, outDir });
  if (process.platform === 'win32') return createWindowsLauncher({ manifest, appDir, runtimeRoot, outDir });
  return createLinuxLauncher({ manifest, appDir, runtimeRoot, outDir });
}

function removeLauncher(launcherPath) {
  if (launcherPath) fs.rmSync(launcherPath, { recursive: true, force: true });
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
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle], { stdio: 'ignore' });
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

// ---- Windows (not yet tested on Windows) --------------------------------

function createWindowsLauncher({ manifest, appDir, runtimeRoot, outDir }) {
  const lnk = path.join(outDir, `${fileName(manifest.name)}.lnk`);
  const ps = (s) => String(s).replace(/'/g, "''");
  const args = `"${path.join(runtimeRoot, 'main.js')}" --app="${appDir}"`;
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${ps(lnk)}')`,
    `$s.TargetPath = '${ps(electronBinary(runtimeRoot))}'`,
    `$s.Arguments = '${ps(args)}'`,
    `$s.WorkingDirectory = '${ps(appDir)}'`,
    `$s.Description = '${ps(manifest.description || manifest.name)}'`,
    '$s.Save()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
  return lnk;
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

module.exports = { createLauncher, removeLauncher, fileName, execName };
