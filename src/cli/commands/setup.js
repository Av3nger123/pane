'use strict';
// pane setup: install this Pane runtime on this computer

const { paneHome } = require('../../core/paths');
const { setupRuntime, installedRuntime } = require('../../packaging/runtime');

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

module.exports = { setup };
