'use strict';
// Links (pane.json "protocols") and files ("fileTypes") the system opens the
// app with. They wait until a page calls pane.onOpen(), then go to that one
// window (never to every window, so nothing is handled twice).
// Must be set up before the app is ready: macOS sends the launch link early.

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { CHANNELS, EVENTS } = require('./ipc/channels');
const { asUrl, asFile, fromArgv } = require('../core/open-requests');
const { RUNTIME_ROOT } = require('../core/paths');

// getWindows: () => the window manager (null until ready)
function setupOpenRequests({ manifest, isAppUrl, getWindows }) {
  const queue = [];
  let receiver = null;

  const deliver = (request) => {
    if (!request) return;
    if (receiver && !receiver.isDestroyed()) {
      receiver.send(CHANNELS.EVENT, { event: EVENTS.OPEN, data: request });
      const win = BrowserWindow.fromWebContents(receiver);
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      return;
    }
    queue.push(request);
    if (getWindows()) getWindows().focusMain();
  };

  app.on('open-url', (e, url) => { e.preventDefault(); deliver(asUrl(url, manifest)); });
  app.on('open-file', (e, file) => { e.preventDefault(); deliver(asFile(file, manifest)); });
  for (const request of fromArgv(process.argv, manifest, process.cwd())) deliver(request);

  // A second launch (Windows/Linux links and files, `pane open`) lands here.
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const requests = fromArgv(argv, manifest, workingDirectory);
    if (!requests.length && getWindows()) getWindows().focusMain();
    for (const request of requests) deliver(request);
  });

  ipcMain.handle(CHANNELS.OPEN_REQUESTS, (e) => {
    if (!isAppUrl((e.senderFrame && e.senderFrame.url) || '')) return [];
    receiver = e.sender;
    return queue.splice(0);
  });
}

// Linux: tell the system that this app handles its protocols. macOS
// launchers declare them in Info.plist and Windows installs write them to the
// registry. Dev runs never register, so a half-built app does not take over links.
function registerProtocols(manifest, { dev }) {
  if (dev || process.platform !== 'linux' || !manifest.protocols.length) return;
  for (const scheme of manifest.protocols) {
    try {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [path.join(RUNTIME_ROOT, 'main.js'), `--app=${manifest.dir}`]);
    } catch (err) {
      console.error(`[pane] could not register ${scheme}:// (${err.message})`);
    }
  }
}

module.exports = { setupOpenRequests, registerProtocols };
