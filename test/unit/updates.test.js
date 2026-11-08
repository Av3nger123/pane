'use strict';
// Updates: Pane updating itself, and apps updating themselves. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateReleaseKey } = require('../../src/core/release-signature');

const A = generateReleaseKey();
const B = generateReleaseKey();

// Runs fn with these environment variables set, then restores them.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('latestUrl: https only, localhost for tests, env override', () => withEnv({ PANE_LATEST_URL: undefined }, () => {
  const { latestUrl } = require('../../src/packaging/runtime');
  process.env.PANE_LATEST_URL = 'https://downloads.example.com/pane/latest.json';
  assert.equal(latestUrl(), 'https://downloads.example.com/pane/latest.json');
  process.env.PANE_LATEST_URL = 'http://127.0.0.1:8080/pane-latest.json';
  assert.equal(latestUrl(), 'http://127.0.0.1:8080/pane-latest.json');
  process.env.PANE_LATEST_URL = 'http://downloads.example.com/latest.json';
  assert.throws(() => latestUrl(), /must use https/);
  delete process.env.PANE_LATEST_URL;
  assert.match(latestUrl(), /^https:\/\/github\.com\/Av3nger123\/pane\/releases\/latest\/download\/pane-latest\.json$/);
}));

// One packed 0.1.1, signed with A and trusting A, shared by the tests below.
let packed = null;
async function packedRuntime() {
  if (packed) return packed;
  const { packRuntime } = require('../../src/packaging/runtime');
  const out = tmp('pane-pack-');
  packed = await withEnv({ PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) },
    () => packRuntime({ out, signingKey: A.privatePem, version: '0.1.1' }));
  packed.out = out;
  return packed;
}

test('pack-runtime: latest file, baked keys, other versions', { skip: process.platform === 'win32' }, async () => {
  const result = await packedRuntime();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.out, 'pane-latest.json'), 'utf8')), { version: '0.1.1' });
  assert.equal(result.latest, path.join(result.out, 'pane-latest.json'));
  assert.match(path.basename(result.archive), /^pane-runtime-0\.1\.1-/);
  const unpacked = tmp('pane-unpacked-');
  execFileSync('tar', ['-xzf', result.archive, '-C', unpacked]);
  const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.1');
  assert.deepEqual(pkg.pane.releaseKeys, [A.publicPem.trim()]);
  fs.rmSync(unpacked, { recursive: true, force: true });
});

module.exports = { withEnv, packedRuntime, A, B, tmp };

// ---- Downloading a Pane ---------------------------------------------------

const { serveDir } = require('../e2e/lib/serve');

// A copy of a packed distribution with one change.
function distCopy(src, change) {
  const out = tmp('pane-dist-');
  fs.cpSync(src, out, { recursive: true });
  change(out);
  return out;
}

test('downloadRuntime installs a signed Pane of the asked version', { skip: process.platform === 'win32' }, async () => {
  const { downloadRuntime } = require('../../src/packaging/runtime-download');
  const result = await packedRuntime();
  const server = await serveDir(result.out);
  try {
    await withEnv({ PANE_HOME: tmp('pane-home-') }, async () => {
      const installed = await downloadRuntime({ version: '0.1.1', dist: server.url, keys: [A.publicPem] });
      assert.equal(installed.version, '0.1.1');
      assert.ok(fs.existsSync(path.join(installed.dir, 'main.js')));
      assert.equal(path.basename(installed.dir), '0.1.1');
    });
  } finally {
    server.close();
  }
});

