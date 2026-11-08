'use strict';
// Launcher signing on macOS, end to end:
//   1. Pane makes a signing identity of this computer's own, in a keychain of
//      its own, and adds that keychain to the user's search list without
//      dropping any entry
// This changes keychain settings (restored afterwards), so it runs only on
// CI machines (CI set), never on a developer's own Mac.
// Run: CI=1 npm run test:keychain   (macOS)

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
  delete process.env.PANE_LAUNCHER_SIGNING;
  const { ensureLocalIdentity } = require('../../src/packaging/signing/local-identity');
  let keychain = null;
  try {
    const first = ensureLocalIdentity();
    assert.ok(first, 'an identity is made on macOS');
    keychain = first.keychain;
    assert.equal(realpath(path.dirname(keychain)), realpath(path.join(process.env.PANE_HOME, 'signing')));
    assert.match(first.identity, /^[0-9A-F]{40}$/);
    assert.equal((fs.statSync(path.join(process.env.PANE_HOME, 'signing', 'password')).mode & 0o777), 0o600);
    assert.match(security('find-identity', '-p', 'codesigning', keychain), new RegExp(`${first.identity} "Pane Local Signing`));
    ok('a signing identity is made in a keychain of Pane\'s own');

    const list = searchList().map(realpath);
    assert.ok(list.includes(realpath(keychain)), 'Pane\'s keychain is on the search list');
    for (const entry of savedList) assert.ok(list.includes(realpath(entry)), `the search list still has ${entry}`);
    assert.equal(security('default-keychain', '-d', 'user').trim().replace(/^"|"$/g, ''), savedDefault);
    ok('the search list keeps every entry, and the default keychain is unchanged');

    const second = ensureLocalIdentity();
    assert.deepEqual(second, first);
    assert.equal(searchList().filter((e) => realpath(e) === realpath(keychain)).length, 1);
    ok('a second call reuses the same identity and lists the keychain once');

    assert.equal(ensureLocalIdentity({ env: { PANE_LAUNCHER_SIGNING: 'adhoc' } }), null);
    ok('PANE_LAUNCHER_SIGNING=adhoc turns it off');

    // A signed binary carries the certificate, and the requirement names it.
    const bin = path.join(work, 'true');
    fs.copyFileSync('/usr/bin/true', bin);
    execFileSync('codesign', ['--force', '--sign', first.identity, '--keychain', keychain, '--identifier', 'dev.pane.test', bin], { stdio: 'pipe' });
    const requirement = execFileSync('codesign', ['-d', '-r-', bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(requirement, /identifier "dev\.pane\.test" and certificate leaf = H"[0-9a-f]{40}"/);
    ok('codesign signs with it, and the requirement pins the certificate');
  } finally {
    if (keychain) { try { security('delete-keychain', keychain); } catch { /* gone */ } }
    security('list-keychains', '-d', 'user', '-s', ...savedList);
    security('default-keychain', '-d', 'user', '-s', savedDefault);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('Keychain test passed.');
}

main().catch((err) => {
  console.error('Keychain test FAILED:', err);
  process.exit(1);
});
