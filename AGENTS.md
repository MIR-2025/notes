# Posting to Notes (for AI agents)

Notes is a tiny notes store an AI agent writes to and a human reads. This file is the
contract: how you -- an agent -- should post, so a person can read your work cold weeks
later and find one clean record per thing, not a pile of duplicates.

The base URL is wherever the app is running. Default: `http://localhost:26715`
(set by the `PORT` env var). Examples below use `$BASE` for that.

```sh
BASE=http://localhost:26715
```

## The contract (the whole API you need)

A note is just **markdown in a `body`**. That's the entire write payload -- one field,
JSON. The app derives everything else.

- **`POST /api/notes`** with `{"body": "<markdown>"}` creates a note, returns it with
  its `id`. Keep that `id`.
- **`PUT /api/notes/:id`** with `{"body": "<markdown>"}` replaces the body of an
  existing note (see the update discipline below -- read first, then write the whole
  revised body).
- **The first line of the body becomes the title.** The app strips a leading `#` and
  trims it. So *lead with a scannable one-liner* -- that line is how a human finds your
  note in the list.

## Identify yourself: the `X-Agent` header

Always send **`X-Agent: <name>`** on every write. Use something stable and meaningful
-- the project or repo you're working in (`brave-ext`, `kit`, `notes`). The app records
it as the note's author and shows *"Updated by \<name\>"* live in the reader's open tab,
so the human can tell which agent wrote which note. Without it the write still succeeds,
just unattributed.

```sh
curl -s -X POST "$BASE/api/notes" \
  -H 'Content-Type: application/json' \
  -H 'X-Agent: brave-ext' \
  -d '{"body": "Session 2026-08-02 -- brave-ext -- Split Screen New grid fix\n\nRewrote newGridPill()..."}'
```

## The discipline (this is what keeps the store useful)

1. **Lead with a scannable title line.** Convention for a session recap:
   `Session YYYY-MM-DD -- <project> -- <the headline>`. Convert relative dates to
   absolute -- "yesterday" is meaningless in a month.

2. **One record per session, updated in place -- not one per hand-back.** Keep the `id`
   from your first `POST`. When you finish again later in the same session,
   `PUT /api/notes/:id` with the *full revised body* rather than posting a near-duplicate.

3. **Lost the id? Find, don't duplicate.** `GET /api/notes?q=<today + project>` and update
   the matching note. Only create a new one if there genuinely isn't a match. A rare
   duplicate beats a lost summary -- but search first.

4. **Read before you overwrite -- never a blind `PUT`.** `GET /api/notes/:id`, merge your
   new content into the existing body, then `PUT` the whole thing. A bare `PUT` that
   ignores what's already there erases prior work.

5. **Post at the finish line.** The moment you complete the work and are handing control
   back with no pending question -- that "I'm done, over to you" beat -- post or refresh
   the note then. Pausing only to ask a question is *not* a finish; hold the note until
   the work is actually done.

6. **Write it for a human reading cold.** What changed, what was decided and *why*, what
   broke and how it was fixed, what's still open. Not a changelog, not a transcript.

7. **Artifacts and transcripts get their own notes.** A standalone deliverable (a letter,
   a memo, a plan, any real document) is its own note, titled by what it is -- not folded
   into the session recap. A substantive conversation worth keeping goes in its own note,
   verbatim, separate from any analysis of it.

8. **Do not hard-wrap prose. One paragraph = one line.** Let the paragraph run long and
   let the reader's window do the wrapping. Do *not* wrap it yourself at 80/90/100
   columns the way you would a source file.

   Why: the reader renders a single newline as a real line break, because in a *note* a
   line break usually is deliberate. So every column you wrap at becomes a permanent
   `<br>` -- the note reads fine in the app but carries hard breaks mid-sentence into
   anything it is pasted into, and they never reflow. The renderer now unwraps the
   obvious cases, but it is a heuristic recovering information you threw away; writing
   one paragraph per line means it never has to guess.

   ```md
   Bad -- hard-wrapped, every wrap point becomes a <br>:
   The list endpoint was returning every note's full body, which meant a few
   hundred notes serialized into megabytes of JSON on every refresh.

   Good -- one line, wraps naturally wherever it is read:
   The list endpoint was returning every note's full body, which meant a few hundred notes serialized into megabytes of JSON on every refresh.
   ```

   **Keep your line breaks where they are meaningful** -- list items, verbatim
   transcripts and DM logs, addresses, code inside fences. Those are content, and they
   are preserved exactly. This rule is only about *prose paragraphs*.

## Full endpoint reference

| Method | Path | Body / query | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/notes` | `?q=<term>`, `?sort=<key>`, `?pinned=mixed`, `?full=1` (all optional) | List notes; `q` searches title + body. Default order is pinned first, then best match (which means newest first when there is no `q`). Rows carry an `excerpt`, **not** the full `body` -- add `full=1` if you really need every body. |
| `GET` | `/api/notes/:id` | -- | Fetch one note. |
| `POST` | `/api/notes` | `{"body": "..."}` | Create. Returns the note (with `id`). `201`. |
| `PUT` | `/api/notes/:id` | `{"body": "..."}` | Replace the body. Re-derives the title, bumps `updated_at`. |
| `PATCH` | `/api/notes/:id/pin` | `{"pinned": true\|false}` | Pin / unpin. Deliberately leaves `author` untouched. |
| `DELETE` | `/api/notes/:id` | -- | Delete. `204`. |
| `GET` | `/api/notes/:id/download` | -- | The note as a `.md` file. |
| `GET` | `/api/export` | `?q=<term>`, `?sort=<key>`, `?pinned=mixed` (all optional) | Every note as a `.md`, zipped. |
| `GET` | `/api/stream` | -- | SSE feed of `created` / `updated` / `deleted` events (for live UIs). |
| `POST` | `/api/media` | the raw image bytes | Upload an image. Returns `{ name, url, type, bytes, deduped }`. |
| `GET` | `/api/media` | -- | Every stored image, each flagged `referenced` or not. |
| `POST` | `/api/media/sweep` | `{"delete": true}` (optional) | List unreferenced images; with `delete` set, remove them. |

Notes:

- **Link to what you wrote.** `POST` returns the note's `id`, and the reader opens
  a single note at **`/?id=<id>`** -- so `http://localhost:26715/?id=1053` is a direct
  link to note 1053. When you tell a human you have written something up, give them
  that URL rather than making them search the list for it. An `id` that no longer
  exists falls back to the normal view instead of erroring.
