'use strict';
// First file loaded in an app's backend process. Makes `require('pane')`
// available, then loads the app's backend file.

const Module = require('module');
const path = require('path');
const { pathToFileURL } = require('url');

const sdkDir = process.env.PANE_SDK_DIR;
process.env.NODE_PATH = [sdkDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const pane = require(path.join(sdkDir, 'pane'));
globalThis.pane = pane;

const entry = process.env.PANE_BACKEND_ENTRY;

(async () => {
  try {
    if (/\.mjs$/.test(entry)) await import(pathToFileURL(entry).href);
    else {
      try {
        require(entry);
      } catch (err) {
        if (err && err.code === 'ERR_REQUIRE_ESM') await import(pathToFileURL(entry).href);
        else throw err;
      }
    }
  } catch (err) {
    console.error(`The backend failed to load ${path.basename(entry)}:\n${(err && err.stack) || err}`);
    process.exit(1);
  }
  pane._ready();
})();
