'use strict';
// What an installed app does about updates when it starts (never under pane
// dev, never for an app that is not installed):
//   - marks itself running, so Pane updates leave it alone until it quits
//   - if Pane moved on (or an app update is waiting) since it last started:
//     hands over to `pane launcher-refresh`, which reopens it on the new Pane,
//     and exits before showing a window
//   - otherwise, a little after starting, lets `pane self-update` look for a
//     newer Pane (at most once a day; nothing is shown to the user)
// Installing is the pane command's job: this process never loads it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { RUNTIME_ROOT, appsDir } = require('../core/paths');
const { updateDue, REOPENED_FLAG } = require('../core/update-state');
const { markRunning, clearRunning } = require('../core/running');

const CHECK_DELAY_MS = 10000;

function readRecord(id) {
  try { return JSON.parse(fs.readFileSync(path.join(appsDir(), id, '.pane-install.json'), 'utf8')); } catch { return null; }
}

// Starts `pane <args>` in the background, detached from this app.
function runPane(home, args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the pane script sets its own
  const opts = { env, detached: true, stdio: 'ignore', windowsHide: true };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${path.join(home, 'bin', 'pane.cmd')}" ${args.map((a) => `"${a}"`).join(' ')}`], { ...opts, windowsVerbatimArguments: true })
    : spawn(path.join(home, 'bin', 'pane'), args, opts);
  child.on('error', () => {});
  child.unref();
}

// The arguments this app was opened with (a link, a file, Chromium flags), so
// it can be reopened with them.
function openArgs() {
  const main = path.join(RUNTIME_ROOT, 'main.js');
  return process.argv.slice(1).filter((a) => a !== main && !a.startsWith('--app=') && !a.startsWith('-psn_') && a !== REOPENED_FLAG);
}

// Hand over to `pane launcher-refresh` only when Pane moved on (or an app
// update waits), and never if Pane itself just reopened this app.
function shouldHandOver(record, { argv = process.argv, runtimeRoot = RUNTIME_ROOT } = {}) {
  if (!record || argv.includes(REOPENED_FLAG)) return false;
  return Boolean((record.pendingRuntime && record.pendingRuntime !== runtimeRoot) || record.pendingUpdate);
}

// { pendingRelaunch, scheduleCheck() }
function startUpdates({ app, manifest, home, dev }) {
  const record = !dev && home && path.resolve(manifest.dir) === path.join(appsDir(), manifest.id) ? readRecord(manifest.id) : null;
  if (!record) return { pendingRelaunch: false, scheduleCheck() {} };

  if (shouldHandOver(record)) {
    runPane(home, ['launcher-refresh', manifest.id, '--open', '--after', String(process.pid), '--', ...openArgs()]);
    return { pendingRelaunch: true, scheduleCheck() {} };
  }

  markRunning(manifest.id, { pid: process.pid, runtimeDir: RUNTIME_ROOT });
  app.on('will-quit', () => clearRunning(manifest.id, process.pid));
  return {
    pendingRelaunch: false,
    scheduleCheck() {
      setTimeout(() => { if (updateDue()) runPane(home, ['self-update']); }, CHECK_DELAY_MS).unref();
    },
  };
}

module.exports = { startUpdates, shouldHandOver, REOPENED_FLAG };
