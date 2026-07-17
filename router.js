import { Router } from 'express';
import {
  listNotes,
  getNote,
  createNote,
  updateNote,
  setPinned,
  deleteNote,
  noteFilename
} from './db.js';
import { bus, publish } from './events.js';
import { makeZip } from './zip.js';

// RFC 5987: filenames with non-ASCII or quotes need the encoded form, so we
// send a plain fallback plus filename* for anything modern.
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const router = Router();

const HEARTBEAT_MS = 25_000;

// Which browser made the change, so it can skip its own echo.
function origin(req) {
  return req.get('X-Client-Id') || null;
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Bad note id' });
    return null;
  }
  return id;
}

router.get('/', (_req, res) => {
  res.render('index', { title: 'Notes' });
});

router.get('/api/notes', (req, res) => {
  res.json(listNotes(req.query.q));
});

// Live feed of note changes. One way, server -> browser, so plain SSE rather
// than a socket: EventSource is native and reconnects by itself.
router.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx and friends not to buffer the stream into uselessness.
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const onNotes = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  bus.on('notes', onNotes);

  // Comment frames keep idle proxies from reaping the connection.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('notes', onNotes);
  });
});

// Every note as a .md file, zipped. Defined before the :id routes so "export"
// is never mistaken for a note id.
router.get('/api/export', (req, res) => {
  const notes = listNotes(req.query.q);
  if (notes.length === 0) return res.status(404).json({ error: 'No notes to export' });

  const files = notes.map((note) => ({
    name: noteFilename(note),
    data: note.body,
    // SQLite stores UTC without a zone marker; tag it so it parses as UTC.
    modified: new Date(`${note.updated_at.replace(' ', 'T')}Z`)
  }));
  const zip = makeZip(files);

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', contentDisposition('notes.zip'));
  res.send(zip);
});

router.post('/api/notes', (req, res) => {
  const note = createNote(req.body?.body ?? '');
  publish('created', { note }, origin(req));
  res.status(201).json(note);
});

router.get('/api/notes/:id', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const note = getNote(id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

router.get('/api/notes/:id/download', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const note = getNote(id);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Content-Disposition', contentDisposition(noteFilename(note)));
  res.send(note.body);
});

router.put('/api/notes/:id', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (typeof req.body?.body !== 'string') {
    return res.status(400).json({ error: 'body must be a string' });
  }
  if (!getNote(id)) return res.status(404).json({ error: 'Note not found' });

  const note = updateNote(id, req.body.body);
  publish('updated', { note }, origin(req));
  res.json(note);
});

router.patch('/api/notes/:id/pin', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!getNote(id)) return res.status(404).json({ error: 'Note not found' });

  const note = setPinned(id, Boolean(req.body?.pinned));
  publish('updated', { note }, origin(req));
  res.json(note);
});

router.delete('/api/notes/:id', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!deleteNote(id)) return res.status(404).json({ error: 'Note not found' });

  publish('deleted', { id }, origin(req));
  res.status(204).end();
});

export default router;
