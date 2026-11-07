'use strict';
// `pane dev`: reload windows when web files change, restart the backend when
// its code changes, restart everything when pane.json changes.

const fs = require('fs');
const path = require('path');
const { isInside } = require('./safe-path');

const IGNORED = new Set(['node_modules', 'dist']);

function watchForDev(manifest, { windows, backend, onManifestChange }) {
  const say = (text) => process.stdout.write(`[pane] ${text}\n`);
  const reload = debounce(() => { say('web files changed, reloading'); windows.reloadAll(); }, 120);
  const restart = debounce(() => { say('backend changed, restarting it'); backend.restart(); }, 200);

  let watcher;
  try {
    watcher = fs.watch(manifest.dir, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (rel.split('/').some((s) => IGNORED.has(s) || s.startsWith('.'))) return;
      if (rel === 'pane.json') { say('pane.json changed, restarting the app'); onManifestChange(); return; }
      const abs = path.join(manifest.dir, rel);
      if (manifest.uiDir === manifest.dir || isInside(manifest.uiDir, abs)) reload();
      else if (manifest.backend) restart();
    });
  } catch (err) {
    say(`file watching is unavailable here (${err.message}); use Develop > Reload`);
    return () => {};
  }
  return () => watcher.close();
}

function debounce(fn, ms) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

module.exports = { watchForDev };
