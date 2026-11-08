'use strict';
// Installing Pane itself on this computer, and packing it for Pane's
// distribution (GitHub Releases).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse, compare } = require('../core/version');
const { signRelease, releaseKeys } = require('../core/release-signature');
const {
  RUNTIME_ROOT, RUNTIME_VERSION, runtimesDir, binDir, electronBinary, electronPackageDir,
} = require('../core/paths');

// What a runtime folder needs, besides Electron. Everything else stays behind.
const RUNTIME_FILES = ['main.js', 'package.json', 'bin', 'src', 'sdk', 'templates'];

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
// pkg: changes to its package.json (packing bakes in the release keys, and
// tests pack other versions).
function stageRuntime(from, dest, pkg = null) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of RUNTIME_FILES) {
    const src = path.join(from, rel);
    if (!fs.existsSync(src)) throw new Error(`The runtime is incomplete: ${rel} is missing.`);
    copyTree(src, path.join(dest, rel));
  }
  if (pkg) {
    const file = path.join(dest, 'package.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.version) data.version = pkg.version;
    if (pkg.releaseKeys) data.pane = { ...data.pane, releaseKeys: pkg.releaseKeys };
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
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

// ---- Pane's distribution -------------------------------------------------
//
// App installers never contain Pane. When a computer lacks the Pane version an
// app was built with (or anything newer), the installer downloads it from the
// distribution server:
//
//   <distribution>/v<version>/pane-runtime-<version>-<os>-<arch>.tar.gz
//   <distribution>/v<version>/pane-runtime-<version>-<os>-<arch>.tar.gz.sig
//   <distribution>/v<version>/pane-runtime-<version>-<os>-<arch>.tar.gz.sha256
//
// Installers refuse an archive whose .sig does not match one of Pane's
// public keys (src/core/release-signature.js). The .sha256 is for people.
//
// `pane pack-runtime` makes those files. The address comes from "pane.
// distributionUrl" in Pane's package.json; PANE_DIST_URL overrides it.

const PACKAGE = require('../../package.json');

// https only, except a local server for testing.
function checkAddress(url, what) {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
    throw new Error(`${what} must use https: ${url}`);
  }
  return url;
}

function distributionUrl() {
  const url = (process.env.PANE_DIST_URL || (PACKAGE.pane && PACKAGE.pane.distributionUrl) || '').trim().replace(/\/+$/, '');
  return url ? checkAddress(url, "Pane's distribution address") : null;
}

// Where the newest Pane version is announced: a small JSON file,
// {"version":"0.2.0"}, that the release workflow publishes. A changed copy can
// at worst delay an update; every download is still checked for Pane's
// signature and version.
function latestUrl({ env = process.env } = {}) {
  const url = (env.PANE_LATEST_URL || (PACKAGE.pane && PACKAGE.pane.latestUrl) || '').trim();
  return url ? checkAddress(url, "Pane's latest-version address") : null;
}

const runtimeArchiveName = (version, platform = process.platform, arch = process.arch) =>
  `pane-runtime-${version}-${platform}-${arch}.tar.gz`;

// Writes this runtime, for this OS and CPU, as files to upload to the
// distribution server: <out>/v<version>/<archive>, <archive>.sig and
// <archive>.sha256. signingKey: Pane's private release key (PEM); defaults to
// PANE_RELEASE_SIGNING_KEY. The packed runtime trusts releaseKeys() (Pane's
// package.json, or PANE_RELEASE_KEYS while packing) for its own updates.
// version: pack under another version number (for tests). Also writes
// <out>/pane-latest.json.
function packRuntime({ out, signingKey = process.env.PANE_RELEASE_SIGNING_KEY, version = RUNTIME_VERSION }) {
  if (!signingKey) throw new Error("Pane's release signing key is missing. Set PANE_RELEASE_SIGNING_KEY or pass --key <file>.");
  const dir = path.join(path.resolve(out), `v${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, runtimeArchiveName(version));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runtime-'));
  try {
    stageRuntime(RUNTIME_ROOT, path.join(stage, 'runtime'), { version, releaseKeys: releaseKeys() });
    execFileSync('tar', ['-czf', archive, '-C', path.join(stage, 'runtime'), '.'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
  const signature = `${archive}.sig`;
  fs.writeFileSync(signature, signRelease(fs.readFileSync(archive), signingKey));
  const latest = path.join(path.resolve(out), 'pane-latest.json');
  fs.writeFileSync(latest, `${JSON.stringify({ version })}\n`);
  return { dir, archive, sha256, signature, latest };
}

function copyTree(from, to) {
  if (process.platform === 'darwin') {
    try { execFileSync('cp', ['-cR', from, to], { stdio: 'pipe' }); return; } catch { /* fall through */ }
  }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

module.exports = {
  setupRuntime, stageRuntime, installedRuntime, packRuntime, distributionUrl, latestUrl, runtimeArchiveName, copyTree,
  runtimeVersionOf,
};
