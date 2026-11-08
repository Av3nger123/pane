'use strict';
// Pane runtime: runs ONE Pane app in this process. Every app gets its own
// process, its own windows and its own Dock/taskbar identity, while all apps
// share the same Chromium and Node installed with Pane.
//
// Started through the root main.js by `pane dev|run <folder>`
// (electron main.js --app=<folder> [--dev]) or by an installed app's launcher,
// which sets global.__paneBoot first.

const path = require('path');
const { app, dialog, session } = require('electron');

// protocol.js does not read PANE_HOME, so it can load before readBoot().
const { registerScheme, serveApp, makeIsAppUrl, isLocalDevUrl } = require('./protocol');

const boot = readBoot();
if (boot.home) process.env.PANE_HOME = boot.home; // before anything reads Pane's paths

const { loadManifest } = require('../core/manifest');
const { satisfies } = require('../core/version');
const { RUNTIME_VERSION, dataDir } = require('../core/paths');
const { Backend } = require('./backend');
const { createWindowManager } = require('./windows');
const { watchForDev } = require('./dev');
const { wireIpc } = require('./ipc');
const { CHANNELS, EVENTS } = require('./ipc/channels');
const { lockDownContents, applyPermissions } = require('./security');
const { setupOpenRequests, registerProtocols } = require('./open');

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
  // --open-only: started by `pane open` to hand a link or file to the running copy.
  return { appDir: value('app'), dev, devUrl, openOnly: args.includes('--open-only') };
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
    manifest = loadManifest(path.resolve(boot.appDir), { requireUi: !boot.devUrl && !boot.openOnly });
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

  // One running copy per app: opening it again focuses the existing window
  // (and hands over any link or file it was opened with, see open.js).
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  if (boot.openOnly && boot.dev && manifest.dev && !boot.devUrl) {
    return fail(`${manifest.name} is not running`, `Start it first with: pane dev ${manifest.dir}`);
  }

  const userData = app.getPath('userData');
  const backend = new Backend(manifest, {
    dev: boot.dev,
    dataDir: path.join(userData, 'files'),
    logFile: boot.dev ? null : path.join(userData, 'logs', 'backend.log'),
  });
  const isAppUrl = makeIsAppUrl(manifest, boot.devUrl);
  let windows = null;

  setupOpenRequests({ manifest, isAppUrl, getWindows: () => windows });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => backend.stop());
  app.on('web-contents-created', (_e, contents) => lockDownContents(contents, isAppUrl));

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    serveApp(ses, manifest);
    applyPermissions(ses, manifest, isAppUrl);

    windows = createWindowManager(manifest, { dev: boot.dev, devUrl: boot.devUrl, isAppUrl });
    wireIpc({ manifest, backend, windows, isAppUrl, dev: boot.dev, userData });
    forwardBackendEvents(backend, windows);

    if (process.platform === 'darwin' && boot.dev && manifest.icon) app.dock.setIcon(manifest.icon);
    registerProtocols(manifest, { dev: boot.dev });
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

// Backend events and lifecycle go to every window.
function forwardBackendEvents(backend, windows) {
  backend.on('emit', (payload) => windows.broadcast(CHANNELS.EVENT, payload));
  backend.on('exit', ({ code, log, willRestart }) => windows.broadcast(CHANNELS.EVENT, {
    event: EVENTS.BACKEND_EXIT,
    data: { code, willRestart, log: boot.dev ? log : undefined },
  }));
  backend.on('restart', () => windows.broadcast(CHANNELS.EVENT, { event: EVENTS.BACKEND_RESTART, data: null }));
  if (boot.dev) backend.on('log', (entry) => windows.broadcast(CHANNELS.LOG, entry));
}

start();
