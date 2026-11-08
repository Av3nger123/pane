'use strict';
// Wires every page API. Each area lives in its own file in this folder.

const { createHandlers } = require('./handle');
const { wireAppIpc } = require('./app');
const { wireDialogs } = require('./dialogs');
const { wireMenus } = require('./menus');
const { wireSystem } = require('./system');
const { wireStorage } = require('./storage');

function wireIpc({ manifest, backend, windows, isAppUrl, dev, userData }) {
  const { handle, fromApp } = createHandlers(isAppUrl);
  const ctx = { manifest, backend, windows, dev, userData, handle, fromApp };
  wireAppIpc(ctx);
  wireDialogs(ctx);
  wireMenus(ctx);
  wireSystem(ctx);
  wireStorage(ctx);
}

module.exports = { wireIpc };
