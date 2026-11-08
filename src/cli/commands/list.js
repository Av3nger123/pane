'use strict';
// pane list

const { listApps } = require('../../packaging/apps');

function list() {
  const apps = listApps();
  if (!apps.length) { console.log('No apps installed.'); return 0; }
  const width = Math.max(...apps.map((a) => a.id.length));
  const by = (a) => (a.publisher ? `${a.publisher.name || 'unnamed publisher'}, key ${a.publisher.fingerprint}` : 'unsigned');
  for (const a of apps) console.log(`${a.id.padEnd(width)}  ${a.name} ${a.version}  (${by(a)})`);
  return 0;
}

module.exports = { list };
