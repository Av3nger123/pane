'use strict';
// pane.store (JSON settings) and pane.secrets (OS keychain), kept in the
// app's profile folder.

const path = require('path');
const { safeStorage } = require('electron');
const { CHANNELS } = require('./channels');
const { InputError } = require('../../core/validate');
const { createStore, createSecrets } = require('../../core/stores');

function wireStorage({ userData, handle }) {
  const store = createStore(path.join(userData, 'pane-store.json'));
  const secrets = createSecrets(path.join(userData, 'pane-secrets.json'), {
    // On Linux without a keyring Electron falls back to a fixed key; that is
    // not secret, so Pane refuses rather than pretend.
    available: () => safeStorage.isEncryptionAvailable()
      && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  });

  handle(CHANNELS.STORE, (_win, action, key, value) => {
    if (action === 'get') return store.get(key);
    if (action === 'set') return store.set(key, value);
    if (action === 'delete') return store.delete(key);
    if (action === 'all') return store.all();
    throw new InputError(`Unknown store action "${action}".`);
  });

  handle(CHANNELS.SECRETS, (_win, action, key, value) => {
    if (action === 'get') return secrets.get(key);
    if (action === 'set') return secrets.set(key, value);
    if (action === 'delete') return secrets.delete(key);
    throw new InputError(`Unknown secrets action "${action}".`);
  });
}

module.exports = { wireStorage };
