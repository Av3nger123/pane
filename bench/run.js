'use strict';
// Runs every case several times and writes RESULTS.md with medians.
// Run: node bench/run.js [--runs 3]   (after node bench/build.js)
// Opens real windows on this computer for roughly 15 minutes.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'out');
const KINDS = ['pane', 'tauri', 'electron'];
const COUNTS = [1, 3, 5];
const APPS = ['notes', 'kanban', 'markdown', 'timer', 'dashboard'];
const runs = process.argv.includes('--runs') ? Number(process.argv[process.argv.indexOf('--runs') + 1]) : 3;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

function measureAll() {
  fs.rmSync(path.join(OUT, 'results'), { recursive: true, force: true });
  for (let run = 1; run <= runs; run++) {
    for (const count of COUNTS) {
      // Rotate the order so no runtime always goes first (or last).
      const order = KINDS.map((_, i) => KINDS[(i + run + count) % KINDS.length]);
      for (const kind of order) {
        execFileSync(process.execPath, [path.join(__dirname, 'measure.js'), kind, String(count), '--run', String(run)], { stdio: 'inherit' });
        execFileSync('sleep', ['5']);
      }
    }
  }
}

// Bytes on disk the files would take as separate copies (clones count fully).
function treeSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    total += e.isDirectory() ? treeSize(p) : fs.statSync(p).size;
  }
  return total;
}
const gzipSize = (file) => zlib.gzipSync(fs.readFileSync(file)).length;
const mb = (b) => (b / 1048576 < 10 ? (b / 1048576).toFixed(1) : String(Math.round(b / 1048576)));
const kb = (b) => String(Math.round(b / 1024));

function report() {
  const rows = {};
  for (const f of fs.readdirSync(path.join(OUT, 'results'))) {
    const r = JSON.parse(fs.readFileSync(path.join(OUT, 'results', f), 'utf8'));
    (rows[`${r.kind}-${r.apps}`] ||= []).push(r);
  }
  const stat = (kind, count, key) => median((rows[`${kind}-${count}`] || []).map((r) => r[key]));
  const name = { pane: 'Pane', tauri: 'Tauri', electron: 'Electron' };

  const memTable = ['| | 1 app | 3 apps | 5 apps | Each extra app (5 vs 1) |', '|---|---|---|---|---|'];
  const cpuTable = ['| | 1 app | 3 apps | 5 apps |', '|---|---|---|---|'];
  const procTable = ['| | 1 app | 3 apps | 5 apps |', '|---|---|---|---|'];
  for (const kind of KINDS) {
    const m = COUNTS.map((c) => stat(kind, c, 'memoryMB'));
    memTable.push(`| ${name[kind]} | ${m.map((x) => `${Math.round(x)} MB`).join(' | ')} | ${Math.round((m[2] - m[0]) / 4)} MB |`);
    cpuTable.push(`| ${name[kind]} | ${COUNTS.map((c) => `${stat(kind, c, 'cpuPercent').toFixed(1)}%`).join(' | ')} |`);
    procTable.push(`| ${name[kind]} | ${COUNTS.map((c) => stat(kind, c, 'processes')).join(' | ')} |`);
  }

  // Sizes
  const paneHome = path.join(OUT, 'pane-home');
  const paneApp = (n) => treeSize(path.join(paneHome, 'apps', `bench-${n}`));
  const tauriBin = (n) => fs.statSync(path.join(OUT, 'target', 'release', `bench-${n}`)).size;
  const electronApp = (n) => treeSize(path.join(OUT, 'electron', `Bench ${n[0].toUpperCase()}${n.slice(1)}.app`));
  const { electronDist } = require(path.join(__dirname, '..', 'src/core/paths'));
  const runtimeSize = treeSize(electronDist(path.join(__dirname, '..'))) + treeSize(path.join(__dirname, '..', 'src'));
  const avg = (f) => APPS.reduce((s, n) => s + f(n), 0) / APPS.length;
  const tauriGz = avg((n) => gzipSize(path.join(OUT, 'target', 'release', `bench-${n}`)));
  const zip = path.join(OUT, 'electron-notes.zip');
  fs.rmSync(zip, { force: true });
  execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(OUT, 'electron', 'Bench Notes.app'), zip]);
  const electronZip = fs.statSync(zip).size;

  const machine = `${sh('sysctl', ['-n', 'machdep.cpu.brand_string'])}, ${Math.round(Number(sh('sysctl', ['-n', 'hw.memsize'])) / 2 ** 30)} GB RAM, macOS ${sh('sw_vers', ['-productVersion'])}`;
  const electronVersion = require(path.join(path.dirname(require.resolve('electron/package.json', { paths: [path.join(__dirname, '..')] })), 'package.json')).version;
  const lock = fs.readFileSync(path.join(OUT, 'tauri', 'notes', 'src-tauri', 'Cargo.lock'), 'utf8');
  const tauriVersion = (/name = "tauri"\nversion = "([^"]+)"/.exec(lock) || [])[1];

  const md = `# Benchmark results

Measured ${new Date().toISOString().slice(0, 10)} on ${machine}.
Pane ${require('../package.json').version} and plain Electron ${electronVersion} (the same Electron), Tauri ${tauriVersion} (macOS WebKit).
Median of ${runs} runs per cell. How these were measured, and what they leave out: [README.md](README.md).

## Memory (all processes the apps started, shared memory counted once)

${memTable.join('\n')}

## CPU while open (average over 10 s, % of one core)

${cpuTable.join('\n')}

## Processes

${procTable.join('\n')}

## Size

| | Each app on disk | Each app download | Shared, once per computer |
|---|---|---|---|
| Pane | ${kb(avg(paneApp))} KB | ${kb(avg(paneApp))} KB or less (.paneapp) | ${mb(runtimeSize)} MB (Pane: Chromium, Node, Pane) |
| Tauri | ${mb(avg(tauriBin))} MB | ~${mb(tauriGz)} MB compressed | none (uses macOS WebKit) |
| Electron | ${mb(avg(electronApp))} MB | ~${mb(electronZip)} MB zipped | none (each app ships its own) |
`;
  fs.writeFileSync(path.join(__dirname, 'RESULTS.md'), md);
  console.log(md);
}

if (!process.argv.includes('--report-only')) measureAll();
report();
