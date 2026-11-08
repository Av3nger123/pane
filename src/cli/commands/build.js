'use strict';
// pane build [folder]

const path = require('path');
const { buildInstaller } = require('../../packaging/build');
const { size } = require('../util');

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

module.exports = { build };
