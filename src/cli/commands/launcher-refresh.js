'use strict';
// pane launcher-refresh <id> [--open] [--after <pid>] [-- <app arguments>]
//
// Started by an installed app that finds Pane moved on (or an app update
// waiting) since it last ran: waits for that app to exit, moves its launcher
// onto the new Pane (or installs the update), and reopens it with the same
// arguments.
//
// At most once: the pending work is cleared from the app's record before it
// is tried, failures only go to the update log, and the reopened app is
// marked so it never hands over again. If another refresh of the same app is
// running, this one does nothing.

const path = require('path');
const { appsDir } = require('../../core/paths');
const { alive, takeLock, takeHandover, logUpdate: log } = require('../../core/update-state');
const { runningApps } = require('../../core/running');
const { refreshLauncher, readRecord, writeRecord, openInstalledApp } = require('../../packaging/apps');
const { cleanupRuntimes } = require('../../packaging/runtime');
const { UsageError } = require('../util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launcherRefresh(id, flags, extra = [], { waitMs = 30000 } = {}) {
  if (!id) throw new UsageError('pane launcher-refresh <app-id> [--open] [--after <pid>]');
  const after = Number(flags.after);
  for (let waited = 0; after && alive(after) && waited < waitMs; waited += 200) await sleep(200);
  // The app's own arguments (a link or file) come in a file, never on a
  // command line (cmd.exe would read quotes and % signs in them).
  const args = [...takeHandover(id), ...extra];

  // Never under a running app: it may have refused to quit (unsaved work).
  // Everything stays pending for its next start.
  const stillRunning = (after && alive(after)) || runningApps().some((r) => r.id === id);
  if (stillRunning) {
    log(`${id}: still running, so nothing was changed; it updates when it next starts`);
    return 0;
  }

  log(`${id}: launcher-refresh started`);
  const release = takeLock(`app-${id}`);
  if (!release) { // another refresh of this app is running and will reopen it
    log(`${id}: another refresh is running; this one does nothing`);
    return 0;
  }
  const appHome = path.join(appsDir(), id);
  try {
    const record = readRecord(appHome);
    if (!record) throw new Error(`No installed app with the id "${id}".`);
    const { pendingRuntime, pendingUpdate } = record;
    const cleared = { ...record };
    delete cleared.pendingRuntime;
    delete cleared.pendingUpdate;
    writeRecord(appHome, cleared); // before trying: a failure must not repeat

    if (pendingUpdate) {
      try {
        require('../../packaging/app-updates').applyPendingUpdate(id, pendingUpdate);
        log(`${id}: installed its update`);
      } catch (err) {
        log(`${id}: could not install its update: ${err.message}`);
      }
    }
    if (pendingRuntime) {
      try {
        refreshLauncher(id, pendingRuntime);
        log(`${id}: moved onto ${pendingRuntime}`);
        cleanupRuntimes();
      } catch (err) {
        log(`${id}: could not move onto ${pendingRuntime}: ${err.message}`);
      }
    }
  } catch (err) {
    log(`${id}: launcher-refresh failed: ${err.message}`);
  } finally {
    release();
  }
  if (flags.open) {
    try {
      openInstalledApp(readRecord(appHome), args);
      log(`${id}: reopened`);
    } catch (err) {
      log(`${id}: could not reopen: ${err.message}`);
    }
  }
  return 0;
}

module.exports = { launcherRefresh };