- **Headers.** `X-Agent: <name>` on writes (author byline, above). `X-Client-Id: <id>` is
  optional and only for interactive UIs -- the SSE stream echoes it back so a browser can
  skip its own edits. Agents can ignore it.
- **The list has no bodies.** `GET /api/notes` returns a summary per note -- every column
  except `body`, plus a short `excerpt` for display. With a few hundred notes the full-body
  list was multiple megabytes per request. To read a note, `GET /api/notes/:id`, which is
  what the update discipline above already tells you to do. `?full=1` restores the old
  shape if you genuinely want every body in one response.
- **Search is full-text.** `q` runs against an FTS5 index: it matches whole words and
  prefixes, so `q=mir dev` finds "MIR dev log" and `q=sess` finds "Session". If that
  finds nothing it falls back to a substring scan, so searching the middle of a word
  still works -- just slower.
- **Sorting.** `?sort=` takes one of `relevance` (the default), `updated_desc`,
  `updated_asc`, `created_desc`, `created_asc`, `title_asc`, `title_desc`. An
  unrecognised value is ignored rather than rejected, so a typo gets you the default
  rather than a `400`.
  - `relevance` is the FTS5 bm25 score, weighted 10:1 toward the title, so a note
    *about* a term beats one that mentions it in passing. It needs a full-text match to
    score: with no `q`, or on the substring fallback, it quietly becomes `updated_desc`.
    That is why it can be the standing default -- on an unfiltered list it just means
    "newest first."
  - The **`X-Sort` response header** on `GET /api/notes` names the ordering actually
    applied, which is how you tell a real ranking from that fallback. The response body
    is still a bare array; nothing about the JSON changed.
  - `?pinned=mixed` stops pinned notes heading the list and lets them sort with
    everything else. Omit it for the old behaviour.
- **Markdown.** Bodies are rendered as GitHub-flavored markdown (sanitized) in the reader.
  Write real markdown -- headings, lists, code fences all work.
- **No auth.** This app ships with no authentication because it's meant to be run locally
  (bound to your own machine). Do **not** expose it to the public internet as-is -- an
  open write endpoint is an abuse magnet. If you need off-box access, put it behind a
  guard (a reverse proxy with a token, a VPN, Cloudflare Access) first.

## Posting an image

A note can carry images, and you can put them there. Upload the bytes, get back a
URL, write the URL into the body as ordinary markdown. Useful when the thing
worth recording is a screenshot -- a UI you just changed, a graph, a failing
render -- rather than a description of one.

```sh
URL=$(curl -s -X POST "$BASE/api/media" \
        -H 'Content-Type: image/png' -H "X-Agent: $AGENT" \
        --data-binary @screenshot.png \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["url"])')

# ...then just reference it in the body like any other markdown image.
# "![the sidebar after the fix]($URL)"
```

Things worth knowing:

- **The bytes are the body.** Not multipart, not JSON, not base64 -- `--data-binary`
  and an `image/*` Content-Type. The one header that will NOT work is
  `application/json`: the app-wide JSON parser grabs that body first and chokes.
  The format is decided by sniffing the magic bytes, so the header only has to
  avoid being JSON.
- **png, jpg, gif, webp, avif. Up to 10MB.** Anything else is a `415`, a body
  over the limit is a `413`. **SVG is refused deliberately** -- it can carry
  `<script>` and would be served from this app's own origin.
- **The URL is a sha256 of the content**, so uploading the same image twice is
  free and returns the same URL with `"deduped": true`. Never a duplicate file.
- **Do not inline a data: URI instead.** It would land in the note body, which
  means in the FTS index, in the browser's textarea, and re-sent on every
  autosave. A link is ~90 characters; a screenshot is megabytes.
- **Nothing is deleted when a note is**, because several notes can share one
  file. `POST /api/media/sweep` lists what is unreferenced; `{"delete": true}`
  removes it. Images stored in the last hour are spared.

## Minimal lifecycle example

```sh
BASE=http://localhost:26715
AGENT=my-project

# 1. Start of session work done -> create, capture the id
ID=$(curl -s -X POST "$BASE/api/notes" \
      -H 'Content-Type: application/json' -H "X-Agent: $AGENT" \
      -d '{"body":"Session 2026-08-02 -- my-project -- first pass\n\nDid X and Y."}' \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# 2. Later, more done -> read current body, append, PUT the whole thing back
BODY=$(curl -s "$BASE/api/notes/$ID" | python3 -c 'import sys,json; print(json.load(sys.stdin)["body"])')
curl -s -X PUT "$BASE/api/notes/$ID" \
  -H 'Content-Type: application/json' -H "X-Agent: $AGENT" \
  -d "$(python3 -c 'import json,sys; b=sys.argv[1]+"\n\n## Update\nAlso did Z."; print(json.dumps({"body":b}))' "$BODY")"
```
