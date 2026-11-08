'use strict';
// pane open <folder> <link|file> [--dev]

const path = require('path');
const { spawnSync } = require('child_process');
const { RUNTIME_ROOT, electronBinary } = require('../../core/paths');
const { loadManifest } = require('../../core/manifest');
const { UsageError } = require('../util');

// Starts the app with a link or file argument. If the app is already running,
// that copy receives it (single instance), exactly like a click in the system.
function openRequest(folder, target, flags) {
  if (!folder || !target) throw new UsageError('pane open <folder> <link|file> [--dev]');
  const dir = path.resolve(folder);
  loadManifest(dir, { requireUi: false });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const arg = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : path.resolve(target);
  const args = [path.join(RUNTIME_ROOT, 'main.js'), `--app=${dir}`, ...(flags.dev ? ['--dev'] : []), '--open-only', arg];
  const res = spawnSync(electronBinary(RUNTIME_ROOT), args, { env, stdio: 'inherit' });
  return res.status || 0;
}

module.exports = { openRequest };
