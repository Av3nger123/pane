'use strict';
// Running an app's own commands (dev server, build) the way `npm run` would:
// in the app folder, with node_modules/.bin on PATH.

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function projectEnv(dir, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = [path.join(dir, 'node_modules', '.bin'), env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

// Runs a command to completion with output shown. Rejects on failure.
function runCommand(command, { cwd, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env: projectEnv(cwd), shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal || `exit code ${code}`}): ${command}`));
    });
  });
}

// Starts a long-running command; each output line goes to onLine.
function startCommand(command, { cwd, onLine }) {
  const child = spawn(command, {
    cwd,
    env: projectEnv(cwd, { FORCE_COLOR: '1' }),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // own process group, so we can stop all of it
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
    stream.on('end', () => { if (buf) onLine(buf); });
  }
  return child;
}

// Stops a command started with startCommand, including anything it started.
function stopCommand(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Resolves once `url` answers (any HTTP status). Rejects if `child` exits
// first or the timeout passes.
async function waitForUrl(url, { child, timeout = 60000 } = {}) {
  const end = Date.now() + timeout;
  let exited = null;
  if (child) child.once('exit', (code) => { exited = code; });
  for (;;) {
    if (exited !== null) throw new Error(`The dev server stopped before it was ready (exit code ${exited}).`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`The dev server did not answer at ${url} within ${Math.round(timeout / 1000)} s.`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

module.exports = { projectEnv, runCommand, startCommand, stopCommand, freePort, waitForUrl };
