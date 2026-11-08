'use strict';
// The `pane` module for app backends.
//
//   const pane = require('pane');                 // or: import pane from 'pane'
//   pane.expose('add', (a, b) => a + b);          // window: await pane.call('add', 1, 2)
//   pane.expose({ list, save });                  // several at once
//   pane.on('refresh', (data) => { ... });        // window: pane.send('refresh', data)
//   pane.emit('progress', 0.5);                   // window: pane.on('progress', fn)
//   pane.app.dataDir                              // private folder that survives updates

const fs = require('fs');

// One instance per process, even if a second copy of this file is loaded.
if (globalThis.__paneBackend) {
  module.exports = globalThis.__paneBackend;
} else {
  module.exports = createBackend();
  globalThis.__paneBackend = module.exports;
}

function createBackend() {
  const port = process.parentPort;
  const handlers = new Map();
  const listeners = new Map();
  const queue = [];
  let ready = false;

  const app = Object.freeze({
    id: process.env.PANE_APP_ID,
    name: process.env.PANE_APP_NAME,
    version: process.env.PANE_APP_VERSION,
    dir: process.env.PANE_APP_DIR,
    dataDir: process.env.PANE_DATA_DIR,
    dev: process.env.PANE_DEV === '1',
  });

  if (app.dataDir) fs.mkdirSync(app.dataDir, { recursive: true });

  function expose(name, fn) {
    if (name && typeof name === 'object') {
      for (const [key, value] of Object.entries(name)) expose(key, value);
      return;
    }
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new TypeError('pane.expose(name, function) or pane.expose({ name: function })');
    }
    handlers.set(name, fn);
  }

  function on(event, fn) {
    if (typeof event !== 'string' || typeof fn !== 'function') throw new TypeError('pane.on(event, function)');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }

  function emit(event, data) {
    if (typeof event !== 'string') throw new TypeError('pane.emit(event, data)');
    post({ type: 'emit', event, data });
  }

  function post(msg) {
    if (!port) return; // loaded outside Pane (e.g. in a unit test)
    try {
      port.postMessage(msg);
    } catch (err) {
      if (msg.type === 'result') {
        port.postMessage({ type: 'result', id: msg.id, ok: false, error: { message: `The result could not be sent to the window: ${err.message}` } });
      } else {
        console.error(`pane.emit("${msg.event}") failed: ${err.message}`);
      }
    }
  }

  async function handle(msg) {
    if (msg.type === 'call') {
      const fn = handlers.get(msg.method);
      if (!fn) {
        post({ type: 'result', id: msg.id, ok: false, error: { message: `The backend has no function "${msg.method}". Add pane.expose("${msg.method}", ...).` } });
        return;
      }
      try {
        const value = await fn(...(Array.isArray(msg.args) ? msg.args : []));
        post({ type: 'result', id: msg.id, ok: true, value });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        post({ type: 'result', id: msg.id, ok: false, error: { message, stack: app.dev && err && err.stack ? err.stack : undefined } });
      }
    } else if (msg.type === 'event') {
      for (const fn of listeners.get(msg.event) || []) {
        try { await fn(msg.data); } catch (err) { console.error(err); }
      }
    }
  }

  if (port) {
    port.on('message', (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (ready) handle(msg);
      else queue.push(msg);
    });
  }

  // Called by Pane once the app's backend file has loaded, so calls that
  // arrive early wait for their handlers instead of failing.
  function _ready() {
    ready = true;
    post({ type: 'ready' });
    for (const msg of queue.splice(0)) handle(msg);
  }

  return { app, expose, on, emit, _ready };
}
