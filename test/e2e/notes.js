'use strict';
// Drives the Notes example (examples/notes) like a user, in a real window.
// Needs network the first time (npm install). Run: npm run test:notes

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { RUNTIME_ROOT } = require('../../src/core/paths');
const { sleep, waitFor, waitForPage, connect, randomPort } = require('./lib/cdp');

const APP = path.join(RUNTIME_ROOT, 'examples', 'notes');
const CLI = path.join(RUNTIME_ROOT, 'bin', 'pane.js');

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notes-'));
  const env = { ...process.env, PANE_HOME: path.join(work, 'home'), PANE_TEST_DIALOGS: JSON.stringify({ message: 0 }) };
  delete env.ELECTRON_RUN_AS_NODE;
  const notesDir = path.join(env.PANE_HOME, 'data', 'notes.dev', 'files', 'notes');

  execFileSync('npm', [fs.existsSync(path.join(APP, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'], {
    cwd: APP, env, stdio: 'pipe', shell: process.platform === 'win32',
  });
  execFileSync('npm', ['test'], { cwd: APP, env, stdio: 'pipe', shell: process.platform === 'win32' });
  ok('npm install, and the store\'s unit tests pass');

  const port = randomPort();
  const cli = spawn(process.execPath, [CLI, 'dev', APP, '--', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  cli.stdout.on('data', (d) => { output += d; });
  cli.stderr.on('data', (d) => { output += d; });

  try {
    const main = await connect((await waitForPage(port, (t) => /^http:\/\/localhost:\d+\/(index\.html)?$/.test(t.url), 'the Notes window')).webSocketDebuggerUrl);
    const run = main.run;
    await waitFor(() => run('Boolean(document.querySelector(".sidebar"))'), 'the app to render');
    await waitFor(() => run('/No notes yet/.test(document.querySelector(".list-empty")?.innerText || "")'), 'the empty state');
    ok('starts empty, with an invitation to write');

    await run('document.querySelector("button.new").click()');
    await waitFor(() => run('document.activeElement && document.activeElement.tagName === "TEXTAREA"'), 'the editor to take focus');
    await main.send('Input.insertText', { text: 'Groceries\nmilk, eggs, coffee' });
    await waitFor(() => run('document.querySelector(".status").innerText === "Saved"'), 'autosave');
    await waitFor(() => run('document.querySelector(".item.selected .item-title")?.innerText === "Groceries"'), 'the list to show the title');
    const files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(notesDir, files[0]), 'utf8'), 'Groceries\nmilk, eggs, coffee');
    ok('a new note autosaves to a Markdown file and shows up in the list');

    await run('document.querySelector("button.new").click()');
    await waitFor(() => run('document.activeElement && document.activeElement.tagName === "TEXTAREA" && document.activeElement.value === ""'), 'a second, empty note');
    await main.send('Input.insertText', { text: 'Trip plan\nbook the train' });
    await waitFor(() => run('document.querySelectorAll(".item").length === 2 && document.querySelector(".status").innerText === "Saved"'), 'two notes');

    const setSearch = (q) => run(`(() => {
      const input = document.querySelector('input[type=search]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(q)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await setSearch('COFFEE');
    await waitFor(async () => JSON.stringify(await run('[...document.querySelectorAll(".item-title")].map((e) => e.innerText)')) === '["Groceries"]', 'search results');
    await setSearch('nothing like this');
    await waitFor(() => run('/No notes contain/.test(document.body.innerText)'), 'the no-results message');
    await setSearch('');
    await waitFor(() => run('document.querySelectorAll(".item").length === 2'), 'the full list again');
    ok('search covers the full text and says when nothing matches');

    // Open "Trip plan" in its own window and edit it there.
    await run('[...document.querySelectorAll(".item")].find((e) => e.innerText.includes("Trip plan")).click()');
    await waitFor(() => run('document.querySelector("textarea")?.value.startsWith("Trip plan")'), 'Trip plan in the editor');
    await run('[...document.querySelectorAll("button")].find((b) => b.innerText === "Open in new window").click()');
    const single = await connect((await waitForPage(port, (t) => t.url.includes('#note='), 'the note window')).webSocketDebuggerUrl);
    await waitFor(() => single.run('document.querySelector("textarea")?.value.startsWith("Trip plan")'), 'the note in its window');
    await single.run('(() => { const t = document.querySelector("textarea"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()');
    await single.send('Input.insertText', { text: ' at 9:40' });
    await waitFor(() => run('document.querySelector("textarea").value === "Trip plan\\nbook the train at 9:40"'), 'the main window to pick up the edit');
    ok('a note opens in its own window, and edits there appear in the main window');

    await run('[...document.querySelectorAll("button")].find((b) => b.innerText === "Open in new window").click()');
    await sleep(800);
    const noteWindows = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page' && t.url.includes('#note='));
    assert.equal(noteWindows.length, 1, 'opening the same note again reuses its window');
    ok('opening a note that already has a window focuses that window');

    await run('[...document.querySelectorAll("button")].find((b) => b.innerText === "Delete").click()');
    await waitFor(() => single.run('/This note was deleted/.test(document.body.innerText)'), 'the note window to notice');
    await waitFor(() => run('document.querySelectorAll(".item").length === 1'), 'the list to drop the note');
    assert.equal(fs.readdirSync(path.join(notesDir, '.trash')).length, 1);
    ok('deleting (confirmed in the native dialog) moves the note to the trash, and its other window says so');

    await run('location.reload()').catch(() => {});
    await waitFor(() => run('document.querySelector(".item.selected .item-title")?.innerText === "Groceries"'), 'the last note to be selected again');
    ok('the last open note is selected again after a restart (pane.store)');

    const paneOpen = (target) => execFileSync(process.execPath, [CLI, 'open', APP, target, '--dev'], { env, stdio: 'pipe' });
    paneOpen('pane-notes://new?text=From%20a%20link%0Asent%20by%20another%20app');
    await waitFor(() => run('document.querySelector(".item.selected .item-title")?.innerText === "From a link"'), 'the note from the link');
    const doc = path.join(work, 'Imported.md');
    fs.writeFileSync(doc, '# Imported plan\nfrom a file on disk');
    paneOpen(doc);
    await waitFor(() => run('document.querySelector(".item.selected .item-title")?.innerText === "Imported plan"'), 'the imported file');
    ok('a pane-notes:// link and an opened .md file each become a note');
    single.close();
    main.close();
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    if (cli.exitCode === null) {
      cli.kill('SIGINT');
      await sleep(3000);
      if (cli.exitCode === null) cli.kill('SIGKILL');
    }
  }

  const out = path.join(work, 'release');
  execFileSync(process.execPath, [CLI, 'build', APP, '--out', out], { env, stdio: 'pipe' });
  const pkg = fs.readdirSync(out).find((f) => f.endsWith('.paneapp'));
  ok(`pane build packages Notes (${Math.round(fs.statSync(path.join(out, pkg)).size / 1024)} KB)`);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log('\nAll Notes checks passed.');
}

function ok(text) { console.log(`ok  ${text}`); }

main().catch((err) => {
  console.error('\nNotes test FAILED:', err.stack || err.message);
  process.exitCode = 1;
});
