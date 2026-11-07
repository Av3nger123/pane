#!/usr/bin/env node
'use strict';
// The `pane` command.

// Installed Pane runs this file on its own Electron in Node mode, where .asar
// archives otherwise pretend to be folders.
if (process.versions.electron) process.noAsar = true;

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { RUNTIME_ROOT, RUNTIME_VERSION, paneHome, electronBinary } = require('../lib/paths');
const { loadManifest } = require('../lib/manifest');
const { appFiles, TEMPLATES } = require('../lib/templates');
const { defaultIconPng } = require('../lib/icon');
const { startCommand, stopCommand, freePort, waitForUrl, projectEnv } = require('../lib/run');
const {
  setupRuntime, installedRuntime, installApp, uninstallApp, listApps, buildInstaller, packRuntime, EXIT_NEEDS_NEWER_PANE,
} = require('../lib/install');

const PACKAGE_NAME = require('../package.json').name;
const EXIT_RESTART = 75;

const HELP = `Pane ${RUNTIME_VERSION}: one shared runtime for many desktop apps.

Usage:
  pane create <folder> [--template ${TEMPLATES.join('|')}] [--name "My App"] [--no-backend] [--no-install]
                                    Start a new app (default template: vanilla)
  pane dev [folder] [-- <electron flags>]
                                    Run an app, reloading when files change
  pane run [folder] [-- <electron flags>]
                                    Run an app as users will see it
  pane build [folder] [--out <dir>] Build the app and its installer in <folder>/release.
                                    Installers download Pane when a computer lacks it.
  pane install <folder|file.paneapp> [--open]
                                    Install an app on this computer
  pane uninstall <app-id> [--purge] Remove an app (--purge also deletes its data)
  pane list                         Show installed apps
  pane setup                        Install this Pane runtime on this computer
  pane pack-runtime [--out <dir>]   Make this runtime's files for the distribution server
  pane version
`;