test('downloadRuntime refuses a wrong key, a missing signature, a wrong version', { skip: process.platform === 'win32' }, async () => {
  const { downloadRuntime } = require('../../src/packaging/runtime-download');
  const { packRuntime, runtimeArchiveName } = require('../../src/packaging/runtime');
  const result = await packedRuntime();
  const name = runtimeArchiveName('0.1.1');
  const unsigned = distCopy(result.out, (d) => fs.rmSync(path.join(d, 'v0.1.1', `${name}.sig`)));
  // A correctly signed 0.1.2 served under 0.1.1's name.
  const other = tmp('pane-pack-');
  await withEnv({ PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) }, () => packRuntime({ out: other, signingKey: A.privatePem, version: '0.1.2' }));
  const swapped = distCopy(result.out, (d) => {
    const from = path.join(other, 'v0.1.2', runtimeArchiveName('0.1.2'));
    fs.copyFileSync(from, path.join(d, 'v0.1.1', name));
    fs.copyFileSync(`${from}.sig`, path.join(d, 'v0.1.1', `${name}.sig`));
  });
  const servers = await Promise.all([result.out, unsigned, swapped].map(serveDir));
  try {
    await withEnv({ PANE_HOME: tmp('pane-home-') }, async () => {
      const { runtimesDir } = require('../../src/core/paths');
      const versions = () => (fs.existsSync(runtimesDir()) ? fs.readdirSync(runtimesDir()).filter((v) => /^\d/.test(v)) : []);
      await assert.rejects(downloadRuntime({ version: '0.1.1', dist: servers[0].url, keys: [B.publicPem] }), /not signed by Pane/);
      await assert.rejects(downloadRuntime({ version: '0.1.1', dist: servers[1].url, keys: [A.publicPem] }), /not signed by Pane|signature/);
      await assert.rejects(downloadRuntime({ version: '0.1.1', dist: servers[2].url, keys: [A.publicPem] }), /version 0\.1\.2.*0\.1\.1/);
      assert.deepEqual(versions(), []);
    });
  } finally {
    servers.forEach((s) => s.close());
  }
});

// ---- Checking for a newer Pane --------------------------------------------

test('update stamp: once a day', () => withEnv({ PANE_HOME: tmp('pane-home-') }, () => {
  const { updateDue, markChecked } = require('../../src/core/update-state');
  const t0 = Date.UTC(2026, 10, 8, 12);
  const hour = 3600 * 1000;
  assert.equal(updateDue({ now: t0 }), true);
  markChecked({ now: t0 });
  assert.equal(updateDue({ now: t0 + 23 * hour }), false);
  assert.equal(updateDue({ now: t0 + 25 * hour }), true);
}));

test('update lock: one at a time, stale locks expire', () => withEnv({ PANE_HOME: tmp('pane-home-') }, () => {
  const { takeLock } = require('../../src/core/update-state');
  const release = takeLock('self-update');
  assert.equal(typeof release, 'function');
  assert.equal(takeLock('self-update'), null);
  release();
  const again = takeLock('self-update');
  assert.equal(typeof again, 'function');
  again();
  const file = path.join(process.env.PANE_HOME, 'locks', 'self-update.lock');
  fs.writeFileSync(file, '999999');
  const takenOver = takeLock('self-update');
  assert.equal(typeof takenOver, 'function', 'a lock held by a dead process is taken over');
  takenOver();
}));

