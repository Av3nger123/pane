'use strict';
// pane self-update [--force]: look for a newer Pane and install it quietly.
// Apps start this when they open (at most once a day). Prints one JSON line.

const { selfUpdate } = require('../../packaging/self-update');

async function selfUpdateCommand(flags) {
  const result = await selfUpdate({ force: Boolean(flags.force) });
  console.log(JSON.stringify(result));
  return result.status === 'failed' ? 1 : 0;
}

module.exports = { selfUpdateCommand };
