'use strict';
// Which Pane apps are running, and on which Pane: PANE_HOME/running/<id>.json
// ({ pid, runtimeDir }), written by the app when it starts and removed when
// it quits. Updates use it to leave running apps alone.

const fs = require('fs');
const path = require('path');
const { paneHome } = require('./paths');
const { alive } = require('./update-state');

const dir = () => path.join(paneHome(), 'running');

function markRunning(id, { pid, runtimeDir }) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${id}.json`), `${JSON.stringify({ pid, runtimeDir })}\n`);
}

// Only removes the marker when it belongs to this process.
function clearRunning(id, pid) {
  const file = path.join(dir(), `${id}.json`);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file);
  } catch { /* already gone */ }
}

// Markers of processes that are still alive; stale ones are removed.
function runningApps() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir(), name);
    let entry = null;
    try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* damaged */ }
    if (entry && alive(entry.pid)) out.push({ id: name.slice(0, -5), pid: entry.pid, runtimeDir: entry.runtimeDir });
    else fs.rmSync(file, { force: true });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { markRunning, clearRunning, runningApps };
