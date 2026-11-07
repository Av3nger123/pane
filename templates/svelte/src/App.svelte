<script>
  // One page, two views. A second window opens on "#about".
  const about = location.hash === '#about';
{{#backend}}  let answer = $state('');
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
{{/backend}}</script>

{#if about}
  <header class="titlebar"><span>About</span></header>
  <main>
    <h1>A second window</h1>
    <p class="muted">Same app, same process, as many windows as you need.</p>
    <button type="button" class="quiet" onclick={() => pane.window.close()}>Close</button>
  </main>
{:else}
  <header class="titlebar"><span>{{name.jsx}}</span></header>
  <main>
    <h1>{{name.jsx}}</h1>
    <p class="muted">Svelte, served by Vite while you develop. Save a file and it updates in place.</p>
{{#backend}}    <form onsubmit={greet}>
      <input name="who" placeholder="Your name" autocomplete="off" aria-label="Your name" />
      <button>Ask the backend</button>
    </form>
    <p class="answer" role="status">{answer}</p>
    <p class="muted">Backend clock: {clock}</p>
{{/backend}}    <button type="button" class="quiet" onclick={() => pane.window.open('index.html#about', { width: 440, height: 320 })}>
      Open another window
    </button>
  </main>
{/if}
