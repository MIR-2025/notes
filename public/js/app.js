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
// table row, fence marker, horizontal rule, image. (A list item is deliberately
// NOT here -- a bullet whose own text wrapped should still absorb its
// continuation.)
//
// `![` is on the list because an image URL is long: a media reference is ~90
// characters, which clears WRAP_MIN on its own, so an image on its own line
// looked exactly like a wrapped sentence and swallowed its own caption. It
// appears in BLOCK_START too -- an image line is a block from both directions,
// so the line of prose above one keeps its break as well.
const NO_JOIN_FROM = /^\s*($|#{1,6}\s|>|\||```|~~~|!\[|(-{3,}|={3,}|_{3,}|\*{3,})\s*$)/;

// Lines that begin a new block, so the line above them keeps its break.
// `=====` / `-----` underline a setext heading -- joining the line above one
// silently destroys the heading, so any run of 3+ counts as a block start.
const BLOCK_START = /^\s*($|[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~|!\[|(-{3,}|={3,}|_{3,}|\*{3,})\s*$|\[\^)/;

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
  printArea: document.getElementById('print-area'),
  attachImage: document.getElementById('attach-image'),
  imageInput: document.getElementById('image-input')
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

// Deep link to a single note: /?id=123 opens it straight away. The param is
// kept in sync as you move around, so whatever is on screen is always what the
// address bar would reopen -- copy it anywhere and it lands on the same note.
const ID_PARAM = 'id';

// Only ever a positive integer. A hand-typed or stale value resolves to null
// and the app falls back to its normal opening behaviour rather than firing a
// request it knows will 400.
function idFromUrl() {
  const id = Number(new URLSearchParams(location.search).get(ID_PARAM));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// `push` writes a history entry, so Back and Forward step between the notes you
// opened. The entry the page BOOTS on must replace instead: pushing there would
// leave the pre-load state behind the first note, and Back would land on a
// blank editor rather than leaving the app.
function syncUrl(id, { push = false } = {}) {
  const url = new URL(location.href);
  if (id === null) url.searchParams.delete(ID_PARAM);
  else url.searchParams.set(ID_PARAM, String(id));

  // Re-pushing an identical URL would stack duplicate history entries that Back
  // appears to ignore, because each one restores the same note.
  if (url.href === location.href) return;
  history[push ? 'pushState' : 'replaceState']({ id }, '', url);
}

function setStatus(text) {
  els.status.textContent = text;
}

// SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, so tag it
// as UTC explicitly -- left bare, the browser would read it as local time and
// every stamp in the app would be wrong by the offset.
function parseStamp(value) {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

// Always the time, not just the day: the hour is half of what places a note when
// several land on the same date. Today shows the time alone (the date would be
// the same on every such row), and anything outside the current year gains a
// year, so a note from last September never reads as this September's.
function formatDate(value) {
  const date = parseStamp(value);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (now.toDateString() === date.toDateString()) return time;

  const day = date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  });
  return `${day}, ${time}`;
}

// The exact stamps, for a row's hover tooltip. Seconds resolve the ties the
// minute-level label cannot, and `created_at` is otherwise not shown anywhere
// in the UI -- the list only ever talks about the last edit.
function fullStamp(note) {
  const at = (value) =>
    parseStamp(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  return `Edited ${at(note.updated_at)}\nCreated ${at(note.created_at)}`;
}

function preview(note) {
  return note.excerpt || 'No additional text';
}

// Mirrors summarizeMedia() in media.js. The server collapses an image
// reference to its alt text before it ships a list row, and a row patched in
// locally has to do the same -- otherwise saving a note with a screenshot in it
// replaces its own sidebar preview with 64 characters of content hash, and it
// stays that way until the next full refresh.
const MEDIA_IMAGE = /!\[([^\]]*)\]\(\/media\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif)\)/g;
const MEDIA_TAIL = /(?:!\[[^\]]*\]\()?\/media\/[0-9a-f]{8,}[^\s)]*$/;

function summarizeMedia(text) {
  return text.replace(MEDIA_IMAGE, (_match, alt) => `[${alt.trim() || 'image'}]`);
}

// A list row is a summary: every column except `body`, plus a short `excerpt`.
// A note handed back by a write is the full thing, so reduce it to that shape
// before it goes back into the list.
function toSummary(note) {
  const { body, ...rest } = note;
  return {
    ...rest,
    excerpt: summarizeMedia(body.split('\n').slice(1).join(' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
      // The slice can cut a reference in half and leave a run of raw hex at
      // the end. Same trailing pass the server does, for the same reason.
      .replace(MEDIA_TAIL, '[image]')
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

    li.title = fullStamp(note);
    li.append(title, meta);
    // Deleted from another tab a moment ago -> 404. Log it; the list refresh
    // that follows the delete event drops the row anyway.
    li.addEventListener('click', () => open(note.id).catch((err) => console.error(err)));
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

// Drop the open note without touching the list. Deliberately does NOT re-render
// -- both callers that remove a note refresh the whole list immediately after,
// and rebuilding a thousand rows twice is worth avoiding. Anything else calling
// this renders for itself.
function closeEditor() {
  clearTimeout(saveTimer);
  dirty = false;
  currentId = null;
  els.body.value = '';
  showEditor(false);
  syncUrl(null);
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

// `push` is false when the URL already says this note -- on boot, and when Back
// or Forward is what asked for it -- so navigating does not re-push the entry it
// just arrived at.
async function open(id, { push = true } = {}) {
  if (id === currentId) return;
  await flush();

  // The list carries no bodies, so opening a note always fetches it. That is
  // one small request instead of preloading every body up front. A 404 here
  // throws before anything is mutated, so a dead link leaves the open note
  // exactly as it was.
  const note = await api(`/api/notes/${id}`);
  currentId = note.id;
  syncUrl(note.id, { push });
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
  closeEditor();
  await refreshList();
}

// Images -----------------------------------------------------------------

// Mirrors MAX_UPLOAD_BYTES in media.js. Checked here only so an obviously
// oversized file fails instantly with a useful number instead of after a long
// upload; the server enforces the real limit either way.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Only has to be unique within this tab's lifetime -- a placeholder exists for
// as long as one upload takes.
let uploadSeq = 0;

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Alt text worth having. A dropped or picked file brings its name; a pasted
// screenshot usually arrives as "image.png" or with no name at all, in which
// case there is nothing better to say than "image". Brackets and parens come
// out because they would end the markdown early.
function altFor(file) {
  const base = String(file.name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base && base.toLowerCase() !== 'image' ? base.slice(0, 80) : 'image';
}

// Splice text in at the caret and leave typing where it left off. In preview
// mode the textarea is hidden and its selection means nothing -- a caret at 0
// would drop the image above the title -- so it goes to the end instead.
function insertAtCursor(text) {
  const el = els.body;
  if (previewing) {
    const gap = el.value === '' || el.value.endsWith('\n') ? '' : '\n';
    el.value += `${gap}${text}`;
    paintPreview();
  } else {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    el.focus();
  }
  scheduleSave();
}

// Swap a placeholder for the finished markdown (or for nothing, if the upload
// failed) without disturbing anything typed since it went in. Found by index
// rather than by String.replace precisely because the alt text can contain a
// `$`, which a string-pattern replacement would read as a backreference.
function replacePlaceholder(token, text) {
  const el = els.body;
  const at = el.value.indexOf(token);
  if (at === -1) return false; // typed over, or the note was closed

  const caret = el.selectionStart;
  el.value = el.value.slice(0, at) + text + el.value.slice(at + token.length);

  if (previewing) {
    paintPreview();
  } else {
    // Only drag the caret along if the edit happened behind it.
    const shift = text.length - token.length;
    const next = caret > at ? Math.max(at, caret + shift) : caret;
    el.setSelectionRange(next, next);
  }
  scheduleSave();
  return true;
}

// POST the bytes straight through. Not via api(), which forces a JSON
// Content-Type -- and `application/json` is the one header this endpoint cannot
// accept, because the app-wide JSON parser would grab the body first.
async function uploadImage(file) {
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Client-Id': CLIENT_ID
    },
    body: file
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Put every image in the drop into the open note. Placeholders all go in first,
// in the order they arrived, so the finished images end up in that order no
// matter which upload lands first -- and so a slow upload never has to hold the
// caret still while you keep typing.
async function attachImages(fileList) {
  const files = [...(fileList ?? [])];
  const images = files.filter((file) => file.type.startsWith('image/'));

  if (images.length === 0) {
    if (files.length > 0) setStatus('Only images can go into a note');
    return;
  }
  if (currentId === null) {
    setStatus('Open or create a note first');
    return;
  }

  const queued = images.map((file) => ({
    file,
    token: `[uploading ${file.name || 'image'} (${humanBytes(file.size)})... #${++uploadSeq}]`
  }));
  insertAtCursor(`${queued.map((item) => item.token).join('\n')}\n`);

  // One at a time. Three screenshots racing for the same textarea is the kind
  // of bug that only shows up on someone else's machine.
  let failure = null;
  for (const { file, token } of queued) {
    try {
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `too large (${humanBytes(file.size)}; limit ${humanBytes(MAX_IMAGE_BYTES)})`
        );
      }
      setStatus(`Uploading ${file.name || 'image'}...`);
      const stored = await uploadImage(file);
      replacePlaceholder(token, `![${altFor(file)}](${stored.url})`);
    } catch (err) {
      replacePlaceholder(token, '');
      failure = err.message;
      console.error(err);
    }
  }

  // Commit now rather than on the debounce: an image is a deliberate act, and
  // the body is the only record of which file the note points at.
  await flush();
  // flush() reports "Saved", which is true but buries the part that is not.
  if (failure) setStatus(`Image failed -- ${failure}`);
}

// `types` rather than `items`: during a drag the browser withholds file
// contents and, from some sources, the per-item MIME type as well -- but it
// always says whether files are involved. The real filter happens on drop,
// where the File objects are readable.
function draggingFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

// dragleave fires every time the pointer crosses into a child element, so the
// highlight has to be reference-counted or it flickers off over the textarea.
let dragDepth = 0;

function endDrag() {
  dragDepth = 0;
  els.pane.classList.remove('drop-target');
}

// Live feed ---------------------------------------------------------------

// Most notes arrive from outside this browser (a Claude session POSTing a
// session summary), so the list has to react to the server, not to the user.
async function handleEvent(event) {
  // Our own edit, already applied locally.
  if (event.origin === CLIENT_ID) return;

  if (event.type === 'deleted' && event.id === currentId) {
    closeEditor();
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

els.pane.addEventListener('dragenter', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  els.pane.classList.add('drop-target');
});

els.pane.addEventListener('dragover', (event) => {
  if (!draggingFiles(event)) return;
  // Required. Without a preventDefault here the browser handles the drop
  // itself and navigates the page to the dropped file.
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

els.pane.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) endDrag();
});

els.pane.addEventListener('drop', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  endDrag();
  attachImages(event.dataTransfer.files).catch((err) => console.error(err));
});

// A screenshot on the clipboard arrives as a file alongside (or instead of) any
// text. Only take over the paste when there is actually an image in it --
// otherwise this is an ordinary text paste and the browser does it better.
els.body.addEventListener('paste', (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
    file.type.startsWith('image/')
  );
  if (images.length === 0) return;
  event.preventDefault();
  attachImages(images).catch((err) => console.error(err));
});

els.attachImage.addEventListener('click', () => els.imageInput.click());

els.imageInput.addEventListener('change', () => {
  const files = els.imageInput.files;
  // Clear it first: picking the same file twice in a row fires no change event
  // otherwise, which reads as a broken button.
  const picked = [...files];
  els.imageInput.value = '';
  attachImages(picked).catch((err) => console.error(err));
});

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

// Back and Forward move between the notes opened this visit. The URL is the
// source of truth here, so `push: false` -- the entry already exists, we are
// travelling to it rather than creating it.
window.addEventListener('popstate', () => {
  const id = idFromUrl();
  if (id === null) {
    // Walked back past the first note opened. Let go of it; the editor is only
    // ever a view of whatever the URL names.
    closeEditor();
    renderList();
    return;
  }
  open(id, { push: false }).catch((err) => console.error(err));
});

setPreview(localStorage.getItem(PREVIEW_KEY) === '1');
restorePrefs();
await refreshList();

// Open what the URL asks for, else the top of the list. A link can outlive the
// note it points at, so a failure here falls back rather than booting into a
// broken editor -- and it must not throw, because an unhandled rejection at
// this top level would skip connectStream() and leave the app with no live
// feed at all.
const requested = idFromUrl();
if (requested !== null) {
  try {
    await open(requested, { push: false });
  } catch (err) {
    console.error(`No note ${requested} -- it may have been deleted.`, err);
    syncUrl(null);
  }
}
if (currentId === null && notes.length > 0) {
  await open(notes[0].id, { push: false }).catch((err) => console.error(err));
}

connectStream();
