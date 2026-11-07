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
const cdpHelpers = require('./cdp');
const { sleep, waitFor, connect } = cdpHelpers;

const PORT = 9300 + Math.floor(Math.random() * 500);

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-smoke-'));
  const appDir = path.join(work, 'smoke-app');
  const env = { ...process.env, PANE_HOME: path.join(work, 'home') };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(process.execPath, [path.join(RUNTIME_ROOT, 'bin', 'pane.js'), 'create', appDir, '--name', 'Smoke App'], { env, stdio: 'pipe' });

  // Links and files: the app declares a protocol and a file type.
  const manifestFile = path.join(appDir, 'pane.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
    protocols: ['smoke-test'],
    fileTypes: [{ name: 'Smoke document', extensions: ['smoke'] }],
  }, null, 2));
  const sample = path.join(work, 'sample.smoke');
  fs.writeFileSync(sample, 'hello');
  const paneOpen = (target) => execFileSync(process.execPath, [path.join(RUNTIME_ROOT, 'bin', 'pane.js'), 'open', appDir, target, '--dev'], { env, stdio: 'pipe' });

  const child = spawn(electronBinary(), [path.join(RUNTIME_ROOT, 'main.js'), `--app=${appDir}`, '--dev', `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  try {
    const page = await waitForPage('index.html');
    const cdp = await connect(page.webSocketDebuggerUrl);
    const { run } = cdp;
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

    await run('pane.store.set("prefs", { wrap: true, size: 15 })');
    await run('location.reload()').catch(() => {});
    await waitFor(() => run('document.readyState === "complete" && typeof pane === "object"'), 'the page after reload');
    assert.deepEqual(await run('pane.store.get("prefs")'), { wrap: true, size: 15 });
    assert.match(await run('pane.store.set("bad key!", 1).then(() => "ok", (e) => e.message)'), /not a valid key/);
    ok('pane.store keeps JSON values across reloads');

    assert.equal(await run('pane.menu.set([{ label: "File", items: [{ label: "New Note", id: "new", shortcut: "CmdOrCtrl+N" }] }, { label: "Note", items: [{ label: "Export", id: "export" }] }])'), true);
    assert.match(await run('pane.menu.set([{ label: "File", items: [{ label: "No id" }] }]).then(() => "ok", (e) => e.message)'), /needs an "id"/);
    ok('pane.menu.set accepts app menus and explains bad ones');

    const first = await run('pane.window.open("about.html", { key: "about", width: 440, height: 320 })');
    const again = await run('pane.window.open("about.html", { key: "about" })');
    assert.equal(first, again, 'the same key focuses the open window');
    assert.match(await run('pane.window.open("about.html", { key: "no spaces allowed" }).then(() => "ok", (e) => e.message)'), /key/);
    ok('windows with a key are not opened twice');

    assert.match(await run('pane.dialog.message({}).then(() => "ok", (e) => e.message)'), /needs a "message"/);
    assert.match(await run('pane.shell.showItemInFolder("relative/path").then(() => "ok", (e) => e.message)'), /absolute path/);
    assert.match(await run('pane.notify({ title: "Hi" }).then(() => "ok", (e) => e.message)'), /Add "notifications"/);
    ok('dialogs, Finder and notifications check their input and permissions');

    paneOpen('smoke-test://first?from=queue');
    await run('window.__opened = []; pane.onOpen((r) => window.__opened.push(r))');
    await waitFor(async () => (await run('window.__opened.length')) === 1, 'the queued link');
    paneOpen('smoke-test://second');
    paneOpen(sample);
    paneOpen('other-scheme://ignored');
    await waitFor(async () => (await run('window.__opened.length')) === 3, 'the link and the file');
    assert.deepEqual(await run('window.__opened'), [
      { kind: 'url', url: 'smoke-test://first?from=queue' },
      { kind: 'url', url: 'smoke-test://second' },
      { kind: 'file', path: sample },
    ]);
    ok('links and files reach the running app (pane open), including ones sent before it listened');

    await run('(() => { const i = document.createElement("input"); i.type = "file"; i.id = "pick"; document.body.append(i); })()');
    const { root } = await cdp.send('DOM.getDocument', {});
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [sample] });
    assert.equal(await run('pane.pathForFile(document.getElementById("pick").files[0])'), sample);
    ok('pane.pathForFile gives the path of a dropped or picked file');

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

const waitForPage = (file) => cdpHelpers.waitForPage(PORT, (t) => t.url.endsWith(`/${file}`), `the ${file} window`);

main();
