'use strict';
// End-to-end check: creates an app with `pane create`, runs it on Electron and
// drives the real window over the Chrome DevTools protocol.
// Run: npm run smoke   (opens a window for a few seconds)

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { electronBinary, RUNTIME_ROOT } = require('../lib/paths');

const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-smoke-'));
  const appDir = path.join(work, 'smoke-app');
  const env = { ...process.env, PANE_HOME: path.join(work, 'home') };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(process.execPath, [path.join(RUNTIME_ROOT, 'bin', 'pane.js'), 'create', appDir, '--name', 'Smoke App'], { env, stdio: 'pipe' });

  const child = spawn(electronBinary(), [path.join(RUNTIME_ROOT, 'main.js'), `--app=${appDir}`, '--dev', `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  try {
    const page = await waitForPage('index.html');
    const cdp = await connect(page.webSocketDebuggerUrl);
    const run = async (expr) => {
      const res = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(`${expr}\n${JSON.stringify(res.exceptionDetails)}`);
      return res.result.value;
    };
    await waitFor(() => run('document.readyState === "complete" && typeof pane === "object"'), 'page ready');

    const appInfo = await run('pane.app');
    assert.equal(appInfo.name, 'Smoke App');
    assert.equal(appInfo.id, 'smoke-app');
    assert.equal(appInfo.hasBackend, true);
    ok('window.pane is there, with app info');

    const greeting = await run('pane.call("greet", "Ada")');
    assert.match(greeting, /^Hello, Ada\. This answer came from Node \d+/);
    ok(`backend call works: "${greeting}"`);

    const missing = await run('pane.call("nope").then(() => "resolved", (e) => e.message)');
    assert.match(missing, /no function "nope"/);
    ok('calling a missing backend function gives a clear error');

    const tick = await run('new Promise((resolve) => { const off = pane.on("tick", (t) => { off(); resolve(t); }); })');
    assert.ok(Math.abs(Date.now() - tick) < 10000);
    ok('backend events reach the window');

    const isolated = await run('[typeof require, typeof process, typeof module].join(",")');
    assert.equal(isolated, 'undefined,undefined,undefined');
    ok('pages have no Node access');

    const top = await run('getComputedStyle(document.documentElement).getPropertyValue("--pane-safe-top").trim()');
    assert.ok(/^\d+px$/.test(top) && top !== '0px', `safe area set, got "${top}"`);
    ok(`hidden title bar reports its safe area (--pane-safe-top: ${top})`);

    const statuses = await run(`Promise.all(["/index.html", "/../pane.json", "/%2e%2e/backend/main.js", "/.hidden", "/nope.html"]
      .map((p) => fetch(p).then((r) => r.status, () => "blocked")))`);
    assert.deepEqual(statuses, [200, 404, 404, 404, 404]);
    ok(`only the app's ui folder is served (${statuses.join(', ')})`);

    const otherApp = await run('fetch("pane-app://some-other-app/index.html").then((r) => r.status, () => "blocked")');
    assert.ok(otherApp === 404 || otherApp === 'blocked', `other app: ${otherApp}`);
    ok('another app\'s files cannot be read');

    const winId = await run('pane.window.open("about.html", { width: 440, height: 320 })');
    assert.equal(typeof winId, 'number');
    await waitForPage('about.html');
    ok('a second window opens in the same app');

    const badPage = await run('pane.window.open("../pane.json").then(() => "opened", (e) => e.message)');
    assert.match(badPage, /no page/);
    ok('windows cannot open files outside the ui folder');

    // file:// is refused outright. (Web links are refused too, but open in the
    // user's browser, which a test should not do.)
    const nav = await run('location.href = "file:///etc/hosts"; new Promise((r) => setTimeout(() => r(location.href), 500))');
    assert.ok(nav.startsWith('pane-app://smoke-app/'), `navigation stayed in the app: ${nav}`);
    ok('navigating away from the app is refused');

    const hashWin = await run('pane.window.open("about.html#details", { width: 440, height: 320 })');
    assert.equal(typeof hashWin, 'number');
    await waitForPage('about.html#details');
    ok('pages can be opened with a #hash');

    fs.appendFileSync(path.join(appDir, 'backend', 'main.js'), '\npane.expose("added", () => "hot");\npane.expose("crash", () => process.exit(3));\n');
    await waitFor(async () => (await run('pane.call("added").catch(() => null)')) === 'hot', 'backend restart after edit', 8000);
    ok('editing the backend restarts it (pane dev)');

    const crash = await run('pane.call("crash").then(() => "no error", (e) => e.message)');
    assert.match(crash, /backend stopped \(exit code 3\)/);
    await waitFor(() => run('Boolean(document.querySelector("pane-dev-overlay"))'), 'the crash overlay');
    ok('a backend crash rejects the call and shows the crash overlay (pane dev)');

    cdp.close();
    console.log('\nAll smoke checks passed.');
  } catch (err) {
    console.error('\nSmoke test FAILED:', err.message, '\n--- app output ---\n', output);
    process.exitCode = 1;
  } finally {
    child.kill();
    await sleep(300);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function ok(text) { console.log(`ok  ${text}`); }

async function waitFor(check, what, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await check()) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function waitForPage(file) {
  let found = null;
  await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    found = list.find((t) => t.type === 'page' && t.url.endsWith(`/${file}`));
    return Boolean(found);
  }, `the ${file} window`);
  return found;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    };
    const timer = setTimeout(() => { ws.close(); reject(new Error('timed out connecting to the window')); }, 10000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('could not connect to the window')); };
    ws.onopen = () => {
      clearTimeout(timer);
      const call = (method, params) => new Promise((res, rej) => {
        const n = ++id;
        waiting.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
      call.close = () => ws.close();
      resolve(call);
    };
  });
}

main();
