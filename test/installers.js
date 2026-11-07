'use strict';
// The real installers, end to end, against a local stand-in for Pane's
// distribution: macOS (.dmg) on a Mac, Windows (Setup.exe) on Windows.
//   1. pack this runtime (pane pack-runtime) and serve it
//   2. build an app that declares a link and a file type
//   3. run its installer on a "computer" without Pane -> Pane downloads, app installs
//   4. check the launcher, its identity, links and file types; launch it
//   5. run the installer again (Pane present), then uninstall and check cleanup
// Run: npm run test:installers   (macOS or Windows)

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { RUNTIME_ROOT, RUNTIME_VERSION, electronBinary } = require('../lib/paths');
const { serveDir } = require('./serve');
const { waitForPage, connect, waitFor, randomPort, sleep } = require('./cdp');

const CLI = path.join(RUNTIME_ROOT, 'bin', 'pane.js');
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const ok = (text) => console.log(`ok  ${text}`);

async function main() {
  if (!MAC && !WIN) { console.log('Installer tests run on macOS and Windows.'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-installers-'));
  const home = path.join(work, 'home');
  const launchers = path.join(work, 'launchers');
  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  let server = null;
  let installedId = null;
  const userEnv = { ...baseEnv, PANE_HOME: home, PANE_LAUNCHERS_DIR: launchers, PANE_INSTALLER_GUI: '0', PANE_INSTALLER_OPEN: '0' };
  try {
    if (WIN) {
      execFileSync(process.execPath, [path.join(RUNTIME_ROOT, 'installer', 'windows', 'build.js')], { stdio: 'pipe' });
      ok('compiled PaneSetup.exe with the C# compiler that ships with Windows');
    }
    execFileSync(process.execPath, [CLI, 'pack-runtime', '--out', path.join(work, 'dist')], { env: baseEnv, stdio: 'pipe' });
    server = await serveDir(path.join(work, 'dist'));
    ok(`packed Pane ${RUNTIME_VERSION} and serving it at ${server.url}`);

    const appDir = path.join(work, 'Field Notes');
    execFileSync(process.execPath, [CLI, 'create', appDir, '--name', 'Field Notes'], { env: baseEnv, stdio: 'pipe' });
    const manifestFile = path.join(appDir, 'pane.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    Object.assign(manifest, { protocols: ['field-notes'], fileTypes: [{ name: 'Field note', extensions: ['fnote'] }] });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    execFileSync(process.execPath, [CLI, 'build', appDir], { env: { ...baseEnv, PANE_DIST_URL: server.url }, stdio: 'pipe' });
    const release = path.join(appDir, 'release', 'Field Notes 0.1.0');
    const files = fs.readdirSync(release);
    ok(`pane build made: ${files.join(', ')}`);
    installedId = manifest.id;

    const runInstaller = MAC ? await macInstaller(release, work) : winInstaller(release);
    const first = await runInstaller(userEnv);
    assert.match(first, /Downloading Pane|Pane is not installed|Installing Pane/i, first);
    assert.ok(fs.existsSync(path.join(home, 'bin', WIN ? 'pane.cmd' : 'pane')), 'Pane was installed');
    ok('on a computer without Pane: the installer downloaded Pane, verified it, installed it, then the app');

    const paneCmd = WIN ? [path.join(home, 'bin', 'pane.cmd')] : [path.join(home, 'bin', 'pane')];
    const pane = (...args) => execFileSync(paneCmd[0], args, { env: userEnv, encoding: 'utf8', shell: WIN });
    assert.match(pane('list'), /field-notes\s+Field Notes 0\.1\.0/);

    const appHome = path.join(home, 'apps', manifest.id);
    if (MAC) await checkMac({ launchers, appHome, manifest, userEnv });
    else await checkWindows({ launchers, appHome, manifest, userEnv, home });

    const second = await runInstaller(userEnv);
    assert.match(second, /already installed/i, second);
    ok('with Pane present: the installer only installs the app');

    pane('uninstall', manifest.id);
    installedId = null;
    assert.equal(fs.readdirSync(launchers).length, 0, 'the launcher is gone');
    if (WIN) {
      for (const key of [`HKCU\\Software\\Classes\\field-notes`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Pane.${manifest.id}`]) {
        assert.notEqual(spawnSync('reg', ['query', key]).status, 0, `${key} was removed`);
      }
    }
    ok('uninstalling removes the launcher and every registration');
    console.log('\nAll installer checks passed.');
  } catch (err) {
    console.error('\nInstaller test FAILED:', err.stack || err.message);
    if (WIN) {
      const log = path.join(os.tmpdir(), 'pane-setup.log');
      if (fs.existsSync(log)) console.error(`--- pane-setup.log ---\n${fs.readFileSync(log, 'utf8')}`);
    }
    process.exitCode = 1;
  } finally {
    if (installedId) {
      try { execFileSync(process.execPath, [CLI, 'uninstall', installedId], { env: userEnv, stdio: 'pipe' }); } catch { /* best effort */ }
    }
    if (server) server.close();
    if (MAC) spawnSync('hdiutil', ['detach', path.join(work, 'mnt'), '-force'], { stdio: 'ignore' });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Runs a program without blocking this process, which also serves the
// downloads the installer asks for.
function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} took longer than 10 minutes:\n${output}`)); }, 600000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

// ---- macOS: mount the .dmg and run "Install <App>.app"'s program -----------

async function macInstaller(release, work) {
  const dmg = fs.readdirSync(release).find((f) => f.endsWith('.dmg'));
  assert.ok(dmg, 'a .dmg was built');
  const mnt = path.join(work, 'mnt');
  fs.mkdirSync(mnt);
  execFileSync('hdiutil', ['attach', path.join(release, dmg), '-nobrowse', '-readonly', '-mountpoint', mnt], { stdio: 'pipe' });
  const app = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
  assert.equal(app, 'Install Field Notes.app');
  const program = path.join(mnt, app, 'Contents', 'MacOS', 'install');
  ok(`the .dmg holds "${app}"`);
  return async (env) => {
    const { code, output } = await run(program, [], env);
    assert.equal(code, 0, output);
    return output;
  };
}

async function checkMac({ launchers, manifest }) {
  const bundle = path.join(launchers, 'Field Notes.app');
  assert.ok(fs.existsSync(bundle));
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const read = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleIdentifier'), `dev.pane.app.${manifest.id}`);
  assert.match(read('CFBundleURLTypes:0:CFBundleURLSchemes'), /field-notes/);
  assert.match(read('CFBundleDocumentTypes:0:CFBundleTypeExtensions'), /fnote/);
  ok('the launcher has the app\'s identity, link and file type');
}

// ---- Windows: run "<App> Setup.exe /quiet" and check the registry ----------

function winInstaller(release) {
  const exe = fs.readdirSync(release).find((f) => f.endsWith('.exe'));
  assert.ok(exe, 'a Setup.exe was built');
  ok(`the release has "${exe}"`);
  return async (env) => {
    const { code } = await run(path.join(release, exe), ['/quiet'], env);
    const log = fs.readFileSync(path.join(os.tmpdir(), 'pane-setup.log'), 'utf8');
    assert.equal(code, 0, `Setup.exe failed:\n${log}`);
    return log;
  };
}

async function checkWindows({ launchers, appHome, manifest, userEnv }) {
  const lnk = path.join(launchers, 'Field Notes.lnk');
  assert.ok(fs.existsSync(lnk), 'Start menu shortcut');
  assert.ok(fs.existsSync(path.join(appHome, '.pane-icon.ico')), 'app icon as .ico');
  const { runWinHelper } = require('../lib/launcher');
  const { shortcut } = runWinHelper(RUNTIME_ROOT, { read: lnk });
  assert.equal(shortcut.appUserModelId, `dev.pane.app.${manifest.id}`);
  assert.match(shortcut.target, /electron\.exe$/i);
  ok(`the shortcut carries the app's taskbar identity (${shortcut.appUserModelId})`);

  const query = (key) => execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8' });
  assert.match(query('HKCU\\Software\\Classes\\field-notes'), /URL Protocol/);
  assert.match(query('HKCU\\Software\\Classes\\field-notes\\shell\\open\\command'), /main\.js.*--app=.*%1/);
  assert.match(query('HKCU\\Software\\Classes\\.fnote\\OpenWithProgids'), /Pane\.field-notes\.1/);
  assert.match(query(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Pane.${manifest.id}`), /DisplayName\s+REG_SZ\s+Field Notes/);
  ok('the registry has the link, "Open with" and the Settings > Apps entry');

  // Start the app the way the shortcut does and talk to its window.
  const port = randomPort();
  const args = shortcut.args.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
  const child = spawn(shortcut.target, [...args, `--remote-debugging-port=${port}`], { env: userEnv, stdio: 'ignore' });
  try {
    const page = await waitForPage(port, (t) => t.url.startsWith('pane-app://'), 'the installed app');
    const c = await connect(page.webSocketDebuggerUrl);
    await waitFor(() => c.run('typeof pane === "object"'), 'the page');
    assert.equal(await c.run('pane.app.name'), 'Field Notes');
    assert.match(await c.run('pane.call("greet", "Windows")'), /^Hello, Windows\./);
    c.close();
    ok('the installed app starts from its shortcut and its backend answers');
  } finally {
    child.kill();
    await sleep(1000);
  }
}

main();
