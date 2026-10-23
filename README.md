# notes

A minimal, single-user note-taking app. Plain text in, markdown out, everything
stored locally in SQLite. No accounts, no cloud, no build step.

## Features

- **Two-pane UI** -- a searchable, sortable list next to a distraction-free
  editor.
- **Autosave** -- saves ~600ms after you stop typing. No save button to hunt for.
- **Deep links** -- `/?id=123` opens that note directly. The param tracks
  whatever is on screen, so the address bar is always a copyable link to the
  note you are reading, and Back / Forward step through the ones you opened.
- **No title field** -- the first line of a note becomes its title.
- **Markdown preview** (`Ctrl+E`) -- GitHub-flavored markdown, sanitized with
  DOMPurify so pasted HTML can never execute.
- **Live updates** -- the list refreshes in real time over Server-Sent Events,
  so notes created by another tab (or another process posting to the API) appear
  without a reload. An incoming change never clobbers what you're typing.
- **Images** -- paste a screenshot, drop a file, or use the Image button. The
  bytes go to `data/media/` under their own sha256, the note carries a short
  `/media/<sha>.png` link, and the same image pasted twice is stored once.
- **Download** -- any note as a `.md` file, or every note as a `.zip` of `.md`
  files (respecting the active search filter), with the images those notes use
  bundled in a `media/` folder and their links rewritten to point at it. The zip
  writer is dependency-free.
- **Search** -- an FTS5 full-text index over titles and bodies, with a substring
  scan behind it so searching the middle of a word still works.
- **Sort** -- seven orderings from the dropdown under the search box: best match
  (bm25 relevance, weighted toward the title), edited or created in either
  direction, and title A-Z or Z-A. The pin button beside it decides whether
  pinned notes head the list or sort in with the rest. Both choices persist.

## Stack

Node's built-in `node:sqlite` (no native module to compile), Express, EJS, and
vanilla JS. The only runtime dependencies are `express`, `ejs`, `marked`, and
`dompurify`.

Requires **Node >= 22.5** (for `node:sqlite`).

## Run

```bash
npm install
npm start        # http://localhost:26715
```

The database is created on first run at `data/notes.db` (git-ignored). Override
its location with the `DB_PATH` environment variable, the image store with
`MEDIA_DIR`, or the port with `PORT`.

## Images

An uploaded image is named after the sha256 of its own bytes, so a URL's content
can never change and the file is served with a one-year immutable cache. The
same screenshot in five notes is one file on disk.

png, jpg, gif, webp and avif, up to 10MB, recognised by their magic bytes rather
than by the `Content-Type` the caller sent. **SVG is refused on purpose**: an SVG
can carry `<script>`, and it would be served from this app's own origin, so
opening one directly would run that script against the notes API.

Because an image can be shared by several notes, nothing is deleted when a note
is. `POST /api/media/sweep` lists what no note references any more (anything
stored in the last hour is spared, since it may be mid-edit); send
`{"delete": true}` to actually remove them.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl/Cmd + N` | New note |
| `Ctrl/Cmd + K` | Focus search |
| `Ctrl/Cmd + E` | Toggle markdown preview |
| `Ctrl/Cmd + S` | Force save now |
| `Ctrl/Cmd + P` | Save the open note as a PDF |
| `Ctrl/Cmd + ↑ / ↓` | Step through the sort orders |

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/notes?q=` | List / search notes (summaries -- no bodies; `&full=1` for bodies). `&sort=` and `&pinned=mixed` set the order; the `X-Sort` response header names the order actually applied |
| `POST` | `/api/notes` | Create a note (`{ body }`) |
| `GET` | `/api/notes/:id` | Fetch one note |
| `PUT` | `/api/notes/:id` | Update a note (`{ body }`) |
| `PATCH` | `/api/notes/:id/pin` | Pin / unpin (`{ pinned }`) |
| `DELETE` | `/api/notes/:id` | Delete a note |
| `GET` | `/api/notes/:id/download` | Download one note as `.md` |
| `GET` | `/api/export?q=` | Download all (matching) notes as a `.zip`; takes the same `sort` / `pinned` params |
| `GET` | `/api/stream` | Server-Sent Events feed of changes |
| `POST` | `/api/media` | Upload an image -- the raw bytes as the body, any `image/*` Content-Type. Returns `{ name, url, type, bytes, deduped }` |
| `GET` | `/api/media` | List stored images, each flagged `referenced` or not |
| `POST` | `/api/media/sweep` | List unreferenced images; `{"delete": true}` removes them |
