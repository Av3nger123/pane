'use strict';
// The app menu: Pane's standard menus (so copy, paste, zoom and window
// commands always work) plus the app's own menus from pane.menu.set().
//
// An app menu named like a standard one is merged into it: "File" items come
// first in File; "Edit", "View", "Window" and "Help" items are added at the
// end of those menus. Other app menus go between View and Window.

const { Menu, shell } = require('electron');

const MAC = process.platform === 'darwin';
const STANDARD = ['file', 'edit', 'view', 'window', 'help'];

function buildMenu({ manifest, dev, windows, backend, appMenus = [], onClick }) {
  const own = new Map();
  const extra = [];
  for (const m of appMenus) {
    const name = m.label.replace(/&/g, '').toLowerCase();
    if (STANDARD.includes(name) && !own.has(name)) own.set(name, m);
    else extra.push(m);
  }
  const items = (name) => (own.has(name) ? convert(own.get(name).items, onClick) : []);
  const sep = (list) => (list.length ? [{ type: 'separator' }, ...list] : []);

  const template = [];
  if (MAC) template.push({ role: 'appMenu' });
  template.push({
    label: own.get('file')?.label || 'File',
    submenu: [...items('file'), ...(own.has('file') ? [{ type: 'separator' }] : []), MAC ? { role: 'close' } : { role: 'quit' }],
  });
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
      ...sep(items('edit')),
    ],
  });
  template.push({
    label: 'View',
    submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...sep(items('view')),
    ],
  });
  for (const m of extra) template.push({ label: m.label, submenu: convert(m.items, onClick) });
  if (dev) {
    template.push({
      label: 'Develop',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => windows.reloadAll() },
        { label: 'Restart Backend', accelerator: 'CmdOrCtrl+Shift+R', enabled: Boolean(manifest.backend), click: () => backend.restart() },
        {
          label: 'Toggle Developer Tools',
          accelerator: MAC ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: (_item, win) => { if (win) win.webContents.toggleDevTools(); },
        },
        { type: 'separator' },
        { label: 'Show App Folder', click: () => shell.openPath(manifest.dir) },
      ],
    });
  }
  template.push({ role: 'windowMenu' });
  if (own.has('window')) {
    template[template.length - 1] = {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(MAC ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]), ...sep(items('window'))],
    };
  }
  if (own.has('help')) template.push({ role: 'help', submenu: items('help') });
  return Menu.buildFromTemplate(template);
}

// Checked items from normalizeMenu() -> Electron menu items. Clicks report
// the item's id and the window it was used in.
function convert(list, onClick) {
  return list.map((item) => {
    if (item.type === 'separator') return { type: 'separator' };
    const out = { label: item.label };
    if (item.items) out.submenu = convert(item.items, onClick);
    if (item.shortcut) out.accelerator = item.shortcut;
    if (item.enabled === false) out.enabled = false;
    if (item.checked !== undefined) { out.type = 'checkbox'; out.checked = item.checked; }
    if (item.id) out.click = (_menuItem, win) => onClick(item.id, win);
    return out;
  });
}

module.exports = { buildMenu, convert };
