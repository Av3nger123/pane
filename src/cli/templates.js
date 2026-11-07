'use strict';
// Files written by `pane create`, from the folders in templates/:
//   vanilla  plain HTML/CSS/JS, no build step, no npm install
//   react    Vite + React
//   svelte   Vite + Svelte
//   _shared  style.css and backend/main.js, used by all three
//
// Template files are real files with a few placeholders:
//   {{name.html}}  the app name, escaped for HTML
//   {{name.jsx}}   the app name, escaped for JSX and Svelte markup
//   {{paneName}}   Pane's package name (for TypeScript types)
//   {{#backend}}...{{/backend}}   only when the app has a backend
//   {{^esm}}...{{/esm}}           only when the backend is CommonJS
// pane.json and package.json are generated here, since they are data.
// A file named _gitignore is written as .gitignore (npm drops .gitignore files).

const fs = require('fs');
const path = require('path');
const { RUNTIME_ROOT } = require('../core/paths');

const TEMPLATES = ['vanilla', 'react', 'svelte'];
const TEMPLATES_DIR = path.join(RUNTIME_ROOT, 'templates');

// Versions current when this Pane release was made.
const VERSIONS = {
  vite: '^8.3.6',
  '@vitejs/plugin-react': '^6.2.1',
  react: '^19.3.1',
  'react-dom': '^19.3.1',
  svelte: '^5.57.3',
  '@sveltejs/vite-plugin-svelte': '^7.3.1',
};

// { id, name, template, backend, paneDependency: { name, spec } } -> { relPath: content }
function appFiles({ id, name, template = 'vanilla', backend = true, paneDependency = { name: 'pane-runtime', spec: '*' } }) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}". Choose: ${TEMPLATES.join(', ')}.`);
  const framework = template !== 'vanilla';
  const vars = {
    backend,
    esm: framework,
    'name.html': escapeHtml(name),
    'name.jsx': escapeJsx(name),
    paneName: paneDependency.name,
  };

  const files = {};
  for (const rel of listFiles(path.join(TEMPLATES_DIR, template))) {
    const out = rel.replace(/(^|\/)_gitignore$/, '$1.gitignore');
    files[out] = render(fs.readFileSync(path.join(TEMPLATES_DIR, template, rel), 'utf8'), vars);
  }
  const shared = (rel) => render(fs.readFileSync(path.join(TEMPLATES_DIR, '_shared', rel), 'utf8'), vars);
  files[framework ? 'src/style.css' : 'ui/style.css'] = shared('style.css');
  if (backend) files['backend/main.js'] = shared('backend/main.js');

  files['pane.json'] = manifest({ id, name, backend, framework });
  if (framework) files['package.json'] = packageJson({ id, template, paneDependency });
  return sortKeys(files);
}

function manifest({ id, name, backend, framework }) {
  return `${JSON.stringify({
    id,
    name,
    version: '0.1.0',
    pane: '>=0.1.0',
    ui: framework ? 'dist' : 'ui',
    start: 'index.html',
    ...(backend ? { backend: 'backend/main.js' } : {}),
    icon: 'icon.png',
    window: { width: 960, height: 640, titleBar: 'hidden', background: { light: '#f6f6f3', dark: '#17181a' } },
    permissions: [],
    ...(framework ? {
      dev: { command: 'vite --port {port} --strictPort', url: 'http://localhost:{port}' },
      build: { command: 'vite build' },
    } : {}),
  }, null, 2)}\n`;
}

function packageJson({ id, template, paneDependency }) {
  const devDependencies = {
    [paneDependency.name]: paneDependency.spec,
    vite: VERSIONS.vite,
    ...(template === 'react'
      ? { '@vitejs/plugin-react': VERSIONS['@vitejs/plugin-react'], react: VERSIONS.react, 'react-dom': VERSIONS['react-dom'] }
      : { svelte: VERSIONS.svelte, '@sveltejs/vite-plugin-svelte': VERSIONS['@sveltejs/vite-plugin-svelte'] }),
  };
  return `${JSON.stringify({
    name: id,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: { dev: 'pane dev', build: 'pane build', start: 'pane run' },
    // Build tools and frontend libraries are devDependencies: Vite bundles
    // them. Packages the backend needs at runtime go in "dependencies".
    dependencies: {},
    devDependencies,
  }, null, 2)}\n`;
}

// {{#flag}}...{{/flag}} keeps the inside when flag is true, {{^flag}} when it
// is false; {{key}} is replaced by vars[key].
function render(text, vars) {
  const sections = text.replace(/\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_m, kind, key, inside) => ((kind === '#') === Boolean(vars[key]) ? inside : ''));
  return sections.replace(/\{\{([\w.]+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

function listFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.name !== '.DS_Store') out.push(rel);
  }
  return out;
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Text inside JSX or Svelte markup: also escape braces.
function escapeJsx(s) {
  return escapeHtml(s).replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));
}

module.exports = { appFiles, render, TEMPLATES, VERSIONS };