const VALUE_FLAGS = new Set(['name', 'out', 'template']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[key] = inline;
      else if (VALUE_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function main() {
  const argv = process.argv.slice(2);
  // Anything after "--" goes to Electron/Chromium, e.g. --remote-debugging-port=9222
  const split = argv.indexOf('--');
  const [command, ...rest] = split >= 0 ? argv.slice(0, split) : argv;
  const extra = split >= 0 ? argv.slice(split + 1) : [];
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'create': return create(positional[0], flags);
    case 'dev': return runApp(positional[0] || '.', { dev: true, extra });
    case 'run': return runApp(positional[0] || '.', { dev: false, extra });
    case 'build': return build(positional[0] || '.', flags);
    case 'install': return install(positional[0], flags);
    case 'uninstall': return uninstall(positional[0], flags);
    case 'list': return list();
    case 'setup': return setup();
    case 'pack-runtime': return packRuntimeCommand(flags);
    case 'version': case '--version': case '-v':
      console.log(RUNTIME_VERSION);
      return 0;
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

// ---- create ----------------------------------------------------------------

function create(folder, flags) {
  if (!folder) throw new UsageError(`pane create <folder> [--template ${TEMPLATES.join('|')}]`);
  const template = typeof flags.template === 'string' ? flags.template : 'vanilla';
  if (!TEMPLATES.includes(template)) throw new UsageError(`--template must be one of: ${TEMPLATES.join(', ')}`);
  const dir = path.resolve(folder);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new UsageError(`${dir} already exists and is not empty.`);

  const base = path.basename(dir);
  const name = typeof flags.name === 'string' && flags.name.trim()
    ? flags.name.trim()
    : base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const id = (typeof flags.name === 'string' ? flags.name : base)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'my-app';

  const files = appFiles({ id, name, template, backend: !flags['no-backend'], paneDependency: paneDependency() });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng());
  loadManifest(dir, { requireUi: template === 'vanilla' }); // templates must always be valid

  const shown = path.relative(process.cwd(), dir) || '.';
  const usesNpm = template !== 'vanilla';
  if (usesNpm && !flags['no-install']) {
    console.log(`Installing ${template} and Vite with npm...`);
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: dir, env: projectEnv(dir), stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (res.status !== 0) {
      console.error(`\nnpm install failed. Fix the problem, then run "npm install" in ${shown}.`);
      return 1;
    }
  }
  console.log(`\nCreated ${name} (${template}) in ${shown}\n\nNext:\n  ${usesNpm ? `cd ${shown}\n  npm run dev` : `pane dev ${shown}`}`);
  return 0;
}

// Framework templates add Pane as a devDependency, for `npm run dev` and the
// TypeScript types. From a git checkout of Pane, link to it; otherwise use
// this version's package from Pane's GitHub release.
function paneDependency() {
  if (fs.existsSync(path.join(RUNTIME_ROOT, '.git'))) return { name: PACKAGE_NAME, spec: `file:${RUNTIME_ROOT}` };
  const repo = require('../package.json').repository.url.replace(/\.git$/, '');
  return { name: PACKAGE_NAME, spec: `${repo}/releases/download/v${RUNTIME_VERSION}/${PACKAGE_NAME}-${RUNTIME_VERSION}.tgz` };
}

// ---- dev / run -------------------------------------------------------------

// Starts Electron with main.js for one app. With a "dev" block in pane.json,
// `pane dev` first starts the dev server and loads its URL. pane.json changes
// restart everything (main.js exits with EXIT_RESTART).
async function runApp(folder, { dev, extra = [] }) {
  const dir = path.resolve(folder);
  const electron = electronBinary(RUNTIME_ROOT);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set when this CLI itself runs on Pane's Electron

  let server = null;
  let child = null;
  let stopping = false;
  const stopAll = () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
    stopCommand(server);
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  try {
    for (;;) {
      let manifest = loadManifest(dir, { requireUi: false });
      const useServer = dev && manifest.dev;
      if (!useServer) manifest = loadManifest(dir); // the built files must exist

      let devUrl = null;
      if (useServer) {
        ({ server, url: devUrl } = await startDevServer(manifest));
        if (stopping) return 1;
      }
      const args = [path.join(RUNTIME_ROOT, 'main.js'), `--app=${dir}`, ...(dev ? ['--dev'] : []), ...(devUrl ? [`--dev-url=${devUrl}`] : []), ...extra];
      const code = await new Promise((resolve) => {
        child = spawn(electron, args, { stdio: 'inherit', env });
        child.on('exit', (c, signal) => resolve(signal ? 1 : c || 0));
      });
      child = null;
      stopCommand(server);
      server = null;
      if (!(dev && code === EXIT_RESTART) || stopping) return code;
    }
  } finally {
    process.off('SIGINT', stopAll);
    process.off('SIGTERM', stopAll);
    stopCommand(server);
  }
}

async function startDevServer(manifest) {
  const port = await freePort();
  const fill = (s) => s.replace(/\{port\}/g, String(port));
  const url = fill(manifest.dev.url);
  let server = null;
  if (manifest.dev.command) {
    const command = fill(manifest.dev.command);
    console.log(`[pane] starting the dev server: ${command}`);
    server = startCommand(command, { cwd: manifest.dir, onLine: (line) => { if (line.trim()) console.log(`[dev server] ${line}`); } });
  } else {
    console.log(`[pane] waiting for your dev server at ${url}`);
  }
  try {
    await waitForUrl(url, { child: server });
  } catch (err) {
    stopCommand(server);
    throw err;
  }
  return { server, url };
}

// ---- build / install -------------------------------------------------------

async function build(folder, flags) {
  const result = await buildInstaller(folder, { out: typeof flags.out === 'string' ? flags.out : undefined });
  const rel = (p) => path.relative(process.cwd(), p) || p;
  console.log(`\nBuilt ${rel(result.outDir)}`);
  console.log(`  ${path.basename(result.package)}  ${size(result.package)}`);
  for (const f of result.installers) console.log(`  ${path.basename(f)}`);
  if (result.distributionUrl) {
    console.log(`\nOn computers without Pane ${result.paneVersion} or newer, the installer downloads it from ${result.distributionUrl}`);
  }
  for (const w of result.warnings) console.warn(`\nWarning: ${w}`);
  return 0;
}

function packRuntimeCommand(flags) {
  const out = typeof flags.out === 'string' ? flags.out : 'pane-dist';
  const result = packRuntime({ out });
  const rel = (p) => path.relative(process.cwd(), p) || p;
  console.log(`Packed Pane ${RUNTIME_VERSION} for ${process.platform}-${process.arch}`);
  console.log(`  ${rel(result.archive)}  ${size(result.archive)}`);
  console.log(`  ${rel(result.archive)}.sha256`);
  console.log(`\nAttach both files to the GitHub release tagged v${RUNTIME_VERSION} (the release workflow does this`);
  console.log('for every OS when you push the tag). Other servers: upload them under v<version>/.');
  return 0;
}

function install(source, flags) {
  if (!source) throw new UsageError('pane install <folder|file.paneapp>');
  let record;
  try {
    record = installApp(source);
  } catch (err) {
    if (err.code !== 'PANE_TOO_OLD') throw err;
    console.error(err.message);
    return EXIT_NEEDS_NEWER_PANE; // installers download a newer Pane and retry
  }
  console.log(`Installed ${record.name} ${record.version}`);
  console.log(`  launcher: ${record.launcher}`);
  if (flags.open) openLauncher(record.launcher);
  return 0;
}

function openLauncher(launcher) {
  if (process.platform === 'darwin') {
    spawn('open', [launcher], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', launcher], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('gtk-launch', [path.basename(launcher, '.desktop')], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
}

function uninstall(id, flags) {
  if (!id) throw new UsageError('pane uninstall <app-id>');
  const record = uninstallApp(id, { purge: Boolean(flags.purge) });
  console.log(`Removed ${record.name}${flags.purge ? ' and its data' : ' (its data was kept; --purge removes it)'}`);
  return 0;
}

function list() {
  const apps = listApps();
  if (!apps.length) { console.log('No apps installed.'); return 0; }
  const width = Math.max(...apps.map((a) => a.id.length));
  for (const a of apps) console.log(`${a.id.padEnd(width)}  ${a.name} ${a.version}`);
  return 0;
}

function setup() {
  const existing = installedRuntime();
  const result = setupRuntime();
  console.log(`${existing ? 'Added' : 'Installed'} Pane ${result.version}`);
  if (result.current !== result.version) console.log(`  (Pane ${result.current} is newer and stays the default)`);
  console.log(`  runtime: ${result.dir}`);
  console.log(`  command: ${result.command}`);
  console.log(`  home:    ${paneHome()}`);
  return 0;
}

function size(file) {
  const bytes = fs.statSync(file).size;
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

class UsageError extends Error {}

Promise.resolve()
  .then(main)
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof UsageError ? `Usage: ${err.message}` : `pane: ${err.message}`);
    process.exitCode = 1;
  });
