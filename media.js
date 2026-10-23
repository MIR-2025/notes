// The media store: where an image's bytes live, and how a note refers to them.
//
// Content-addressed. A file's name IS the sha256 of its bytes, so the same
// screenshot pasted into five notes is stored once, a URL's content can never
// change under it (which is what lets it be cached forever), and nothing in
// here has to invent, sequence or collide over a filename.
//
// Note bodies hold a short text URL -- `/media/<sha256>.<ext>` -- and never the
// bytes. That is the whole reason this file exists rather than inlining a data:
// URI: the body is what gets re-PUT on every pause in typing, indexed by FTS,
// and shown in the textarea. Base64 in there would make all three much worse.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Under data/ deliberately: that path is already gitignored, already inside the
// nightly restic backup of this tree, and sits next to the database whose notes
// point at it -- so a copy of data/ is a complete copy of the store.
export const MEDIA_DIR = process.env.MEDIA_DIR || join(__dirname, 'data', 'media');

mkdirSync(MEDIA_DIR, { recursive: true });

// Where the files are served from, and therefore the prefix that ends up
// written into note bodies. Both of those read it from here.
export const MEDIA_ROUTE = '/media';

// A screenshot is a few hundred KB; a phone photo is three or four MB. Ten is
// generous without making an accidental drop of a video file anyone's problem.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Formats are recognised by their magic bytes, never by the Content-Type the
// caller claimed -- the extension we store decides the Content-Type we later
// serve it back as, so it has to be derived from the bytes themselves.
//
// SVG is deliberately absent, and not by oversight. An SVG is a document: it
// can carry <script>, and it would be served from this app's own origin, so
// opening one directly would run that script with full access to the notes API.
// Raster formats only. A diagram belongs in a PNG here.
const FORMATS = [
  {
    ext: 'png',
    type: 'image/png',
    test: (b) => b.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n'
  },
  {
    ext: 'jpg',
    type: 'image/jpeg',
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  {
    ext: 'gif',
    type: 'image/gif',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'
  },
  {
    // RIFF container, with the form type four bytes after the size field.
    ext: 'webp',
    type: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP'
  },
  {
    // ISO-BMFF: the `ftyp` box comes first, its brand immediately after.
    ext: 'avif',
    type: 'image/avif',
    test: (b) =>
      b.subarray(4, 8).toString('latin1') === 'ftyp' &&
      ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1'))
  }
];

const EXTENSIONS = FORMATS.map((format) => format.ext);

// 64 hex characters and one of our own extensions. This pattern is doing two
// jobs: it is how a reference is spotted inside a note body, and it is the only
// validation a filename gets before it is joined onto MEDIA_DIR -- a name that
// matches this cannot contain a slash, a dot-dot, or anything else that would
// walk out of the directory.
const NAME_SOURCE = `[0-9a-f]{64}\\.(?:${EXTENSIONS.join('|')})`;

export const MEDIA_NAME = new RegExp(`^${NAME_SOURCE}$`);

// `g`, because every consumer wants all of the matches. String.matchAll and
// String.replace both work from a clone, so there is no lastIndex to reset.
const MEDIA_REF = new RegExp(`${MEDIA_ROUTE}/(${NAME_SOURCE})`, 'g');

// The full `![alt](/media/...)` form, for collapsing one to its alt text.
const IMAGE_REF = new RegExp(`!\\[([^\\]]*)\\]\\(${MEDIA_ROUTE}/${NAME_SOURCE}\\)`, 'g');

export const SUPPORTED_IMAGE_TYPES = FORMATS.map((format) => format.type);

// Which format these bytes are, or null for anything not on the list above.
// Twelve bytes is the longest signature we check and far smaller than any real
// image, so a shorter buffer is simply not one.
export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return FORMATS.find((format) => format.test(buffer)) ?? null;
}

// Store the bytes and hand back how a note should refer to them. Null means the
// bytes are not an image we serve.
export function storeMedia(buffer) {
  const format = sniff(buffer);
  if (!format) return null;

  const name = `${createHash('sha256').update(buffer).digest('hex')}.${format.ext}`;
  const path = join(MEDIA_DIR, name);
  const deduped = existsSync(path);

  if (!deduped) {
    // Write beside the target and rename into place. A rename within one
    // directory is atomic, so a crash or a second upload of the same image
    // mid-write can never leave a truncated file sitting at a name that
    // promises the hash of the whole thing.
    const partial = `${path}.${process.pid}.part`;
    writeFileSync(partial, buffer);
    renameSync(partial, path);
  }

  return {
    name,
    url: `${MEDIA_ROUTE}/${name}`,
    type: format.type,
    bytes: buffer.length,
    // True when this image was already here. Worth saying out loud: it is why
    // re-pasting the same screenshot costs nothing.
    deduped
  };
}

// The path a stored file lives at, or null if it is not there. Also the guard
// that keeps a caller-supplied name from reaching the filesystem unchecked.
export function mediaFile(name) {
  if (!MEDIA_NAME.test(String(name ?? ''))) return null;
  const path = join(MEDIA_DIR, name);
  return existsSync(path) ? path : null;
}

// Every media file this text points at. Takes a note body (or any string).
export function referencedIn(text) {
  const names = new Set();
  for (const [, name] of String(text ?? '').matchAll(MEDIA_REF)) names.add(name);
  return names;
}

// Everything in the store, newest first. Anything that does not match the
// content-addressed shape is ignored rather than reported -- a stray .part from
// an interrupted write is not a media file.
export function listMedia() {
  return readdirSync(MEDIA_DIR)
    .filter((name) => MEDIA_NAME.test(name))
    .map((name) => {
      const { size, mtime } = statSync(join(MEDIA_DIR, name));
      return {
        name,
        url: `${MEDIA_ROUTE}/${name}`,
        bytes: size,
        stored_at: mtime.toISOString()
      };
    })
    .sort((a, b) => b.stored_at.localeCompare(a.stored_at));
}

export function removeMedia(name) {
  const path = mediaFile(name);
  if (!path) return false;
  unlinkSync(path);
  return true;
}

// Absolute `/media/...` URLs only resolve while this app is running, so an
// export rewrites them relative to the media/ folder travelling in the zip.
// From a .md file at the zip root, `media/<name>` lands on exactly that folder.
export function toRelativeMedia(text) {
  return String(text ?? '').replace(MEDIA_REF, (_match, name) => `media/${name}`);
}

// An image reference is ~90 characters of content hash, which would swallow the
// whole one-line preview under a note's title. The alt text is what a human
// wanted to read there anyway.
//
// The only caller passes a fixed-length SLICE of a body, so a reference can be
// cut in half by the slice boundary and leave a run of hex with no closing
// paren -- hence the second pass, which only ever fires at the very end of the
// string. Anything shorter than eight hex characters is left alone: that is not
// recognisably a hash, and it could be real text.
export function summarizeMedia(text) {
  return String(text ?? '')
    .replace(IMAGE_REF, (_match, alt) => `[${alt.trim() || 'image'}]`)
    .replace(
      new RegExp(`(?:!\\[[^\\]]*\\]\\()?${MEDIA_ROUTE}/[0-9a-f]{8,}[^\\s)]*$`),
      '[image]'
    );
}
