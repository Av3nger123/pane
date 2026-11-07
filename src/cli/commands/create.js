'use strict';
// pane create <folder> [--template react|svelte|vanilla]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RUNTIME_ROOT, RUNTIME_VERSION } = require('../../core/paths');
const { loadManifest } = require('../../core/manifest');
const { defaultIconPng } = require('../../core/icon');
const { projectEnv } = require('../../core/run');
const { appFiles, TEMPLATES } = require('../templates');
const { UsageError } = require('../util');

const PACKAGE_NAME = require('../../../package.json').name;

function create(folder, flags) {
  if (!folder) throw new UsageError(`pane create <folder> [--template ${TEMPLATES.join('|')}]`);
  const template = typeof flags.template === 'string' ? flags.template : 'vanilla';
  if (!TEMPLATES.includes(template)) throw new UsageError(`--template must be one of: ${TEMPLATES.join(', ')}`);
  const dir = path.resolve(folder);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new UsageError(`${dir} already exists and is not empty.`);

  const base = path.basename(dir);
  const name = typeof flags.name === 'string' && flags.name.trim()
    ? flags.name.trim()
    : base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const id = (typeof flags.name === 'string' ? flags.name : base)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'my-app';

  const files = appFiles({ id, name, template, backend: !flags['no-backend'], paneDependency: paneDependency() });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), defaultIconPng());
  loadManifest(dir, { requireUi: template === 'vanilla' }); // templates must always be valid

  const shown = path.relative(process.cwd(), dir) || '.';
  const usesNpm = template !== 'vanilla';
  if (usesNpm && !flags['no-install']) {
    console.log(`Installing ${template} and Vite with npm...`);
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: dir, env: projectEnv(dir), stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (res.status !== 0) {
      console.error(`\nnpm install failed. Fix the problem, then run "npm install" in ${shown}.`);
      return 1;
    }
  }
  console.log(`\nCreated ${name} (${template}) in ${shown}\n\nNext:\n  ${usesNpm ? `cd ${shown}\n  npm run dev` : `pane dev ${shown}`}`);
  return 0;
}

// Framework templates add Pane as a devDependency, for `npm run dev` and the
// TypeScript types. From a git checkout of Pane, link to it; otherwise use
// this version's package from Pane's GitHub release.

// Framework templates add Pane as a devDependency, for `npm run dev` and the
// TypeScript types. From a git checkout of Pane, link to it; otherwise use
// this version's package from Pane's GitHub release.
function paneDependency() {
  if (fs.existsSync(path.join(RUNTIME_ROOT, '.git'))) return { name: PACKAGE_NAME, spec: `file:${RUNTIME_ROOT}` };
  const repo = require('../../package.json').repository.url.replace(/\.git$/, '');
  return { name: PACKAGE_NAME, spec: `${repo}/releases/download/v${RUNTIME_VERSION}/${PACKAGE_NAME}-${RUNTIME_VERSION}.tgz` };
}

module.exports = { create };
