// The Notes backend: stores notes as Markdown files in the app's data folder
// and tells every window when something changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import pane from 'pane';
import { createStore } from './store.js';

const notesDir = path.join(pane.app.dataDir, 'notes');
const store = createStore(notesDir);

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
  folder: () => notesDir,
  // Writes a copy of a note to a path the user picked in a save dialog.
  async export(id, target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Choose where to save the note.');
    const { body } = await store.get(id);
    await fs.writeFile(target, body);
    return target;
  },
  async remove(id, from) {
    await store.remove(id);
    changed('removed', id, from);
    return true;
  },
});

console.log(`notes are in ${notesDir}`);
