'use strict';
// Pane runtime: runs ONE Pane app in this process. Every app gets its own
// process, its own windows and its own Dock/taskbar identity, while all apps
// share the same Chromium and Node installed with Pane.
//
// Started by `pane dev|run <folder>` (electron main.js --app=<folder> [--dev])
// or by an installed app's launcher, which sets global.__paneBoot first.

const path = require('path');
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');

// protocol.js does not read PANE_HOME, so it can load before readBoot().
const { registerScheme, serveApp, makeIsAppUrl, isLocalDevUrl } = require('./lib/protocol');

const boot = readBoot();
if (boot.home) process.env.PANE_HOME = boot.home; // before anything reads Pane's paths

const { loadManifest } = require('./lib/manifest');
const { satisfies } = require('./lib/version');
const { RUNTIME_VERSION, dataDir } = require('./lib/paths');
const { Backend } = require('./lib/backend');
const { createWindowManager } = require('./lib/windows');
const { buildMenu } = require('./lib/menu');
const { watchForDev } = require('./lib/dev');
const { wireNative } = require('./lib/native');

// Exit code that tells `pane dev` to start the app again (pane.json changed).
const EXIT_RESTART = 75;

function readBoot() {
  if (global.__paneBoot) return global.__paneBoot;
  const args = process.argv.slice(1);
  const value = (name) => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : null;
  };
  const dev = args.includes('--dev');
  // A dev server is only ever used in dev mode, and only on this computer.
  const devUrl = dev && isLocalDevUrl(value('dev-url')) ? value('dev-url') : null;
  return { appDir: value('app'), dev, devUrl };
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
    manifest = loadManifest(path.resolve(boot.appDir), { requireUi: !boot.devUrl });
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
  const isAppUrl = makeIsAppUrl(manifest, boot.devUrl);

  app.on('second-instance', () => { if (windows) windows.focusMain(); });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => backend.stop());
  app.on('web-contents-created', (_e, contents) => lockDownContents(contents, isAppUrl));

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    serveApp(ses, manifest);
    applyPermissions(ses, manifest, isAppUrl);

    windows = createWindowManager(manifest, { dev: boot.dev, devUrl: boot.devUrl, isAppUrl });
    const fromApp = (e) => isAppUrl((e.senderFrame && e.senderFrame.url) || '');
    wireIpc(manifest, backend, windows, fromApp);

    // App menus from pane.menu.set(); a click goes to the window it was used in.
    let appMenus = [];
    const onMenuClick = (id, win) => {
      const target = (win && windows.get(win.id)) || null;
      if (target) target.webContents.send('pane:event', { event: 'pane:menu', data: { id } });
      else windows.broadcast('pane:event', { event: 'pane:menu', data: { id } });
    };
    const rebuildMenu = () => Menu.setApplicationMenu(buildMenu({ manifest, dev: boot.dev, windows, backend, appMenus, onClick: onMenuClick }));
    wireNative({ manifest, windows, fromApp, userData, dev: boot.dev, onAppMenus: (menus) => { appMenus = menus; rebuildMenu(); } });
    backend.on('emit', (payload) => windows.broadcast('pane:event', payload));
    backend.on('exit', ({ code, log, willRestart }) => windows.broadcast('pane:event', {
      event: 'pane:backend-exit',
      data: { code, willRestart, log: boot.dev ? log : undefined },
    }));
    backend.on('restart', () => windows.broadcast('pane:event', { event: 'pane:backend-restart', data: null }));
    if (boot.dev) backend.on('log', (entry) => windows.broadcast('pane:log', entry));

    if (process.platform === 'darwin' && boot.dev && manifest.icon) app.dock.setIcon(manifest.icon);
    rebuildMenu();

    backend.start();
    windows.open({ main: true });

    if (boot.dev) {
      if (boot.devUrl) console.log(`[pane] loading ${boot.devUrl} (dev server)`);
      watchForDev(manifest, {
        windows,
        backend,
        reloadUi: !boot.devUrl, // a dev server reloads its own pages
        onManifestChange: () => { backend.stop(); app.exit(EXIT_RESTART); },
      });
    }
  }).catch((err) => {
    // Never leave a running app with no window.
    backend.stop();
    fail(`${manifest.name} could not start`, (err && err.stack) || String(err));
  });
}

function wireIpc(manifest, backend, windows, fromApp) {
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

  // Dev-only helpers used by the crash screen.
  ipcMain.on('pane:dev', (e, action) => {
    if (!boot.dev || !fromApp(e)) return;
    if (action === 'restart-backend') backend.restart();
  });

  ipcMain.handle('pane:open-external', async (e, url) => {
    if (!fromApp(e)) return deny;
    if (!isExternalUrl(url)) return { ok: false, error: { message: 'Only http, https and mailto links can be opened.' } };
    await shell.openExternal(url);
    return { ok: true, value: true };
  });
}

// Pages stay on the app's own origin. Web links open in the user's browser.
function lockDownContents(contents, isAppUrl) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url);
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

// Only what pane.json asks for. macOS then asks the user for camera and
// microphone in the app's own name.
function applyPermissions(ses, manifest, isAppUrl) {
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
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isAppUrl(details.requestingUrl) && decide(permission, details));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const from = requestingOrigin || (details && details.requestingUrl);
    return isAppUrl(from) && decide(permission, details || {});
  });
}

function isExternalUrl(url) {
  return typeof url === 'string' && /^(https?:|mailto:)/i.test(url);
}

start();
