'use strict';
// pane build [folder]

const path = require('path');
const { buildInstaller } = require('../../packaging/build');
const { size } = require('../util');

async function build(folder, flags) {
  const result = await buildInstaller(folder, {
    out: typeof flags.out === 'string' ? flags.out : undefined,
    key: typeof flags.key === 'string' ? flags.key : undefined,
    sign: Boolean(flags.sign),
    updateUrl: typeof flags['update-url'] === 'string' ? flags['update-url'] : undefined,
  });
  const rel = (p) => path.relative(process.cwd(), p) || p;
  console.log(`\nBuilt ${rel(result.outDir)}`);
  console.log(`  ${path.basename(result.package)}  ${size(result.package)}`);
  for (const f of result.installers) console.log(`  ${path.basename(f)}`);
  if (result.updateFile) {
    console.log(`  ${path.basename(result.updateFile)}  (upload it last, next to ${path.basename(result.package)}: installed copies read it to find this version)`);
  }
  if (result.publisher) console.log(`\nSigned by ${result.publisher.name || 'an unnamed publisher'} (key ${result.publisher.fingerprint})`);
  if (result.distributionUrl) {
    console.log(`\nOn computers without Pane ${result.paneVersion} or newer, the installer downloads it from ${result.distributionUrl}`);
  }
  for (const w of result.warnings) console.warn(`\nWarning: ${w}`);
  return 0;
}

module.exports = { build };
