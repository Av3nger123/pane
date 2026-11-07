import { useCallback, useEffect, useRef, useState } from 'react';

const ME = pane.window.id; // marks changes this window made
const SAVE_DELAY = 400;

// The app's menus. Clicks arrive as 'pane:menu' events in the window they
// were used in, so each window handles the items that make sense there.
pane.menu.set([
  {
    label: 'File',
    items: [
      { label: 'New Note', id: 'new', shortcut: 'CmdOrCtrl+N' },
      { label: 'Open in New Window', id: 'open-window', shortcut: 'CmdOrCtrl+Shift+O' },
      { type: 'separator' },
      { label: 'Export…', id: 'export', shortcut: 'CmdOrCtrl+E' },
      { label: 'Show Notes Folder', id: 'show-folder' },
      { type: 'separator' },
      { label: 'Delete Note', id: 'delete', shortcut: 'CmdOrCtrl+Backspace' },
    ],
  },
  { label: 'Edit', items: [{ label: 'Find Notes', id: 'find', shortcut: 'CmdOrCtrl+F' }] },
]);

// Runs `handlers[id]` for app menu clicks in this window.
function useMenu(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => pane.on('pane:menu', ({ id }) => ref.current[id]?.()), []);
}

const openNoteWindow = (id, title) =>
  pane.window.open(`index.html#note=${id}`, { key: `note-${id}`, width: 620, height: 640, title });

const showFolder = async () => pane.shell.showItemInFolder(await pane.call('folder'));

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
  const editor = useRef(null); // { flush, remove, exportNote, openAlone } of the open note

  const refresh = useCallback(async () => {
    const [list, last] = await Promise.all([pane.call('search', query), pane.store.get('lastNote')]);
    setNotes(list);
    setSelected((cur) => {
      const want = cur ?? last;
      return want && list.some((n) => n.id === want) ? want : list[0]?.id ?? null;
    });
  }, [query]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => pane.on('notes:changed', refresh), [refresh]);
  useEffect(() => { if (selected) pane.store.set('lastNote', selected); }, [selected]);

  // Links (pane-notes://new?text=..., pane-notes://open/<id>) and .md files
  // opened with Notes.
  useEffect(() => pane.onOpen(async (request) => {
    try {
      if (request.kind === 'file') {
        const note = await pane.call('importFile', request.path, ME);
        setQuery('');
        setSelected(note.id);
        return;
      }
      const url = new URL(request.url);
      const [action, id] = [url.hostname, url.pathname.replace(/^\//, '')];
      if (action === 'new') {
        const note = await pane.call('createWith', url.searchParams.get('text') || '', ME);
        setQuery('');
        setSelected(note.id);
      } else if (action === 'open' && /^[a-z0-9]+$/.test(id)) {
        setQuery('');
        setSelected(id);
      }
    } catch (err) {
      pane.dialog.message({ type: 'warning', message: 'Notes could not open that.', detail: err.message });
    }
  }), []);

  const create = useCallback(async () => {
    setQuery('');
    const note = await pane.call('create', ME);
    setSelected(note.id);
  }, []);

  useMenu({
    new: create,
    find: () => search.current?.focus(),
    'show-folder': showFolder,
    export: () => editor.current?.exportNote(),
    delete: () => editor.current?.remove(),
    'open-window': () => editor.current?.openAlone(),
  });

  async function contextMenu(e, note) {
    e.preventDefault();
    setSelected(note.id);
    const choice = await pane.menu.popup([
      { label: 'Open in New Window', id: 'open-window' },
      { label: 'Export…', id: 'export' },
      { type: 'separator' },
      { label: 'Delete', id: 'delete' },
    ]);
    if (choice === 'open-window') openNoteWindow(note.id, note.title);
    if (choice === 'export') exportNote(note.id, note.title);
    if (choice === 'delete') removeNote(note.id, note.title);
  }

  // Drop .md files on the window to import them as notes.
  const [dropping, setDropping] = useState(false);
  async function drop(e) {
    e.preventDefault();
    setDropping(false);
    for (const file of e.dataTransfer.files) {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) continue;
      const note = await pane.call('importFile', pane.pathForFile(file), ME);
      setQuery('');
      setSelected(note.id);
    }
  }

  return (
    <div
      className={dropping ? 'library dropping' : 'library'}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
      onDrop={drop}
    >
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
        <NoteList notes={notes} query={query} selected={selected} onSelect={setSelected} onCreate={create} onContextMenu={contextMenu} />
      </aside>
      <main className="editor-pane">
        {selected
          ? <Editor key={selected} id={selected} showOpen handle={editor} />
          : <div className="drag blank">{notes && !notes.length && !query ? '' : 'Select a note'}</div>}
      </main>
    </div>
  );
}

function NoteList({ notes, query, selected, onSelect, onCreate, onContextMenu }) {
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
            onContextMenu={(e) => onContextMenu(e, n)}
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
  const editor = useRef(null);
  useEffect(() => pane.on('notes:changed', ({ kind, id: changed }) => {
    if (kind === 'removed' && changed === id) setGone(true);
  }), [id]);

  useMenu({
    new: async () => {
      const note = await pane.call('create', ME);
      openNoteWindow(note.id, 'Untitled');
    },
    'show-folder': showFolder,
    export: () => editor.current?.exportNote(),
    delete: () => editor.current?.remove(),
  });

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
  return <div className="single"><Editor id={id} handle={editor} onTitle={(t) => pane.window.setTitle(t)} /></div>;
}

// ---- actions shared by menus, buttons and the context menu ---------------

async function exportNote(id, title) {
  const target = await pane.dialog.save({
    title: 'Export note',
    defaultPath: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Note'}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
  });
  if (target) await pane.call('export', id, target);
}

async function removeNote(id, title) {
  const ok = await pane.dialog.confirm(`Delete “${title}”?`, {
    detail: 'The note moves to the trash folder inside the notes folder.',
    okLabel: 'Delete',
    type: 'warning',
  });
  if (ok) await pane.call('remove', id, ME);
  return ok;
}

// ---- the editor (autosaves) ---------------------------------------------

function Editor({ id, showOpen = false, onTitle, handle }) {
  const [body, setBody] = useState(null);
  const [startEmpty, setStartEmpty] = useState(false); // new notes take the cursor
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(null); // text waiting to be saved
  const timer = useRef(null);

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
    await flush();
    const deleted = await removeNote(id, title);
    if (deleted && !showOpen) pane.window.close();
  }

  async function openAlone() {
    await flush();
    openNoteWindow(id, title);
  }

  async function exportThis() {
    await flush();
    await exportNote(id, title);
  }

  if (handle) handle.current = { flush, remove, openAlone, exportNote: exportThis };

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
