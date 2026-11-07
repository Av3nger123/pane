'use strict';
// Links (notes://...) and files ("Open with") that the system hands to an app.
// On macOS they arrive as open-url / open-file events; on Windows and Linux as
// command-line arguments, at launch or forwarded to the running copy.
// No Electron imports, so this can be unit-tested.

const fs = require('fs');
const path = require('path');

const SCHEME = /^[a-z][a-z0-9+.-]{1,31}$/;
const RESERVED = new Set(['http', 'https', 'file', 'ftp', 'mailto', 'data', 'blob', 'about', 'javascript', 'ws', 'wss', 'chrome', 'devtools', 'pane-app', 'pane']);
const EXTENSION = /^[a-z0-9]{1,16}$/;

// pane.json "protocols": ["notes"]
function checkProtocols(value, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push('"protocols" must be a list like ["notes"].'); return []; }
  const out = [];
  for (const p of value) {
    if (typeof p !== 'string' || !SCHEME.test(p)) errors.push(`"${p}" is not a valid protocol name (lowercase letters and digits, like "notes").`);
    else if (RESERVED.has(p)) errors.push(`The protocol "${p}" belongs to the system or browser; choose another.`);
    else out.push(p);
  }
  return [...new Set(out)];
}

// pane.json "fileTypes": [{ "name": "Markdown", "extensions": ["md"], "role": "editor" }]
function checkFileTypes(value, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { errors.push('"fileTypes" must be a list like [{ "name": "Markdown", "extensions": ["md"] }].'); return []; }
  return value.map((t, i) => {
    if (!t || typeof t.name !== 'string' || !t.name.trim() || !Array.isArray(t.extensions) || !t.extensions.length) {
      errors.push(`"fileTypes" entry ${i + 1} needs a "name" and a list of "extensions".`);
      return null;
    }
    const extensions = t.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase());
    for (const e of extensions) if (!EXTENSION.test(e)) errors.push(`"${e}" is not a file extension.`);
    const role = t.role === undefined ? 'editor' : t.role;
    if (!['editor', 'viewer'].includes(role)) errors.push(`"fileTypes" role must be "editor" or "viewer".`);
    return Object.freeze({ name: t.name.trim().slice(0, 80), extensions: Object.freeze(extensions), role });
  }).filter(Boolean);
}

// A URL for one of the app's protocols, or null.
function asUrl(text, manifest) {
  if (typeof text !== 'string' || text.length > 8192) return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (!m || !manifest.protocols.includes(m[1].toLowerCase())) return null;
  return { kind: 'url', url: text };
}

// An existing file with one of the app's extensions, or null.
function asFile(text, manifest, cwd) {
  if (typeof text !== 'string' || !text || text.startsWith('-')) return null;
  const extensions = manifest.fileTypes.flatMap((t) => t.extensions);
  if (!extensions.length) return null;
  const full = path.resolve(cwd || process.cwd(), text);
  const ext = path.extname(full).slice(1).toLowerCase();
  if (!extensions.includes(ext)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return { kind: 'file', path: full };
}

// Requests in a command line: [electron, main.js, --app=..., --dev, notes://x, a.md]
function fromArgv(argv, manifest, cwd) {
  const out = [];
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg.startsWith('--')) continue;
    const request = asUrl(arg, manifest) || asFile(arg, manifest, cwd);
    if (request) out.push(request);
  }
  return out;
}

module.exports = { checkProtocols, checkFileTypes, asUrl, asFile, fromArgv };
