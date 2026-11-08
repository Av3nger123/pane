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

const fs = require('fs');
const path = require('path');
const { paneHome, appsDir } = require('../../core/paths');
const { alive, takeLock } = require('../../core/update-state');
const { refreshLauncher, readRecord, writeRecord, openInstalledApp } = require('../../packaging/apps');
const { cleanupRuntimes } = require('../../packaging/runtime');
const { UsageError } = require('../util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  const dir = path.join(paneHome(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'update.log'), `${new Date().toISOString()} ${line}\n`);
}

async function launcherRefresh(id, flags, extra = []) {
  if (!id) throw new UsageError('pane launcher-refresh <app-id> [--open] [--after <pid>]');
  const after = Number(flags.after);
  for (let waited = 0; after && alive(after) && waited < 30000; waited += 200) await sleep(200);

  const release = takeLock(`app-${id}`);
  if (!release) return 0; // another refresh of this app is running and will reopen it
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
  } finally {
    release();
  }
  if (flags.open) openInstalledApp(readRecord(appHome), extra);
  return 0;
}

module.exports = { launcherRefresh };
