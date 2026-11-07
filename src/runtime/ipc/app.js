'use strict';
// The core page API: app info, backend calls and events, windows, links.

const { BrowserWindow, ipcMain, shell } = require('electron');
const { CHANNELS } = require('./channels');
const { userError } = require('./handle');
const { isExternalUrl } = require('../security');
const { RUNTIME_VERSION } = require('../../core/paths');

function wireAppIpc({ manifest, backend, windows, dev, handle, fromApp }) {
  ipcMain.on(CHANNELS.INFO, (e) => {
    e.returnValue = {
      app: {
        id: manifest.id, name: manifest.name, version: manifest.version,
        dev, hasBackend: Boolean(manifest.backend), pane: RUNTIME_VERSION,
      },
      window: windows.describe(BrowserWindow.fromWebContents(e.sender)),
    };
  });

  handle(CHANNELS.CALL, async (_win, method, args) => {
    if (typeof method !== 'string' || !method) throw userError('pane.call needs a function name.');
    try {
      return await backend.call(method, Array.isArray(args) ? args : []);
    } catch (err) {
      throw userError(err.message, dev ? err.backendStack : undefined);
    }
  });

  ipcMain.on(CHANNELS.SEND, (e, event, data) => {
    if (fromApp(e) && typeof event === 'string' && event) backend.send(event, data);
  });

  handle(CHANNELS.WINDOW, (win, name, arg) => {
    try {
      return windows.action(win, name, arg);
    } catch (err) {
      throw userError(err.message);
    }
  });

  // Dev-only helpers used by the crash screen.
  ipcMain.on(CHANNELS.DEV, (e, action) => {
    if (!dev || !fromApp(e)) return;
    if (action === 'restart-backend') backend.restart();
  });

  handle(CHANNELS.OPEN_EXTERNAL, async (_win, url) => {
    if (!isExternalUrl(url)) throw userError('Only http, https and mailto links can be opened.');
    await shell.openExternal(url);
    return true;
  });
}

module.exports = { wireAppIpc };
