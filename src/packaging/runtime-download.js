'use strict';
// Downloading and installing a Pane version from Pane's distribution, the way
// install.sh and Setup.exe do, for Pane's own updates.
//
// A download is installed only if its .sig matches one of the release keys
// of the Pane that is already installed (never keys from the environment),
// and only if it is the version that was asked for.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyRelease, checkReleaseKeys } = require('../core/release-signature');
const { RUNTIME_ROOT, paneHome, runtimesDir, electronBinary } = require('../core/paths');
const { runtimeArchiveName } = require('./runtime');
const { tarBinary } = require('../core/run');

class RuntimeDownloadError extends Error {}

// The keys an installed Pane trusts for its updates: baked into its
// package.json when it was packed.
function installedReleaseKeys(runtimeDir = RUNTIME_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'));
  return checkReleaseKeys((pkg.pane && pkg.pane.releaseKeys) || []);
}

async function fetchTo(url, file, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      out.write(chunk);
      received += chunk.length;
      if (onProgress && total) onProgress(received / total);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

async function downloadRuntime({ version, dist, keys, onProgress }) {
  if (!keys || !keys.length) throw new RuntimeDownloadError("This Pane has no release key, so it cannot check Pane's downloads.");
  const name = runtimeArchiveName(version);
  const url = `${dist.replace(/\/+$/, '')}/v${version}/${name}`;
  fs.mkdirSync(path.join(paneHome(), 'downloads'), { recursive: true });
  const work = fs.mkdtempSync(path.join(paneHome(), 'downloads', `pane-${version}-`));
  try {
    const archive = path.join(work, name);
    try {
      await fetchTo(url, archive, onProgress);
    } catch (err) {
      throw new RuntimeDownloadError(`Could not download Pane ${version}: ${err.message}`);
    }
    let signature;
    try {
      await fetchTo(`${url}.sig`, `${archive}.sig`);
      signature = fs.readFileSync(`${archive}.sig`);
    } catch {
      throw new RuntimeDownloadError(`Pane ${version}'s download is not signed by Pane (no signature at ${url}.sig).`);
    }
    if (!verifyRelease(fs.readFileSync(archive), signature, keys)) {
      throw new RuntimeDownloadError(`Pane ${version}'s download is not signed by Pane.`);
    }

    const unpacked = path.join(work, 'runtime');
    fs.mkdirSync(unpacked);
    execFileSync(tarBinary(), ['-xzf', archive, '-C', unpacked], { stdio: 'pipe' });

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    try {
      execFileSync(electronBinary(unpacked), [path.join(unpacked, 'bin', 'pane.js'), 'setup', '--expect', version], { env, stdio: 'pipe' });
    } catch (err) {
      const output = `${err.stdout || ''}${err.stderr || ''}`.trim();
      throw new RuntimeDownloadError(output || `Could not install Pane ${version}.`);
    }
    return { dir: path.join(runtimesDir(), version), version };
  } finally {
    // Tidying up never fails an install: Windows can keep a file locked for
    // a moment (antivirus, a process that just exited). cleanupRuntimes
    // removes anything left behind later.
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for later */ }
  }
}

module.exports = { downloadRuntime, installedReleaseKeys, fetchTo, RuntimeDownloadError };
