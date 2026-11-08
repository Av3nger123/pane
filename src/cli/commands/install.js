'use strict';
// pane install <folder|file.paneapp> [--open]

const path = require('path');
const { spawn } = require('child_process');
const { installApp, EXIT_NEEDS_NEWER_PANE } = require('../../packaging/apps');
const { AppSignatureError } = require('../../core/app-signature');
const { UsageError } = require('../util');

function install(source, flags) {
  if (!source) throw new UsageError('pane install <folder|file.paneapp>');
  let record;
  try {
    record = installApp(source);
  } catch (err) {
    if (err.code === 'PUBLISHER_CHANGED' || err instanceof AppSignatureError) {
      console.error(err.message);
      return 1;
    }
    if (err.code !== 'PANE_TOO_OLD') throw err;
    console.error(err.message);
    return EXIT_NEEDS_NEWER_PANE; // installers download a newer Pane and retry
  }
  console.log(`Installed ${record.name} ${record.version}`);
  console.log(`  launcher: ${record.launcher}`);
  console.log(`  publisher: ${record.publisher ? `${record.publisher.name || 'unnamed'} (key ${record.publisher.fingerprint})` : 'unsigned'}`);
  console.log(`  permissions: ${record.permissions.length ? record.permissions.join(', ') : 'none'}`);
  if (flags.open) openLauncher(record.launcher);
  return 0;
}

// Starts the app with a link or file argument. If the app is already running,
// that copy receives it (single instance), exactly like a click in the system.

function openLauncher(launcher) {
  if (process.platform === 'darwin') {
    spawn('open', [launcher], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', launcher], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('gtk-launch', [path.basename(launcher, '.desktop')], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
}

module.exports = { install };
