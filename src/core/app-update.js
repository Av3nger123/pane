'use strict';
// App updates: the address in pane.json ("updates") and the small update
// file it points to, which the developer uploads next to each new .paneapp:
//
// {
//   "version": "0.2.0",                                  required
//   "url": "https://dl.example.com/notes/notes-0.2.0.paneapp",  required
//   "notes": "What changed, in a sentence or two.",      optional
//   "pane": ">=0.1.0",                                   optional, the update's Pane range
//   "sha256": "<64 hex characters>"                      optional, the .paneapp's hash
// }
//
// The file only says where an update is. Whatever it points to is installed
// only if it is signed by the key the app was installed with.

const { isValidSpec, parse: parseVersion } = require('./version');

class UpdateFileError extends Error {}

// https, or a local test server.
function isUpdateAddress(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol === 'https:') return Boolean(url.hostname);
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function parseUpdateFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UpdateFileError('The update file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UpdateFileError('The update file must contain a JSON object.');
  const bad = (field, what) => { throw new UpdateFileError(`The update file's "${field}" ${what}`); };

  if (typeof data.version !== 'string' || !parseVersion(data.version)) bad('version', 'must look like 1.0.0.');
  if (!isUpdateAddress(data.url)) bad('url', 'must be an https address of the .paneapp file.');
  let notes = null;
  if (data.notes !== undefined && data.notes !== null) {
    if (typeof data.notes !== 'string' || data.notes.length > 2000) bad('notes', 'must be text of at most 2000 characters.');
    notes = data.notes;
  }
  let pane = null;
  if (data.pane !== undefined && data.pane !== null) {
    if (typeof data.pane !== 'string' || !isValidSpec(data.pane)) bad('pane', 'must be a Pane version such as ">=0.1.0".');
    pane = data.pane;
  }
  let sha256 = null;
  if (data.sha256 !== undefined && data.sha256 !== null) {
    if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(data.sha256)) bad('sha256', 'must be 64 hexadecimal characters.');
    sha256 = data.sha256.toLowerCase();
  }
  return { version: data.version, url: data.url, notes, pane, sha256 };
}

module.exports = { parseUpdateFile, isUpdateAddress, UpdateFileError };