test('selfUpdate: up to date, newer, offline, garbage, older', { skip: process.platform === 'win32' }, async () => {
  const { packRuntime } = require('../../src/packaging/runtime');
  const { downloadRuntime } = require('../../src/packaging/runtime-download');
  const { selfUpdate } = require('../../src/packaging/self-update');
  const newer = await packedRuntime();
  const dist = tmp('pane-dist-');
  await withEnv({ PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) }, () => packRuntime({ out: dist, signingKey: A.privatePem, version: '0.1.0' }));
  fs.cpSync(path.join(newer.out, 'v0.1.1'), path.join(dist, 'v0.1.1'), { recursive: true });
  const latest = (text) => fs.writeFileSync(path.join(dist, 'pane-latest.json'), text);
  const server = await serveDir(dist);
  try {
    await withEnv({ PANE_HOME: tmp('pane-home-'), PANE_DIST_URL: server.url, PANE_LATEST_URL: `${server.url}/pane-latest.json`, PANE_RELEASE_KEYS: undefined }, async () => {
      const { installedRuntime } = require('../../src/packaging/runtime');
      await downloadRuntime({ version: '0.1.0', dist: server.url, keys: [A.publicPem] });
      assert.match(installedRuntime(), /0\.1\.0$/);

      latest('{"version":"0.1.0"}');
      assert.equal((await selfUpdate({ force: true })).status, 'up-to-date');
      latest('{"version":"0.0.9"}');
      assert.equal((await selfUpdate({ force: true })).status, 'up-to-date');
      latest('nonsense');
      assert.equal((await selfUpdate({ force: true })).status, 'failed');
      await withEnv({ PANE_LATEST_URL: 'http://127.0.0.1:9/pane-latest.json' }, async () => {
        assert.equal((await selfUpdate({ force: true })).status, 'failed');
        assert.equal((await selfUpdate()).status, 'not-due', 'a failed check still waits a day');
      });
      assert.match(installedRuntime(), /0\.1\.0$/, 'nothing was installed');

      latest('{"version":"0.1.1"}');
      const result = await selfUpdate({ force: true });
      assert.equal(result.status, 'updated', JSON.stringify(result));
      assert.equal(result.version, '0.1.1');
      assert.match(installedRuntime(), /0\.1\.1$/);
      assert.match(fs.readFileSync(path.join(process.env.PANE_HOME, 'logs', 'update.log'), 'utf8'), /updated to Pane 0\.1\.1/);
    });
  } finally {
    server.close();
  }
});

// ---- Moving apps onto a new Pane ------------------------------------------

test('version specs: "=x.y.z" pins an exact Pane version', () => {
  const { satisfies, isValidSpec } = require('../../src/core/version');
  assert.equal(satisfies('0.1.0', '=0.1.0'), true);
  assert.equal(satisfies('0.1.1', '=0.1.0'), false);
  assert.equal(isValidSpec('=0.1'), true);
  assert.equal(satisfies('0.1.1', '0.1.0'), true, 'a bare version still means "at least"');
});

test('running markers: live processes only', () => withEnv({ PANE_HOME: tmp('pane-home-') }, () => {
  const { markRunning, clearRunning, runningApps } = require('../../src/core/running');
  markRunning('a', { pid: process.pid, runtimeDir: '/r/0.1.0' });
  markRunning('dead', { pid: 999999, runtimeDir: '/r/0.1.0' });
  assert.deepEqual(runningApps().map((r) => r.id), ['a']);
  assert.ok(!fs.existsSync(path.join(process.env.PANE_HOME, 'running', 'dead.json')), 'stale markers are removed');
  clearRunning('a', 12345);
  assert.equal(runningApps().length, 1, 'another pid does not clear it');
  clearRunning('a', process.pid);
  assert.equal(runningApps().length, 0);
}));

