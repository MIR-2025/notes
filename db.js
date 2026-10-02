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

// The orderings a list or a search can come back in. The keys are the API's
// `sort` values and the fragments go straight into SQL, so this map IS the
// allowlist -- anything that is not a key here never reaches a query.
//
// `relevance` is FTS5's own bm25 score, weighted 10:1 toward the title so a
// note *about* a word outranks one that merely mentions it in passing. It is
// the one ordering that needs something to score, which `ranked` marks: with no
// search term -- or on the LIKE fallback below, which computes no score -- it
// degrades to `updated_desc`. That degradation is the point rather than a
// consolation, because it lets "Best match" stand as the permanent default and
// still mean "newest first" on an unfiltered list.
export const SORTS = {
  relevance:    { label: 'Best match',       sql: 'bm25(notes_fts, 10.0, 1.0) ASC', ranked: true },
  updated_desc: { label: 'Recently edited',  sql: 'n.updated_at DESC' },
  updated_asc:  { label: 'Oldest edited',    sql: 'n.updated_at ASC' },
  created_desc: { label: 'Recently created', sql: 'n.created_at DESC' },
  created_asc:  { label: 'Oldest created',   sql: 'n.created_at ASC' },
  // An untitled note is a blank string, which sorts before every letter -- so
  // A-Z would open on the empty ones. The leading term sinks them in BOTH
  // directions, which is what "Untitled" deserves either way round.
  title_asc:    { label: 'Title A-Z',        sql: "(n.title = '') ASC, n.title COLLATE NOCASE ASC" },
  title_desc:   { label: 'Title Z-A',        sql: "(n.title = '') ASC, n.title COLLATE NOCASE DESC" }
};

export const DEFAULT_SORT = 'relevance';
const UNRANKED_SORT = 'updated_desc';

// Which ordering a request actually gets, after the two ways the asked-for one
// can be unavailable: an unknown key, or `relevance` where there is no MATCH to
// rank. Every list path reports this back, so the UI can say what it really did
// instead of labelling a recency list "Best match".
function resolveSort(sort, ranked) {
  const chosen = Object.hasOwn(SORTS, sort) ? sort : DEFAULT_SORT;
  return SORTS[chosen].ranked && !ranked ? UNRANKED_SORT : chosen;
}

// `n.id DESC` is a tiebreak, not decoration: `updated_at` has one-second
// resolution and titles repeat, so without it rows that compare equal are free
// to swap places between two identical requests.
function orderBy(sort, pinnedFirst) {
  return `ORDER BY ${pinnedFirst ? 'n.pinned DESC, ' : ''}${SORTS[sort].sql}, n.id DESC`;
}

// List statements are built per (sort, pinned) pair rather than up front: seven
// sorts x two pin modes x three query shapes is a lot of SQL to compile on boot
// for the two or three combinations any one person actually uses. Cached on
// first use, so each one is still only ever prepared once.
const compiled = new Map();
function prepared(sql) {
  let statement = compiled.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    compiled.set(sql, statement);
  }
  return statement;
}

const statements = {
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
export function listSummaries(query, { sort = DEFAULT_SORT, pinnedFirst = true } = {}) {
  const term = String(query ?? '').trim();

  if (!term) {
    const key = resolveSort(sort, false);
    return {
      notes: tidy(
        prepared(`
          SELECT ${SUMMARY_COLUMNS}
            FROM notes n
           ${orderBy(key, pinnedFirst)}
        `).all()
      ),
      sort: key
    };
  }

  const match = ftsQuery(term);
  if (match) {
    const key = resolveSort(sort, true);
    const hits = tidy(
      prepared(`
        SELECT ${SUMMARY_COLUMNS}
          FROM notes_fts
          JOIN notes n ON n.id = notes_fts.rowid
         WHERE notes_fts MATCH ?
         ${orderBy(key, pinnedFirst)}
      `).all(match)
    );
    // FTS matches whole words and prefixes, so it misses a search for the
    // middle of one ("ession"). Only pay for the full scan when the fast
    // path found nothing.
    if (hits.length > 0) return { notes: hits, sort: key };
  }

  // The fallback scan knows only whether a row matched, never how well, so
  // `relevance` has nothing to rank here either.
  const key = resolveSort(sort, false);
  return {
    notes: tidy(
      prepared(`
        SELECT ${SUMMARY_COLUMNS}
          FROM notes n
         WHERE n.title LIKE :q ESCAPE '\\' OR n.body LIKE :q ESCAPE '\\'
         ${orderBy(key, pinnedFirst)}
      `).all({ q: `%${escapeLike(term)}%` })
    ),
    sort: key
  };
}

// Bodies included. Only the export path wants this -- it is writing every note
// out to a file, so it genuinely needs all of them at once.
export function listNotes(query, { sort = DEFAULT_SORT, pinnedFirst = true } = {}) {
  const term = String(query ?? '').trim();
  const columns = 'id, title, body, pinned, author, created_at, updated_at';
  // This path is LIKE-only -- there is no MATCH anywhere in it -- so nothing
  // here is ever rankable.
  const key = resolveSort(sort, false);

  if (!term) {
    return {
      notes: prepared(`SELECT ${columns} FROM notes n ${orderBy(key, pinnedFirst)}`).all(),
      sort: key
    };
  }
  return {
    notes: prepared(`
      SELECT ${columns}
        FROM notes n
       WHERE n.title LIKE :q ESCAPE '\\' OR n.body LIKE :q ESCAPE '\\'
       ${orderBy(key, pinnedFirst)}
    `).all({ q: `%${escapeLike(term)}%` }),
    sort: key
  };
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
