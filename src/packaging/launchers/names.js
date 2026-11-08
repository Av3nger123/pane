'use strict';
// Launcher and executable names derived from an app's name.

// Safe as a file name on every platform.
function fileName(name) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.+$/, '').trim() || 'Pane App';
}

// Executable and CFBundleName: letters, digits, spaces, dots, dashes.
function execName(name) {
  return name.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim() || 'Pane App';
}

module.exports = { fileName, execName };
