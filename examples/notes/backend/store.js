// Notes are plain Markdown files in a folder: <id>.md. Deleted notes move to
// .trash/ instead of disappearing. No Pane imports here, so this file can be
// tested with plain Node.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[a-z0-9]{6,40}$/;

export function createStore(dir) {
  const trash = path.join(dir, '.trash');
  const file = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('That is not a note id.');
    return path.join(dir, `${id}.md`);
  };

  async function ready() {
    await fs.mkdir(trash, { recursive: true });
  }

  async function summary(id) {
    const f = file(id);
    const [body, stat] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
    return { id, title: titleOf(body), snippet: snippetOf(body), updated: stat.mtimeMs, size: body.length };
  }

  return {
    async list() {
      await ready();
      const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
      const notes = await Promise.all(names.map((n) => summary(n.slice(0, -3)).catch(() => null)));
      return notes.filter(Boolean).sort((a, b) => b.updated - a.updated);
    },

    async get(id) {
      const f = file(id);
      const [body, stat] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
      return { id, body, updated: stat.mtimeMs };
    },

    async create(body = '') {
      await ready();
      const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      await writeAtomic(file(id), String(body));
      return summary(id);
    },

    async save(id, body) {
      if (typeof body !== 'string') throw new Error('A note must be text.');
      await writeAtomic(file(id), body);
      return summary(id);
    },

    async remove(id) {
      await ready();
      await fs.rename(file(id), path.join(trash, `${id}.md`));
      return { id };
    },

    // Case-insensitive search over titles and full text.
    async search(query) {
      const q = String(query || '').trim().toLowerCase();
      const all = await this.list();
      if (!q) return all;
      const hits = await Promise.all(all.map(async (n) => {
        const body = (await fs.readFile(file(n.id), 'utf8')).toLowerCase();
        return body.includes(q) ? n : null;
      }));
      return hits.filter(Boolean);
    },
  };
}

// The first non-empty line, without Markdown heading marks.
export function titleOf(body) {
  const line = body.split('\n').find((l) => l.trim()) || '';
  return line.replace(/^\s*#{1,6}\s*/, '').trim().slice(0, 120) || 'Untitled';
}

// The text after the title, on one line.
export function snippetOf(body) {
  const lines = body.split('\n');
  const first = lines.findIndex((l) => l.trim());
  return lines.slice(first + 1).join(' ').replace(/[#*_`>\-[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

// Write to a temporary file, then rename: a crash never leaves half a note.
async function writeAtomic(target, text) {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, target);
}
