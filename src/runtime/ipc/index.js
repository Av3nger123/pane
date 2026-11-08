'use strict';
// Wires every page API. Each area lives in its own file in this folder.

const { createHandlers } = require('./handle');
const { wireAppIpc } = require('./app');
const { wireDialogs } = require('./dialogs');
const { wireMenus } = require('./menus');
const { wireSystem } = require('./system');
const { wireStorage } = require('./storage');
const { wireUpdates } = require('./updates');

function wireIpc({ manifest, backend, windows, isAppUrl, dev, userData, updates }) {
  const { handle, fromApp } = createHandlers(isAppUrl);
  const ctx = { manifest, backend, windows, dev, userData, updates, handle, fromApp };
  wireAppIpc(ctx);
  wireDialogs(ctx);
  wireMenus(ctx);
  wireSystem(ctx);
  wireStorage(ctx);
  wireUpdates(ctx);
}

module.exports = { wireIpc };
