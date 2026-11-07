'use strict';
// Every message name between app pages (src/runtime/preload.js) and the
// runtime. The preload runs sandboxed and cannot import this file, so
// test/unit/architecture.test.js checks that both sides use the same names.

const CHANNELS = Object.freeze({
  // page -> runtime
  INFO: 'pane:info', // sync: app and window info for the preload
  CALL: 'pane:call', // call a backend function
  SEND: 'pane:send', // event to the backend
  WINDOW: 'pane:window', // window actions
  DEV: 'pane:dev', // dev-only helpers (crash screen)
  OPEN_EXTERNAL: 'pane:open-external',
  OPEN_REQUESTS: 'pane:open-requests', // links and files waiting for a page
  DIALOG: 'pane:dialog',
  MENU: 'pane:menu',
  SHELL: 'pane:shell',
  NOTIFY: 'pane:notify',
  STORE: 'pane:store',
  SECRETS: 'pane:secrets',
  // runtime -> page
  EVENT: 'pane:event', // { event, data }: backend events and the runtime events below
  LOG: 'pane:log', // backend output during pane dev
  SAFE_AREA: 'pane:safe-area', // window-control space changed (full screen)
});

// Runtime events delivered on CHANNELS.EVENT (pages: pane.on(name, fn)).
const EVENTS = Object.freeze({
  OPEN: 'pane:open',
  MENU: 'pane:menu',
  NOTIFICATION_CLICK: 'pane:notification-click',
  BACKEND_EXIT: 'pane:backend-exit',
  BACKEND_RESTART: 'pane:backend-restart',
});

module.exports = { CHANNELS, EVENTS };
