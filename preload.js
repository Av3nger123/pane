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
