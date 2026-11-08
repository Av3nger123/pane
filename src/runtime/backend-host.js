'use strict';
// First file loaded in an app's backend process. Makes `require('pane')` and
// `import pane from 'pane'` resolve to Pane's own module (whatever the app has
// in node_modules), then loads the app's backend file.

const Module = require('module');
const path = require('path');
const { pathToFileURL } = require('url');

const sdkFile = path.join(process.env.PANE_SDK_DIR, 'index.js');
const sdkUrl = pathToFileURL(sdkFile).href;

if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'pane') return { url: sdkUrl, format: 'commonjs', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
} else {
  // Older Node: CommonJS only.
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function paneResolve(request, ...rest) {
    return request === 'pane' ? sdkFile : resolve.call(this, request, ...rest);
  };
}

const pane = require(sdkFile);
globalThis.pane = pane;

const entry = process.env.PANE_BACKEND_ENTRY;

(async () => {
  try {
    if (/\.mjs$/.test(entry)) await import(pathToFileURL(entry).href);
    else {
      try {
        require(entry);
      } catch (err) {
        if (err && (err.code === 'ERR_REQUIRE_ESM' || err.code === 'ERR_REQUIRE_ASYNC_MODULE')) await import(pathToFileURL(entry).href);
        else throw err;
      }
    }
  } catch (err) {
    console.error(`The backend failed to load ${path.basename(entry)}:\n${(err && err.stack) || err}`);
    process.exit(1);
  }
  pane._ready();
})();
