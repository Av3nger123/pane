// Runs with plain Node: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, titleOf, snippetOf } from '../backend/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));

test('create, save, list newest first, get', async () => {
  const store = createStore(tmp());
  const a = await store.create('# Groceries\nmilk, eggs');
  await new Promise((r) => setTimeout(r, 15));
  const b = await store.create('');
  await store.save(b.id, 'Trip plan\n- book train');
  const list = await store.list();
  assert.deepEqual(list.map((n) => n.title), ['Trip plan', 'Groceries']);
  assert.equal(list[1].snippet, 'milk, eggs');
  assert.equal((await store.get(a.id)).body, '# Groceries\nmilk, eggs');
});

test('search looks at the full text, ignoring case', async () => {
  const store = createStore(tmp());
  await store.create('Ideas\nA REMOTE cabin');
  await store.create('Shopping\nbread');
  assert.deepEqual((await store.search('remote')).map((n) => n.title), ['Ideas']);
  assert.equal((await store.search('')).length, 2);
  assert.equal((await store.search('nothing like this')).length, 0);
});

test('remove moves the note to .trash', async () => {
  const dir = tmp();
  const store = createStore(dir);
  const n = await store.create('Old');
  await store.remove(n.id);
  assert.equal((await store.list()).length, 0);
  assert.ok(fs.existsSync(path.join(dir, '.trash', `${n.id}.md`)));
});

test('ids cannot reach outside the notes folder', async () => {
  const store = createStore(tmp());
  for (const bad of ['../../etc/passwd', 'a/b', '', 'ABC123', null]) {
    await assert.rejects(store.get(bad), /not a note id/);
    await assert.rejects(store.save(bad, 'x'), /not a note id/);
  }
});

test('titles and snippets', () => {
  assert.equal(titleOf('\n\n## Weekly review  \nbody'), 'Weekly review');
  assert.equal(titleOf('   '), 'Untitled');
  assert.equal(snippetOf('Title\n- **one**\n- two'), 'one two');
});
