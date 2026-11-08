'use strict';
// The `pane` command: parses arguments and runs one of ./commands.

// Installed Pane runs the CLI on its own Electron in Node mode, where .asar
// archives otherwise pretend to be folders.
if (process.versions.electron) process.noAsar = true;

const { RUNTIME_VERSION } = require('../core/paths');
const { TEMPLATES } = require('./templates');
const { UsageError } = require('./util');

const HELP = `Pane ${RUNTIME_VERSION}: one shared runtime for many desktop apps.

Usage:
  pane create <folder> [--template ${TEMPLATES.join('|')}] [--name "My App"] [--no-backend] [--no-install]
                                    Start a new app (default template: vanilla)
  pane dev [folder] [-- <electron flags>]
                                    Run an app, reloading when files change
  pane run [folder] [-- <electron flags>]
                                    Run an app as users will see it
  pane build [folder] [--out <dir>] [--key <file>] [--sign] [--update-url <address>]
                                    Build the app and its installer in <folder>/release.
                                    Installers download Pane when a computer lacks it.
                                    --key signs the app (default: PANE_SIGNING_KEY)
                                    --sign signs the installers with your certificates
                                    (PANE_SIGN_* settings, see README)
                                    --update-url is where you upload the .paneapp; it goes
                                    into latest.json (default: next to pane.json's "updates")
  pane keygen <file>                Create a key for signing your apps
  pane open <folder> <link|file> [--dev]
                                    Hand a link (notes://...) or file to the app, as the
                                    system would (--dev: the copy running under pane dev)
  pane install <folder|file.paneapp> [--open]
                                    Install an app on this computer
  pane uninstall <app-id> [--purge] Remove an app (--purge also deletes its data)
  pane list                         Show installed apps
  pane setup                        Install this Pane runtime on this computer
  pane self-update [--force]        Install a newer Pane if there is one (apps do this daily)
  pane pack-runtime [--out <dir>] [--key <file>]
                                    Make this runtime's signed files for the distribution server
                                    (key: Pane's release key; default PANE_RELEASE_SIGNING_KEY)
  pane keygen --release <file>      Create Pane's release signing key
  pane version
`;

const VALUE_FLAGS = new Set(['name', 'out', 'template', 'key', 'expect', 'after', 'update-url']);

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

const command = (file) => require(`./commands/${file}`);

function main() {
  const argv = process.argv.slice(2);
  // Anything after "--" goes to Electron/Chromium, e.g. --remote-debugging-port=9222
  const split = argv.indexOf('--');
  const [name, ...rest] = split >= 0 ? argv.slice(0, split) : argv;
  const extra = split >= 0 ? argv.slice(split + 1) : [];
  const { positional, flags } = parseArgs(rest);
  switch (name) {
    case 'create': return command('create').create(positional[0], flags);
    case 'dev': return command('run').runApp(positional[0] || '.', { dev: true, extra });
    case 'run': return command('run').runApp(positional[0] || '.', { dev: false, extra });
    case 'build': return command('build').build(positional[0] || '.', flags);
    case 'install': return command('install').install(positional[0], flags);
    case 'open': return command('open').openRequest(positional[0], positional[1], flags);
    case 'uninstall': return command('uninstall').uninstall(positional[0], flags);
    case 'list': return command('list').list();
    case 'setup': return command('setup').setup(flags);
    case 'self-update': return command('self-update').selfUpdateCommand(flags);
    case 'launcher-refresh': return command('launcher-refresh').launcherRefresh(positional[0], flags, extra);
    case 'pack-runtime': return command('pack-runtime').packRuntimeCommand(flags);
    case 'keygen': return command('keygen').keygen(positional[0], flags);
    case 'version': case '--version': case '-v':
      console.log(RUNTIME_VERSION);
      return 0;
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      console.error(`Unknown command "${name}".\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

Promise.resolve()
  .then(main)
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof UsageError ? `Usage: ${err.message}` : `pane: ${err.message}`);
    process.exitCode = 1;
  });
