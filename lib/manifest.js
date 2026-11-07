'use strict';
// pane.json: everything Pane needs to know about an app.
//
// {
//   "id": "hello",                    lowercase letters, digits, dashes
//   "name": "Hello",                  shown in the Dock, taskbar, title bar
//   "version": "0.1.0",
//   "pane": ">=0.1.0",                Pane versions this app works with
//   "ui": "ui",                       folder with the app's web files
//   "start": "index.html",            first page, inside "ui"
//   "backend": "backend/main.js",     optional Node file, runs on Pane's Node
//   "icon": "icon.png",               optional, square PNG (512 px or more)
//   "window": { "width": 960, "height": 640, "minWidth": 400, "minHeight": 300,
//               "titleBar": "default" | "hidden",
//               "background": "#ffffff" or { "light": "#ffffff", "dark": "#1e1e1e" } },
//   "permissions": ["notifications", "camera", "microphone", "clipboard", "geolocation"],
//   "dev":   { "command": "vite --port {port} --strictPort", "url": "http://localhost:{port}" },
//   "build": { "command": "vite build" }
// }
//
// "dev" (optional): `pane dev` starts this command and loads the URL instead of
// the "ui" folder, so a framework's hot reload works. {port} is a free port
// Pane picks. "build" (optional): `pane build` runs it before packaging, so the
// "ui" folder holds the built files.

const fs = require('fs');
const path = require('path');
const { resolveInside } = require('./safe-path');
const { isValidSpec, parse: parseVersion } = require('./version');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PERMISSIONS = ['notifications', 'camera', 'microphone', 'clipboard', 'geolocation'];
const TITLE_BARS = ['default', 'hidden'];
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

// requireUi: false skips the checks that the "ui" folder and start page exist
// (used by `pane dev` with a dev server, before the first build).
function loadManifest(appDir, { requireUi = true } = {}) {
  const dir = path.resolve(appDir);
  const file = path.join(dir, 'pane.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ManifestError(`There is no pane.json in ${dir}.`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`pane.json is not valid JSON: ${err.message}`);
  }
  return normalizeManifest(data, dir, { requireUi });
}

