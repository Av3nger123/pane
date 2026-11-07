'use strict';
// Files written by `pane create`.
//   vanilla  plain HTML/CSS/JS, no build step, no npm install
//   react    Vite + React
//   svelte   Vite + Svelte

const TEMPLATES = ['vanilla', 'react', 'svelte'];

// Versions current when this Pane release was made.
const VERSIONS = {
  vite: '^8.3.6',
  '@vitejs/plugin-react': '^6.2.1',
  react: '^19.3.1',
  'react-dom': '^19.3.1',
  svelte: '^5.57.3',
  '@sveltejs/vite-plugin-svelte': '^7.3.1',
};

// { id, name, template, backend, paneDependency: { name, spec } }
function appFiles({ id, name, template = 'vanilla', backend = true, paneDependency }) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}". Choose: ${TEMPLATES.join(', ')}.`);
  const files = template === 'vanilla'
    ? vanilla({ id, name, backend })
    : framework({ id, name, template, backend, paneDependency });
  if (backend) files['backend/main.js'] = backendFile(template !== 'vanilla');
  return files;
}

function manifest({ id, name, backend, extra = {} }) {
  return `${JSON.stringify({
    id,
    name,
    version: '0.1.0',
    pane: '>=0.1.0',
    ...extra.ui,
    ...(backend ? { backend: 'backend/main.js' } : {}),
    icon: 'icon.png',
    window: { width: 960, height: 640, titleBar: 'hidden', background: { light: '#f6f6f3', dark: '#17181a' } },
    permissions: [],
    ...extra.commands,
  }, null, 2)}\n`;
}

function backendFile(esm) {
  return `// Runs in its own process on the Node that comes with Pane.
// Full Node: fs, child_process, network, npm packages.
${esm ? "import pane from 'pane';" : "const pane = require('pane');"}

pane.expose('greet', (who) => {
  const name = String(who || '').trim() || 'there';
  return \`Hello, \${name}. This answer came from Node \${process.versions.node}.\`;
});

setInterval(() => pane.emit('tick', Date.now()), 1000);

console.log('backend started, data folder:', pane.app.dataDir);
`;
}

const STYLE = `:root {
  color-scheme: light dark;
  --bg: #f6f6f3;
  --text: #1b1d20;
  --muted: #61666d;
  --line: #d9dad5;
  --accent: #2557d6;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #17181a; --text: #ececea; --muted: #a2a5a9; --line: #34363a; --accent: #7aa2ff; }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }

/* With "titleBar": "hidden" the window controls float over the page.
   Pane tells you how much room they need. Drag the window by this bar. */
.titlebar {
  height: var(--pane-safe-top, 0px);
  padding: 0 calc(var(--pane-safe-right, 0px) + 16px) 0 calc(var(--pane-safe-left, 0px) + 4px);
  display: flex; align-items: center;
  font-size: 13px; font-weight: 600; color: var(--muted);
  -webkit-app-region: drag; user-select: none;
  overflow: hidden;
}
html:not([data-pane-title-bar="hidden"]) .titlebar { display: none; }

main { max-width: 560px; padding: 24px 32px 40px; }
h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.01em; }
.muted { color: var(--muted); }
form { display: flex; gap: 8px; margin: 24px 0 8px; }
input { flex: 1; min-width: 0; font: inherit; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
button { font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; cursor: pointer; }
button.quiet { background: transparent; color: var(--accent); padding-left: 0; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.answer { min-height: 1.5em; }
`;

// ---- vanilla -------------------------------------------------------------

