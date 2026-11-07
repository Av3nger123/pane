'use strict';
// pane list

const { listApps } = require('../../packaging/apps');

function list() {
  const apps = listApps();
  if (!apps.length) { console.log('No apps installed.'); return 0; }
  const width = Math.max(...apps.map((a) => a.id.length));
  for (const a of apps) console.log(`${a.id.padEnd(width)}  ${a.name} ${a.version}`);
  return 0;
}

module.exports = { list };
