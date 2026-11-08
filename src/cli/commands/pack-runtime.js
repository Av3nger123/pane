'use strict';
// pane pack-runtime: files for Pane's distribution (GitHub release)

const path = require('path');
const { RUNTIME_VERSION } = require('../../core/paths');
const { packRuntime } = require('../../packaging/runtime');
const { size } = require('../util');

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

module.exports = { packRuntimeCommand };
