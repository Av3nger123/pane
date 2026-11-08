'use strict';
// Finder / Explorer and system notifications.

const fs = require('fs');
const path = require('path');
const { Notification, shell } = require('electron');
const { CHANNELS, EVENTS } = require('./channels');
const { InputError, normalizeNotification } = require('../../core/validate');

function wireSystem({ manifest, windows, handle }) {
  handle(CHANNELS.SHELL, (_win, action, target) => {
    if (action !== 'showItemInFolder') throw new InputError(`Unknown action "${action}".`);
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new InputError('showItemInFolder needs an absolute path.');
    if (!fs.existsSync(target)) throw new InputError(`There is nothing at ${target}.`);
    shell.showItemInFolder(target);
    return true;
  });

  handle(CHANNELS.NOTIFY, (win, opts) => {
    if (!manifest.permissions.includes('notifications')) {
      throw new InputError('Add "notifications" to "permissions" in pane.json to show notifications.');
    }
    const n = normalizeNotification(opts);
    if (!Notification.isSupported()) return false;
    const notification = new Notification({ title: n.title, body: n.body, silent: n.silent });
    notification.on('click', () => {
      const target = win && !win.isDestroyed() ? win : null;
      if (!target) { windows.focusMain(); return; }
      if (target.isMinimized()) target.restore();
      target.focus();
      target.webContents.send(CHANNELS.EVENT, { event: EVENTS.NOTIFICATION_CLICK, data: { id: n.id || null } });
    });
    notification.show();
    return true;
  });
}

module.exports = { wireSystem };
