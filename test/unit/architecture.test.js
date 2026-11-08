'use strict';
// Keeps the code layout honest. Run: npm test
//
//   src/core       no Electron; never loads runtime, cli or packaging
//   src/runtime    Electron, one app per process; never loads cli or packaging
//   src/cli        the pane command; no Electron runtime APIs
//   src/packaging  installing and building; no Electron runtime APIs
//                  (except launchers/win-helper.js, which runs inside Electron on purpose)
//   sdk/backend    the `pane` module for app backends; loads nothing from src

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsFiles(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// Every module a file loads with require(), resolved to a repo path or a package name.
function requiresOf(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => {
    const spec = m[1];
    if (!spec.startsWith('.')) return spec;
    return path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), spec)).split(path.sep).join('/');
  });
}

const layer = (target) => {
  for (const name of ['src/core', 'src/runtime', 'src/cli', 'src/packaging', 'sdk']) {
    if (target === name || target.startsWith(`${name}/`)) return name;
  }
  return null;
};

const RULES = {
  'src/core': { forbid: ['src/runtime', 'src/cli', 'src/packaging', 'sdk'], electron: false },
  'src/runtime': { forbid: ['src/cli', 'src/packaging'], electron: true },
  'src/cli': { forbid: ['src/runtime'], electron: false },
  'src/packaging': { forbid: ['src/runtime', 'src/cli'], electron: false },
  sdk: { forbid: ['src/core', 'src/runtime', 'src/cli', 'src/packaging'], electron: false },
};
const RUNS_IN_ELECTRON = new Set(['src/packaging/launchers/win-helper.js']);

test('each layer only loads what it may', () => {
  const problems = [];
  for (const [dir, rule] of Object.entries(RULES)) {
    for (const file of jsFiles(dir)) {
      for (const target of requiresOf(file)) {
        if (target === 'electron' && !rule.electron && !RUNS_IN_ELECTRON.has(file)) problems.push(`${file} loads electron`);
        const to = layer(target);
        if (to && rule.forbid.includes(to)) problems.push(`${file} loads ${target}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('pages and the runtime use the same message names', () => {
  const { CHANNELS, EVENTS } = require('../../src/runtime/ipc/channels');
  const known = new Set([...Object.values(CHANNELS), ...Object.values(EVENTS)]);
  const preload = fs.readFileSync(path.join(ROOT, 'src/runtime/preload.js'), 'utf8');
  const used = new Set([...preload.matchAll(/'(pane:[a-z-]+)'/g)].map((m) => m[1]));
  for (const name of used) assert.ok(known.has(name), `preload.js uses "${name}", which is not in ipc/channels.js`);
  for (const name of Object.values(CHANNELS)) assert.ok(used.has(name), `ipc/channels.js has "${name}", which preload.js never uses`);
});

test('runtime code uses the shared message names, not strings', () => {
  const offenders = jsFiles('src/runtime')
    .filter((f) => !f.endsWith('ipc/channels.js') && !f.endsWith('/preload.js'))
    .filter((f) => /['"]pane:[a-z-]+['"]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('entry points stay one line', () => {
  for (const file of ['main.js', 'bin/pane.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//') && !l.startsWith('#!') && l.trim() !== "'use strict';");
    assert.equal(code.length, 1, `${file} should only load src/`);
  }
});