test('moveAppsOnto: moves idle apps, waits for running ones, keeps pinned ones', { skip: process.platform === 'win32' }, async () => {
  const sandbox = tmp('pane-move-');
  await withEnv({ PANE_HOME: path.join(sandbox, 'home'), PANE_LAUNCHERS_DIR: path.join(sandbox, 'launchers'), PANE_LAUNCHER_SIGNING: 'adhoc' }, async () => {
    const { installApp, uninstallApp, moveAppsOnto } = require('../../src/packaging/apps');
    const { stageRuntime } = require('../../src/packaging/runtime');
    const { RUNTIME_ROOT } = require('../../src/core/paths');
    const { markRunning, clearRunning } = require('../../src/core/running');
    const app = (id, pane) => {
      const dir = path.join(sandbox, id);
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify({ id, name: `App ${id}`, pane }));
      fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '');
      return dir;
    };
    const record = (id) => JSON.parse(fs.readFileSync(path.join(process.env.PANE_HOME, 'apps', id, '.pane-install.json'), 'utf8'));
    try {
      installApp(app('a', '>=0.1.0'));
      installApp(app('b', '=0.1.0'));
      const next = path.join(process.env.PANE_HOME, 'runtime', '0.1.1');
      stageRuntime(RUNTIME_ROOT, next, { version: '0.1.1' });

      markRunning('a', { pid: process.pid, runtimeDir: RUNTIME_ROOT });
      const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r.result]));
      assert.deepEqual(byId(moveAppsOnto(next)), { a: 'pending', b: 'kept' });
      assert.equal(record('a').pendingRuntime, next);

      clearRunning('a', process.pid);
      assert.deepEqual(byId(moveAppsOnto(next)), { a: 'moved', b: 'kept' });
      assert.equal(record('a').runtimeDir, next);
      assert.equal(record('a').runtime, '0.1.1');
      assert.equal(record('a').pendingRuntime, undefined);
      assert.equal(record('b').runtimeDir, RUNTIME_ROOT);
      if (process.platform === 'darwin') {
        const boot = fs.readFileSync(path.join(process.env.PANE_LAUNCHERS_DIR, 'App a.app', 'Contents', 'Resources', 'app', 'boot.js'), 'utf8');
        assert.ok(boot.includes(next), 'the launcher starts the new Pane');
      }
    } finally {
      for (const id of ['a', 'b']) { try { uninstallApp(id, { purge: true }); } catch { /* not installed */ } }
    }
  });
});

// ---- Handing over to a new Pane happens at most once ----------------------
// (A relaunch loop once took over the owner's Mac: the app kept quitting and
// reopening. None of these tests open a window.)

test('an app reopened by Pane never hands over again', () => {
  const { shouldHandOver, REOPENED_FLAG } = require('../../src/runtime/updates');
  const pending = { pendingRuntime: '/pane/runtime/0.1.1' };
  assert.equal(shouldHandOver(pending, { argv: ['/x/App'], runtimeRoot: '/pane/runtime/0.1.0' }), true);
  assert.equal(shouldHandOver(pending, { argv: ['/x/App', REOPENED_FLAG], runtimeRoot: '/pane/runtime/0.1.0' }), false);
  assert.equal(shouldHandOver(pending, { argv: ['/x/App'], runtimeRoot: '/pane/runtime/0.1.1' }), false, 'already on it');
  assert.equal(shouldHandOver({ pendingUpdate: '/u.paneapp' }, { argv: ['/x/App', REOPENED_FLAG], runtimeRoot: '/r' }), false);
  assert.equal(shouldHandOver({}, { argv: ['/x/App'], runtimeRoot: '/r' }), false);
});

test('reopen arguments mark the app and keep its own arguments once', () => {
  const { reopenArgs, REOPENED_FLAG } = require('../../src/packaging/apps');
  assert.deepEqual(reopenArgs(['notes://a', '--remote-debugging-port=9']), ['notes://a', '--remote-debugging-port=9', REOPENED_FLAG]);
  assert.deepEqual(reopenArgs([REOPENED_FLAG, 'x']), ['x', REOPENED_FLAG]);
  assert.equal(REOPENED_FLAG, require('../../src/runtime/updates').REOPENED_FLAG);
});

