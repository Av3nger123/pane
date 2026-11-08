'use strict';
// Windows launcher.
//
// A Start menu shortcut whose AppUserModelID matches the one the app sets at
// runtime, so the taskbar shows the app's own name and icon. Links, "Open
// with" and Settings > Apps entries go in the registry (HKCU, no admin).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { electronBinary } = require('../../core/paths');
const { installEntries, removeEntries, encodeRegFile } = require('../../core/win-registry');
const { fileName } = require('./names');

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
  fs.writeFileSync(file, require('../../core/icon').defaultIconPng({ size: 256 }));
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

// Removes the shortcut and the app's registry entries (links, file types,
// Settings > Apps).
function removeWindowsLauncher(launcherPath, manifest) {
  if (manifest) {
    try { regImport(removeEntries(manifest)); } catch { /* best effort */ }
  }
  if (launcherPath) fs.rmSync(launcherPath, { force: true });
}

module.exports = { createWindowsLauncher, removeWindowsLauncher, runWinHelper };
