'use strict';
// pane.updates, for pages and backends: the app's own updates. The app
// decides when to check and draws its own UI; Pane checks, downloads and
// verifies (through the pane command), and installs on restart.

const { CHANNELS, EVENTS } = require('./channels');
const { userError } = require('./handle');
const { InputError } = require('../../core/validate');
const { runAppUpdate, restartToUpdate } = require('../updates');

// -> request(action, arg): the one entry point pages and the backend share.
function createUpdates({ app, manifest, home, installed, dev, windows, backend }) {
  const tell = (event, data) => {
    windows.broadcast(CHANNELS.EVENT, { event, data });
    backend.send(event, data);
  };
  const progress = (fraction) => tell(EVENTS.UPDATE_PROGRESS, fraction);
  const run = async (args, onProgress) => {
    try {
      return await runAppUpdate(home, args, onProgress);
    } catch (err) {
      throw userError(err.message);
    }
  };

  return async function request(action, arg) {
    if (dev) throw userError('Updates work in installed apps, not under pane dev.');
    if (!installed) throw userError('Updates work in installed apps (pane install), not in this copy.');
    if (action === 'check') {
      const { available, version, notes } = await run(['check', manifest.id]);
      return { available, version, notes };
    }
    if (action === 'download' || action === 'installFile') {
      if (action === 'installFile' && (typeof arg !== 'string' || !arg)) throw new InputError('pane.updates.installFile(path) needs the path of a .paneapp file.');
      const result = action === 'download'
        ? await run(['download', manifest.id], progress)
        : await run(['install-file', manifest.id, arg]);
      tell(EVENTS.UPDATE_READY, { version: result.version });
      return { version: result.version };
    }
    if (action === 'restart') {
      setImmediate(() => restartToUpdate({ app, manifest, home }));
      return null;
    }
    throw new InputError(`Unknown updates action "${action}".`);
  };
}

function wireUpdates({ handle, updates }) {
  handle(CHANNELS.UPDATES, (_win, action, arg) => updates(action, arg));
}

module.exports = { createUpdates, wireUpdates };
