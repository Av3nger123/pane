'use strict';
// Builds the five demo apps twice from the same UI:
//   out/tauri/<app>   a Tauri 2 app (cargo build --release, system WebView)
//   out/pane/<app>    a Pane app, installed into a sandboxed PANE_HOME
//   out/electron/Bench <App>.app   a plain Electron app the way Electron apps
//                     ship: its own copy of Electron.app (the same Electron
//                     version Pane uses), with the app in Resources/app
// Run: node bench/build.js [--only tauri|pane|electron]
// Never touches the real Pane folder, ~/Applications or the keychains.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BENCH = __dirname;
const OUT = path.join(BENCH, 'out');
const APPS = ['notes', 'kanban', 'markdown', 'timer', 'dashboard'];
const title = (s) => s[0].toUpperCase() + s.slice(1);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

function copyUi(name, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(BENCH, 'apps', name, 'index.html'), path.join(dest, 'index.html'));
  fs.copyFileSync(path.join(BENCH, 'apps', 'shared.css'), path.join(dest, 'shared.css'));
}

const sandboxEnv = () => ({
  ...process.env,
  PANE_HOME: path.join(OUT, 'pane-home'),
  PANE_LAUNCHERS_DIR: path.join(OUT, 'launchers'),
  PANE_LAUNCHER_SIGNING: 'adhoc',
  PANE_LATEST_URL: 'http://127.0.0.1:9/none.json', // never looks for a newer Pane
});

function buildPane() {
  const env = sandboxEnv();
  for (const name of APPS) {
    const dir = path.join(OUT, 'pane', name);
    fs.rmSync(dir, { recursive: true, force: true });
    copyUi(name, path.join(dir, 'ui'));
    fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify({
      id: `bench-${name}`, name: `Bench ${title(name)}`, version: '1.0.0', window: { width: 1024, height: 700 },
    }, null, 2));
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'pane.js'), 'install', dir], { env, stdio: 'inherit' });
  }
  // No update check during measurements.
  fs.writeFileSync(path.join(env.PANE_HOME, 'update-check.json'), JSON.stringify({ lastCheck: Date.now() + 365 * 864e5 }));
}

function buildTauri() {
  const icon = path.join(OUT, 'icon.png');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(icon, require(path.join(ROOT, 'src/core/icon')).defaultIconPng({ size: 512 }));
  for (const name of APPS) {
    const app = path.join(OUT, 'tauri', name);
    const crate = path.join(app, 'src-tauri');
    fs.rmSync(app, { recursive: true, force: true });
    copyUi(name, path.join(app, 'ui'));
    fs.mkdirSync(path.join(crate, 'src'), { recursive: true });
    fs.writeFileSync(path.join(crate, 'Cargo.toml'), `[package]
name = "bench-${name}"
version = "1.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }

# Tauri's own template settings for release builds.
[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true
`);
    fs.writeFileSync(path.join(crate, 'build.rs'), 'fn main() { tauri_build::build() }\n');
    fs.writeFileSync(path.join(crate, 'src', 'main.rs'), `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    tauri::Builder::default().run(tauri::generate_context!()).expect("could not start");
}
`);
    fs.writeFileSync(path.join(crate, 'tauri.conf.json'), JSON.stringify({
      productName: `Bench ${title(name)} Tauri`,
      version: '1.0.0',
      identifier: `dev.pane.bench.tauri.${name}`,
      build: { frontendDist: '../ui' },
      app: { windows: [{ title: title(name), width: 1024, height: 700 }], security: { csp: null } },
      bundle: { active: false, icon: ['icons/32x32.png', 'icons/128x128.png', 'icons/icon.icns', 'icons/icon.ico'] },
    }, null, 2));
    execFileSync('npx', ['--yes', '@tauri-apps/cli@2.12.4', 'icon', icon, '-o', path.join(crate, 'icons')], { stdio: 'pipe' });
    console.log(`building Tauri ${name}…`);
    execFileSync('cargo', ['build', '--release', '--manifest-path', path.join(crate, 'Cargo.toml')], {
      env: { ...process.env, CARGO_TARGET_DIR: path.join(OUT, 'target') }, stdio: 'inherit',
    });
  }
}

function buildElectron() {
  const { electronDist } = require(path.join(ROOT, 'src/core/paths'));
  const source = path.join(electronDist(ROOT), 'Electron.app');
  for (const name of APPS) {
    const bundle = path.join(OUT, 'electron', `Bench ${title(name)}.app`);
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    execFileSync('cp', ['-cR', source, bundle]); // a clone: its own file, like a shipped app
    const app = path.join(bundle, 'Contents', 'Resources', 'app');
    copyUi(name, path.join(app, 'ui'));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: `bench-${name}`, productName: `Bench ${title(name)}`, version: '1.0.0', main: 'main.js' }));
    fs.writeFileSync(path.join(app, 'main.js'), `const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1024, height: 700, title: ${JSON.stringify(title(name))}, webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
`);
    // Shipped Electron apps are signed after packaging; ad hoc here, as
    // electron-builder does without a certificate.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' });
  }
}

if (!only || only === 'tauri') buildTauri();
if (!only || only === 'pane') buildPane();
if (!only || only === 'electron') buildElectron();
console.log('done');
