'use strict';
// The Windows installer: PaneSetup.exe with the app attached
// (see src/core/installer-payload.js and installer/windows/PaneSetup.cs).

const fs = require('fs');
const path = require('path');
const { attachPayload } = require('../../core/installer-payload');
const { RUNTIME_VERSION } = require('../../core/paths');
const { fileName } = require('../launchers');
const { jwkParts } = require('../../core/release-signature');

// The compiled Windows installer: shipped in Pane releases, or built here on
// Windows.
function windowsStub() {
  const { STUB, buildStub } = require('../../../installer/windows/build');
  if (fs.existsSync(STUB)) return STUB;
  if (process.platform === 'win32') {
    try { return buildStub(); } catch { return null; }
  }
  return null;
}

// "<App> Setup <version>.exe", or null when PaneSetup.exe is not available.
function writeSetupExe({ manifest, pkg, pkgName, outDir, dist, releaseKeys = [] }) {
  const stub = windowsStub();
  if (!stub) return null;
  const exe = path.join(outDir, `${fileName(manifest.name)} Setup ${manifest.version}.exe`);
  fs.writeFileSync(exe, attachPayload(fs.readFileSync(stub), {
    name: manifest.name, id: manifest.id, version: manifest.version,
    paneVersion: RUNTIME_VERSION, distUrl: dist || '', package: pkgName,
    releaseKeys: releaseKeys.map(jwkParts).join(','),
  }, fs.readFileSync(pkg)));
  return exe;
}

module.exports = { writeSetupExe, windowsStub };
