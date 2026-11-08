'use strict';
// A tiny static file server standing in for Pane's distribution (GitHub
// Releases) in tests.

const fs = require('fs');
const http = require('http');
const path = require('path');

function serveDir(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

module.exports = { serveDir };
