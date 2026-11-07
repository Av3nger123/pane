'use strict';
// Linux launcher: a .desktop entry (not yet tested on Linux).

const fs = require('fs');
const path = require('path');
const { electronBinary } = require('../../core/paths');

function createLinuxLauncher({ manifest, appDir, runtimeRoot, outDir }) {
  const file = path.join(outDir, `pane-${manifest.id}.desktop`);
  const q = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${manifest.name}`,
    `Comment=${manifest.description || ''}`,
    `Exec=${q(electronBinary(runtimeRoot))} ${q(path.join(runtimeRoot, 'main.js'))} ${q(`--app=${appDir}`)}`,
    manifest.icon ? `Icon=${path.join(appDir, path.relative(manifest.dir, manifest.icon))}` : null,
    manifest.protocols.length ? `MimeType=${manifest.protocols.map((p) => `x-scheme-handler/${p};`).join('')}` : null,
    'Terminal=false',
    'Categories=Utility;',
    `StartupWMClass=${manifest.name}`,
    '',
  ].filter((l) => l !== null).join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

module.exports = { createLinuxLauncher };
