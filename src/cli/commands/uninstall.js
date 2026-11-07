'use strict';
// pane uninstall <app-id> [--purge]

const { uninstallApp } = require('../../packaging/apps');
const { UsageError } = require('../util');

function uninstall(id, flags) {
  if (!id) throw new UsageError('pane uninstall <app-id>');
  const record = uninstallApp(id, { purge: Boolean(flags.purge) });
  console.log(`Removed ${record.name}${flags.purge ? ' and its data' : ' (its data was kept; --purge removes it)'}`);
  return 0;
}

module.exports = { uninstall };
