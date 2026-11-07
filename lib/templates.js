'use strict';
// Files written by `pane create`.

function appFiles({ id, name, backend }) {
  const manifest = {
    id,
    name,
    version: '0.1.0',
    pane: '>=0.1.0',
    ui: 'ui',
    start: 'index.html',
    ...(backend ? { backend: 'backend/main.js' } : {}),
    icon: 'icon.png',
    window: { width: 960, height: 640, titleBar: 'hidden', background: '#f6f6f3' },
    permissions: [],
  };

  const files = {
    'pane.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'ui/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'">
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
    <p id="answer" role="status"></p>
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
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
    'ui/style.css': `:root {
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
#answer { min-height: 1.5em; }
`,
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

  if (backend) {
    files['backend/main.js'] = `// Runs in its own process on the Node that comes with Pane.
// Full Node: fs, child_process, net, npm packages.
const pane = require('pane');

pane.expose('greet', (who) => {
  const name = String(who || '').trim() || 'there';
  return \`Hello, \${name}. This answer came from Node \${process.versions.node}.\`;
});

setInterval(() => pane.emit('tick', Date.now()), 1000);

console.log('backend started, data folder:', pane.app.dataDir);
`;
  }
  return files;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { appFiles };
