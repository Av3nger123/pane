'use strict';
// `pane build --sign`, end to end, with a throwaway self-signed certificate:
//   Windows  signtool signs "<App> Setup.exe"; the signature covers the
//            attached app, and the signed installer still installs it
//   macOS    codesign signs "Install <App>.app" and the .dmg
// Never touches the machine's certificate stores or default keychain.
// Run: npm run test:signing   (macOS or Windows)

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { RUNTIME_ROOT } = require('../../src/core/paths');
const { generateReleaseKey } = require('../../src/core/release-signature');
const { readPayload } = require('../../src/core/installer-payload');
const { serveDir } = require('./lib/serve');

const CLI = path.join(RUNTIME_ROOT, 'bin', 'pane.js');
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const ok = (text) => console.log(`ok  ${text}`);

// openssl: on macOS the system's, on Windows the one Git for Windows ships.
function opensslPath() {
  if (!WIN) return 'openssl';
  for (const p of ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return 'openssl';
}

// A self-signed code-signing certificate as a .p12 file, readable by both
// signtool and macOS's security tool.
function makeCertificate(dir, password) {
  const openssl = opensslPath();
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const p12 = path.join(dir, 'cert.p12');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Pane Test',
    '-addext', 'extendedKeyUsage=critical,codeSigning', '-addext', 'keyUsage=critical,digitalSignature',
    '-keyout', key, '-out', cert], { stdio: 'pipe' });
  execFileSync(openssl, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `pass:${password}`,
    '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'], { stdio: 'pipe' });
  return p12;
}

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} took longer than 10 minutes`)); }, 600000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function main() {
  if (!MAC && !WIN) { console.log('Signing tests run on macOS and Windows.'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-signing-'));
  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  const cleanups = [];
  try {
    const password = crypto.randomBytes(12).toString('hex');
    const p12 = makeCertificate(work, password);
    ok('made a throwaway code-signing certificate (CN=Pane Test)');

    const releaseKey = generateReleaseKey();
    baseEnv.PANE_RELEASE_KEYS = JSON.stringify([releaseKey.publicPem]);
    const appDir = path.join(work, 'Field Notes');
    execFileSync(process.execPath, [CLI, 'create', appDir, '--name', 'Field Notes'], { env: baseEnv, stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'pane.json'), 'utf8'));
    const release = path.join(appDir, 'release', 'Field Notes 0.1.0');

    if (WIN) await windows({ work, baseEnv, appDir, manifest, release, p12, password, releaseKey, cleanups });
    else await mac({ work, baseEnv, appDir, release, p12, password, cleanups });
    console.log('\nAll signing checks passed.');
  } catch (err) {
    console.error('\nSigning test FAILED:', err.stack || err.message);
    if (WIN) {
      const log = path.join(os.tmpdir(), 'pane-setup.log');
      if (fs.existsSync(log)) console.error(`--- pane-setup.log ---\n${fs.readFileSync(log, 'utf8')}`);
    }
    process.exitCode = 1;
  } finally {
    for (const fn of cleanups.reverse()) { try { fn(); } catch { /* best effort */ } }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// ---- Windows ---------------------------------------------------------------

function authenticode(file) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath $env:PANE_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  // Without PSModulePath: one inherited from PowerShell 7 stops Windows
  // PowerShell from loading the module that has Get-AuthenticodeSignature.
  const env = { ...process.env, PANE_FILE: file };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8' }).trim();
  const [status, subject] = out.split('|');
  return { status, subject };
}

async function windows({ work, baseEnv, appDir, manifest, release, p12, password, releaseKey, cleanups }) {
  execFileSync(process.execPath, [path.join(RUNTIME_ROOT, 'installer', 'windows', 'build.js')], { stdio: 'pipe' });
  execFileSync(process.execPath, [CLI, 'pack-runtime', '--out', path.join(work, 'dist')], {
    env: { ...baseEnv, PANE_RELEASE_SIGNING_KEY: releaseKey.privatePem }, stdio: 'pipe',
  });
  const server = await serveDir(path.join(work, 'dist'));
  cleanups.push(() => server.close());

  execFileSync(process.execPath, [CLI, 'build', appDir, '--sign'], {
    env: { ...baseEnv, PANE_DIST_URL: server.url, PANE_SIGN_PFX: p12, PANE_SIGN_PFX_PASSWORD: password, PANE_SIGN_TIMESTAMP_URL: 'none' },
    stdio: 'pipe',
  });
  const exe = path.join(release, fs.readdirSync(release).find((f) => f.endsWith('.exe')));
  const sig = authenticode(exe);
  assert.ok(!['NotSigned', 'HashMismatch'].includes(sig.status), `Setup.exe is signed and intact (status ${sig.status})`);
  assert.equal(sig.subject, 'CN=Pane Test');
  assert.equal(readPayload(fs.readFileSync(exe)).config.id, manifest.id);
  ok(`pane build --sign signed "${path.basename(exe)}" (${sig.status}: the test certificate is not trusted, as expected)`);

  const tampered = path.join(work, 'tampered.exe');
  const bytes = fs.readFileSync(exe);
  bytes[readPayload(bytes).stubLength + 64] ^= 0xff;
  fs.writeFileSync(tampered, bytes);
  assert.equal(authenticode(tampered).status, 'HashMismatch');
  ok('the signature covers the attached app: changing one byte of it breaks the signature');

  const home = path.join(work, 'home');
  const env = { ...baseEnv, PANE_HOME: home, PANE_LAUNCHERS_DIR: path.join(work, 'launchers') };
  delete env.PANE_RELEASE_KEYS;
  const { code } = await run(exe, ['/quiet'], env);
  const log = fs.readFileSync(path.join(os.tmpdir(), 'pane-setup.log'), 'utf8');
  assert.equal(code, 0, `the signed Setup.exe failed:\n${log}`);
  const paneCmd = path.join(home, 'bin', 'pane.cmd');
  cleanups.push(() => execFileSync(paneCmd, ['uninstall', manifest.id, '--purge'], { env, stdio: 'pipe', shell: true }));
  assert.match(execFileSync(paneCmd, ['list'], { env, encoding: 'utf8', shell: true }), /field-notes\s+Field Notes 0\.1\.0/);
  ok('the signed Setup.exe finds its app and installs it');
}

// ---- macOS -----------------------------------------------------------------

// A temporary keychain holding the test identity. codesign only finds
// identities in keychains on the user's search list, so it joins the list
// for the test and the saved list is put back afterwards.
function tempKeychain(work, p12, password, cleanups) {
  const keychain = path.join(work, 'pane-test.keychain-db');
  const pw = crypto.randomBytes(12).toString('hex');
  const security = (...args) => execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const saved = security('list-keychains', '-d', 'user').split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  security('create-keychain', '-p', pw, keychain);
  cleanups.push(() => security('delete-keychain', keychain));
  security('unlock-keychain', '-p', pw, keychain);
  security('set-keychain-settings', keychain);
  security('import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign');
  security('set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', pw, keychain);
  security('list-keychains', '-d', 'user', '-s', keychain, ...saved);
  cleanups.push(() => security('list-keychains', '-d', 'user', '-s', ...saved));
  const identity = /\b([0-9A-F]{40})\b "Pane Test"/.exec(security('find-identity', '-p', 'codesigning', keychain))[1];
  return { keychain, identity };
}

async function mac({ work, baseEnv, appDir, release, p12, password, cleanups }) {
  const { keychain, identity } = tempKeychain(work, p12, password, cleanups);
  const env = {
    ...baseEnv, PANE_DIST_URL: 'https://downloads.example.com/pane',
    PANE_SIGN_IDENTITY: identity, PANE_SIGN_KEYCHAIN: keychain, PANE_SIGN_TIMESTAMP: 'none',
  };
  delete env.PANE_NOTARY_PROFILE;
  const built = spawnSync(process.execPath, [CLI, 'build', appDir, '--sign'], { env, encoding: 'utf8' });
  const out = `${built.stdout}${built.stderr}`;
  assert.equal(built.status, 0, out);
  assert.match(out, /not notarized/, out); // warnings go to stderr
  const dmg = path.join(release, fs.readdirSync(release).find((f) => f.endsWith('.dmg')));
  execFileSync('codesign', ['--verify', '--strict', dmg], { stdio: 'pipe' });
  const mnt = path.join(work, 'mnt');
  fs.mkdirSync(mnt);
  execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mnt], { stdio: 'pipe' });
  cleanups.push(() => spawnSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' }));
  const app = path.join(mnt, 'Install Field Notes.app');
  execFileSync('codesign', ['--verify', '--strict', '--deep', app], { stdio: 'pipe' });
  const details = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' }).stderr;
  assert.match(details, /Authority=Pane Test/, details);
  assert.match(details, /flags=0x10000\(runtime\)/, details);
  ok('pane build --sign signed "Install Field Notes.app" (hardened runtime) and the .dmg');
  ok('without PANE_NOTARY_PROFILE it warns that the .dmg is not notarized');
}

main();
