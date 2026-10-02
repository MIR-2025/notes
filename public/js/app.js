import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

// A single newline means a line break -- people type notes, not prose.
marked.setOptions({ gfm: true, breaks: true });

// Markdown lets raw HTML through by design, so every rendered note goes through
// DOMPurify. Without it a <script> pasted into a note would simply run.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Lines that never merge into the line below them: blank, heading, blockquote,
// table row, fence marker, horizontal rule. (A list item is deliberately NOT
// here -- a bullet whose own text wrapped should still absorb its continuation.)
const NO_JOIN_FROM = /^\s*($|#{1,6}\s|>|\||```|~~~|(-{3,}|={3,}|_{3,}|\*{3,})\s*$)/;

// Lines that begin a new block, so the line above them keeps its break.
// `=====` / `-----` underline a setext heading -- joining the line above one
// silently destroys the heading, so any run of 3+ counts as a block start.
const BLOCK_START = /^\s*($|[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~|(-{3,}|={3,}|_{3,}|\*{3,})\s*$|\[\^)/;

// Below this a break was almost certainly deliberate -- a transcript stanza, an
// address, a hand-typed list -- rather than a column wrap.
const WRAP_MIN = 60;

// Notes are hard-wrapped at ~90 columns, because that is how they get written.
// With `breaks: true` every one of those wrap points became a <br>, so a note
// copied out of the preview carried hard breaks mid-sentence that never reflow
// in whatever it was pasted into. Join a line to the next only where it looks
// like a wrap continuation; code fences, lists, tables, quotes, explicit
// hard-break markers and short lines are left exactly as typed.
//
// Known edge: joining puts characters on one physical line, and marked matches
// `~del~` only within a line -- so a paragraph with two stray tildes (a `~/path`
// and another below it) can pick up a strikethrough it did not have. One note
// in the current 471 does this; the alternative, `breaks: false`, would collapse
// 23k deliberate breaks across 72% of them, which is far worse.
function unwrapHardBreaks(md) {
  const lines = String(md ?? '').split('\n');
  const out = [];
  let inFence = false;
  let joinedInto = false; // the previous line absorbed this one -- drop its indent

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    if (joinedInto) line = line.replace(/^\s+/, '');
    joinedInto = false;

    const next = lines[i + 1];
    const joinable =
      !inFence &&
      next !== undefined &&
      !NO_JOIN_FROM.test(line) &&
      !/(\\|\s{2})$/.test(line) && // markdown's own hard-break markers -- honour them
      !BLOCK_START.test(next) &&
      line.trim().length >= WRAP_MIN;

    if (joinable) {
      out.push(line.replace(/\s+$/, ''), ' ');
      joinedInto = true;
    } else {
      out.push(line, '\n');
    }
  }
  return out.join('').replace(/\n$/, '');
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(unwrapHardBreaks(text)));
}

const els = {
  list: document.getElementById('note-list'),
  emptyList: document.getElementById('empty-list'),
  search: document.getElementById('search'),
  newNote: document.getElementById('new-note'),
  pane: document.getElementById('editor-pane'),
  editorEmpty: document.getElementById('editor-empty'),
  body: document.getElementById('note-body'),
  preview: document.getElementById('note-preview'),
  togglePreview: document.getElementById('toggle-preview'),
  status: document.getElementById('status'),
  pin: document.getElementById('pin-note'),
  del: document.getElementById('delete-note'),
  download: document.getElementById('download-note'),
  pdf: document.getElementById('pdf-note'),
  exportAll: document.getElementById('export-all'),
  sort: document.getElementById('sort'),
  pinFirst: document.getElementById('pin-first'),
  sortNote: document.getElementById('sort-note'),
  themeToggle: document.getElementById('theme-toggle'),
  printArea: document.getElementById('print-area')
};

const SAVE_DELAY = 600;
const PREVIEW_KEY = 'notes:preview';
const THEME_KEY = 'notes:theme';
const SORT_KEY = 'notes:sort';
const PIN_FIRST_KEY = 'notes:pinFirst';

// Mirrors DEFAULT_SORT in db.js. "Best match" and not a recency order, because
// the server degrades it to recency whenever there is nothing to rank -- so one
// setting covers both an idle list and an active search.
const DEFAULT_SORT = 'relevance';

// Mirrors the server's ORDER BY for the sorts that can be recomputed from a
// summary row. `relevance` deliberately has no entry: bm25 lives inside the FTS
// index and cannot be worked out here, which is what patchLocal() is about.
// Title ordering is the one near-miss -- SQLite's COLLATE NOCASE folds ASCII
// only, localeCompare folds everything -- and it applies solely to a row being
// slotted back in locally, which the next refresh re-sorts properly anyway.
const COMPARATORS = {
  updated_desc: (a, b) => b.updated_at.localeCompare(a.updated_at),
  updated_asc: (a, b) => a.updated_at.localeCompare(b.updated_at),
  created_desc: (a, b) => b.created_at.localeCompare(a.created_at),
  created_asc: (a, b) => a.created_at.localeCompare(b.created_at),
  title_asc: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  title_desc: (a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: 'base' })
};

