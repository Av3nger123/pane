'use strict';
// App launchers: what the user double-clicks. Each one gives the app its own
// name, icon and identity while running on the shared Pane runtime.
//   macos.js    "<App>.app" sharing Pane's Chromium through an APFS clone
//   windows.js  Start menu shortcut with the app's taskbar identity, registry entries
//   linux.js    .desktop entry

const fs = require('fs');
const { fileName, execName } = require('./names');

function createLauncher(opts) {
  fs.mkdirSync(opts.outDir, { recursive: true });
  if (process.platform === 'darwin') return require('./macos').createMacLauncher(opts);
  if (process.platform === 'win32') return require('./windows').createWindowsLauncher(opts);
  return require('./linux').createLinuxLauncher(opts);
}

// manifest (optional): the installed app's, so Windows registry entries for
// its links, file types and Settings > Apps entry are removed too.
function removeLauncher(launcherPath, manifest) {
  if (process.platform === 'win32') { require('./windows').removeWindowsLauncher(launcherPath, manifest); return; }
  if (!launcherPath) return;
  if (process.platform === 'darwin') { require('./macos').removeMacLauncher(launcherPath); return; }
  fs.rmSync(launcherPath, { recursive: true, force: true });
}

const makeIcns = (...args) => require('./macos').makeIcns(...args);
const runWinHelper = (...args) => require('./windows').runWinHelper(...args);

module.exports = { createLauncher, removeLauncher, runWinHelper, makeIcns, fileName, execName };
