'use strict';
// pane setup [--expect <version>]: install this Pane runtime on this computer
//
// Installers pass --expect with the version they downloaded: the signature
// proves a download came from Pane, and this proves it is the version asked
// for (not an older signed release served under the new name).

const { paneHome, RUNTIME_VERSION } = require('../../core/paths');
const { setupRuntime, installedRuntime } = require('../../packaging/runtime');

function setup(flags = {}) {
  if (typeof flags.expect === 'string' && flags.expect !== RUNTIME_VERSION) {
    console.error(`This Pane download is version ${RUNTIME_VERSION}, but version ${flags.expect} was expected. Nothing was installed.`);
    return 1;
  }
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
