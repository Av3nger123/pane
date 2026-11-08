'use strict';
// pane app-update check <id>
// pane app-update download <id>              download and stage the update
// pane app-update install-file <id> <file>   stage an update the app got itself
// pane app-update apply <id> [--open] [--after <pid>] [-- <app arguments>]
//
// Started by a running app (pane.updates). Prints JSON lines for it to read:
// {"progress":0.4} while downloading, then {"result":...} or {"error":"..."}.

const { UsageError } = require('../util');

const USAGE = 'pane app-update check|download|install-file|apply <app-id> [file]';
const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function appUpdate(positional, flags, extra = []) {
  const [action, id, file] = positional;
  if (!action || !id) throw new UsageError(USAGE);
  if (action === 'apply') return require('./launcher-refresh').launcherRefresh(id, flags, extra);

  const updates = require('../../packaging/app-updates');
  try {
    let result;
    if (action === 'check') result = await updates.checkAppUpdate(id);
    else if (action === 'download') {
      let last = -1;
      const downloaded = await updates.downloadAppUpdate(id, {
        onProgress: (p) => {
          const step = Math.floor(p * 20) / 20; // every 5%
          if (step > last) { last = step; say({ progress: step }); }
        },
      });
      result = await updates.stageAppUpdate(id, downloaded);
    } else if (action === 'install-file') {
      if (!file) throw new UsageError('pane app-update install-file <app-id> <file>');
      result = await updates.stageAppUpdate(id, file);
    } else throw new UsageError(USAGE);
    say({ result });
    return 0;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    say({ error: err.message });
    return 1;
  }
}

module.exports = { appUpdate };
