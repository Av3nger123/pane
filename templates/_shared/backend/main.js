// Runs in its own process on the Node that comes with Pane.
// Full Node: fs, child_process, network, npm packages.
{{#esm}}import pane from 'pane';{{/esm}}{{^esm}}const pane = require('pane');{{/esm}}

pane.expose('greet', (who) => {
  const name = String(who || '').trim() || 'there';
  return `Hello, ${name}. This answer came from Node ${process.versions.node}.`;
});

setInterval(() => pane.emit('tick', Date.now()), 1000);

console.log('backend started, data folder:', pane.app.dataDir);
