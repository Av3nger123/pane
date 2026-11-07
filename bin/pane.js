#!/usr/bin/env node
'use strict';
// The `pane` command.

// Installed Pane runs this file on its own Electron in Node mode, where .asar
// archives otherwise pretend to be folders.
if (process.versions.electron) process.noAsar = true;

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { RUNTIME_ROOT, RUNTIME_VERSION, paneHome, electronBinary } = require('../lib/paths');
const { loadManifest } = require('../lib/manifest');
const { appFiles } = require('../lib/templates');
const { defaultIconPng } = require('../lib/icon');
const {
  setupRuntime, installedRuntime, installApp, uninstallApp, listApps, buildInstaller,
} = require('../lib/install');

const EXIT_RESTART = 75;

const HELP = `Pane ${RUNTIME_VERSION}: one shared runtime for many desktop apps.

Usage:
  pane create <folder> [--name "My App"] [--no-backend]   Start a new app
  pane dev [folder]                 Run an app, reloading when files change
  pane run [folder]                 Run an app as users will see it
  pane build [folder] [--with-runtime] [--out <dir>]
                                    Make the app's installer in <folder>/dist
  pane install <folder|file.paneapp> [--open]
                                    Install an app on this computer
  pane uninstall <app-id> [--purge] Remove an app (--purge also deletes its data)
  pane list                         Show installed apps
  pane setup                        Install this Pane runtime on this computer
  pane version
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[key] = inline;
      else if (['name', 'out'].includes(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'create': return create(positional[0], flags);
    case 'dev': return runApp(positional[0] || '.', { dev: true });
    case 'run': return runApp(positional[0] || '.', { dev: false });
    case 'build': return build(positional[0] || '.', flags);
    case 'install': return install(positional[0], flags);
    case 'uninstall': return uninstall(positional[0], flags);
    case 'list': return list();
    case 'setup': return setup();
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

function create(folder, flags) {
  if (!folder) throw new UsageError('pane create <folder> [--name "My App"]');
  const dir = path.resolve(folder);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new UsageError(`${dir} already exists and is not empty.`);
  const base = path.basename(dir);
  const name = typeof flags.name === 'string' && flags.name.trim()
    ? flags.name.trim()
    : base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const id = (typeof flags.name === 'string' ? flags.name : base)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'my-app';
  const files = appFiles({ id, name, backend: !flags['no-backend'] });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng());
  loadManifest(dir); // the template must always be valid
  const shown = path.relative(process.cwd(), dir) || '.';
  console.log(`Created ${name} in ${shown}\n\nNext:\n  pane dev ${shown}`);
  return 0;
}

// Starts Electron with main.js for one app. `pane dev` restarts it when
// pane.json changes (main.js exits with EXIT_RESTART).
function runApp(folder, { dev }) {
  const dir = path.resolve(folder);
  loadManifest(dir); // fail here, with a readable message, before starting Electron
  const electron = electronBinary(RUNTIME_ROOT);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set when this CLI itself runs on Pane's Electron
  const args = [path.join(RUNTIME_ROOT, 'main.js'), `--app=${dir}`, ...(dev ? ['--dev'] : [])];

  return new Promise((resolve) => {
    const launch = () => {
      const child = spawn(electron, args, { stdio: 'inherit', env });
      const forward = (sig) => () => child.kill(sig);
      const onInt = forward('SIGINT');
      const onTerm = forward('SIGTERM');
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      child.on('exit', (code, signal) => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        if (dev && code === EXIT_RESTART) { launch(); return; }
        resolve(signal ? 1 : code || 0);
      });
    };
    launch();
  });
}

function build(folder, flags) {
  const result = buildInstaller(folder, { out: typeof flags.out === 'string' ? flags.out : undefined, withRuntime: Boolean(flags['with-runtime']) });
  const rel = (p) => path.relative(process.cwd(), p) || p;
  console.log(`Built ${rel(result.outDir)}`);
  console.log(`  ${path.basename(result.package)}  ${size(result.package)}`);
  for (const f of result.installers) console.log(`  ${path.basename(f)}`);
  if (result.runtimeArchive) console.log(`  ${path.basename(result.runtimeArchive)}  ${size(result.runtimeArchive)}  (Pane, for computers without it)`);
  else console.log('\nThis installer needs Pane on the computer, or PANE_DOWNLOAD_URL. Add --with-runtime to include Pane.');
  return 0;
}

function install(source, flags) {
  if (!source) throw new UsageError('pane install <folder|file.paneapp>');
  const record = installApp(source);
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
  console.log(`${existing ? 'Updated' : 'Installed'} Pane ${result.version}`);
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