test('launcher-refresh clears pending moves even when the move fails, and never runs twice at once', { skip: process.platform === 'win32' }, async () => {
  const sandbox = tmp('pane-refresh-');
  await withEnv({ PANE_HOME: path.join(sandbox, 'home'), PANE_LAUNCHERS_DIR: path.join(sandbox, 'launchers'), PANE_LAUNCHER_SIGNING: 'adhoc' }, async () => {
    const { installApp, uninstallApp, readRecord, writeRecord } = require('../../src/packaging/apps');
    const { launcherRefresh } = require('../../src/cli/commands/launcher-refresh');
    const { takeLock } = require('../../src/core/update-state');
    const dir = path.join(sandbox, 'app');
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pane.json'), '{"id":"refresh-check","name":"Refresh Check"}');
    fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '');
    const appHome = path.join(process.env.PANE_HOME, 'apps', 'refresh-check');
    try {
      installApp(dir);
      const before = readRecord(appHome);
      writeRecord(appHome, { ...before, pendingRuntime: path.join(process.env.PANE_HOME, 'runtime', '9.9.9') });
      assert.equal(await launcherRefresh('refresh-check', {}), 0);
      const after = readRecord(appHome);
      assert.equal(after.pendingRuntime, undefined, 'the pending move is cleared even though it failed');
      assert.equal(after.runtimeDir, before.runtimeDir);
      assert.match(fs.readFileSync(path.join(process.env.PANE_HOME, 'logs', 'update.log'), 'utf8'), /could not move/);

      writeRecord(appHome, { ...after, pendingRuntime: '/elsewhere' });
      const release = takeLock('app-refresh-check');
      try {
        assert.equal(await launcherRefresh('refresh-check', { open: true }), 0, 'another refresh is running: this one does nothing');
        assert.equal(readRecord(appHome).pendingRuntime, '/elsewhere');
      } finally {
        release();
      }
    } finally {
      try { uninstallApp('refresh-check', { purge: true }); } catch { /* not installed */ }
    }
  });
});

// ---- Removing Panes nobody uses -------------------------------------------

test('cleanupRuntimes removes only Panes nothing uses', () => withEnv({ PANE_HOME: tmp('pane-home-') }, () => {
  const { cleanupRuntimes } = require('../../src/packaging/runtime');
  const { markRunning } = require('../../src/core/running');
  const home = process.env.PANE_HOME;
  const runtime = (v) => {
    const dir = path.join(home, 'runtime', v);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main.js'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: v }));
    return dir;
  };
  const r090 = runtime('0.0.9');
  const r100 = runtime('0.1.0');
  const r110 = runtime('0.1.1');
  const r080 = runtime('0.0.8');
  fs.writeFileSync(path.join(home, 'runtime', 'current'), `${r110}\n`);
  const app = (id, rec) => {
    fs.mkdirSync(path.join(home, 'apps', id), { recursive: true });
    fs.writeFileSync(path.join(home, 'apps', id, '.pane-install.json'), JSON.stringify({ id, name: id, version: '1.0.0', ...rec }));
  };
  app('on-old', { runtimeDir: r100 });
  app('moving', { runtimeDir: r110, pendingRuntime: r110 });
  markRunning('still-open', { pid: process.pid, runtimeDir: r080 });
  const oldPartial = path.join(home, 'runtime', '0.2.0.partial');
  fs.mkdirSync(oldPartial);
  fs.utimesSync(oldPartial, new Date(Date.now() - 2 * 3600e3), new Date(Date.now() - 2 * 3600e3));

  const oldDownload = path.join(home, 'downloads', 'pane-0.1.1-old');
  const newDownload = path.join(home, 'downloads', 'pane-0.1.2-now');
  fs.mkdirSync(oldDownload, { recursive: true });
  fs.mkdirSync(newDownload, { recursive: true });
  fs.utimesSync(oldDownload, new Date(Date.now() - 2 * 3600e3), new Date(Date.now() - 2 * 3600e3));

  assert.deepEqual(cleanupRuntimes().sort(), ['0.0.9', '0.2.0.partial']);
  // Nothing uses 0.1.0 now, but it is the Pane before the current one: kept.
  fs.rmSync(path.join(home, 'apps', 'on-old'), { recursive: true });
  assert.deepEqual(cleanupRuntimes(), []);
  assert.ok(fs.existsSync(r100), 'the previous Pane stays');
  assert.ok(!fs.existsSync(oldDownload), 'a download left behind is removed');
  assert.ok(fs.existsSync(newDownload), 'a download in progress is kept');
  assert.ok(!fs.existsSync(r090));
  for (const kept of [r100, r110, r080]) assert.ok(fs.existsSync(kept), `${path.basename(kept)} is kept`);
}));

