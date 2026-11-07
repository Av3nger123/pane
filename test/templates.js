'use strict';
// Checks the React and Svelte templates end to end: pane create (with a real
// npm install), pane dev through Vite with hot reload, pane build.
// Needs network access. Run: npm run test:templates [react|svelte]

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { RUNTIME_ROOT } = require('../lib/paths');
const { sleep, waitFor, waitForPage, connect } = require('./cdp');

const CLI = path.join(RUNTIME_ROOT, 'bin', 'pane.js');
const only = process.argv[2];

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-templates-'));
  const env = { ...process.env, PANE_HOME: path.join(work, 'home') };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const template of ['react', 'svelte'].filter((t) => !only || t === only)) {
      console.log(`\n== ${template}`);
      await checkTemplate(template, work, env);
    }
    console.log('\nAll template checks passed.');
  } catch (err) {
    console.error('\nTemplate test FAILED:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function checkTemplate(template, work, env) {
  const dir = path.join(work, `${template}-app`);
  execFileSync(process.execPath, [CLI, 'create', dir, '--template', template], { env, stdio: 'pipe' });
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'vite')), 'npm install ran');
  ok('created, dependencies installed');

  // ---- pane dev through Vite
  const port = 9300 + Math.floor(Math.random() * 500);
  const cli = spawn(process.execPath, [CLI, 'dev', dir, '--', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  cli.stdout.on('data', (d) => { output += d; });
  cli.stderr.on('data', (d) => { output += d; });
  try {
    const page = await waitForPage(port, (t) => t.url.startsWith('http://localhost:'));
    const viteUrl = new URL(page.url).origin;
    const cdp = await connect(page.webSocketDebuggerUrl);
    const { run } = cdp;
    await waitFor(() => run('Boolean(document.querySelector("h1"))'), 'the app to render');
    ok(`pane dev loads the Vite dev server (${viteUrl})`);

    const greeting = await run('pane.call("greet", "Vite")');
    assert.match(greeting, /^Hello, Vite\./);
    ok('the ESM backend (import pane from "pane") answers');

    await run('window.__sameDocument = true');
    const app = path.join(dir, 'src', template === 'react' ? 'App.jsx' : 'App.svelte');
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('served by Vite while you develop', 'EDITED BY THE TEST'));
    await waitFor(() => run('document.body.innerText.includes("EDITED BY THE TEST")'), 'hot reload', 15000);
    assert.equal(await run('window.__sameDocument === true'), true, 'updated in place, not a full reload');
    ok('editing a component hot-reloads it in place');

    const winId = await run('pane.window.open("index.html#about", { width: 440, height: 320 })');
    assert.equal(typeof winId, 'number');
    await waitForPage(port, (t) => t.url.endsWith('/index.html#about'));
    ok('a second window opens on #about');
    cdp.close();

    cli.kill('SIGINT');
    await waitFor(async () => {
      try { await fetch(viteUrl, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
    }, 'the dev server to stop', 8000);
    ok('Ctrl+C stops the app and the dev server');
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    if (cli.exitCode === null) {
      cli.kill('SIGINT'); // lets Pane stop Electron and the dev server
      await sleep(3000);
      if (cli.exitCode === null) cli.kill('SIGKILL');
    }
  }

  // ---- pane build
  const out = execFileSync(process.execPath, [CLI, 'build', dir], { env, encoding: 'utf8', stdio: 'pipe' });
  const releaseDir = path.join(dir, 'release');
  const [folder] = fs.readdirSync(releaseDir);
  const pkg = fs.readdirSync(path.join(releaseDir, folder)).find((f) => f.endsWith('.paneapp'));
  const entries = execFileSync('tar', ['-tzf', path.join(releaseDir, folder, pkg)], { encoding: 'utf8' }).split('\n');
  assert.ok(entries.some((e) => /(^|\/)dist\/index\.html$/.test(e)), 'built files are packaged');
  assert.ok(!entries.some((e) => e.includes('node_modules/vite')), 'build tools are not packaged');
  assert.ok(!out.includes('Warning:'), out);
  const kb = Math.round(fs.statSync(path.join(releaseDir, folder, pkg)).size / 1024);
  ok(`pane build runs vite build and packages the app (${kb} KB, no node_modules)`);
}

function ok(text) { console.log(`ok  ${text}`); }

main();
