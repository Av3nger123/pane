'use strict';
// An app's windows. Every app can open as many as it likes; they all belong to
// the app's own process and Dock/taskbar icon.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const { resolveInside } = require('./safe-path');
const { SCHEME } = require('./protocol');

const PRELOAD = path.join(__dirname, '..', 'preload.js');
const MAC = process.platform === 'darwin';

// Space the window controls take when the title bar is hidden. Apps read these
// as CSS variables (--pane-safe-top, --pane-safe-left, --pane-safe-right).
const MAC_TRAFFIC_LIGHTS = { x: 16, y: 16 };
const MAC_SAFE = { top: 44, left: 84, right: 0 };
const OVERLAY_HEIGHT = 40;
const OTHER_SAFE = { top: OVERLAY_HEIGHT, left: 0, right: 138 };
const NO_SAFE = { top: 0, left: 0, right: 0 };

function createWindowManager(manifest, { dev }) {
  const all = new Map();
  let mainId = null;
  const stateFile = path.join(app.getPath('userData'), 'pane-window.json');

  function titleBarOptions() {
    if (manifest.window.titleBar !== 'hidden') return {};
    if (MAC) return { titleBarStyle: 'hidden', trafficLightPosition: MAC_TRAFFIC_LIGHTS };
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: manifest.window.background, symbolColor: contrastColor(manifest.window.background), height: OVERLAY_HEIGHT },
    };
  }

  function safeArea(win) {
    if (manifest.window.titleBar !== 'hidden' || !win || win.isDestroyed()) return NO_SAFE;
    if (MAC) return win.isFullScreen() ? NO_SAFE : MAC_SAFE;
    return OTHER_SAFE;
  }

  function pageFile(page) {
    const file = typeof page === 'string' ? resolveInside(manifest.uiDir, page, { decode: false }) : null;
    if (!file || !isFile(file)) throw new Error(`There is no page "${page}" in the app's "${manifest.ui}" folder.`);
    return page.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function urlFor(page) {
    return `${SCHEME}://${manifest.id}/${page.split('/').map(encodeURIComponent).join('/')}`;
  }

  function open(opts = {}) {
    const page = pageFile(opts.page || manifest.start);
    const w = manifest.window;
    const saved = opts.main ? readState() : null;
    const win = new BrowserWindow({
      width: opts.width || (saved && saved.width) || w.width,
      height: opts.height || (saved && saved.height) || w.height,
      x: saved ? saved.x : undefined,
      y: saved ? saved.y : undefined,
      minWidth: Math.min(w.minWidth, opts.width || w.minWidth),
      minHeight: Math.min(w.minHeight, opts.height || w.minHeight),
      title: opts.title || manifest.name,
      backgroundColor: w.background,
      show: false,
      icon: !MAC && manifest.icon ? manifest.icon : undefined,
      ...titleBarOptions(),
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: true,
        devTools: dev,
      },
    });
    const id = win.id;
    all.set(id, win);
    if (opts.main || mainId === null) mainId = id;
    if (saved && saved.maximized) win.maximize();

    const show = () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); };
    win.once('ready-to-show', show);
    setTimeout(show, 3000); // never leave a window invisible if the page is slow or broken

    const pushSafeArea = () => win.webContents.send('pane:safe-area', safeArea(win));
    win.on('enter-full-screen', pushSafeArea);
    win.on('leave-full-screen', pushSafeArea);
    if (id === mainId) win.on('close', () => saveState(win));
    win.on('closed', () => {
      all.delete(id);
      if (mainId === id) mainId = all.size ? all.keys().next().value : null;
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (code !== -3) console.error(`[pane] could not load ${url}: ${desc}`);
    });

    win.loadURL(urlFor(page));
    return id;
  }

  function action(win, name, arg) {
    if (!win || win.isDestroyed()) throw new Error('That window is closed.');
    switch (name) {
      case 'open': {
        const o = arg && typeof arg === 'object' ? arg : {};
        return open({
          page: typeof o.page === 'string' ? o.page : undefined,
          width: pixels(o.width),
          height: pixels(o.height),
          title: typeof o.title === 'string' ? o.title.slice(0, 200) : undefined,
        });
      }
      case 'close': win.close(); return true;
      case 'minimize': win.minimize(); return true;
      case 'toggleMaximize':
        if (win.isMaximized()) win.unmaximize(); else win.maximize();
        return win.isMaximized();
      case 'toggleFullScreen':
        win.setFullScreen(!win.isFullScreen());
        return true;
      case 'setTitle': win.setTitle(String(arg == null ? '' : arg).slice(0, 200)); return true;
      case 'focus': win.focus(); return true;
      default: throw new Error(`Unknown window action "${name}".`);
    }
  }

  function describe(win) {
    return {
      id: win ? win.id : null,
      main: Boolean(win && win.id === mainId),
      titleBar: manifest.window.titleBar,
      platform: process.platform,
      safeArea: safeArea(win),
    };
  }

  function broadcast(channel, payload) {
    for (const win of all.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function reloadAll() {
    for (const win of all.values()) if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }

  function focusMain() {
    const win = mainId !== null ? all.get(mainId) : null;
    if (!win) { open({ main: true }); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) return null;
      // Only reuse the position if it is still on a connected screen.
      const visible = screen.getAllDisplays().some(({ workArea: a }) =>
        s.x + 100 > a.x && s.x < a.x + a.width - 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 100);
      return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
    } catch {
      return null;
    }
  }

  function saveState(win) {
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch { /* not important */ }
  }

  return { open, action, describe, broadcast, reloadAll, focusMain, get count() { return all.size; } };
}

function pixels(v) {
  return Number.isInteger(v) && v >= 100 && v <= 10000 ? v : undefined;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Black or white window-control symbols, whichever reads better on `hex`.
function contrastColor(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1b1b1b' : '#f5f5f5';
}

module.exports = { createWindowManager, contrastColor };
