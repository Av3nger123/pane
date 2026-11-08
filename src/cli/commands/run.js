'use strict';
// pane dev / pane run: start one app (with its dev server under pane dev)

const path = require('path');
const { spawn } = require('child_process');
const { RUNTIME_ROOT, electronBinary } = require('../../core/paths');
const { loadManifest } = require('../../core/manifest');
const { startCommand, stopCommand, freePort, waitForUrl } = require('../../core/run');

// Exit code from the runtime that means "start again" (pane.json changed).
const EXIT_RESTART = 75;

// Starts Electron with main.js for one app. With a "dev" block in pane.json,
// `pane dev` first starts the dev server and loads its URL. pane.json changes
// restart everything (main.js exits with EXIT_RESTART).
async function runApp(folder, { dev, extra = [] }) {
  const dir = path.resolve(folder);
  const electron = electronBinary(RUNTIME_ROOT);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set when this CLI itself runs on Pane's Electron

  let server = null;
  let child = null;
  let stopping = false;
  const stopAll = () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
    stopCommand(server);
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  try {
    for (;;) {
      let manifest = loadManifest(dir, { requireUi: false });
      const useServer = dev && manifest.dev;
      if (!useServer) manifest = loadManifest(dir); // the built files must exist

      let devUrl = null;
      if (useServer) {
        ({ server, url: devUrl } = await startDevServer(manifest));
        if (stopping) return 1;
      }
      const args = [path.join(RUNTIME_ROOT, 'main.js'), `--app=${dir}`, ...(dev ? ['--dev'] : []), ...(devUrl ? [`--dev-url=${devUrl}`] : []), ...extra];
      const code = await new Promise((resolve) => {
        child = spawn(electron, args, { stdio: 'inherit', env });
        child.on('exit', (c, signal) => resolve(signal ? 1 : c || 0));
      });
      child = null;
      stopCommand(server);
      server = null;
      if (!(dev && code === EXIT_RESTART) || stopping) return code;
    }
  } finally {
    process.off('SIGINT', stopAll);
    process.off('SIGTERM', stopAll);
    stopCommand(server);
  }
}

async function startDevServer(manifest) {
  const port = await freePort();
  const fill = (s) => s.replace(/\{port\}/g, String(port));
  const url = fill(manifest.dev.url);
  let server = null;
  if (manifest.dev.command) {
    const command = fill(manifest.dev.command);
    console.log(`[pane] starting the dev server: ${command}`);
    server = startCommand(command, { cwd: manifest.dir, onLine: (line) => { if (line.trim()) console.log(`[dev server] ${line}`); } });
  } else {
    console.log(`[pane] waiting for your dev server at ${url}`);
  }
  try {
    await waitForUrl(url, { child: server });
  } catch (err) {
    stopCommand(server);
    throw err;
  }
  return { server, url };
}

module.exports = { runApp };
