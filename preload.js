'use strict';
// window.pane: the only bridge between an app's pages and Pane. Pages never
// get Node or Electron themselves.

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('pane:info');
const listeners = new Map();

function unwrap(res) {
  if (res && res.ok) return res.value;
  const err = new Error((res && res.error && res.error.message) || 'Something went wrong.');
  if (res && res.error && res.error.stack) err.stack = res.error.stack;
  throw err;
}

ipcRenderer.on('pane:event', (_e, { event, data }) => {
  for (const key of [event, '*']) {
    for (const fn of listeners.get(key) || []) {
      try { key === '*' ? fn(event, data) : fn(data); } catch (err) { console.error(err); }
    }
  }
});

ipcRenderer.on('pane:log', (_e, { stream, line }) => {
  (stream === 'stderr' ? console.warn : console.log)('%cbackend', 'color:#7c3aed;font-weight:600', line);
});

function applySafeArea(area) {
  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty('--pane-safe-top', `${area.top}px`);
  root.style.setProperty('--pane-safe-left', `${area.left}px`);
  root.style.setProperty('--pane-safe-right', `${area.right}px`);
  root.dataset.paneTitleBar = info.window.titleBar;
  root.dataset.panePlatform = info.window.platform;
}
ipcRenderer.on('pane:safe-area', (_e, area) => applySafeArea(area));
if (document.documentElement) applySafeArea(info.window.safeArea);
else window.addEventListener('DOMContentLoaded', () => applySafeArea(info.window.safeArea), { once: true });

// ---- dev: show backend crashes in the window -----------------------------

if (info.app.dev) {
  let overlay = null;
  const hide = () => { if (overlay) { overlay.remove(); overlay = null; } };
  const showCrash = ({ code, log }) => {
    hide();
    overlay = document.createElement('pane-dev-overlay');
    const root = overlay.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 2147483647;
        font: 13px/1.5 system-ui, sans-serif; color: #f4f4f2; }
      .box { background: #2a1416; border: 1px solid #7a2a31; border-radius: 10px; padding: 14px 16px;
        box-shadow: 0 12px 40px -12px rgba(0,0,0,.6); -webkit-app-region: no-drag; }
      .row { display: flex; align-items: center; gap: 12px; }
      strong { font-size: 14px; flex: 1; }
      pre { margin: 10px 0 0; max-height: 40vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
        font: 12px/1.5 ui-monospace, monospace; color: #ffd9d9; user-select: text; }
      button { font: inherit; font-weight: 600; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
      .go { background: #f4f4f2; color: #2a1416; }
      .x { background: transparent; color: #f4f4f2; }
      button:focus-visible { outline: 2px solid #ffb4b4; outline-offset: 2px; }`;
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'alert');
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('strong');
    title.textContent = `The backend stopped (exit code ${code}). Save a backend file or restart it.`;
    const restart = document.createElement('button');
    restart.className = 'go';
    restart.textContent = 'Restart backend';
    restart.onclick = () => ipcRenderer.send('pane:dev', 'restart-backend');
    const close = document.createElement('button');
    close.className = 'x';
    close.textContent = 'Dismiss';
    close.onclick = hide;
    row.append(title, restart, close);
    const pre = document.createElement('pre');
    pre.textContent = (log || []).join('\n') || 'No output.';
    box.append(row, pre);
    root.append(style, box);
    (document.body || document.documentElement).append(overlay);
  };
  ipcRenderer.on('pane:event', (_e, { event, data }) => {
    if (event === 'pane:backend-exit') showCrash(data || {});
    else if (event === 'pane:backend-restart') hide();
  });
}

const win = (name, arg) => ipcRenderer.invoke('pane:window', name, arg).then(unwrap);

contextBridge.exposeInMainWorld('pane', {
  app: Object.freeze({ ...info.app }),

  // Call a function the backend exposed: await pane.call('save', note)
  call: (method, ...args) => ipcRenderer.invoke('pane:call', method, args).then(unwrap),

  // Send an event to the backend without waiting for an answer.
  send: (event, data) => ipcRenderer.send('pane:send', event, data),

  // Listen for backend events. Returns a function that stops listening.
  // pane.on('*', (event, data) => ...) receives every event.
  on: (event, fn) => {
    if (typeof event !== 'string' || typeof fn !== 'function') throw new TypeError('pane.on(event, function)');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },

  window: Object.freeze({
    id: info.window.id,
    isMain: info.window.main,
    // pane.window.open('settings.html', { width: 480, height: 360, title: 'Settings' })
    open: (page, options = {}) => win('open', { ...options, page }),
    close: () => win('close'),
    minimize: () => win('minimize'),
    toggleMaximize: () => win('toggleMaximize'),
    toggleFullScreen: () => win('toggleFullScreen'),
    setTitle: (title) => win('setTitle', title),
    focus: () => win('focus'),
  }),

  openExternal: (url) => ipcRenderer.invoke('pane:open-external', url).then(unwrap),
});
