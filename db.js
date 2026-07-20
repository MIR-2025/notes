import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'notes.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL DEFAULT '',
    body       TEXT    NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notes_order ON notes(pinned DESC, updated_at DESC);
`);

// Migration: `author` records which agent last wrote the note (NULL for notes
// written by hand in the browser, and for everything predating this column).
// Additive and idempotent, so it is safe to run on every boot.
const columns = db.prepare(`PRAGMA table_info(notes)`).all().map((c) => c.name);
if (!columns.includes('author')) {
  db.exec(`ALTER TABLE notes ADD COLUMN author TEXT`);
}

const statements = {
  list: db.prepare(`
    SELECT id, title, body, pinned, author, created_at, updated_at
      FROM notes
     ORDER BY pinned DESC, updated_at DESC
  `),
  search: db.prepare(`
    SELECT id, title, body, pinned, author, created_at, updated_at
      FROM notes
     WHERE title LIKE :q ESCAPE '\\' OR body LIKE :q ESCAPE '\\'
     ORDER BY pinned DESC, updated_at DESC
  `),
  get: db.prepare(`SELECT * FROM notes WHERE id = ?`),
  insert: db.prepare(`INSERT INTO notes (title, body, author) VALUES (?, ?, ?)`),
  update: db.prepare(`
    UPDATE notes
       SET title = ?,
           body = ?,
           -- Keep the existing author when the writer is anonymous (a human in
           -- the browser), so a stray typo does not erase an agent's byline.
           author = COALESCE(?, author),
           updated_at = datetime('now')
     WHERE id = ?
  `),
  setPinned: db.prepare(`
    UPDATE notes SET pinned = ? WHERE id = ?
  `),
  remove: db.prepare(`DELETE FROM notes WHERE id = ?`)
};

// A note's title is whatever the first non-empty line says, trimmed to a sane
// length. Nothing in the UI asks for a title separately.
export function deriveTitle(body) {
  const first = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return '';
  return first.replace(/^#{1,6}\s*/, '').slice(0, 120);
}

// LIKE wildcards in user input would otherwise match everything.
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Turn a note into a safe download filename. Derived from the title, stripped
// of anything a filesystem or Content-Disposition header would choke on, with
// the id appended so two same-titled notes never collide in a zip.
export function noteFilename(note) {
  const slug = String(note.title || '')
    .replace(/[\/\\:*?"<>|]/g, ' ') // reserved on Windows / path separators
    .replace(/[\x00-\x1f]/g, ' ') // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, ''); // no trailing dot/space (also Windows-hostile)
  const base = slug || 'untitled';
  return `${base}-${note.id}.md`;
}

export function listNotes(query) {
  const term = String(query ?? '').trim();
  if (!term) return statements.list.all();
  return statements.search.all({ q: `%${escapeLike(term)}%` });
}

export function getNote(id) {
  return statements.get.get(id);
}

export function createNote(body = '', author = null) {
  const { lastInsertRowid } = statements.insert.run(deriveTitle(body), body, author);
  return getNote(lastInsertRowid);
}

export function updateNote(id, body, author = null) {
  statements.update.run(deriveTitle(body), body, author, id);
  return getNote(id);
}

export function setPinned(id, pinned) {
  statements.setPinned.run(pinned ? 1 : 0, id);
  return getNote(id);
}

export function deleteNote(id) {
  return statements.remove.run(id).changes > 0;
}
