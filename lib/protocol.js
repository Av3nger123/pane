'use strict';
// Serves an app's own web files at pane-app://<app-id>/..., and nothing else.

const fs = require('fs');
const { pathToFileURL } = require('url');
const { protocol, net } = require('electron');
const { resolveInside, isInside } = require('./safe-path');

const SCHEME = 'pane-app';

// Must run before the app is ready.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  }]);
}

const originFor = (manifest) => `${SCHEME}://${manifest.id}`;

function serveApp(ses, manifest) {
  const root = fs.realpathSync(manifest.uiDir);
  ses.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== manifest.id) return notFound();
    const file = url.pathname === '/'
      ? resolveInside(root, manifest.start, { decode: false })
      : resolveInside(root, url.pathname);
    if (!file) return notFound();
    let real;
    try {
      real = await fs.promises.realpath(file);
      if (!(await fs.promises.stat(real)).isFile()) return notFound();
    } catch {
      return notFound();
    }
    // A symlink inside the ui folder must not lead outside it.
    if (!isInside(root, real)) return notFound();
    const headers = {};
    const range = request.headers.get('range');
    if (range) headers.range = range; // lets <video> and <audio> seek
    return net.fetch(pathToFileURL(real).toString(), { headers });
  });
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

module.exports = { SCHEME, registerScheme, serveApp, originFor };
