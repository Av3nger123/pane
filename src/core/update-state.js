'use strict';
// Small shared state for updates, in PANE_HOME (plain files, no Electron):
//   update-check.json   when Pane last looked for a newer version
//   locks/<name>.lock   one updater at a time (holds the pid)
//   logs/update.log     what updates did (the only place they report to)
//   handover/<id>.json  an app's last hand-over to the pane command: what was
//                       pending, when, and the arguments to reopen it with

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

// The live pid holding a lock taken less than maxAge ago, or null.
function lockHolder(name, { maxAge = STALE_LOCK } = {}) {
  const file = path.join(paneHome(), 'locks', `${name}.lock`);
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    return alive(pid) && Date.now() - fs.statSync(file).mtimeMs < maxAge ? pid : null;
  } catch {
    return null;
  }
}

// Hand-over attempts. The app records one before it exits; the pane command
// takes it (with the arguments) when it runs. A record still there for the
// same pending work means the pane command never ran: the app then starts
// normally instead of handing over again, so a failure never repeats.
const HANDOVER_RETRY = 3600 * 1000;
const handoverFile = (id) => path.join(paneHome(), 'handover', `${id}.json`);
const pendingOf = (record) => ({ runtime: record.pendingRuntime || null, update: record.pendingUpdate || null });

function recordHandover(id, record, args, { now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(handoverFile(id)), { recursive: true });
  fs.writeFileSync(handoverFile(id), JSON.stringify({ ...pendingOf(record), at: now, args }));
}

function recentHandover(id, record, { now = Date.now() } = {}) {
  try {
    const last = JSON.parse(fs.readFileSync(handoverFile(id), 'utf8'));
    const pending = pendingOf(record);
    return last.runtime === pending.runtime && last.update === pending.update && now - last.at < HANDOVER_RETRY;
  } catch {
    return false;
  }
}

// The arguments the app asked to be reopened with ([] if none); the record is removed.
function takeHandover(id) {
  let args = [];
  try {
    const last = JSON.parse(fs.readFileSync(handoverFile(id), 'utf8'));
    if (Array.isArray(last.args) && last.args.every((a) => typeof a === 'string')) args = last.args;
  } catch { /* none */ }
  fs.rmSync(handoverFile(id), { force: true });
  return args;
}

function logUpdate(line) {
  try {
    const dir = path.join(paneHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'update.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break an app or an update */ }
}

module.exports = {
  updateDue, markChecked, takeLock, lockHolder, alive, logUpdate, recordHandover, recentHandover, takeHandover, REOPENED_FLAG,
};
