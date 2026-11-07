// The Notes backend: stores notes as Markdown files in the app's data folder
// and tells every window when something changes.
import path from 'node:path';
import pane from 'pane';
import { createStore } from './store.js';

const store = createStore(path.join(pane.app.dataDir, 'notes'));

// `from` is the window that made the change, so it can ignore its own echo.
const changed = (kind, id, from) => pane.emit('notes:changed', { kind, id, from });

pane.expose({
  list: () => store.list(),
  search: (query) => store.search(query),
  get: (id) => store.get(id),
  async create(from) {
    const note = await store.create('');
    changed('created', note.id, from);
    return note;
  },
  async save(id, body, from) {
    const note = await store.save(id, body);
    changed('saved', id, from);
    return note;
  },
  async remove(id, from) {
    await store.remove(id);
    changed('removed', id, from);
    return true;
  },
});

console.log(`notes are in ${path.join(pane.app.dataDir, 'notes')}`);
