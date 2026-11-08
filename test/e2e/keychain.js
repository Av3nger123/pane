'use strict';
// Launcher signing on macOS, end to end:
//   1. Pane makes a signing identity of this computer's own, in a keychain of
//      its own; that keychain is on the user's search list only while
//      codesign runs, the user's list comes back exactly, and a locked Pane
//      keychain never causes a prompt
//   2. a launcher signed with it keeps reading its pane.secrets after it is
//      rebuilt onto another Pane (as a Pane update does), with no password
//      prompt; an ad hoc signed launcher (the control) does not
// This changes keychain settings (restored afterwards), so it runs only on
// CI machines (CI set), never on a developer's own Mac.
// Run: CI=1 npm run test:keychain   (macOS)

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { RUNTIME_ROOT } = require('../../src/core/paths');
const { waitForPage, connect, waitFor, randomPort, sleep } = require('./lib/cdp');

const CLI = path.join(RUNTIME_ROOT, 'bin', 'pane.js');

const ok = (text) => console.log(`ok  ${text}`);

function security(...args) {
  return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const searchList = () => security('list-keychains', '-d', 'user').split('\n')
  .map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

async function main() {
  if (process.platform !== 'darwin') { console.log('Keychain tests run on macOS.'); return; }
  if (!process.env.CI) {
    console.log('Skipped: this test changes keychain settings. It runs only on CI machines (CI set).');
    return;
  }

  const savedList = searchList();
  const savedDefault = security('default-keychain', '-d', 'user').trim().replace(/^"|"$/g, '');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-keychain-'));
  process.env.PANE_HOME = path.join(work, 'home');
  process.env.PANE_LAUNCHERS_DIR = path.join(work, 'launchers');
  delete process.env.PANE_LAUNCHER_SIGNING;
  delete process.env.ELECTRON_RUN_AS_NODE;
  const { ensureLocalIdentity, withLocalIdentity } = require('../../src/packaging/signing/local-identity');
  let keychain = null;
  const installed = [];
  try {
    const first = ensureLocalIdentity();
    assert.ok(first, 'an identity is made on macOS');
    keychain = first.keychain;
    assert.equal(realpath(path.dirname(keychain)), realpath(path.join(process.env.PANE_HOME, 'signing')));
    assert.match(first.identity, /^[0-9A-F]{40}$/);
    assert.equal((fs.statSync(path.join(process.env.PANE_HOME, 'signing', 'password')).mode & 0o777), 0o600);
    assert.match(security('find-identity', '-p', 'codesigning', keychain), new RegExp(`${first.identity} "Pane Local Signing`));
    ok('a signing identity is made in a keychain of Pane\'s own');

    const sameList = () => assert.deepEqual(searchList().map(realpath), savedList.map(realpath), 'the search list is exactly the user\'s');
    sameList();
    assert.equal(security('default-keychain', '-d', 'user').trim().replace(/^"|"$/g, ''), savedDefault);
    ok('making it leaves the search list and the default keychain exactly as they were');

    const second = ensureLocalIdentity();
    assert.deepEqual(second, first);
    ok('a second call reuses the same identity');

    assert.equal(ensureLocalIdentity({ env: { PANE_LAUNCHER_SIGNING: 'adhoc' } }), null);
    assert.equal(withLocalIdentity((local) => local, { env: { PANE_LAUNCHER_SIGNING: 'adhoc' } }), null);
    ok('PANE_LAUNCHER_SIGNING=adhoc turns it off');

    // A signed binary carries the certificate, and the requirement names it.
    const bin = path.join(work, 'true');
    fs.copyFileSync('/usr/bin/true', bin);
    withLocalIdentity((local) => {
      assert.ok(searchList().map(realpath).includes(realpath(local.keychain)), 'on the list while signing');
      execFileSync('codesign', ['--force', '--sign', local.identity, '--keychain', local.keychain, '--identifier', 'dev.pane.test', bin], { stdio: 'pipe' });
    });
    sameList();
    const requirement = execFileSync('codesign', ['-d', '-r-', bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(requirement, /identifier "dev\.pane\.test" and certificate leaf = H"[0-9a-f]{40}"/);
    ok('codesign signs with it, the requirement pins the certificate, and the list comes back exactly');

    // After a restart Pane's keychain is locked. A search for something that
    // is in no keychain must answer at once, never wait on an unlock prompt.
    security('lock-keychain', keychain);
    const started = Date.now();
    const miss = spawnSync('security', ['find-generic-password', '-s', `pane-missing-${process.pid}`], { timeout: 15000, stdio: 'ignore' });
    assert.notEqual(miss.signal, 'SIGTERM', 'the lookup hung (an unlock prompt)');
    assert.equal(miss.status, 44, 'not found');
    ok(`a locked Pane keychain asks nothing: a missing item is reported in ${Date.now() - started} ms`);

    // ---- Part 2: secrets survive a launcher rebuild ------------------------
    // Electron keeps the key behind pane.secrets in the default keychain: a
    // temporary one here, unlocked, so nothing touches the machine's own.
    const userKeychain = path.join(work, 'user.keychain-db');
    security('create-keychain', '-p', 'pane-test', userKeychain);
    security('unlock-keychain', '-p', 'pane-test', userKeychain);
    security('set-keychain-settings', userKeychain);
    security('list-keychains', '-d', 'user', '-s', userKeychain, ...searchList());
    security('default-keychain', '-d', 'user', '-s', userKeychain);

    // A second Pane at another path: the launcher's files change, as they do
    // when an app moves onto a newer Pane.
    const secondRuntime = path.join(work, 'runtime-2');
    fs.mkdirSync(secondRuntime);
    for (const entry of fs.readdirSync(RUNTIME_ROOT)) {
      if (entry === '.git') continue;
      fs.symlinkSync(path.join(RUNTIME_ROOT, entry), path.join(secondRuntime, entry));
    }

    const signed = await secretSurvivesRebuild(work, 'Kept Secret', null, secondRuntime, installed);
    assert.equal(signed, 'kept', 'a launcher signed with Pane\'s identity reads its secret after the rebuild');
    ok('a launcher signed with Pane\'s identity keeps its secrets across a rebuild, with no prompt');

    const control = await secretSurvivesRebuild(work, 'Adhoc Secret', 'adhoc', secondRuntime, installed);
    assert.notEqual(control, 'kept', 'an ad hoc launcher loses keychain access after a rebuild (proves the test sees prompts)');
    ok(`control: an ad hoc signed launcher cannot read it after a rebuild (${control})`);
  } finally {
    const { uninstallApp } = require('../../src/packaging/apps');
    for (const id of installed) { try { uninstallApp(id, { purge: true }); } catch { /* gone */ } }
    if (keychain) { try { security('delete-keychain', keychain); } catch { /* gone */ } }
    try { security('delete-keychain', path.join(work, 'user.keychain-db')); } catch { /* never made */ }
    security('list-keychains', '-d', 'user', '-s', ...savedList);
    security('default-keychain', '-d', 'user', '-s', savedDefault);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('Keychain test passed.');
}

// Installs an app, saves a secret, rebuilds its launcher onto another Pane,
// and returns what the app reads back: 'kept', or why it could not.
async function secretSurvivesRebuild(work, name, signing, secondRuntime, installed) {
  if (signing) process.env.PANE_LAUNCHER_SIGNING = signing; else delete process.env.PANE_LAUNCHER_SIGNING;
  const { installApp, refreshLauncher, readRecord } = require('../../src/packaging/apps');
  const { appsDir } = require('../../src/core/paths');
  const dir = path.join(work, name);
  execFileSync(process.execPath, [CLI, 'create', dir, '--name', name], { stdio: 'pipe' });
  const { id } = JSON.parse(fs.readFileSync(path.join(dir, 'pane.json'), 'utf8'));
  installApp(dir);
  installed.push(id);
  const record = () => readRecord(path.join(appsDir(), id));

  const port = randomPort();
  let app = launch(record().launcher, port);
  let c = await page(port);
  await c.run("pane.secrets.set('token', 'kept')");
  assert.equal(await c.run("pane.secrets.get('token')"), 'kept');
  c.close();
  await quit(app);

  refreshLauncher(id, secondRuntime);
  app = launch(record().launcher, port);
  try {
    c = await page(port);
    const read = c.run("pane.secrets.get('token')").then((v) => v, (err) => `error: ${err.message.split('\n').pop()}`);
    const result = await Promise.race([read, sleep(20000).then(() => 'no answer in 20 s (a keychain prompt)')]);
    c.close();
    return result;
  } finally {
    await quit(app);
  }
}

function launch(bundle, port) {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const exe = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' }).trim();
  return spawn(path.join(bundle, 'Contents', 'MacOS', exe), [`--remote-debugging-port=${port}`], { env: process.env, stdio: 'ignore' });
}

async function page(port) {
  const target = await waitForPage(port, (t) => t.url.startsWith('pane-app://'), 'the app window');
  const c = await connect(target.webSocketDebuggerUrl);
  await waitFor(() => c.run('typeof pane === "object"'), 'the page');
  return c;
}

async function quit(child) {
  const exited = new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  child.kill();
  await Promise.race([exited, sleep(15000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(1000);
}

main().catch((err) => {
  console.error('Keychain test FAILED:', err);
  process.exit(1);
});
