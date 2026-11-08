'use strict';
// Checks what pages send for menus and dialogs before it reaches Electron.
// No Electron imports, so it can be unit-tested.

const MAX_ITEMS = 300;
const MAX_DEPTH = 4;

class InputError extends Error {}

const MODIFIERS = new Set(['cmdorctrl', 'commandorcontrol', 'cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);
const NAMED_KEYS = new Set([
  'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace', 'delete', 'insert', 'return', 'enter',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'escape', 'esc', 'printscreen',
  'volumeup', 'volumedown', 'volumemute', 'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause',
]);

// "CmdOrCtrl+Shift+N", "Alt+F4", "F5". Returns the shortcut or throws.
function checkShortcut(text) {
  if (typeof text !== 'string' || !text || text.length > 60) throw new InputError(`"${text}" is not a keyboard shortcut.`);
  const parts = text.split('+');
  // "CmdOrCtrl++" means the plus key.
  if (text.endsWith('++')) parts.splice(parts.length - 2, 2, 'Plus');
  const key = parts.pop();
  if (!parts.every((p) => MODIFIERS.has(p.toLowerCase()))) throw new InputError(`"${text}" has an unknown modifier. Use CmdOrCtrl, Shift, Alt, Ctrl.`);
  const k = String(key).toLowerCase();
  const ok = /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED_KEYS.has(k) || /^[`\-=[\]\\;',./~!@#$%^&*()_:<>?"{}|]$/.test(key);
  if (!ok) throw new InputError(`"${text}" ends in an unknown key.`);
  return text;
}

// Menu items as pages describe them:
//   { label, id?, shortcut?, enabled?, checked?, items? } or { type: 'separator' }
// Returns a clean copy, or throws with a message for the developer.
function normalizeMenu(items, { what = 'menu' } = {}) {
  let count = 0;
  const walk = (list, depth, where) => {
    if (!Array.isArray(list)) throw new InputError(`${where} must be a list of items.`);
    if (depth > MAX_DEPTH) throw new InputError(`${what} is nested too deeply (at most ${MAX_DEPTH} levels).`);
    return list.map((item, i) => {
      if (++count > MAX_ITEMS) throw new InputError(`${what} has more than ${MAX_ITEMS} items.`);
      const at = `${where} item ${i + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new InputError(`${at} must be an object.`);
      if (item.type === 'separator') return { type: 'separator' };
      if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80) {
        throw new InputError(`${at} needs a "label" (1 to 80 characters).`);
      }
      const out = { label: item.label };
      if (item.id !== undefined) {
        if (typeof item.id !== 'string' || !item.id || item.id.length > 100) throw new InputError(`${at} ("${item.label}"): "id" must be a short string.`);
        out.id = item.id;
      }
      if (item.shortcut !== undefined) out.shortcut = checkShortcut(item.shortcut);
      if (item.enabled !== undefined) out.enabled = Boolean(item.enabled);
      if (item.checked !== undefined) out.checked = Boolean(item.checked);
      if (item.items !== undefined) out.items = walk(item.items, depth + 1, `"${item.label}"`);
      if (!out.items && !out.id) throw new InputError(`${at} ("${item.label}") needs an "id" so its clicks can be told apart.`);
      return out;
    });
  };
  return walk(items, 1, what);
}

// Top-level app menus: [{ label: 'File', items: [...] }, ...]
function normalizeAppMenus(menus) {
  if (!Array.isArray(menus)) throw new InputError('pane.menu.set() needs a list of menus, like [{ label: "File", items: [...] }].');
  const clean = normalizeMenu(menus, { what: 'The app menu' });
  for (const m of clean) {
    if (!m.items) throw new InputError(`The app menu "${m.label}" needs "items".`);
  }
  return clean;
}

const str = (v, max = 500) => (typeof v === 'string' && v.length <= max ? v : undefined);

function normalizeFilters(filters) {
  if (filters === undefined) return undefined;
  if (!Array.isArray(filters) || filters.length > 30) throw new InputError('"filters" must be a list like [{ name: "Text", extensions: ["txt", "md"] }].');
  return filters.map((f) => {
    if (!f || typeof f.name !== 'string' || !Array.isArray(f.extensions) || !f.extensions.length) {
      throw new InputError('Each filter needs a "name" and a list of "extensions".');
    }
    const extensions = f.extensions.map((e) => {
      if (typeof e !== 'string' || !/^(\*|[A-Za-z0-9_-]{1,16})$/.test(e.replace(/^\./, ''))) throw new InputError(`"${e}" is not a file extension.`);
      return e.replace(/^\./, '');
    });
    return { name: f.name.slice(0, 80), extensions };
  });
}

// pane.dialog.open / save / message options -> Electron dialog options.
function normalizeDialog(kind, opts = {}) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new InputError('Dialog options must be an object.');
  const base = { title: str(opts.title, 200), defaultPath: str(opts.defaultPath, 4096), buttonLabel: str(opts.buttonLabel, 60) };
  if (kind === 'open') {
    const properties = [opts.directory ? 'openDirectory' : 'openFile', 'createDirectory'];
    if (opts.multiple) properties.push('multiSelections');
    if (opts.showHidden) properties.push('showHiddenFiles');
    return { ...base, filters: normalizeFilters(opts.filters), properties };
  }
  if (kind === 'save') {
    return { ...base, filters: normalizeFilters(opts.filters), properties: ['createDirectory', 'showOverwriteConfirmation'] };
  }
  if (kind === 'message') {
    const message = str(opts.message, 2000);
    if (!message) throw new InputError('A message dialog needs a "message".');
    const types = ['none', 'info', 'warning', 'error', 'question'];
    const buttons = opts.buttons === undefined ? ['OK'] : opts.buttons;
    if (!Array.isArray(buttons) || !buttons.length || buttons.length > 6 || !buttons.every((b) => typeof b === 'string' && b && b.length <= 40)) {
      throw new InputError('"buttons" must be a list of 1 to 6 short labels.');
    }
    const index = (v) => (Number.isInteger(v) && v >= 0 && v < buttons.length ? v : undefined);
    return {
      type: types.includes(opts.type) ? opts.type : 'none',
      title: base.title,
      message,
      detail: str(opts.detail, 4000),
      buttons,
      defaultId: index(opts.defaultId) ?? 0,
      cancelId: index(opts.cancelId) ?? (buttons.length > 1 ? buttons.length - 1 : 0),
      noLink: true,
    };
  }
  throw new InputError(`Unknown dialog "${kind}".`);
}

function normalizeNotification(opts) {
  if (!opts || typeof opts !== 'object') throw new InputError('pane.notify() needs { title, body }.');
  const title = str(opts.title, 200);
  if (!title) throw new InputError('A notification needs a "title".');
  return { title, body: str(opts.body, 1000) || '', silent: Boolean(opts.silent), id: str(opts.id, 100) };
}

module.exports = { InputError, checkShortcut, normalizeMenu, normalizeAppMenus, normalizeDialog, normalizeNotification };
