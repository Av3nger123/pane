'use strict';
// Pane updating itself, quietly. Started by an app when it opens (at most
// once a day, src/runtime/updates.js) as `pane self-update`. Nothing is shown
// to the user; every outcome goes to PANE_HOME/logs/update.log.

const fs = require('fs');
const path = require('path');
const { parse, compare } = require('../core/version');
const { paneHome } = require('../core/paths');
const { updateDue, markChecked, takeLock } = require('../core/update-state');
const { installedRuntime, runtimeVersionOf, distributionUrl, latestUrl } = require('./runtime');
const { downloadRuntime, installedReleaseKeys } = require('./runtime-download');

function log(line) {
  const dir = path.join(paneHome(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'update.log'), `${new Date().toISOString()} ${line}\n`);
}

async function latestVersion() {
  const url = latestUrl();
  if (!url) throw new Error('This Pane has no latest-version address.');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  let data;
  try { data = JSON.parse(await response.text()); } catch { throw new Error(`${url} is not a valid latest-version file.`); }
  const version = data && typeof data.version === 'string' ? data.version : null;
  if (!version || !parse(version)) throw new Error(`${url} does not name a valid version.`);
  return version;
}

// { status: 'not-due' | 'busy' | 'up-to-date' | 'updated' | 'failed', version?, error? }
async function selfUpdate({ force = false, now = Date.now() } = {}) {
  if (!force && !updateDue({ now })) return { status: 'not-due' };
  const release = takeLock('self-update');
  if (!release) return { status: 'busy' };
  try {
    const current = installedRuntime();
    const currentVersion = current ? runtimeVersionOf(current) : null;
    let result;
    try {
      const version = await latestVersion();
      if (currentVersion && compare(parse(version), parse(currentVersion)) <= 0) {
        result = { status: 'up-to-date', version: currentVersion, removed: require('./runtime').cleanupRuntimes() };
      } else {
        const dist = distributionUrl();
        if (!dist) throw new Error('This Pane has no distribution address.');
        // Trust only the keys of the Pane installed as current.
        const keys = installedReleaseKeys(current || undefined);
        const installed = await downloadRuntime({ version, dist, keys });
        const moved = require('./apps').moveAppsOnto(installed.dir);
        const removed = require('./runtime').cleanupRuntimes();
        result = { status: 'updated', version, moved, removed };
      }
    } catch (err) {
      result = { status: 'failed', error: err.message };
    }
    markChecked({ now });
    log(result.status === 'updated' ? `updated to Pane ${result.version}`
      : result.status === 'failed' ? `update check failed: ${result.error}` : `Pane ${result.version} is up to date`);
    return result;
  } finally {
    release();
  }
}

module.exports = { selfUpdate, latestVersion };
