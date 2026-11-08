'use strict';
// Runs the app's backend file on Pane's built-in Node, in its own process
// (Electron utility process), and relays calls and events.
//
// Messages, backend -> Pane:
//   { type: 'ready' }
//   { type: 'result', id, ok: true, value } | { type: 'result', id, ok: false, error: { message, stack } }
//   { type: 'emit', event, data }
//   { type: 'request', id, api, args }      a Pane API (pane.updates in backends)
// Pane -> backend:
//   { type: 'call', id, method, args }
//   { type: 'event', event, data }
//   { type: 'response', id, ok, value | error }

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { utilityProcess } = require('electron');

const HOST = path.join(__dirname, 'backend-host.js');
const SDK_DIR = path.join(__dirname, '..', '..', 'sdk', 'backend');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RECENT_LINES = 40;
// Installed apps restart a crashed backend, but not forever.
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60 * 1000;

class Backend extends EventEmitter {
  constructor(manifest, { dev, dataDir, logFile }) {
    super();
    this.manifest = manifest;
    this.dev = dev;
    this.dataDir = dataDir;
    this.logFile = logFile;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.recent = [];
    this.crashes = [];
    this.restartTimer = null;
  }

  get enabled() { return Boolean(this.manifest.backend); }

  start() {
    if (!this.enabled || this.child) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.logFile) prepareLog(this.logFile);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      PANE_APP_ID: this.manifest.id,
      PANE_APP_NAME: this.manifest.name,
      PANE_APP_VERSION: this.manifest.version,
      PANE_APP_DIR: this.manifest.dir,
      PANE_DATA_DIR: this.dataDir,
      PANE_BACKEND_ENTRY: this.manifest.backend,
      PANE_SDK_DIR: SDK_DIR,
      PANE_DEV: this.dev ? '1' : '',
    });

    const child = utilityProcess.fork(HOST, [], {
      serviceName: `${this.manifest.name} backend`,
      stdio: 'pipe',
      cwd: this.manifest.dir,
      env,
    });
    this.child = child;
    pipeLines(child.stdout, (line) => this.log('stdout', line));
    pipeLines(child.stderr, (line) => this.log('stderr', line));

    child.on('message', (msg) => this.onMessage(msg));
    child.on('exit', (code) => {
      if (this.child !== child) return; // an old process we already replaced
      this.child = null;
      this.failPending(new Error(`The backend stopped (exit code ${code}).`));
      this.log('stderr', `[pane] backend exited with code ${code}`);
      const willRestart = !this.dev && this.scheduleRestart();
      this.emit('exit', { code, log: this.recent.slice(), willRestart });
    });
  }

  // Returns true if a restart was scheduled.
  scheduleRestart() {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    if (this.crashes.length > MAX_CRASHES) {
      this.log('stderr', `[pane] backend crashed ${this.crashes.length} times in a minute; not restarting it`);
      return false;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.start(); this.emit('restart'); }, 500 * this.crashes.length);
    return true;
  }

  stop() {
    clearTimeout(this.restartTimer);
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill();
    this.failPending(new Error('The backend was restarted.'));
  }

  restart() {
    this.stop();
    this.crashes = [];
    this.recent = [];
    this.start();
    this.emit('restart');
  }

  call(method, args) {
    if (!this.enabled) return Promise.reject(new Error('This app has no backend. Add "backend" to pane.json.'));
    if (!this.child) return Promise.reject(new Error('The backend is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.postMessage({ type: 'call', id, method, args });
      } catch (err) {
        this.pending.delete(id);
        reject(new Error(`Could not send that to the backend: ${err.message}`));
      }
    });
  }

  send(event, data) {
    if (!this.child) return;
    try { this.child.postMessage({ type: 'event', event, data }); } catch { /* not cloneable: drop */ }
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else {
        const err = new Error((msg.error && msg.error.message) || 'The backend reported an error.');
        if (msg.error && msg.error.stack) err.backendStack = msg.error.stack;
        p.reject(err);
      }
    } else if (msg.type === 'emit' && typeof msg.event === 'string') {
      this.emit('emit', { event: msg.event, data: msg.data });
    } else if (msg.type === 'request' && typeof msg.api === 'string') {
      this.emit('request', { id: msg.id, api: msg.api, args: msg.args });
    } else if (msg.type === 'ready') {
      this.emit('ready');
    }
  }

  respond(id, answer) {
    if (!this.child) return;
    try { this.child.postMessage({ type: 'response', id, ...answer }); } catch { /* not cloneable: the request times out */ }
  }

  failPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  log(stream, line) {
    this.recent.push(line);
    if (this.recent.length > RECENT_LINES) this.recent.shift();
    if (this.dev) {
      const out = stream === 'stderr' ? process.stderr : process.stdout;
      out.write(`[${this.manifest.id}] ${line}\n`);
    }
    if (this.logFile) {
      try { fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${stream} ${line}\n`); } catch { /* ignore */ }
    }
    this.emit('log', { stream, line });
  }
}

function pipeLines(stream, onLine) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => { if (buf) onLine(buf); buf = ''; });
}

function prepareLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* logging is best effort */ }
}

module.exports = { Backend };
