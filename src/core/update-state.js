'use strict';
// Small shared state for updates, in PANE_HOME (plain files, no Electron):
//   update-check.json   when Pane last looked for a newer version
//   locks/<name>.lock   one updater at a time (holds the pid)

const fs = require('fs');
const path = require('path');
const { paneHome } = require('./paths');

const DAY = 24 * 3600 * 1000;

// Added to the arguments of an app that Pane reopens after moving it onto a
// new Pane (or installing its update). An app started with it never hands
// over again, so a failed move costs one restart, never a loop.
const REOPENED_FLAG = '--pane-reopened';
const STALE_LOCK = 30 * 60 * 1000;

const stampFile = () => path.join(paneHome(), 'update-check.json');

function updateDue({ now = Date.now() } = {}) {
  try {
    const { lastCheck } = JSON.parse(fs.readFileSync(stampFile(), 'utf8'));
    return !(typeof lastCheck === 'number' && now - lastCheck < DAY && now >= lastCheck);
  } catch {
    return true;
  }
}

function markChecked({ now = Date.now() } = {}) {
  fs.mkdirSync(paneHome(), { recursive: true });
  fs.writeFileSync(stampFile(), `${JSON.stringify({ lastCheck: now })}\n`);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// A release function, or null when another live process holds the lock.
// A lock older than 30 minutes, or held by a process that is gone, is taken over.
function takeLock(name) {
  const dir = path.join(paneHome(), 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); } catch { /* gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = true;
      try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        stale = !alive(pid) || Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK;
      } catch { /* unreadable: stale */ }
      if (!stale) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

module.exports = { updateDue, markChecked, takeLock, alive, REOPENED_FLAG };
