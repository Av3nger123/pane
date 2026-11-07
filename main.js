'use strict';
// Pane runtime: runs ONE Pane app in this process. Every app gets its own
// process, its own windows and its own Dock/taskbar identity, while all apps
// share the same Chromium and Node installed with Pane.
//
// Started by `pane dev|run <folder>` (electron main.js --app=<folder> [--dev])
// or by an installed app's launcher, which sets global.__paneBoot first.

const path = require('path');
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');

const boot = readBoot();
if (boot.home) process.env.PANE_HOME = boot.home;

const { loadManifest } = require('./lib/manifest');
const { satisfies } = require('./lib/version');
const { RUNTIME_VERSION, dataDir } = require('./lib/paths');
const { registerScheme, serveApp, originFor } = require('./lib/protocol');
const { Backend } = require('./lib/backend');
const { createWindowManager } = require('./lib/windows');
const { buildMenu } = require('./lib/menu');
const { watchForDev } = require('./lib/dev');

// Exit code that tells `pane dev` to start the app again (pane.json changed).
const EXIT_RESTART = 75;

function readBoot() {
  if (global.__paneBoot) return global.__paneBoot;
  const args = process.argv.slice(1);
  const appArg = args.find((a) => a.startsWith('--app='));
  return { appDir: appArg ? appArg.slice('--app='.length) : null, dev: args.includes('--dev') };
}

function fail(title, message) {
  console.error(`pane: ${title}\n${message}`);
  if (!boot.dev) dialog.showErrorBox(title, message);
  app.exit(1);
}

function start() {
  if (!boot.appDir) return fail('No app to open', 'Start an app with: pane dev <app folder>');

  let manifest;
  try {
    manifest = loadManifest(path.resolve(boot.appDir));
  } catch (err) {
    return fail('This app could not start', err.message);
  }
  if (!satisfies(RUNTIME_VERSION, manifest.pane)) {
    return fail(`${manifest.name} needs a newer Pane`,
      `${manifest.name} needs Pane ${manifest.pane}. This computer has Pane ${RUNTIME_VERSION}.`);
  }

  app.setName(manifest.name);
  app.setPath('userData', dataDir(manifest.id, boot.dev));
  if (process.platform === 'win32') app.setAppUserModelId(`dev.pane.app.${manifest.id}`);
  registerScheme();

  // One running copy per app: opening it again focuses the existing window.
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }

  const userData = app.getPath('userData');
  const backend = new Backend(manifest, {
    dev: boot.dev,
    dataDir: path.join(userData, 'files'),
    logFile: boot.dev ? null : path.join(userData, 'logs', 'backend.log'),
  });
  let windows = null;

  app.on('second-instance', () => { if (windows) windows.focusMain(); });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => backend.stop());
  app.on('web-contents-created', (_e, contents) => lockDownContents(contents, manifest));

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    serveApp(ses, manifest);
    applyPermissions(ses, manifest);

    windows = createWindowManager(manifest, { dev: boot.dev });
    wireIpc(manifest, backend, windows);
    backend.on('emit', (payload) => windows.broadcast('pane:event', payload));
    backend.on('exit', (code) => windows.broadcast('pane:event', { event: 'pane:backend-exit', data: { code } }));
    backend.on('restart', () => windows.broadcast('pane:event', { event: 'pane:backend-restart', data: null }));
    if (boot.dev) backend.on('log', (entry) => windows.broadcast('pane:log', entry));

    if (process.platform === 'darwin' && boot.dev && manifest.icon) app.dock.setIcon(manifest.icon);
    Menu.setApplicationMenu(buildMenu({ manifest, dev: boot.dev, windows, backend }));

    backend.start();
    windows.open({ main: true });

    if (boot.dev) {
      watchForDev(manifest, {
        windows,
        backend,
        onManifestChange: () => { backend.stop(); app.exit(EXIT_RESTART); },
      });
    }
  });
}

function wireIpc(manifest, backend, windows) {
  const origin = originFor(manifest);
  const fromApp = (e) => {
    const url = (e.senderFrame && e.senderFrame.url) || '';
    return url === origin || url.startsWith(`${origin}/`);
  };
  const deny = { ok: false, error: { message: 'Not allowed from this page.' } };

  ipcMain.on('pane:info', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    e.returnValue = {
      app: {
        id: manifest.id, name: manifest.name, version: manifest.version,
        dev: boot.dev, hasBackend: Boolean(manifest.backend), pane: RUNTIME_VERSION,
      },
      window: windows.describe(win),
    };
  });

  ipcMain.handle('pane:call', async (e, method, args) => {
    if (!fromApp(e)) return deny;
    if (typeof method !== 'string' || !method) return { ok: false, error: { message: 'pane.call needs a function name.' } };
    try {
      return { ok: true, value: await backend.call(method, Array.isArray(args) ? args : []) };
    } catch (err) {
      return { ok: false, error: { message: err.message, stack: boot.dev ? err.backendStack : undefined } };
    }
  });

  ipcMain.on('pane:send', (e, event, data) => {
    if (fromApp(e) && typeof event === 'string' && event) backend.send(event, data);
  });

  ipcMain.handle('pane:window', (e, name, arg) => {
    if (!fromApp(e)) return deny;
    try {
      return { ok: true, value: windows.action(BrowserWindow.fromWebContents(e.sender), name, arg) };
    } catch (err) {
      return { ok: false, error: { message: err.message } };
    }
  });

  ipcMain.handle('pane:open-external', async (e, url) => {
    if (!fromApp(e)) return deny;
    if (!isExternalUrl(url)) return { ok: false, error: { message: 'Only http, https and mailto links can be opened.' } };
    await shell.openExternal(url);
    return { ok: true, value: true };
  });
}

// Pages stay on the app's own origin. Web links open in the user's browser.
function lockDownContents(contents, manifest) {
  const origin = originFor(manifest);
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (url === origin || url.startsWith(`${origin}/`)) return;
    e.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url);
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

// Only what pane.json asks for. macOS then asks the user for camera and
// microphone in the app's own name.
function applyPermissions(ses, manifest) {
  const origin = originFor(manifest);
  const allowed = new Set(manifest.permissions);
  const decide = (permission, details = {}) => {
    switch (permission) {
      case 'fullscreen':
      case 'clipboard-sanitized-write':
        return true;
      case 'notifications':
        return allowed.has('notifications');
      case 'clipboard-read':
        return allowed.has('clipboard');
      case 'geolocation':
        return allowed.has('geolocation');
      case 'media': {
        const types = details.mediaTypes || [];
        if (!types.length) return allowed.has('camera') || allowed.has('microphone');
        return types.every((t) => (t === 'video' ? allowed.has('camera') : t === 'audio' ? allowed.has('microphone') : false));
      }
      default:
        return false;
    }
  };
  const fromOrigin = (url) => typeof url === 'string' && (url === origin || url.startsWith(`${origin}/`));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(fromOrigin(details.requestingUrl) && decide(permission, details));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const from = requestingOrigin || (details && details.requestingUrl);
    return fromOrigin(from) && decide(permission, details || {});
  });
}

function isExternalUrl(url) {
  return typeof url === 'string' && /^(https?:|mailto:)/i.test(url);
}

start();
