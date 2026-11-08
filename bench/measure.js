'use strict';
// Opens N of the demo apps (Pane or Tauri), lets them settle, and measures
// everything they started: memory (macOS footprint, shared memory counted
// once), CPU over a sampling window, and the number of processes. Tauri's
// WebKit helpers are system XPC services, not children of the app, so new
// com.apple.WebKit.* processes are counted too.
//
// Run: node bench/measure.js <pane|tauri|electron> <count> [--settle 15] [--sample 10]
// Opens real windows; closes them afterwards by exact process id.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'out');
const APPS = ['notes', 'kanban', 'markdown', 'timer', 'dashboard'];
const title = (s) => s[0].toUpperCase() + s.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : def);

const [kind, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (!['pane', 'tauri', 'electron'].includes(kind) || !(count >= 1 && count <= APPS.length)) {
  console.error('node bench/measure.js <pane|tauri|electron> <1-5> [--settle 15] [--sample 10]');
  process.exit(2);
}
const settle = arg('--settle', 15);
const sample = arg('--sample', 10);

function processes() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,comm='], { encoding: 'utf8' });
  return out.trim().split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), cpu: cpuSeconds(m[3]), comm: m[4] };
  }).filter(Boolean);
}
// ps TIME: [[dd-]hh:]mm:ss.cc
function cpuSeconds(t) {
  const [d, rest] = t.includes('-') ? t.split('-') : ['0', t];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function launch(name) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's terminal; Electron would start as plain Node
  if (kind === 'pane') {
    Object.assign(env, {
      PANE_HOME: path.join(OUT, 'pane-home'), PANE_LAUNCHERS_DIR: path.join(OUT, 'launchers'),
      PANE_LAUNCHER_SIGNING: 'adhoc', PANE_LATEST_URL: 'http://127.0.0.1:9/none.json',
    });
    const bundle = path.join(OUT, 'launchers', `Bench ${title(name)}.app`);
    const exe = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    return spawn(path.join(bundle, 'Contents', 'MacOS', exe), [], { env, stdio: 'ignore' });
  }
  if (kind === 'electron') {
    return spawn(path.join(OUT, 'electron', `Bench ${title(name)}.app`, 'Contents', 'MacOS', 'Electron'), [], { env, stdio: 'ignore' });
  }
  return spawn(path.join(OUT, 'target', 'release', `bench-${name}`), [], { env, stdio: 'ignore' });
}

function family(all, roots, before) {
  const pids = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (!pids.has(p.pid) && pids.has(p.ppid)) { pids.add(p.pid); grew = true; }
  }
  // WebKit (Tauri's WebView) runs its helpers as system services.
  for (const p of all) if (!before.has(p.pid) && /com\.apple\.WebKit\./.test(p.comm)) pids.add(p.pid);
  return all.filter((p) => pids.has(p.pid));
}

function footprint(pids) {
  const file = path.join(os.tmpdir(), `pane-bench-${process.pid}.json`);
  execFileSync('footprint', ['-j', file, ...pids.map(String)], { stdio: 'ignore' });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file, { force: true });
  const unit = data['bytes per unit'] || 1;
  return {
    total: data['total footprint'] * unit,
    perProcess: Object.fromEntries(data.processes.map((p) => [p.pid, p.footprint * unit])),
  };
}

const mb = (b) => Math.round(b / 1048576);

async function main() {
  const before = new Set(processes().map((p) => p.pid));
  const roots = [];
  try {
    for (const name of APPS.slice(0, count)) {
      roots.push(launch(name).pid);
      await sleep(1500);
    }
    await sleep(settle * 1000);
    const first = family(processes(), roots, before);
    await sleep(sample * 1000);
    const second = family(processes(), roots, before);
    const cpu0 = new Map(first.map((p) => [p.pid, p.cpu]));
    const cpu = second.reduce((sum, p) => sum + (p.cpu - (cpu0.get(p.pid) ?? p.cpu)), 0) / sample;
    const mem = footprint(second.map((p) => p.pid));
    const result = {
      kind, apps: count, processes: second.length,
      memoryMB: mb(mem.total), memoryPerAppMB: Math.round(mb(mem.total) / count),
      cpuPercent: Math.round(cpu * 1000) / 10,
      detail: second.map((p) => ({ pid: p.pid, name: p.comm.split('/').pop(), mb: mb(mem.perProcess[p.pid] || 0) })),
    };
    fs.mkdirSync(path.join(OUT, 'results'), { recursive: true });
    const run = arg('--run', 1);
    fs.writeFileSync(path.join(OUT, 'results', `${kind}-${count}-${run}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, detail: undefined }));
  } finally {
    for (const pid of roots) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    await sleep(3000);
    for (const pid of roots) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