test('cleanupRuntimes keeps a Pane referenced through another path to the same folder', () => {
  // macOS: /var is a link to /private/var, so an app's record may hold
  // /private/var/... while PANE_HOME says /var/... (or the reverse).
  const real = tmp('pane-real-');
  const link = path.join(tmp('pane-link-'), 'home');
  fs.symlinkSync(real, link, 'dir');
  return withEnv({ PANE_HOME: link }, () => {
    const { cleanupRuntimes } = require('../../src/packaging/runtime');
    const runtime = (v) => {
      const dir = path.join(link, 'runtime', v);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.js'), '');
      return dir;
    };
    const used = runtime('0.1.0');
    const unused = runtime('0.0.9');
    fs.writeFileSync(path.join(link, 'runtime', 'current'), `${runtime('0.1.1')}\n`);
    fs.mkdirSync(path.join(link, 'apps', 'a'), { recursive: true });
    fs.writeFileSync(path.join(link, 'apps', 'a', '.pane-install.json'),
      JSON.stringify({ id: 'a', runtimeDir: fs.realpathSync(used) })); // the real path
    assert.deepEqual(cleanupRuntimes(), ['0.0.9']);
    assert.ok(fs.existsSync(path.join(used, 'main.js')), 'the Pane an app uses is kept');
    assert.ok(!fs.existsSync(unused));
  });
});

test('an app already on its pending Pane, named another way, does not hand over', () => {
  const { shouldHandOver } = require('../../src/runtime/updates');
  const real = tmp('pane-real-');
  const link = path.join(tmp('pane-link-'), 'runtime');
  fs.symlinkSync(real, link, 'dir');
  assert.equal(shouldHandOver({ pendingRuntime: link }, { argv: [], runtimeRoot: real }), false);
  assert.equal(shouldHandOver({ pendingRuntime: tmp('pane-other-') }, { argv: [], runtimeRoot: real }), true);
});

