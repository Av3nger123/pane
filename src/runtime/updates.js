'use strict';
// What an installed app does about updates when it starts (never under pane
// dev, never for an app that is not installed):
//   - marks itself running, so Pane updates leave it alone until it quits
//   - if Pane moved on (or an app update is waiting) since it last started:
//     hands over to `pane launcher-refresh`, which reopens it on the new Pane,
//     and exits before showing a window
//   - otherwise, a little after starting, lets `pane self-update` look for a
//     newer Pane (at most once a day; nothing is shown to the user)
//   - runs `pane app-update ...` for the app's own updates (pane.updates)
// Installing is the pane command's job: this process never loads it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { RUNTIME_ROOT, appsDir } = require('../core/paths');
const { updateDue, logUpdate, REOPENED_FLAG } = require('../core/update-state');
const { markRunning, clearRunning } = require('../core/running');

const CHECK_DELAY_MS = 10000;

function readRecord(id) {
  try { return JSON.parse(fs.readFileSync(path.join(appsDir(), id, '.pane-install.json'), 'utf8')); } catch { return null; }
}

function spawnPane(home, args, opts) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the pane script sets its own
  const all = { env, windowsHide: true, ...opts };
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${path.join(home, 'bin', 'pane.cmd')}" ${args.map((a) => `"${a}"`).join(' ')}`], { ...all, windowsVerbatimArguments: true })
    : spawn(path.join(home, 'bin', 'pane'), args, all);
}

// Starts `pane <args>` in the background, detached from this app.
function runPane(home, args) {
  const child = spawnPane(home, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => logUpdate(`could not start pane ${args[0]}: ${err.message}`));
  child.unref();
}

// Runs `pane app-update <args>` and reads its JSON lines: progress goes to
// onProgress, and the promise settles with the result or the error message.
function runAppUpdate(home, args, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPane(home, ['app-update', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = null;
    const line = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg && typeof msg.progress === 'number') onProgress(msg.progress);
      else if (msg && 'result' in msg) settled = { result: msg.result };
      else if (msg && typeof msg.error === 'string') settled = { error: msg.error };
    };
    child.stdout.on('data', (chunk) => {
      out += chunk;
      let i;
      while ((i = out.indexOf('\n')) >= 0) { line(out.slice(0, i)); out = out.slice(i + 1); }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (e) => reject(new Error(`Could not start Pane's updater: ${e.message}`)));
    child.on('close', () => {
      if (out.trim()) line(out.trim());
      if (settled && 'result' in settled) resolve(settled.result);
      else reject(new Error((settled && settled.error) || err.trim() || "Pane's updater stopped without an answer."));
    });
  });
}

// Quits the app; `pane app-update apply` installs the waiting update and
// reopens it (once, see launcher-refresh).
function restartToUpdate({ app, manifest, home }) {
  runPane(home, ['app-update', 'apply', manifest.id, '--open', '--after', String(process.pid), '--', ...openArgs()]);
  app.quit();
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
  if (!record) return { installed: false, pendingRelaunch: false, scheduleCheck() {} };

  if (shouldHandOver(record)) {
    logUpdate(`${manifest.id}: handing over to pane launcher-refresh (${record.pendingUpdate ? 'update waiting' : `moving onto ${record.pendingRuntime}`})`);
    runPane(home, ['launcher-refresh', manifest.id, '--open', '--after', String(process.pid), '--', ...openArgs()]);
    return { installed: true, pendingRelaunch: true, scheduleCheck() {} };
  }

  if (record.pendingRuntime || record.pendingUpdate) {
    logUpdate(`${manifest.id}: started on ${RUNTIME_ROOT} with pending work but not handing over (reopened: ${process.argv.includes(REOPENED_FLAG)})`);
  }
  markRunning(manifest.id, { pid: process.pid, runtimeDir: RUNTIME_ROOT });
  app.on('will-quit', () => clearRunning(manifest.id, process.pid));
  return {
    installed: true,
    pendingRelaunch: false,
    scheduleCheck() {
      setTimeout(() => { if (updateDue()) runPane(home, ['self-update']); }, CHECK_DELAY_MS).unref();
    },
  };
}

module.exports = { startUpdates, shouldHandOver, runAppUpdate, restartToUpdate, REOPENED_FLAG };
