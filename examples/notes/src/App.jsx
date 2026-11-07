import { useCallback, useEffect, useRef, useState } from 'react';

const ME = pane.window.id; // marks changes this window made
const SAVE_DELAY = 400;
const mod = (e) => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey);

export default function App() {
  const single = /^#note=([a-z0-9]+)$/.exec(location.hash);
  return single ? <NoteWindow id={single[1]} /> : <Library />;
}

// ---- the main window: list + editor -------------------------------------

function Library() {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState(null);
  const [selected, setSelected] = useState(null);
  const search = useRef(null);

  const refresh = useCallback(async () => {
    const list = await pane.call('search', query);
    setNotes(list);
    setSelected((cur) => (cur && list.some((n) => n.id === cur) ? cur : list[0]?.id ?? null));
  }, [query]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => pane.on('notes:changed', refresh), [refresh]);

  const create = useCallback(async () => {
    setQuery('');
    const note = await pane.call('create', ME);
    setSelected(note.id);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (mod(e) && e.key === 'n') { e.preventDefault(); create(); }
      if (mod(e) && e.key === 'f') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [create]);

  return (
    <div className="library">
      <aside className="sidebar">
        <div className="drag sidebar-top" />
        <div className="sidebar-tools">
          <input
            ref={search}
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="new" onClick={create} title="New note (⌘N)" aria-label="New note">+</button>
        </div>
        <NoteList notes={notes} query={query} selected={selected} onSelect={setSelected} onCreate={create} />
      </aside>
      <main className="editor-pane">
        {selected
          ? <Editor key={selected} id={selected} showOpen />
          : <div className="drag blank">{notes && !notes.length && !query ? '' : 'Select a note'}</div>}
      </main>
    </div>
  );
}

function NoteList({ notes, query, selected, onSelect, onCreate }) {
  if (!notes) return <div className="list-empty" />;
  if (!notes.length) {
    return query
      ? <p className="list-empty">No notes contain “{query}”.</p>
      : (
        <div className="list-empty">
          <p>No notes yet.</p>
          <button type="button" className="link" onClick={onCreate}>Write your first note</button>
        </div>
      );
  }
  return (
    <ul className="list" role="listbox" aria-label="Notes">
      {notes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            role="option"
            aria-selected={n.id === selected}
            className={n.id === selected ? 'item selected' : 'item'}
            onClick={() => onSelect(n.id)}
          >
            <span className="item-title">{n.title}</span>
            <span className="item-meta">
              <time>{ago(n.updated)}</time>
              {n.snippet && <span className="item-snippet">{n.snippet}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---- a note in its own window -------------------------------------------

function NoteWindow({ id }) {
  const [gone, setGone] = useState(false);
  useEffect(() => pane.on('notes:changed', ({ kind, id: changed }) => {
    if (kind === 'removed' && changed === id) setGone(true);
  }), [id]);
  if (gone) {
    return (
      <div className="drag blank">
        <div className="no-drag">
          <p>This note was deleted.</p>
          <button type="button" className="link" onClick={() => pane.window.close()}>Close window</button>
        </div>
      </div>
    );
  }
  return <div className="single"><Editor id={id} onTitle={(t) => pane.window.setTitle(t)} /></div>;
}

// ---- the editor (autosaves) ---------------------------------------------

function Editor({ id, showOpen = false, onTitle }) {
  const [body, setBody] = useState(null);
  const [startEmpty, setStartEmpty] = useState(false); // new notes take the cursor
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(null); // text waiting to be saved
  const timer = useRef(null);
  const area = useRef(null);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const text = pending.current;
    if (text === null) return;
    pending.current = null;
    setStatus('Saving…');
    try {
      await pane.call('save', id, text, ME);
      setStatus(pending.current === null ? 'Saved' : 'Edited');
      setError('');
    } catch (err) {
      pending.current = pending.current ?? text; // keep it, try again on the next edit
      setStatus('Not saved');
      setError(err.message);
    }
  }, [id]);

  // Load, and save anything pending when switching away.
  useEffect(() => {
    let live = true;
    pane.call('get', id).then((note) => {
      if (!live) return;
      setStartEmpty(!note.body);
      setBody(note.body);
      setStatus('');
    }, (err) => live && setError(err.message));
    return () => { live = false; flush(); };
  }, [id, flush]);

  // Another window saved this note: take its text unless we have unsaved edits.
  useEffect(() => pane.on('notes:changed', async ({ kind, id: changed, from }) => {
    if (changed !== id || from === ME || kind !== 'saved' || pending.current !== null) return;
    const note = await pane.call('get', id);
    setBody(note.body);
  }), [id]);

  useEffect(() => {
    const save = () => { flush(); };
    window.addEventListener('beforeunload', save);
    return () => window.removeEventListener('beforeunload', save);
  }, [flush]);

  const title = body === null ? '' : titleOf(body);
  useEffect(() => { if (onTitle && body !== null) onTitle(title); }, [title, onTitle, body]);

  function edit(e) {
    setBody(e.target.value);
    pending.current = e.target.value;
    setStatus('Edited');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY);
  }

  async function remove() {
    if (!confirm(`Delete “${title}”? It moves to the trash folder.`)) return;
    pending.current = null;
    clearTimeout(timer.current);
    await pane.call('remove', id, ME);
    if (!showOpen) pane.window.close();
  }

  async function openAlone() {
    await flush();
    pane.window.open(`index.html#note=${id}`, { width: 620, height: 640, title });
  }

  return (
    <div className="editor">
      <header className="drag editor-top">
        <span className="status" role="status">{error ? `${status}: ${error}` : status}</span>
        <div className="no-drag actions">
          {showOpen && <button type="button" className="quiet" onClick={openAlone}>Open in new window</button>}
          <button type="button" className="quiet danger" onClick={remove}>Delete</button>
        </div>
      </header>
      {body === null
        ? <div className="loading" />
        : (
          <textarea
            ref={area}
            autoFocus={startEmpty}
            value={body}
            onChange={edit}
            onBlur={flush}
            placeholder="Start with a title on the first line…"
            aria-label={title || 'Note'}
            spellCheck
          />
        )}
    </div>
  );
}

function titleOf(body) {
  const line = body.split('\n').find((l) => l.trim()) || '';
  return line.replace(/^\s*#{1,6}\s*/, '').trim() || 'Untitled';
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
