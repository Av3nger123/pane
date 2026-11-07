'use strict';
// The macOS installer: a disk image holding "Install <App>.app".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileName, makeIcns } = require('../launchers');
const { unixInstaller } = require('./install-sh');

// "<Name> <version>.dmg" holding "Install <Name>.app": a tiny app whose
// program is the install script, with the .paneapp in its Resources.
function buildDmg({ manifest, pkg, pkgName, outDir, opts }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-dmg-'));
  try {
    const appName = `Install ${fileName(manifest.name)}`;
    const contents = path.join(stage, `${appName}.app`, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    const script = path.join(contents, 'MacOS', 'install');
    fs.writeFileSync(script, unixInstaller({ ...opts, gui: true, packageExpr: '"$HERE/../Resources/"' }));
    fs.chmodSync(script, 0o755);
    fs.copyFileSync(pkg, path.join(contents, 'Resources', pkgName));
    let iconKey = '';
    if (manifest.icon) {
      makeIcns(manifest.icon, path.join(contents, 'Resources', 'app.icns'));
      iconKey = '  <key>CFBundleIconFile</key><string>app.icns</string>\n';
    }
    const x = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>install</string>
  <key>CFBundleIdentifier</key><string>dev.pane.installer.${x(manifest.id)}</string>
  <key>CFBundleName</key><string>${x(appName)}</string>
  <key>CFBundleDisplayName</key><string>${x(appName)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${x(manifest.version)}</string>
  <key>CFBundleVersion</key><string>${x(manifest.version)}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
${iconKey}</dict>
</plist>
`);
    const dmg = path.join(outDir, `${fileName(manifest.name)} ${manifest.version}.dmg`);
    fs.rmSync(dmg, { force: true });
    execFileSync('hdiutil', ['create', '-volname', fileName(manifest.name), '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg], { stdio: 'pipe' });
    return dmg;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { buildDmg };
