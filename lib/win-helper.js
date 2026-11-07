'use strict';
// Runs in Electron (app mode, not Node mode) for the Windows steps that need
// Electron's APIs: resizing an icon into a .ico, and writing or reading a
// Start menu shortcut with an AppUserModelID (the taskbar identity).
//
//   electron lib/win-helper.js <job.json>
//   job: { out, icon?: { png, out }, shortcut?: { path, options }, read?: path }

const fs = require('fs');
const { app, nativeImage, shell } = require('electron');
const { encodeIco } = require('./ico');

const job = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const result = { ok: true };
  try {
    if (job.icon) {
      const image = nativeImage.createFromPath(job.icon.png);
      if (image.isEmpty()) throw new Error(`Could not read the icon ${job.icon.png}.`);
      const images = ICON_SIZES.map((size) => ({ size, png: image.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
      fs.writeFileSync(job.icon.out, encodeIco(images));
    }
    if (job.shortcut) {
      if (!shell.writeShortcutLink(job.shortcut.path, 'create', job.shortcut.options)) {
        throw new Error(`Windows refused to create the shortcut ${job.shortcut.path}.`);
      }
    }
    if (job.read) result.shortcut = shell.readShortcutLink(job.read);
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }
  fs.writeFileSync(job.out, JSON.stringify(result));
  app.exit(0);
});