// Identifies this tab so the live feed can skip the echo of our own edits.
const CLIENT_ID = crypto.randomUUID();

let notes = [];
// What is selected in the dropdown, versus what the server reports it actually
// ordered by. They differ when "Best match" has nothing to rank.
let sortKey = DEFAULT_SORT;
let effectiveSort = DEFAULT_SORT;
let pinnedFirst = true;
let currentId = null;
let saveTimer = null;
let dirty = false;
let previewing = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
      ...options.headers
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

// api() hands back only the parsed body; the list also needs a response header
// off the same request (X-Sort), so it goes through this instead.
async function apiWithHeaders(path) {
  const res = await fetch(path, { headers: { 'X-Client-Id': CLIENT_ID } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { data: await res.json(), headers: res.headers };
}

function setStatus(text) {
  els.status.textContent = text;
}

function formatDate(value) {
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function preview(note) {
  return note.excerpt || 'No additional text';
}

// A list row is a summary: every column except `body`, plus a short `excerpt`.
// A note handed back by a write is the full thing, so reduce it to that shape
// before it goes back into the list.
function toSummary(note) {
  const { body, ...rest } = note;
  return {
    ...rest,
    excerpt: body.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  };
}

// The same order the server listed in, so a locally patched row lands where a
// refetch would have put it. Falls back to recency for an ordering that has no
// local comparator -- which only `relevance` does, and patchLocal never gets
// that far.
function sortNotes() {
  const compare = COMPARATORS[effectiveSort] ?? COMPARATORS.updated_desc;
  notes.sort(
    (a, b) => (pinnedFirst ? b.pinned - a.pinned : 0) || compare(a, b) || b.id - a.id
  );
}

// Fold one changed note into the list in place, instead of refetching all of
// them. Saving is the hottest request in the app -- it fires on every pause in
// typing -- and it already has the updated note in hand.
function patchLocal(note) {
  // Not while a search is running. An edit can change whether the note still
  // matches the term at all, and under "Best match" it changes where the note
  // ranks -- neither of which is knowable here. Ask the server instead. (This
  // also fixes an older wrinkle: a note edited out of its own search results
  // used to sit there until the next full refresh.)
  if (els.search.value.trim()) {
    refreshList().catch((err) => console.error(err));
    return;
  }

  const summary = toSummary(note);
  const at = notes.findIndex((n) => n.id === note.id);
  if (at === -1) notes.push(summary);
  else notes[at] = summary;
  sortNotes();
  renderList();
}

function renderList() {
  els.list.replaceChildren();
  els.emptyList.classList.toggle('d-none', notes.length > 0);
  els.emptyList.textContent = els.search.value.trim()
    ? 'No matches.'
    : 'No notes yet.';

  for (const note of notes) {
    const li = document.createElement('li');
    li.dataset.id = String(note.id);
    li.classList.toggle('active', note.id === currentId);

    const title = document.createElement('span');
    title.className = 'note-title';
    // textContent, never innerHTML -- note text is untrusted input.
    title.textContent = `${note.pinned ? '📌 ' : ''}${note.title || 'Untitled'}`;

    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = `${formatDate(note.updated_at)} -- ${preview(note)}`;

    li.append(title, meta);
    li.addEventListener('click', () => open(note.id));
    els.list.append(li);
  }
}

// localStorage throws outright in some private-browsing modes, so every read
// and write of a preference goes through these. A lost preference is a session
// on the defaults, never a broken list.
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage -- the choice still holds for this session */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSort(value, { refresh = true } = {}) {
  sortKey = value;
  els.sort.value = value;
  remember(SORT_KEY, value);
  if (refresh) refreshList().catch((err) => console.error(err));
}

function setPinnedFirst(on, { refresh = true } = {}) {
  pinnedFirst = on;
  els.pinFirst.setAttribute('aria-pressed', String(on));
  els.pinFirst.title = on ? 'Pinned notes first' : 'Pinned notes sort with the rest';
  remember(PIN_FIRST_KEY, on ? '1' : '0');
  if (refresh) refreshList().catch((err) => console.error(err));
}

// Run once at boot, before the first list request, so the opening view is the
// one that was left behind rather than the defaults followed by a visible jump.
function restorePrefs() {
  const saved = recall(SORT_KEY);
  const known = [...els.sort.options].some((option) => option.value === saved);
  setSort(known ? saved : DEFAULT_SORT, { refresh: false });
  setPinnedFirst(recall(PIN_FIRST_KEY) !== '0', { refresh: false });
}

// The query string every list-shaped request shares, so the export downloads
// exactly the notes in exactly the order the sidebar is showing.
function listParams() {
  const params = new URLSearchParams();
  const query = els.search.value.trim();
  if (query) params.set('q', query);
  params.set('sort', sortKey);
  if (!pinnedFirst) params.set('pinned', 'mixed');
  return params;
}

// Say so when the ordering applied is not the one selected, rather than leaving
// the dropdown quietly lying. Only happens on a search that fell through to the
// substring scan, which computes no relevance score.
function renderSortNote() {
  const mismatch = effectiveSort !== sortKey && els.search.value.trim() !== '';
  els.sortNote.classList.toggle('d-none', !mismatch);
  if (mismatch) {
    els.sortNote.textContent =
      'Matched inside words, so there is nothing to rank -- ordered by most recently edited.';
  }
}

async function refreshList() {
  const { data, headers } = await apiWithHeaders(`/api/notes?${listParams()}`);
  notes = data;
  effectiveSort = headers.get('X-Sort') ?? sortKey;
  renderSortNote();
  renderList();
}

// Briefly highlight a row so a note that lands on its own is noticeable but
// not disruptive. Skipped if the search filter means it did not render.
function flashRow(id) {
  const row = els.list.querySelector(`li[data-id="${id}"]`);
  if (!row) return;
  row.classList.add('arrived');
  row.addEventListener('animationend', () => row.classList.remove('arrived'), {
    once: true
  });
}

function showEditor(show) {
  els.pane.classList.toggle('d-none', !show);
  els.editorEmpty.classList.toggle('d-none', show);
}

function paintPreview() {
  const text = els.body.value.trim();
  if (text) {
    els.preview.innerHTML = renderMarkdown(els.body.value);
  } else {
    els.preview.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'text-secondary';
    hint.textContent = 'Nothing to preview yet.';
    els.preview.append(hint);
  }
}

function setPreview(on) {
  previewing = on;
  if (on) paintPreview();

  els.body.classList.toggle('d-none', on);
  els.preview.classList.toggle('d-none', !on);
  els.togglePreview.textContent = on ? 'Edit' : 'Preview';
  els.togglePreview.classList.toggle('active', on);
  localStorage.setItem(PREVIEW_KEY, on ? '1' : '0');

  if (!on) els.body.focus();
}

async function open(id) {
  if (id === currentId) return;
  await flush();

  // The list carries no bodies, so opening a note always fetches it. That is
  // one small request instead of preloading every body up front.
  const note = await api(`/api/notes/${id}`);
  currentId = note.id;
  els.body.value = note.body;
  els.pin.textContent = note.pinned ? 'Unpin' : 'Pin';
  setStatus(`Edited ${formatDate(note.updated_at)}`);
  showEditor(true);
  renderList();

  if (previewing) paintPreview();
  else els.body.focus();
}

async function save() {
  if (!dirty || currentId === null) return;

  const id = currentId;
  const body = els.body.value;
  dirty = false;
  setStatus('Saving...');

  try {
    const saved = await api(`/api/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ body })
    });
    setStatus(`Saved ${formatDate(saved.updated_at)}`);
    patchLocal(saved);
  } catch (err) {
    dirty = true;
    setStatus('Save failed -- retrying on next edit');
    console.error(err);
  }
}

// Cancel the pending debounce and commit right now. Anything that navigates
// away from the current note must await this or the last keystrokes are lost.
async function flush() {
  clearTimeout(saveTimer);
  await save();
}

function scheduleSave() {
  dirty = true;
  setStatus('Unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
}

async function createNote() {
  await flush();
  const note = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ body: '' })
  });
  await refreshList();
  currentId = null;
  // A brand new note is empty -- previewing it would just show the empty hint.
  setPreview(false);
  await open(note.id);
}

async function togglePin() {
  if (currentId === null) return;
  const note = notes.find((n) => n.id === currentId);
  const updated = await api(`/api/notes/${currentId}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned: !note?.pinned })
  });
  els.pin.textContent = updated.pinned ? 'Unpin' : 'Pin';
  patchLocal(updated);
}

// A hidden <a download> click is the reliable cross-browser way to trigger a
// file save from a same-origin URL without navigating the page away.
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

async function downloadCurrent() {
  if (currentId === null) return;
  // Flush first so the file reflects the latest keystrokes, not the last save.
  await flush();
  triggerDownload(`/api/notes/${currentId}/download`);
}

function exportAll() {
  // Respect the active search filter and ordering: what you see is what you
  // export. (The export path matches with LIKE only, so a search that FTS
  // answered can pull a few extra notes into the zip -- broader, never fewer.)
  triggerDownload(`/api/export?${listParams()}`);
}

// Render the open note into the hidden print area. Runs on `beforeprint`, so it
// covers every route to the print dialog -- the PDF button, Ctrl+P, and the
// browser's own menu -- not just our button.
let titleBeforePrint = null;
function fillPrintArea() {
  if (currentId === null) {
    els.printArea.replaceChildren();
    return;
  }
  els.printArea.innerHTML = renderMarkdown(els.body.value);
  // The browser seeds the "Save as PDF" filename from document.title. Prefer the
  // saved title, else the current first line (mirrors how the server derives it).
  const note = notes.find((n) => n.id === currentId);
  const firstLine = els.body.value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  const name = (note?.title || firstLine?.replace(/^#{1,6}\s*/, '') || 'note').slice(0, 120);
  titleBeforePrint = document.title;
  document.title = name;
}

function restoreTitle() {
  if (titleBeforePrint !== null) {
    document.title = titleBeforePrint;
    titleBeforePrint = null;
  }
}

async function printCurrent() {
  if (currentId === null) return;
  // Save first so the PDF reflects the latest keystrokes, not the last autosave.
  await flush();
  // Populate synchronously here -- `beforeprint` does NOT fire reliably from a
  // programmatic window.print() (and not at all in some browsers), so relying on
  // it alone left the print area empty and the page blank.
  fillPrintArea();
  window.print();
}

// Belt and suspenders for the one path that skips printCurrent(): the browser's
// own File > Print menu. Where beforeprint does fire, this fills the area too.
window.addEventListener('beforeprint', fillPrintArea);
window.addEventListener('afterprint', restoreTitle);

async function removeNote() {
  if (currentId === null) return;
  const note = notes.find((n) => n.id === currentId);
  if (!confirm(`Delete "${note?.title || 'Untitled'}"? This cannot be undone.`)) {
    return;
  }

  clearTimeout(saveTimer);
  dirty = false;
  await api(`/api/notes/${currentId}`, { method: 'DELETE' });
  currentId = null;
  els.body.value = '';
  showEditor(false);
  await refreshList();
}

// Live feed ---------------------------------------------------------------

// Most notes arrive from outside this browser (a Claude session POSTing a
// session summary), so the list has to react to the server, not to the user.
async function handleEvent(event) {
  // Our own edit, already applied locally.
  if (event.origin === CLIENT_ID) return;

  if (event.type === 'deleted' && event.id === currentId) {
    clearTimeout(saveTimer);
    dirty = false;
    currentId = null;
    els.body.value = '';
    showEditor(false);
  }

  if (event.type === 'updated' && event.note.id === currentId) {
    // Name the agent that made THIS change; "elsewhere" when it was anonymous
    // (a human in another tab).
    const who = event.by ? `by ${event.by}` : 'elsewhere';
    if (dirty) {
      // Never clobber what is being typed -- the unsaved text wins, and the
      // next autosave will overwrite the other change.
      setStatus(`Changed ${who} -- your unsaved edits are kept`);
    } else if (event.note.body !== els.body.value) {
      const caret = els.body.selectionStart;
      els.body.value = event.note.body;
      els.body.setSelectionRange(caret, caret);
      if (previewing) paintPreview();
      setStatus(`Updated ${who} ${formatDate(event.note.updated_at)}`);
    }
  }

  await refreshList();
  if (event.type === 'created') flashRow(event.note.id);
}

function connectStream() {
  let connected = false;
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    // On a reconnect, re-sync: anything published while we were away was
    // simply missed, since the server keeps no backlog.
    if (connected) refreshList();
    connected = true;
  });

  source.addEventListener('message', (event) => {
    handleEvent(JSON.parse(event.data)).catch((err) => console.error(err));
  });

  // EventSource retries on its own using the server's `retry:` hint.
  source.addEventListener('error', () => {
    connected = false;
  });
}

// Wiring ------------------------------------------------------------------

let searchTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshList, 150);
});

