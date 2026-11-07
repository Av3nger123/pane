'use strict';

const { Menu, shell } = require('electron');

const MAC = process.platform === 'darwin';

function buildMenu({ manifest, dev, windows, backend }) {
  const template = [];
  if (MAC) template.push({ role: 'appMenu' });
  template.push({ role: 'fileMenu' });
  template.push({ role: 'editMenu' });
  template.push({
    label: 'View',
    submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });
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
  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