function vanilla({ id, name, backend }) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'">`;
  return {
    'pane.json': manifest({ id, name, backend, extra: { ui: { ui: 'ui', start: 'index.html' } } }),
    'ui/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${csp}
  <title>${escapeHtml(name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="titlebar"><span>${escapeHtml(name)}</span></header>
  <main>
    <h1>${escapeHtml(name)}</h1>
    <p class="muted">This window is plain HTML, CSS and JavaScript.${backend ? ' Its backend is Node, running on the Node that comes with Pane.' : ''}</p>
${backend ? `
    <form id="greet">
      <input name="who" placeholder="Your name" autocomplete="off" aria-label="Your name">
      <button>Ask the backend</button>
    </form>
    <p id="answer" class="answer" role="status"></p>
    <p class="muted">Backend clock: <span id="clock">waiting</span></p>
` : ''}
    <button id="open" type="button" class="quiet">Open another window</button>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
    'ui/about.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${csp}
  <title>About ${escapeHtml(name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="titlebar"><span>About</span></header>
  <main>
    <h1>A second window</h1>
    <p class="muted">Same app, same process, as many windows as you need.</p>
    <button id="close" type="button" class="quiet">Close</button>
  </main>
  <script src="about.js"></script>
</body>
</html>
`,
    'ui/about.js': `document.getElementById('close').addEventListener('click', () => pane.window.close());
`,
    'ui/style.css': STYLE,
    'ui/app.js': `// window.pane is how this page talks to Pane and to the backend.
${backend ? `const form = document.getElementById('greet');
const answer = document.getElementById('answer');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    answer.textContent = await pane.call('greet', form.who.value);
  } catch (err) {
    answer.textContent = err.message;
  }
});

pane.on('tick', (time) => {
  document.getElementById('clock').textContent = new Date(time).toLocaleTimeString();
});

` : ''}document.getElementById('open').addEventListener('click', () => {
  pane.window.open('about.html', { width: 440, height: 320 });
});
`,
  };
}

// ---- react / svelte (Vite) -----------------------------------------------

function framework({ id, name, template, backend, paneDependency }) {
  const react = template === 'react';
  const devDependencies = {
    [paneDependency.name]: paneDependency.spec,
    vite: VERSIONS.vite,
    ...(react
      ? { '@vitejs/plugin-react': VERSIONS['@vitejs/plugin-react'], react: VERSIONS.react, 'react-dom': VERSIONS['react-dom'] }
      : { svelte: VERSIONS.svelte, '@sveltejs/vite-plugin-svelte': VERSIONS['@sveltejs/vite-plugin-svelte'] }),
  };
  const files = {
    'pane.json': manifest({
      id, name, backend,
      extra: {
        ui: { ui: 'dist', start: 'index.html' },
        commands: {
          dev: { command: 'vite --port {port} --strictPort', url: 'http://localhost:{port}' },
          build: { command: 'vite build' },
        },
      },
    }),
    'package.json': `${JSON.stringify({
      name: id,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'pane dev', build: 'pane build', start: 'pane run' },
      // Build tools and frontend libraries are devDependencies: Vite bundles
      // them. Put packages the backend needs at runtime in "dependencies".
      dependencies: {},
      devDependencies,
    }, null, 2)}\n`,
    'jsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        ...(react ? { jsx: 'react-jsx' } : {}),
        types: [paneDependency.name, 'vite/client'],
        checkJs: false,
        skipLibCheck: true,
      },
      include: ['src', 'backend'],
    }, null, 2)}\n`,
    '.gitignore': 'node_modules/\ndist/\nrelease/\n',
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(name)}</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.${react ? 'jsx' : 'js'}"></script>
</body>
</html>
`,
    'vite.config.js': react
      ? `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' keeps asset paths relative, so the build works from Pane.
export default defineConfig({ plugins: [react()], base: './' });
`
      : `import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// base: './' keeps asset paths relative, so the build works from Pane.
export default defineConfig({ plugins: [svelte()], base: './' });
`,
    'src/style.css': STYLE,
  };

  if (react) {
    files['src/main.jsx'] = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';

createRoot(document.getElementById('app')).render(<StrictMode><App /></StrictMode>);
`;
    files['src/App.jsx'] = `import { useEffect, useState } from 'react';

// One page, two views. A second window opens on "#about".
export default function App() {
  return location.hash === '#about' ? <About /> : <Home />;
}

function Home() {
${backend ? `  const [answer, setAnswer] = useState('');
  const [clock, setClock] = useState('waiting');

  useEffect(() => pane.on('tick', (time) => setClock(new Date(time).toLocaleTimeString())), []);

  async function greet(event) {
    event.preventDefault();
    const who = new FormData(event.currentTarget).get('who');
    try {
      setAnswer(await pane.call('greet', who));
    } catch (err) {
      setAnswer(err.message);
    }
  }

` : ''}  return (
    <>
      <header className="titlebar"><span>${escapeJsx(name)}</span></header>
      <main>
        <h1>${escapeJsx(name)}</h1>
        <p className="muted">React, served by Vite while you develop. Save a file and it updates in place.</p>
${backend ? `        <form onSubmit={greet}>
          <input name="who" placeholder="Your name" autoComplete="off" aria-label="Your name" />
          <button>Ask the backend</button>
        </form>
        <p className="answer" role="status">{answer}</p>
        <p className="muted">Backend clock: {clock}</p>
` : ''}        <button type="button" className="quiet" onClick={() => pane.window.open('index.html#about', { width: 440, height: 320 })}>
          Open another window
        </button>
      </main>
    </>
  );
}

function About() {
  return (
    <>
      <header className="titlebar"><span>About</span></header>
      <main>
        <h1>A second window</h1>
        <p className="muted">Same app, same process, as many windows as you need.</p>
        <button type="button" className="quiet" onClick={() => pane.window.close()}>Close</button>
      </main>
    </>
  );
}
`;
  } else {
    files['src/main.js'] = `import { mount } from 'svelte';
import App from './App.svelte';
import './style.css';

mount(App, { target: document.getElementById('app') });
`;
    files['src/App.svelte'] = `<script>
  // One page, two views. A second window opens on "#about".
  const about = location.hash === '#about';
${backend ? `  let answer = $state('');
  let clock = $state('waiting');

  $effect(() => pane.on('tick', (time) => { clock = new Date(time).toLocaleTimeString(); }));

  async function greet(event) {
    event.preventDefault();
    const who = new FormData(event.currentTarget).get('who');
    try {
      answer = await pane.call('greet', who);
    } catch (err) {
      answer = err.message;
    }
  }
` : ''}</script>

{#if about}
  <header class="titlebar"><span>About</span></header>
  <main>
    <h1>A second window</h1>
    <p class="muted">Same app, same process, as many windows as you need.</p>
    <button type="button" class="quiet" onclick={() => pane.window.close()}>Close</button>
  </main>
{:else}
  <header class="titlebar"><span>${escapeJsx(name)}</span></header>
  <main>
    <h1>${escapeJsx(name)}</h1>
    <p class="muted">Svelte, served by Vite while you develop. Save a file and it updates in place.</p>
${backend ? `    <form onsubmit={greet}>
      <input name="who" placeholder="Your name" autocomplete="off" aria-label="Your name" />
      <button>Ask the backend</button>
    </form>
    <p class="answer" role="status">{answer}</p>
    <p class="muted">Backend clock: {clock}</p>
` : ''}    <button type="button" class="quiet" onclick={() => pane.window.open('index.html#about', { width: 440, height: 320 })}>
      Open another window
    </button>
  </main>
{/if}
`;
  }
  return files;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Text inside JSX or Svelte markup: also escape braces.
function escapeJsx(s) {
  return escapeHtml(s).replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));
}

module.exports = { appFiles, TEMPLATES, VERSIONS };
