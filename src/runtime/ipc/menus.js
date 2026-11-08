'use strict';
// pane.menu: the app menu (merged into Pane's standard menus) and context menus.

const { Menu } = require('electron');
const { CHANNELS, EVENTS } = require('./channels');
const { InputError, normalizeAppMenus, normalizeMenu } = require('../../core/validate');
const { buildMenu, convert } = require('../menu');

function wireMenus({ manifest, windows, backend, dev, handle }) {
  let appMenus = [];
  // A click goes to the window it was used in.
  const onClick = (id, win) => {
    const target = (win && windows.get(win.id)) || null;
    const message = { event: EVENTS.MENU, data: { id } };
    if (target) target.webContents.send(CHANNELS.EVENT, message);
    else windows.broadcast(CHANNELS.EVENT, message);
  };
  const rebuild = () => Menu.setApplicationMenu(buildMenu({ manifest, dev, windows, backend, appMenus, onClick }));

  handle(CHANNELS.MENU, (win, action, payload) => {
    if (action === 'set') {
      appMenus = normalizeAppMenus(payload);
      rebuild();
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

  rebuild();
}

module.exports = { wireMenus };
