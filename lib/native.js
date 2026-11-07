'use strict';
// Native features for app pages: dialogs, menus, notifications, Finder/
// Explorer, a small settings store and keychain-backed secrets.
// Every request is checked to come from the app's own pages, and validated
// (lib/native-validate.js) before it reaches the OS.

const fs = require('fs');
const path = require('path');
const { BrowserWindow, Menu, Notification, dialog, ipcMain, safeStorage, shell } = require('electron');
const { InputError, normalizeAppMenus, normalizeMenu, normalizeDialog, normalizeNotification } = require('./native-validate');
const { createStore, createSecrets, StoreError } = require('./stores');
const { convert } = require('./menu');

function wireNative({ manifest, windows, fromApp, userData, onAppMenus, dev }) {
  const testAnswers = dev ? readTestAnswers() : null;
  const store = createStore(path.join(userData, 'pane-store.json'));
  const secrets = createSecrets(path.join(userData, 'pane-secrets.json'), {
    // On Linux without a keyring Electron falls back to a fixed key; that is
    // not secret, so Pane refuses rather than pretend.
    available: () => safeStorage.isEncryptionAvailable()
      && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  });

  // Registers an IPC handler that only answers the app's pages and turns
  // errors into { ok: false, error } for the preload to rethrow.
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!fromApp(e)) return { ok: false, error: { message: 'Not allowed from this page.' } };
    try {
      return { ok: true, value: await fn(BrowserWindow.fromWebContents(e.sender), ...args) };
    } catch (err) {
      const known = err instanceof InputError || err instanceof StoreError;
      return { ok: false, error: { message: known ? err.message : `Pane could not do that: ${err.message}` } };
    }
  });

  handle('pane:dialog', async (win, kind, opts) => {
    const options = normalizeDialog(kind, opts);
    if (testAnswers && kind in testAnswers) {
      console.log(`[pane] test mode: answered the ${kind} dialog with ${JSON.stringify(testAnswers[kind])}`);
      return testAnswers[kind];
    }
    if (kind === 'open') {
      const r = await dialog.showOpenDialog(win, options);
      return r.canceled ? [] : r.filePaths;
    }
    if (kind === 'save') {
      const r = await dialog.showSaveDialog(win, options);
      return r.canceled || !r.filePath ? null : r.filePath;
    }
    return (await dialog.showMessageBox(win, options)).response;
  });

  handle('pane:menu', (win, action, payload) => {
    if (action === 'set') {
      onAppMenus(normalizeAppMenus(payload));
      return true;
    }
    if (action === 'popup') {
      const items = normalizeMenu(payload && payload.items, { what: 'The context menu' });
      return new Promise((resolve) => {
        let chosen = null;
        const menu = Menu.buildFromTemplate(convert(items, (id) => { chosen = id; }));
        const at = payload && Number.isFinite(payload.x) && Number.isFinite(payload.y)
          ? { x: Math.round(payload.x), y: Math.round(payload.y) } : {};
        // The click handler runs before the menu reports that it closed.
        menu.popup({ window: win, ...at, callback: () => setImmediate(() => resolve(chosen)) });
      });
    }
    throw new InputError(`Unknown menu action "${action}".`);
  });

  handle('pane:shell', (_win, action, target) => {
    if (action !== 'showItemInFolder') throw new InputError(`Unknown action "${action}".`);
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new InputError('showItemInFolder needs an absolute path.');
    if (!fs.existsSync(target)) throw new InputError(`There is nothing at ${target}.`);
    shell.showItemInFolder(target);
    return true;
  });

  handle('pane:notify', (win, opts) => {
    if (!manifest.permissions.includes('notifications')) {
      throw new InputError('Add "notifications" to "permissions" in pane.json to show notifications.');
    }
    const n = normalizeNotification(opts);
    if (!Notification.isSupported()) return false;
    const notification = new Notification({ title: n.title, body: n.body, silent: n.silent });
    notification.on('click', () => {
      const target = win && !win.isDestroyed() ? win : null;
      if (target) {
        if (target.isMinimized()) target.restore();
        target.focus();
        target.webContents.send('pane:event', { event: 'pane:notification-click', data: { id: n.id || null } });
      } else {
        windows.focusMain();
      }
    });
    notification.show();
    return true;
  });

  handle('pane:store', (_win, action, key, value) => {
    if (action === 'get') return store.get(key);
    if (action === 'set') return store.set(key, value);
    if (action === 'delete') return store.delete(key);
    if (action === 'all') return store.all();
    throw new InputError(`Unknown store action "${action}".`);
  });

  handle('pane:secrets', (_win, action, key, value) => {
    if (action === 'get') return secrets.get(key);
    if (action === 'set') return secrets.set(key, value);
    if (action === 'delete') return secrets.delete(key);
    throw new InputError(`Unknown secrets action "${action}".`);
  });
}

// For end-to-end tests, under `pane dev` only: PANE_TEST_DIALOGS answers
// dialogs instead of showing them, e.g.
//   PANE_TEST_DIALOGS='{"message":0,"save":"/tmp/out.md","open":["/tmp/in.md"]}'
function readTestAnswers() {
  const raw = process.env.PANE_TEST_DIALOGS;
  if (!raw) return null;
  try {
    const answers = JSON.parse(raw);
    return answers && typeof answers === 'object' ? answers : null;
  } catch {
    console.error('[pane] PANE_TEST_DIALOGS is not valid JSON; showing real dialogs');
    return null;
  }
}

module.exports = { wireNative };
