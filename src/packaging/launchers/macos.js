'use strict';
// macOS launcher: "<App>.app" whose 251 MB Chromium framework is an APFS clone
// of Pane's copy (copy-on-write, so it takes almost no disk). A symlink does
// not work: Chromium's sandboxed helpers refuse files outside their bundle.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { electronDist } = require('../../core/paths');
const { setFuses, LAUNCHER_FUSES } = require('../../core/fuses');
const { repairPageHashes } = require('../../core/macho-signature');
const { ensureLocalIdentity } = require('../signing/local-identity');
const { fileName, execName } = require('./names');

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

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

  // No running as plain Node, NODE_OPTIONS or --inspect: nobody can run their
  // own code as this app (with its camera, microphone or file permissions).
  // The pane command's Electron is a different copy and keeps them.
  // Its signature is repaired in place, so the 200 MB file stays shared with
  // Pane's copy instead of being rewritten by codesign.
  const framework = path.join(frameworks, 'Electron Framework.framework', 'Electron Framework');
  repairPageHashes(framework, setFuses(framework, LAUNCHER_FUSES));

  // New signatures for what changed (renamed helpers, the app's Info.plist
  // and files): required on Apple silicon. Not --deep: that would re-sign the
  // unchanged frameworks and rewrite them in full.
  const sign = signingArgs(manifest);
  for (const entry of fs.readdirSync(frameworks)) {
    if (/ Helper.*\.app$/.test(entry)) execFileSync('codesign', [...sign, path.join(frameworks, entry)], { stdio: 'pipe' });
  }
  execFileSync('codesign', [...sign, tmp], { stdio: 'pipe' });
}

// Signed with this computer's own Pane identity, so the signature stays the
// same when the launcher is rebuilt (a Pane update) and the app keeps access
// to its keychain items (pane.secrets) without asking for a password.
// Ad hoc when that identity cannot be set up: the app still works, but may
// ask for the password once after a rebuild.
function signingArgs(manifest) {
  let local = null;
  try {
    local = ensureLocalIdentity();
  } catch (err) {
    process.stderr.write(`${manifest.name}'s launcher is signed ad hoc: ${err.message}\n`);
  }
  return local
    ? ['--force', '--timestamp=none', '--sign', local.identity, '--keychain', local.keychain]
    : ['--force', '--sign', '-'];
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

// macOS remembers apps (and the links and file types they handle) until told
// to forget them; deleting the bundle alone leaves a stale entry.
function removeMacLauncher(launcherPath) {
  if (fs.existsSync(launcherPath)) {
    try { execFileSync(LSREGISTER, ['-u', launcherPath], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
  fs.rmSync(launcherPath, { recursive: true, force: true });
}

module.exports = { createMacLauncher, removeMacLauncher, makeIcns };