els.sort.addEventListener('change', () => {
  setSort(els.sort.value);
});

els.pinFirst.addEventListener('click', () => {
  setPinnedFirst(!pinnedFirst);
});

els.body.addEventListener('input', scheduleSave);
els.newNote.addEventListener('click', createNote);
els.pin.addEventListener('click', togglePin);
els.del.addEventListener('click', removeNote);
els.togglePreview.addEventListener('click', () => setPreview(!previewing));
els.download.addEventListener('click', downloadCurrent);
els.pdf.addEventListener('click', printCurrent);
els.exportAll.addEventListener('click', exportAll);

// The initial theme is set by an inline script in <head> (before paint, to
// avoid a flash). Here we only handle the toggle and persist the choice.
els.themeToggle.addEventListener('click', () => {
  const next =
    document.documentElement.getAttribute('data-bs-theme') === 'dark'
      ? 'light'
      : 'dark';
  document.documentElement.setAttribute('data-bs-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* no storage -- theme still applies for this session */
  }
});

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;

  if (event.key === 'n') {
    event.preventDefault();
    createNote();
  } else if (event.key === 'k') {
    event.preventDefault();
    els.search.focus();
    els.search.select();
  } else if (event.key === 's') {
    event.preventDefault();
    flush();
  } else if (event.key === 'e') {
    event.preventDefault();
    if (currentId !== null) setPreview(!previewing);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    // Step through the orderings without leaving the keyboard, the same way
    // Ctrl+K reaches the search box.
    event.preventDefault();
    const options = [...els.sort.options].map((option) => option.value);
    const next = options.indexOf(sortKey) + (event.key === 'ArrowDown' ? 1 : -1);
    setSort(options[(next + options.length) % options.length]);
  } else if (event.key === 'p' && currentId !== null) {
    // Route the native print shortcut through our flow so it saves first and
    // prints just the note, not the whole app chrome.
    event.preventDefault();
    printCurrent();
  }
});

// Two jobs on a visibility change:
//  1. Coming BACK to a tab that may have slept or been backgrounded: the SSE
//     stream can die silently (no 'error' event, so no reconnect and no resync),
//     which means any note posted while we were away was missed. Re-sync the
//     list. This is the fix for "an agent posted but it only showed after refresh."
//  2. Going hidden mid-edit: best-effort save. fetch() keepalive survives teardown.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshList();
    return;
  }
  if (!dirty || currentId === null) return;
  clearTimeout(saveTimer);
  dirty = false;
  fetch(`/api/notes/${currentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
    body: JSON.stringify({ body: els.body.value }),
    keepalive: true
  }).catch(() => {});
});

setPreview(localStorage.getItem(PREVIEW_KEY) === '1');
restorePrefs();
await refreshList();
if (notes.length > 0) await open(notes[0].id);
connectStream();
