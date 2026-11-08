'use strict';
// `pane build`: runs the app's build command, packages the app with its
// production dependencies, and writes its installers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadManifest } = require('../core/manifest');
const { runCommand, projectEnv } = require('../core/run');
const { RUNTIME_VERSION } = require('../core/paths');
const { fileName } = require('./launchers');
const { distributionUrl } = require('./runtime');
const { releaseKeys } = require('../core/release-signature');
const { signApp, fingerprint } = require('../core/app-signature');
const { isUpdateAddress } = require('../core/app-update');
const { SKIP_IN_APP } = require('./apps');
const { buildDmg } = require('./installers/dmg');
const { writeSetupExe } = require('./installers/setup-exe');
const { writeInstallScript } = require('./installers/install-sh');

// release/<Name> <version>/
//   <id>-<version>.paneapp      the app (tar.gz), production dependencies only
//   <Name> <version>.dmg        macOS: "Install <Name>.app" (built on a Mac)
//   <Name> Setup <version>.exe  Windows: PaneSetup.exe with the app attached
//   install.sh                  macOS / Linux terminal install
//   latest.json                 the update file, for apps that update themselves
// Each gets Pane first when needed, then installs the app.
//
// key: a file with the developer's Ed25519 key (pane keygen); defaults to
// PANE_SIGNING_KEY (the key itself, for CI). Without one the app is unsigned.
//
// sign: also sign the installers with the developer's certificates
// (signing/windows.js, signing/macos.js).
//
// updateUrl: where the .paneapp will be uploaded, for latest.json. Defaults to
// the folder of pane.json's "updates" address. Without either, no latest.json.
async function buildInstaller(appDir, { out, key, sign = false, updateUrl } = {}) {
  if (updateUrl !== undefined && !isUpdateAddress(updateUrl)) {
    throw new Error(`--update-url must be an https address of the folder you upload to: ${updateUrl}`);
  }
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

  const keys = releaseKeys();
  if (!keys.length) {
    warnings.push('Pane has no release key, so this installer will refuse to download Pane on computers that lack it. '
      + 'Add Pane\'s public key to "pane.releaseKeys" in Pane\'s package.json and build again.');
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-build-'));
  try {
    // The app without dev tooling: copy it, then install production
    // dependencies only (frontend build tools are not needed at runtime).
    fs.cpSync(manifest.dir, stage, {
      recursive: true,
      verbatimSymlinks: true, // relative links stay relative
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
    // Signed last, so the signature covers the production dependencies.
    const privatePem = key ? fs.readFileSync(path.resolve(key), 'utf8') : process.env.PANE_SIGNING_KEY;
    let publisher = null;
    if (privatePem) {
      signApp(stage, { id: manifest.id, version: manifest.version, publisher: manifest.publisher }, privatePem);
      publisher = { name: manifest.publisher, fingerprint: fingerprint(privatePem) };
    } else {
      warnings.push(`This app is unsigned. Anyone can publish an app with the id "${manifest.id}" and replace it on users' computers. `
        + 'Create a key with "pane keygen <file>" and build with --key <file>.');
    }
    const pkgName = `${manifest.id}-${manifest.version}.paneapp`;
    const pkg = path.join(outDir, pkgName);
    // No macOS metadata (AppleDouble "._" entries): other systems would unpack
    // them as files the app's signature does not list.
    const macOnly = process.platform === 'darwin' ? ['--no-mac-metadata'] : [];
    execFileSync('tar', [...macOnly, '-czf', pkg, '-C', stage, ...fs.readdirSync(stage)], {
      stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    const opts = { name: manifest.name, pkgName, paneVersion: RUNTIME_VERSION, dist: dist || '', releaseKeys: keys };
    const installers = [];

    // macOS: a disk image with an "Install <App>" app (needs hdiutil).
    if (process.platform === 'darwin') installers.push(buildDmg({ manifest, pkg, pkgName, outDir, opts, sign, warnings }));
    else warnings.push('No macOS installer (.dmg): build on a Mac to make one.');

    // Windows: PaneSetup.exe with the app attached (from any OS, once the
    // compiled PaneSetup.exe is available).
    const exe = writeSetupExe({ manifest, pkg, pkgName, outDir, dist, releaseKeys: keys });
    if (exe && sign) {
      if (process.platform === 'win32') require('./signing/windows').signWindows(exe);
      else warnings.push('The Windows installer is not signed: signing it needs Windows (signtool).');
    }
    if (exe) installers.push(exe);
    else {
      warnings.push('No Windows installer (.exe): it needs the compiled PaneSetup.exe, which Pane releases include. '
        + 'In a checkout, run `node installer/windows/build.js` on Windows.');
    }

    // Terminal installs on macOS and Linux.
    installers.push(writeInstallScript({ outDir, opts }));

    const updateFile = writeUpdateFile({ manifest, pkg, pkgName, outDir, updateUrl, warnings });
    return { outDir, package: pkg, installers, updateFile, paneVersion: RUNTIME_VERSION, distributionUrl: dist, publisher, warnings };
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

// latest.json, uploaded next to the .paneapp: tells installed copies that
// this version exists and where to get it. Null when the app has no updates.
function writeUpdateFile({ manifest, pkg, pkgName, outDir, updateUrl, warnings }) {
  if (updateUrl === undefined && !manifest.updates) return null;
  const base = updateUrl !== undefined ? updateUrl.replace(/\/*$/, '/') : manifest.updates;
  const latest = {
    version: manifest.version,
    url: new URL(encodeURIComponent(pkgName), base).href,
    pane: manifest.pane || undefined,
    sha256: require('crypto').createHash('sha256').update(fs.readFileSync(pkg)).digest('hex'),
  };
  if (!manifest.updates) {
    warnings.push('pane.json has no "updates" address, so installed copies of this version will not look for updates. '
      + 'Add "updates": "<address of latest.json>" before building the version you ship.');
  }
  const file = path.join(outDir, 'latest.json');
  fs.writeFileSync(file, `${JSON.stringify(latest, null, 2)}\n`);
  return file;
}

module.exports = { buildInstaller };