function normalizeManifest(data, dir, { requireUi = true } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ManifestError('pane.json must contain a JSON object.');
  }
  const errors = [];
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const id = str(data.id);
  if (!id || !ID_RE.test(id)) errors.push('"id" must be lowercase letters, digits and dashes, for example "invoices".');

  const name = str(data.name);
  if (!name) errors.push('"name" is required.');
  else if (name.length > 60) errors.push('"name" must be 60 characters or fewer.');

  const version = str(data.version) || '0.1.0';
  if (!parseVersion(version)) errors.push('"version" must look like 1.0.0.');

  const pane = data.pane === undefined ? null : str(data.pane);
  if (data.pane !== undefined && (!pane || !isValidSpec(pane))) {
    errors.push('"pane" must be a Pane version such as ">=0.1.0".');
  }

  const ui = str(data.ui) || 'ui';
  const uiDir = ui === '.' ? dir : resolveInside(dir, ui, { decode: false });
  if (!uiDir) errors.push('"ui" must be a folder inside the app.');
  else if (requireUi && !isDir(uiDir)) errors.push(`The "ui" folder "${ui}" does not exist.${data.build ? ' Run `pane build` (or your build command) first.' : ''}`);

  const start = str(data.start) || 'index.html';
  if (uiDir) {
    const startFile = resolveInside(uiDir, start, { decode: false });
    if (!startFile) errors.push('"start" must be a file inside the "ui" folder.');
    else if (requireUi && !isFile(startFile)) errors.push(`The start page "${ui}/${start}" does not exist.`);
  }

  let backend = null;
  if (data.backend !== undefined && data.backend !== null) {
    backend = resolveInside(dir, String(data.backend), { decode: false });
    if (!backend) errors.push('"backend" must be a file inside the app.');
    else if (!isFile(backend)) errors.push(`The backend file "${data.backend}" does not exist.`);
  }

  let icon = null;
  if (data.icon !== undefined && data.icon !== null) {
    icon = resolveInside(dir, String(data.icon), { decode: false });
    if (!icon || !/\.png$/i.test(icon)) errors.push('"icon" must be a .png file inside the app.');
    else if (!isFile(icon)) errors.push(`The icon "${data.icon}" does not exist.`);
  }

  const w = data.window === undefined ? {} : data.window;
  if (!w || typeof w !== 'object' || Array.isArray(w)) errors.push('"window" must be an object.');
  const win = {
    width: size(w.width, 1024, 'window.width', errors),
    height: size(w.height, 700, 'window.height', errors),
    minWidth: size(w.minWidth, 320, 'window.minWidth', errors),
    minHeight: size(w.minHeight, 240, 'window.minHeight', errors),
    titleBar: w.titleBar === undefined ? 'default' : w.titleBar,
    background: background(w.background, errors),
  };
  if (!TITLE_BARS.includes(win.titleBar)) errors.push(`"window.titleBar" must be one of: ${TITLE_BARS.join(', ')}.`);


  const permissions = data.permissions === undefined ? [] : data.permissions;
  if (!Array.isArray(permissions)) errors.push('"permissions" must be a list.');
  else {
    for (const p of permissions) {
      if (!PERMISSIONS.includes(p)) errors.push(`Unknown permission "${p}". Known: ${PERMISSIONS.join(', ')}.`);
    }
  }

  const dev = command('dev', data.dev, errors, { needsUrl: true });
  const build = command('build', data.build, errors, { needsUrl: false });

  if (errors.length) {
    throw new ManifestError(`pane.json has ${errors.length === 1 ? 'a problem' : 'problems'}:\n- ${errors.join('\n- ')}`);
  }

  return Object.freeze({
    dir, id, name, version, pane,
    description: str(data.description) || '',
    ui, uiDir, start: start.replace(/\\/g, '/').replace(/^\/+/, ''),
    backend, icon,
    window: Object.freeze(win),
    permissions: Object.freeze([...new Set(permissions)]),
    dev, build,
  });
}

// { command, url? } blocks. Dev URLs must be local: a dev build must never
// load a remote site with the Pane bridge attached.
const DEV_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:(\d{1,5}|\{port\}))?(\/[^\s]*)?$/;
function command(label, value, errors, { needsUrl }) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`"${label}" must be an object like { "command": "..." }.`);
    return null;
  }
  const cmd = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : null;
  if (!cmd && !(needsUrl && value.url)) errors.push(`"${label}.command" must be a command to run.`);
  if (!needsUrl) return Object.freeze({ command: cmd });
  if (typeof value.url !== 'string' || !DEV_URL_RE.test(value.url)) {
    errors.push(`"${label}.url" must be a local address such as "http://localhost:{port}".`);
    return null;
  }
  if (value.url.includes('{port}') && !(cmd && cmd.includes('{port}'))) {
    errors.push(`"${label}.url" uses {port}, so "${label}.command" must pass {port} to the dev server too.`);
  }
  return Object.freeze({ command: cmd, url: value.url });
}

// One colour for both themes, or { light, dark }. Shown while pages load and
// behind the window controls.
const DEFAULT_BACKGROUND = Object.freeze({ light: '#ffffff', dark: '#1e1e1e' });
function background(value, errors) {
  if (value === undefined) return DEFAULT_BACKGROUND;
  const ok = (c) => typeof c === 'string' && COLOR_RE.test(c);
  if (ok(value)) return Object.freeze({ light: value, dark: value });
  if (value && typeof value === 'object' && ok(value.light) && ok(value.dark)) return Object.freeze({ light: value.light, dark: value.dark });
  errors.push('"window.background" must be a hex colour such as "#ffffff", or { "light": "#ffffff", "dark": "#1e1e1e" }.');
  return DEFAULT_BACKGROUND;
}

function size(value, fallback, label, errors) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 10000) {
    errors.push(`"${label}" must be a whole number of pixels between 100 and 10000.`);
    return fallback;
  }
  return value;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { loadManifest, normalizeManifest, ManifestError, PERMISSIONS };
