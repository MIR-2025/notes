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

// Full-text index. `content='notes'` makes it an external-content table: FTS
// stores only the inverted index and reads columns back from `notes`, so the
// note text is not duplicated on disk. The triggers keep the two in step --
// an external-content table does NOT update itself.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    body,
    content='notes',
    content_rowid='id',
    tokenize='unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;

  CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
  END;

  CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
`);

// One-time backfill of the index for notes that predate it. Gated on
// user_version rather than on a row count: an external-content FTS table
// answers COUNT(*) from `notes`, so it always looks populated.
const SCHEMA_VERSION = 1;
if (db.prepare(`PRAGMA user_version`).get().user_version < SCHEMA_VERSION) {
  db.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// How much of the body travels with a list row. Enough to fill the two-line
// preview under each title; the client never renders more than this.
const EXCERPT_CHARS = 300;

// The list columns, minus `body`. Shipping every body turned a list request
// into megabytes of JSON -- see listSummaries.
const SUMMARY_COLUMNS = `
  n.id, n.title, n.pinned, n.author, n.created_at, n.updated_at,
  CASE
    WHEN instr(n.body, char(10)) = 0 THEN ''
    ELSE substr(n.body, instr(n.body, char(10)) + 1, ${EXCERPT_CHARS})
  END AS excerpt
`;

const statements = {
  listSummaries: db.prepare(`
    SELECT ${SUMMARY_COLUMNS}
      FROM notes n
     ORDER BY n.pinned DESC, n.updated_at DESC
  `),
  searchSummaries: db.prepare(`
    SELECT ${SUMMARY_COLUMNS}
      FROM notes_fts
      JOIN notes n ON n.id = notes_fts.rowid
     WHERE notes_fts MATCH ?
     ORDER BY n.pinned DESC, n.updated_at DESC
  `),
  searchSummariesLike: db.prepare(`
    SELECT ${SUMMARY_COLUMNS}
      FROM notes n
     WHERE n.title LIKE :q ESCAPE '\\' OR n.body LIKE :q ESCAPE '\\'
     ORDER BY n.pinned DESC, n.updated_at DESC
  `),
  listFull: db.prepare(`
    SELECT id, title, body, pinned, author, created_at, updated_at
      FROM notes
     ORDER BY pinned DESC, updated_at DESC
  `),
  searchFull: db.prepare(`
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

// Turn what someone typed in the search box into an FTS5 MATCH expression.
// Every word becomes a quoted prefix term, so "mir dev" finds "MIR dev log"
// and a half-typed word still matches. Quoting is what keeps FTS operators
// (AND, OR, NOT, *, ^, ":") in a note's text from being read as syntax --
// unquoted, a search for `NOT` is a parse error, not a search.
function ftsQuery(term) {
  const words = term.match(/[\p{L}\p{N}_]+/gu);
  if (!words) return null;
  return words.map((word) => `"${word}"*`).join(' AND ');
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

// The excerpt arrives as a raw slice of markdown; the list shows it as one
// line, so flatten the whitespace here rather than in every caller.
function tidy(rows) {
  for (const row of rows) {
    row.excerpt = row.excerpt.replace(/\s+/g, ' ').trim();
  }
  return rows;
}

// What the note list needs: everything except the bodies. Sending the bodies
// meant a few hundred notes serialized into multiple megabytes on every
// refresh -- and the list refreshes on every save, search and live event.
// Bodies are fetched one at a time, by getNote, when a note is opened.
export function listSummaries(query) {
  const term = String(query ?? '').trim();
  if (!term) return tidy(statements.listSummaries.all());

  const match = ftsQuery(term);
  if (match) {
    const hits = tidy(statements.searchSummaries.all(match));
    // FTS matches whole words and prefixes, so it misses a search for the
    // middle of one ("ession"). Only pay for the full scan when the fast
    // path found nothing.
    if (hits.length > 0) return hits;
  }
  return tidy(statements.searchSummariesLike.all({ q: `%${escapeLike(term)}%` }));
}

// Bodies included. Only the export path wants this -- it is writing every note
// out to a file, so it genuinely needs all of them at once.
export function listNotes(query) {
  const term = String(query ?? '').trim();
  if (!term) return statements.listFull.all();
  return statements.searchFull.all({ q: `%${escapeLike(term)}%` });
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
