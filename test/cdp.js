'use strict';
// Helpers for driving real Pane windows over the Chrome DevTools protocol.
// Start the app with --remote-debugging-port=<port> (after `--` for the CLI).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      if (await check()) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${lastError ? ` (${lastError.message})` : ''}`);
    await sleep(150);
  }
}

// The first page target that matches.
async function waitForPage(port, match, what = 'the window', timeout = 60000) {
  let found = null;
  await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    found = list.find((t) => t.type === 'page' && match(t));
    return Boolean(found);
  }, what, timeout);
  return found;
}

// Returns { send(method, params), run(expression), close() }.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    const timer = setTimeout(() => { ws.close(); reject(new Error('timed out connecting to the window')); }, 10000);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('could not connect to the window')); };
    ws.onopen = () => {
      clearTimeout(timer);
      const send = (method, params) => new Promise((res, rej) => {
        const n = ++id;
        const t = setTimeout(() => { waiting.delete(n); rej(new Error(`${method} timed out`)); }, 30000);
        waiting.set(n, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
      const run = async (expression) => {
        const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) {
          const d = res.exceptionDetails;
          throw new Error(`${expression}\n${(d.exception && d.exception.description) || d.text}`);
        }
        return res.result.value;
      };
      resolve({ send, run, close: () => ws.close() });
    };
  });
}

const randomPort = () => 9300 + Math.floor(Math.random() * 600);

module.exports = { sleep, waitFor, waitForPage, connect, randomPort };