test('app updates: check, download, stage, apply, and every refusal', { skip: process.platform === 'win32' }, async () => {
  const { generateAppKey, signApp } = require('../../src/core/app-signature');
  const { RUNTIME_ROOT } = require('../../src/core/paths');
  const { serveDir } = require('../e2e/lib/serve');
  const K = generateAppKey();
  const L = generateAppKey();
  const sandbox = tmp('pane-app-update-');
  const dist = path.join(sandbox, 'dist');
  fs.mkdirSync(dist);
  const server = await serveDir(dist);
  let n = 0;
  const makeApp = (version, { key, id = 'upd', updates = `${server.url}/latest.json` } = {}) => {
    const dir = path.join(sandbox, `src-${++n}`);
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'index.html'), `<p>${version}</p>`);
    fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify({ id, name: id === 'upd' ? 'Upd' : id, version, updates }));
    if (key) signApp(dir, { id, version, publisher: 'Acme' }, key.privatePem);
    return dir;
  };
  const pack = (dir, name) => {
    const file = path.join(dist, name);
    const macOnly = process.platform === 'darwin' ? ['--no-mac-metadata'] : [];
    execFileSync('tar', [...macOnly, '-czf', file, '-C', dir, ...fs.readdirSync(dir)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return file;
  };
  const announce = (version, name, extra = {}) => fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version, url: `${server.url}/${name}`, ...extra }));

  try { await withEnv({ PANE_HOME: path.join(sandbox, 'home'), PANE_LAUNCHERS_DIR: path.join(sandbox, 'launchers'), PANE_LAUNCHER_SIGNING: 'adhoc' }, async () => {
    const { installApp, uninstallApp } = require('../../src/packaging/apps');
    const { checkAppUpdate, downloadAppUpdate, stageAppUpdate, applyPendingUpdate } = require('../../src/packaging/app-updates');
    const record = (id = 'upd') => JSON.parse(fs.readFileSync(path.join(process.env.PANE_HOME, 'apps', id, '.pane-install.json'), 'utf8'));
    try {
      installApp(makeApp('0.1.0', { key: K }));
      pack(makeApp('0.2.0', { key: K }), 'upd-0.2.0.paneapp');
      announce('0.2.0', 'upd-0.2.0.paneapp', { notes: 'Faster.' });
      assert.deepEqual(await checkAppUpdate('upd'), { available: true, version: '0.2.0', current: '0.1.0', notes: 'Faster.' });

      const file = await downloadAppUpdate('upd');
      assert.ok(file.startsWith(path.join(process.env.PANE_HOME, 'updates', 'upd')), file);
      assert.deepEqual(await stageAppUpdate('upd', file), { version: '0.2.0' });
      assert.equal(record().pendingUpdate, file);
      assert.equal(record().version, '0.1.0', 'nothing changes under the running app');

      applyPendingUpdate('upd', file);
      assert.equal(record().version, '0.2.0');
      assert.equal(record().pendingUpdate, undefined);
      assert.ok(!fs.existsSync(file), 'the downloaded file is removed once installed');
      assert.equal((await checkAppUpdate('upd')).available, false);

      // Refusals: the installed version stays, nothing is pending.
      const refuse = async (dir, name, pattern) => {
        await assert.rejects(stageAppUpdate('upd', pack(dir, name)), pattern);
        assert.equal(record().version, '0.2.0');
        assert.equal(record().pendingUpdate, undefined);
      };
      await refuse(makeApp('0.3.0', { key: L }), 'other-key.paneapp', /not signed by its publisher/);
      await refuse(makeApp('0.3.0'), 'unsigned.paneapp', /unsigned/);
      await refuse(makeApp('0.1.5', { key: K }), 'older.paneapp', /not newer/);
      await refuse(makeApp('0.3.0', { key: K, id: 'other' }), 'other-app.paneapp', /is for other, not Upd/);
      const junk = path.join(dist, 'junk.paneapp');
      fs.writeFileSync(junk, 'not an archive');
      await assert.rejects(stageAppUpdate('upd', junk), /could not be unpacked/);
      assert.throws(() => applyPendingUpdate('upd', pack(makeApp('0.3.0'), 'unsigned-apply.paneapp')), /unsigned/);
      assert.equal(record().version, '0.2.0');

      pack(makeApp('0.3.0', { key: K }), 'bad-hash.paneapp');
      announce('0.3.0', 'bad-hash.paneapp', { sha256: '0'.repeat(64) });
      await assert.rejects(downloadAppUpdate('upd'), /does not match/);
      assert.deepEqual(fs.readdirSync(path.join(process.env.PANE_HOME, 'updates', 'upd')), [], 'a bad download is not kept');

      // The app hands Pane a file it got some other way: Pane keeps its own copy.
      const handed = pack(makeApp('0.3.0', { key: K }), 'handed.paneapp');
      const out = execFileSync(process.execPath, [path.join(RUNTIME_ROOT, 'bin', 'pane.js'), 'app-update', 'install-file', 'upd', handed], { env: process.env, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { result: { version: '0.3.0' } });
      assert.ok(record().pendingUpdate.startsWith(path.join(process.env.PANE_HOME, 'updates', 'upd')), record().pendingUpdate);
      assert.ok(fs.existsSync(record().pendingUpdate));
      const failed = require('child_process').spawnSync(process.execPath, [path.join(RUNTIME_ROOT, 'bin', 'pane.js'), 'app-update', 'check', 'nope'], { env: process.env, encoding: 'utf8' });
      assert.equal(failed.status, 1);
      assert.match(JSON.parse(failed.stdout.trim().split('\n').pop()).error, /No installed app/);

      // Apps installed unsigned cannot update themselves.
      installApp(makeApp('0.1.0', { id: 'plain' }));
      await assert.rejects(checkAppUpdate('plain'), /not signed, so it cannot update itself/);
      installApp(makeApp('0.1.0', { id: 'quiet', key: K, updates: null }));
      await assert.rejects(checkAppUpdate('quiet'), /has no update address/);
    } finally {
      for (const id of ['upd', 'plain', 'quiet']) { try { uninstallApp(id, { purge: true }); } catch { /* not installed */ } }
    }
  }); } finally {
    server.close();
  }
});

