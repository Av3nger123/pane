'use strict';
// Request handlers for app pages: only the app's own pages are answered, and
// errors come back as { ok: false, error } for the preload to rethrow.

const { BrowserWindow, ipcMain } = require('electron');
const { InputError } = require('../../core/validate');
const { StoreError } = require('../../core/stores');

const DENIED = Object.freeze({ ok: false, error: { message: 'Not allowed from this page.' } });

// isAppUrl -> { fromApp(event), handle(channel, fn(win, ...args)) }
function createHandlers(isAppUrl) {
  const fromApp = (e) => isAppUrl((e.senderFrame && e.senderFrame.url) || '');
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!fromApp(e)) return DENIED;
    try {
      return { ok: true, value: await fn(BrowserWindow.fromWebContents(e.sender), ...args) };
    } catch (err) {
      const known = err instanceof InputError || err instanceof StoreError || err.paneMessage;
      return { ok: false, error: { message: known ? err.message : `Pane could not do that: ${err.message}`, stack: err.paneStack } };
    }
  });
  return { fromApp, handle };
}

// An error whose message is meant for the developer as is.
function userError(message, stack) {
  const err = new Error(message);
  err.paneMessage = true;
  if (stack) err.paneStack = stack;
  return err;
}

module.exports = { createHandlers, userError, DENIED };
