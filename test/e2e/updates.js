'use strict';
// Updates, end to end, against a local stand-in for Pane's distribution:
//   1. a computer has Pane 0.1.0 and two installed apps (one pinned to =0.1.0)
//   2. a newer Pane (0.1.1) is announced; an app opens and quietly installs it
//   3. the running app keeps working; its launcher moves when it next opens
//   4. the pinned app stays on 0.1.0; a failed move still opens the app
//   5. a signed app updates itself through pane.updates (check, download,
//      restart into the new version); an unsigned app cannot
// Run: npm run test:updates   (macOS or Windows)

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { RUNTIME_ROOT } = require('../../src/core/paths');
const { cmdArgs } = require('../../src/core/run');
const { generateReleaseKey } = require('../../src/core/release-signature');
const { serveDir } = require('./lib/serve');
const { waitForPage, connect, waitFor, randomPort, sleep } = require('./lib/cdp');

const CLI = path.join(RUNTIME_ROOT, 'bin', 'pane.js');
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const ok = (text) => console.log(`ok  ${text}`);

async function main() {
  if (!MAC && !WIN) { console.log('Update tests run on macOS and Windows.'); return; }
  // This test quits and reopens real app windows. It runs in CI; on your own
  // computer only when asked (PANE_RUN_WINDOW_TESTS=1).
  if (!process.env.CI && process.env.PANE_RUN_WINDOW_TESTS !== '1') {
    console.log('Skipped: this test opens and reopens app windows. It runs in CI (or set PANE_RUN_WINDOW_TESTS=1).');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-updates-'));
  const home = path.join(work, 'home');
  const launchers = path.join(work, 'launchers');
  const dist = path.join(work, 'dist');
  const children = [];
  let server = null;
  const installed = [];
  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  let env = null;
  const paneCmd = path.join(home, 'bin', WIN ? 'pane.cmd' : 'pane');
  // Async: this process also serves the downloads, so it must not block.
  const pane = (...args) => run(paneCmd, args, env);
  try {
    // ---- Pane 0.1.0 and 0.1.1, signed with a test release key ------------
    const key = generateReleaseKey();
    const packEnv = { ...baseEnv, PANE_RELEASE_KEYS: JSON.stringify([key.publicPem]), PANE_RELEASE_SIGNING_KEY: key.privatePem };
    for (const version of ['0.1.0', '0.1.1']) {
      execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(RUNTIME_ROOT, 'src/packaging/runtime.js'))}).packRuntime({ out: ${JSON.stringify(dist)}, version: ${JSON.stringify(version)} })`], { env: packEnv, stdio: 'pipe' });
    }
    const announce = (version) => fs.writeFileSync(path.join(dist, 'pane-latest.json'), JSON.stringify({ version }));
    announce('0.1.0');
    server = await serveDir(dist);
    env = {
      ...baseEnv, PANE_HOME: home, PANE_LAUNCHERS_DIR: launchers, PANE_DIST_URL: server.url,
      PANE_LATEST_URL: `${server.url}/pane-latest.json`, PANE_LAUNCHER_SIGNING: 'adhoc',
    };
    ok(`packed and signed Pane 0.1.0 and 0.1.1, serving them at ${server.url}`);

    // ---- A computer with Pane 0.1.0 --------------------------------------
    const setup = await run(process.execPath, ['-e', `require(${JSON.stringify(path.join(RUNTIME_ROOT, 'src/packaging/runtime-download.js'))}).downloadRuntime({ version: '0.1.0', dist: ${JSON.stringify(server.url)}, keys: [${JSON.stringify(key.publicPem)}] }).catch((e) => { console.error(e.message); process.exit(1); })`], env);
    assert.equal(setup.status, 0, setup.stderr);
    assert.ok(fs.existsSync(paneCmd), 'Pane 0.1.0 is installed');
    const makeApp = async (dir, name, paneSpec) => {
      execFileSync(process.execPath, [CLI, 'create', dir, '--name', name], { env: baseEnv, stdio: 'pipe' });
      const file = path.join(dir, 'pane.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pane: paneSpec }, null, 2));
      const result = await pane('install', dir);
      assert.equal(result.status, 0, result.stderr);
      const id = JSON.parse(fs.readFileSync(file, 'utf8')).id;
      installed.push(id);
      return id;
    };
    const notes = await makeApp(path.join(work, 'Field Notes'), 'Field Notes', '>=0.1.0');
    const pinned = await makeApp(path.join(work, 'Pinned'), 'Pinned', '=0.1.0');
    const record = (id) => JSON.parse(fs.readFileSync(path.join(home, 'apps', id, '.pane-install.json'), 'utf8'));
    assert.match(record(notes).runtimeDir, /0\.1\.0$/);
    ok('a computer with Pane 0.1.0, one app that follows Pane and one pinned to =0.1.0');

    // ---- Open the app ------------------------------------------------------
    const port = randomPort();
    const open = (id) => {
      const child = launch(record(id), port, env);
      children.push(child);
      return child;
    };
    const page = async () => {
      const target = await waitForPage(port, (t) => t.url.startsWith('pane-app://'), 'the app window');
      const c = await connect(target.webSocketDebuggerUrl);
      await waitFor(() => c.run('typeof pane === "object"'), 'the page');
      return c;
    };
    let app = open(notes);
    let c = await page();
    assert.equal(await c.run('pane.app.pane'), '0.1.0');
    assert.match(await c.run('pane.call("greet", "update")'), /^Hello, update\./);
    c.close();
    ok('the app runs on Pane 0.1.0');
    await quit(app);

    // ---- A newer Pane is announced; the app opens and installs it quietly --
    announce('0.1.1');
    fs.rmSync(path.join(home, 'update-check.json'), { force: true });
    app = open(notes);
    c = await page();
    const targetsBefore = await targetCount(port);
    await waitFor(() => fs.existsSync(path.join(home, 'runtime', '0.1.1', 'main.js')) && record(notes).pendingRuntime, 'Pane 0.1.1 to install in the background', 180000);
    assert.match(await c.run('pane.call("greet", "still here")'), /^Hello, still here\./);
    assert.equal(await c.run('pane.app.pane'), '0.1.0', 'the running app keeps its Pane');
    assert.equal(await targetCount(port), targetsBefore, 'no window appeared');
    c.close();
    ok('a newer Pane installed quietly while the app kept running, with no new window');

    // ---- Next open: the launcher moves onto 0.1.1 --------------------------
    await quit(app);
    app = open(notes);
    await waitFor(async () => {
      try {
        const target = await waitForPage(port, (t) => t.url.startsWith('pane-app://'), 'the app window', 5000);
        const probe = await connect(target.webSocketDebuggerUrl);
        const version = await probe.run('typeof pane === "object" ? pane.app.pane : null');
        probe.close();
        return version === '0.1.1';
      } catch { return false; }
    }, 'the app to reopen on Pane 0.1.1', 120000);
    c = await page();
    assert.match(await c.run('pane.call("greet", "new")'), /^Hello, new\./);
    c.close();
    assert.match(record(notes).runtimeDir, /0\.1\.1$/);
    assert.equal(record(notes).pendingRuntime, undefined);
    ok('on its next open the app moved onto Pane 0.1.1, and its backend answers');
    await quitByPort(port);

    // ---- The pinned app stays -----------------------------------------------
    assert.match(record(pinned).runtimeDir, /0\.1\.0$/);
    assert.ok(fs.existsSync(path.join(home, 'runtime', '0.1.0', 'main.js')), 'Pane 0.1.0 stays while an app uses it');
    ok('the app pinned to =0.1.0 stays on Pane 0.1.0');

    // ---- A failed move still opens the app ---------------------------------
    const rec = record(pinned);
    fs.writeFileSync(path.join(home, 'apps', pinned, '.pane-install.json'), JSON.stringify({ ...rec, pendingRuntime: path.join(home, 'runtime', '9.9.9') }));
    const refresh = await pane('launcher-refresh', pinned, '--open', '--', `--remote-debugging-port=${port}`);
    assert.equal(refresh.status, 0, refresh.stderr);
    c = await page();
    assert.equal(await c.run('pane.app.pane'), '0.1.0', 'the app opened on its old Pane');
    c.close();
    assert.match(record(pinned).runtimeDir, /0\.1\.0$/);
    assert.match(fs.readFileSync(path.join(home, 'logs', 'update.log'), 'utf8'), /could not move/i);
    ok('when moving a launcher fails, the app still opens on its old Pane and the failure is logged');
    await quitByPort(port);

    // ---- Once nothing uses Pane 0.1.0, it goes ------------------------------
    assert.equal((await pane('uninstall', pinned, '--purge')).status, 0);
    installed.splice(installed.indexOf(pinned), 1);
    const check = await pane('self-update', '--force');
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.ok(!fs.existsSync(path.join(home, 'runtime', '0.1.0')), 'Pane 0.1.0 was removed');
    assert.ok(fs.existsSync(path.join(home, 'runtime', '0.1.1', 'main.js')));
    ok('once no app uses Pane 0.1.0, the next check removes it');

    // ---- An app updates itself through pane.updates --------------------------
    const { generateAppKey, signApp } = require('../../src/core/app-signature');
    const appKey = generateAppKey();
    const appDist = path.join(dist, 'apps');
    fs.mkdirSync(appDist, { recursive: true });
    const updaterApp = (version, { key = appKey, id = 'updater' } = {}) => {
      const dir = path.join(work, `${id}-${version}`);
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ui', 'index.html'), `<!doctype html><title>${id}</title><p>${version}</p>`);
      fs.writeFileSync(path.join(dir, 'backend.js'), "const pane = require('pane');\npane.expose('checkUpdate', () => pane.updates.check());\n");
      fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify({
        id, name: id === 'updater' ? 'Updater' : 'Plain', version, backend: 'backend.js', updates: `${server.url}/apps/latest.json`,
      }));
      if (key) signApp(dir, { id, version, publisher: 'Test' }, key.privatePem);
      return dir;
    };
    const v1 = await pane('install', updaterApp('0.1.0'));
    assert.equal(v1.status, 0, v1.stderr);
    installed.push('updater');
    const v2 = updaterApp('0.2.0');
    const macOnly = MAC ? ['--no-mac-metadata'] : [];
    execFileSync('tar', [...macOnly, '-czf', path.join(appDist, 'updater-0.2.0.paneapp'), '-C', v2, ...fs.readdirSync(v2)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    fs.writeFileSync(path.join(appDist, 'latest.json'), JSON.stringify({ version: '0.2.0', url: `${server.url}/apps/updater-0.2.0.paneapp`, notes: 'New.' }));

    app = open('updater');
    c = await page();
    assert.equal(await c.run('pane.app.version'), '0.1.0');
    assert.deepEqual(await c.run('pane.updates.check()'), { available: true, version: '0.2.0', notes: 'New.' });
    await c.run('window.__ready = []; window.__progress = 0; pane.updates.onReady((u) => window.__ready.push(u)); pane.updates.onProgress((p) => { window.__progress = p; }); true');
    assert.deepEqual(await c.run('pane.updates.download()'), { version: '0.2.0' });
    await waitFor(async () => (await c.run('window.__ready.length')) === 1, 'onReady');
    assert.deepEqual(await c.run('window.__ready[0]'), { version: '0.2.0' });
    assert.equal(record('updater').version, '0.1.0', 'nothing installs under the running app');
    assert.ok(record('updater').pendingUpdate, 'the update waits for a restart');
    ok('pane.updates: check finds 0.2.0, download verifies it and fires onReady; nothing changes while it runs');

    const oldPid = app.pid;
    await c.run('pane.updates.restartToUpdate(), true').catch(() => {});
    c.close();
    // The app quits and Pane reopens it: a new process, on the 0.2.0 files.
    const marker = path.join(home, 'running', 'updater.json');
    let reopenedPid = null;
    await waitFor(() => {
      if (record('updater').version !== '0.2.0' || !fs.existsSync(marker)) return false;
      const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (pid === oldPid) return false;
      try { process.kill(pid, 0); } catch { return false; }
      reopenedPid = pid;
      return true;
    }, 'the app to reopen as 0.2.0', 120000);
    assert.equal(record('updater').pendingUpdate, undefined);
    if (MAC) {
      // On Windows the reopened app cannot reuse the old one's debugging
      // port (Windows still holds it), so the window is checked on macOS.
      await waitFor(async () => {
        try {
          const target = await waitForPage(port, (t) => t.url.startsWith('pane-app://'), 'the app window', 5000);
          const probe = await connect(target.webSocketDebuggerUrl);
          const version = await probe.run('typeof pane === "object" ? pane.app.version : null');
          probe.close();
          return version === '0.2.0';
        } catch { return false; }
      }, 'the reopened window', 60000);
      c = await page();
      assert.deepEqual(await c.run('pane.call("checkUpdate")'), { available: false, version: '0.2.0', notes: 'New.' });
      c.close();
      ok('restartToUpdate reopened the app as 0.2.0; its backend\'s pane.updates.check() finds nothing newer');
      await quitByPort(port);
    } else {
      ok(`restartToUpdate reopened the app (pid ${reopenedPid}) on its 0.2.0 files`);
      spawnSync('taskkill', ['/pid', String(reopenedPid), '/t', '/f'], { stdio: 'ignore' }); // this test's own app, by exact pid
      await sleep(2000);
    }

    const plain = await pane('install', updaterApp('0.1.0', { key: null, id: 'plain' }));
    assert.equal(plain.status, 0, plain.stderr);
    installed.push('plain');
    app = open('plain');
    c = await page();
    await assert.rejects(c.run('pane.updates.check()'), /not signed, so it cannot update itself/);
    c.close();
    ok('an app installed unsigned cannot update itself');
    await quit(app);

    console.log('\nAll update checks passed.');
  } catch (err) {
    console.error('\nUpdate test FAILED:', err.stack || err.message);
    const log = path.join(home, 'logs', 'update.log');
    if (fs.existsSync(log)) console.error(`--- update.log ---\n${fs.readFileSync(log, 'utf8')}`);
    for (const id of installed) {
      const rec = path.join(home, 'apps', id, '.pane-install.json');
      if (fs.existsSync(rec)) console.error(`--- ${id} record ---\n${fs.readFileSync(rec, 'utf8')}`);
    }
    try {
      for (const f of fs.readdirSync(path.join(home, 'logs')).filter((n) => n.endsWith('-reopen.log'))) {
        console.error(`--- ${f} ---\n${fs.readFileSync(path.join(home, 'logs', f), 'utf8').slice(-3000)}`);
      }
    } catch { /* none */ }
    for (const { pid, text } of appOutput) console.error(`--- app ${pid} output ---\n${text.slice(-3000)}`);
    try { console.error(`--- locks ---\n${fs.readdirSync(path.join(home, 'locks')).join('\n')}`); } catch { /* none */ }
    process.exitCode = 1;
  } finally {
    for (const child of children) { try { child.kill(); } catch { /* gone */ } }
    for (const id of installed) {
      if (env) {
        if (WIN) spawnSync(process.env.ComSpec || 'cmd.exe', cmdArgs(paneCmd, ['uninstall', id, '--purge']), { env, stdio: 'ignore', windowsVerbatimArguments: true });
        else spawnSync(paneCmd, ['uninstall', id, '--purge'], { env, stdio: 'ignore' });
      }
    }
    if (server) server.close();
    await sleep(1000);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    // .cmd files run through cmd.exe, quoted the way the runtime does it.
    const child = WIN && /\.cmd$/i.test(file)
      ? spawn(process.env.ComSpec || 'cmd.exe', cmdArgs(file, args), { env, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

// Starts an installed app the way its launcher does, with a debugging port.
function launch(record, port, env) {
  const extra = [`--remote-debugging-port=${port}`];
  if (MAC) {
    const plist = path.join(record.launcher, 'Contents', 'Info.plist');
    const exe = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' }).trim();
    return capture(spawn(path.join(record.launcher, 'Contents', 'MacOS', exe), extra, { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  const { runWinHelper } = require('../../src/packaging/launchers');
  const { shortcut } = runWinHelper(record.runtimeDir, { read: record.launcher });
  const args = shortcut.args.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
  return capture(spawn(shortcut.target, [...args, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
}

// Keeps what each app printed, shown if the test fails.
const appOutput = [];
function capture(child) {
  const entry = { pid: child.pid, text: '' };
  appOutput.push(entry);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => { entry.text += d; });
  child.on('exit', (code, signal) => { entry.text += `\n[exited: ${code ?? signal}]`; });
  return child;
}

async function targetCount(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page').length;
}

async function quit(child) {
  const exited = new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  child.kill();
  await Promise.race([exited, sleep(15000)]);
  await sleep(1000);
}

// Quits an app this test did not start itself (Pane reopened it), through
// its window: closing the last window quits a Pane app.
async function quitByPort(port) {
  try {
    const target = await waitForPage(port, (t) => t.url.startsWith('pane-app://'), 'the app window', 5000);
    const c = await connect(target.webSocketDebuggerUrl);
    await c.run('pane.window.close()').catch(() => {});
    c.close();
  } catch { /* already closed */ }
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${port}/json/list`); return false; } catch { return true; }
  }, 'the app to quit', 20000).catch(() => {});
  await sleep(1000);
}

main();