test('cmd.exe lines for .cmd files survive /s and spaces', () => {
  const { cmdArgs } = require('../../src/core/run');
  assert.deepEqual(cmdArgs('C:\\Users\\A B\\Pane\\bin\\pane.cmd', ['launcher-refresh', 'notes', '--', 'C:\\My Notes\\a.md']),
    ['/d', '/s', '/c', '""C:\\Users\\A B\\Pane\\bin\\pane.cmd" "launcher-refresh" "notes" "--" "C:\\My Notes\\a.md""']);
});

test('hand-over: a failed attempt is not repeated, and an app being moved does not start', () => withEnv({ PANE_HOME: tmp('pane-handover-') }, () => {
  const { recordHandover, recentHandover, takeHandover, takeLock } = require('../../src/core/update-state');
  const { startUpdates } = require('../../src/runtime/updates');
  const { appsDir } = require('../../src/core/paths');
  const record = { id: 'h', pendingRuntime: '/x/runtime/0.1.1' };
  const now = Date.now();
  recordHandover('h', record, ['notes://a b', '100%"&calc'], { now });
  assert.equal(recentHandover('h', record, { now: now + 1000 }), true, 'same pending work: do not hand over again');
  assert.equal(recentHandover('h', { ...record, pendingRuntime: '/x/runtime/0.1.2' }, { now }), false, 'new pending work: try again');
  assert.equal(recentHandover('h', record, { now: now + 2 * 3600e3 }), false, 'an hour later: try again');
  assert.deepEqual(takeHandover('h'), ['notes://a b', '100%"&calc'], 'arguments come back exactly, through a file');
  assert.equal(recentHandover('h', record, { now }), false, 'taken: gone');

  // While Pane holds the app's lock (moving it), opening it exits quietly.
  const dir = path.join(appsDir(), 'h');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.pane-install.json'), JSON.stringify({ id: 'h' }));
  const release = takeLock('app-h');
  try {
    const result = startUpdates({ app: { on() {} }, manifest: { id: 'h', dir }, home: process.env.PANE_HOME, dev: false });
    assert.equal(result.pendingRelaunch, true);
  } finally {
    release();
  }
}));

test('launcher-refresh changes nothing while the app is still running', { skip: process.platform === 'win32' }, async () => {
  const sandbox = tmp('pane-busy-');
  await withEnv({ PANE_HOME: path.join(sandbox, 'home'), PANE_LAUNCHERS_DIR: path.join(sandbox, 'launchers'), PANE_LAUNCHER_SIGNING: 'adhoc' }, async () => {
    const { installApp, uninstallApp } = require('../../src/packaging/apps');
    const { launcherRefresh } = require('../../src/cli/commands/launcher-refresh');
    const dir = path.join(sandbox, 'app');
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify({ id: 'busy', name: 'Busy' }));
    fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '');
    try {
      installApp(dir);
      const file = path.join(process.env.PANE_HOME, 'apps', 'busy', '.pane-install.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pendingUpdate: '/nowhere.paneapp' }));
      // The "app" is this test process: alive, so it refused to quit.
      assert.equal(await launcherRefresh('busy', { after: String(process.pid), open: true }, [], { waitMs: 300 }), 0);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pendingUpdate, '/nowhere.paneapp', 'still pending for its next start');
      assert.match(fs.readFileSync(path.join(process.env.PANE_HOME, 'logs', 'update.log'), 'utf8'), /still running, so nothing was changed/);
    } finally {
      try { uninstallApp('busy', { purge: true }); } catch { /* not installed */ }
    }
  });
});
