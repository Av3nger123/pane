#!/usr/bin/env node
'use strict';
// npm create pane-app@latest my-app
// npm create pane-app@latest my-app -- --template svelte
// Asks for anything missing, then runs `pane create`.

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');

const TEMPLATES = ['react', 'svelte', 'vanilla'];

function paneCli() {
  try {
    return path.join(path.dirname(require.resolve('pane-runtime/package.json')), 'bin', 'pane.js');
  } catch {
    // Running from a checkout of the Pane repo.
    const repo = path.resolve(__dirname, '..', '..');
    const pkg = path.join(repo, 'package.json');
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'pane-runtime') return path.join(repo, 'bin', 'pane.js');
    throw new Error('Could not find Pane (the pane-runtime package).');
  }
}

async function main() {
  const args = process.argv.slice(2);
  let folder = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--template' && args[args.indexOf(a) - 1] !== '--name');
  const hasTemplate = args.some((a) => a === '--template' || a.startsWith('--template='));
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const extra = args.filter((a) => a !== folder);

  if (interactive && (!folder || !hasTemplate)) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!folder) folder = (await rl.question('Project folder (my-app): ')).trim() || 'my-app';
      if (!hasTemplate) {
        const answer = (await rl.question(`Template (${TEMPLATES.join(', ')}) [react]: `)).trim().toLowerCase() || 'react';
        if (!TEMPLATES.includes(answer)) throw new Error(`Unknown template "${answer}".`);
        extra.push('--template', answer);
      }
    } finally {
      rl.close();
    }
  }
  if (!folder) {
    console.error('Usage: npm create pane-app@latest <folder> [-- --template react|svelte|vanilla]');
    return 1;
  }
  if (!hasTemplate && !extra.includes('--template')) extra.push('--template', 'react');
  const res = spawnSync(process.execPath, [paneCli(), 'create', folder, ...extra], { stdio: 'inherit' });
  return res.status === null ? 1 : res.status;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 1; });
