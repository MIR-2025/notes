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

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text));
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
  printArea: document.getElementById('print-area')
};

const SAVE_DELAY = 600;
const PREVIEW_KEY = 'notes:preview';

// Identifies this tab so the live feed can skip the echo of our own edits.
const CLIENT_ID = crypto.randomUUID();

let notes = [];
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
  const rest = note.body.split('\n').slice(1).join(' ').trim();
  return rest || 'No additional text';
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

async function refreshList() {
  const query = els.search.value.trim();
  notes = await api(`/api/notes?q=${encodeURIComponent(query)}`);
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

  const note = notes.find((n) => n.id === id) ?? (await api(`/api/notes/${id}`));
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
    await refreshList();
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
  await refreshList();
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
  // Respect the active search filter: what you see is what you export.
  const query = els.search.value.trim();
  triggerDownload(`/api/export${query ? `?q=${encodeURIComponent(query)}` : ''}`);
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
    if (dirty) {
      // Never clobber what is being typed -- the unsaved text wins, and the
      // next autosave will overwrite the other change.
      setStatus('Changed elsewhere -- your unsaved edits are kept');
    } else if (event.note.body !== els.body.value) {
      const caret = els.body.selectionStart;
      els.body.value = event.note.body;
      els.body.setSelectionRange(caret, caret);
      if (previewing) paintPreview();
      setStatus(`Updated elsewhere ${formatDate(event.note.updated_at)}`);
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

els.body.addEventListener('input', scheduleSave);
els.newNote.addEventListener('click', createNote);
els.pin.addEventListener('click', togglePin);
els.del.addEventListener('click', removeNote);
els.togglePreview.addEventListener('click', () => setPreview(!previewing));
els.download.addEventListener('click', downloadCurrent);
els.pdf.addEventListener('click', printCurrent);
els.exportAll.addEventListener('click', exportAll);

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
  } else if (event.key === 'p' && currentId !== null) {
    // Route the native print shortcut through our flow so it saves first and
    // prints just the note, not the whole app chrome.
    event.preventDefault();
    printCurrent();
  }
});

// Best-effort save when the tab is hidden or closed mid-edit. fetch() with
// keepalive survives teardown; a normal one gets cancelled.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !dirty || currentId === null) return;
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
await refreshList();
if (notes.length > 0) await open(notes[0].id);
connectStream();
