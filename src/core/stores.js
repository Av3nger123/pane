'use strict';
// Small per-app storage kept by Pane in the app's profile folder:
//   pane.store    JSON values (settings, last-opened state)
//   pane.secrets  strings encrypted with the OS keychain (tokens, passwords)
// The same in `pane dev` and in installed apps. No Electron imports: the
// encryption functions are passed in, so this can be unit-tested.

const fs = require('fs');
const path = require('path');

const MAX_STORE_BYTES = 1024 * 1024;
const KEY = /^[\w.:-]{1,200}$/;

class StoreError extends Error {}

function checkKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new StoreError(`"${key}" is not a valid key. Use letters, digits and . _ : - (up to 200 characters).`);
  }
  return key;
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function createStore(file) {
  let data = null;
  const load = () => { if (!data) data = readJson(file); return data; };
  return {
    get(key) {
      const d = load();
      return Object.prototype.hasOwnProperty.call(d, checkKey(key)) ? d[key] : undefined;
    },
    set(key, value) {
      checkKey(key);
      if (value === undefined) return this.delete(key);
      let json;
      try { json = JSON.stringify(value); } catch { json = undefined; }
      if (json === undefined) throw new StoreError('pane.store only keeps JSON values (text, numbers, true/false, null, lists, objects).');
      const next = { ...load(), [key]: JSON.parse(json) };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_STORE_BYTES) {
        throw new StoreError('pane.store is full (1 MB). Keep larger data in files in the backend\'s data folder.');
      }
      writeJson(file, next);
      data = next;
      return true;
    },
    delete(key) {
      const d = { ...load() };
      delete d[checkKey(key)];
      writeJson(file, d);
      data = d;
      return true;
    },
    all() {
      return { ...load() };
    },
  };
}

// crypto: { available(): boolean, encrypt(text): Buffer, decrypt(Buffer): string }
function createSecrets(file, crypto) {
  const ensure = () => {
    if (!crypto.available()) {
      throw new StoreError('Secure storage is not available on this computer (no system keychain), so pane.secrets is turned off.');
    }
  };
  return {
    get(key) {
      checkKey(key);
      ensure();
      const stored = readJson(file)[key];
      if (typeof stored !== 'string') return null;
      try {
        return crypto.decrypt(Buffer.from(stored, 'base64'));
      } catch {
        throw new StoreError(`The secret "${key}" could not be decrypted (the keychain entry may have changed).`);
      }
    },
    set(key, value) {
      checkKey(key);
      if (typeof value !== 'string' || value.length > 64 * 1024) throw new StoreError('A secret must be text, up to 64 KB.');
      ensure();
      writeJson(file, { ...readJson(file), [key]: crypto.encrypt(value).toString('base64') });
      return true;
    },
    delete(key) {
      checkKey(key);
      const d = readJson(file);
      delete d[key];
      writeJson(file, d);
      return true;
    },
  };
}

module.exports = { createStore, createSecrets, StoreError };
