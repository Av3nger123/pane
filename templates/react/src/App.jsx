import { useEffect, useState } from 'react';

// One page, two views. A second window opens on "#about".
export default function App() {
  return location.hash === '#about' ? <About /> : <Home />;
}

function Home() {
{{#backend}}  const [answer, setAnswer] = useState('');
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

{{/backend}}  return (
    <>
      <header className="titlebar"><span>{{name.jsx}}</span></header>
      <main>
        <h1>{{name.jsx}}</h1>
        <p className="muted">React, served by Vite while you develop. Save a file and it updates in place.</p>
{{#backend}}        <form onSubmit={greet}>
          <input name="who" placeholder="Your name" autoComplete="off" aria-label="Your name" />
          <button>Ask the backend</button>
        </form>
        <p className="answer" role="status">{answer}</p>
        <p className="muted">Backend clock: {clock}</p>
{{/backend}}        <button type="button" className="quiet" onClick={() => pane.window.open('index.html#about', { width: 440, height: 320 })}>
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
