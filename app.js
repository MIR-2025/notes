import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import router from './router.js';
import { MEDIA_DIR, MEDIA_ROUTE } from './media.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 26715;

const app = express();

app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

// Uploaded images. Every URL here is a sha256 of its own content, so the bytes
// behind one can never change -- which is exactly the condition `immutable`
// asks for, and why this is the one thing in the app cached for longer than
// zero seconds. `nosniff` because the extension is derived from the magic bytes
// on the way in, so the declared type is the right one and guessing can only
// make it wrong.
app.use(
  MEDIA_ROUTE,
  express.static(MEDIA_DIR, {
    maxAge: '1y',
    immutable: true,
    index: false,
    dotfiles: 'ignore',
    setHeaders(res) {
      res.set('X-Content-Type-Options', 'nosniff');
    }
  })
);

// Serve the two browser ESM builds straight out of node_modules, so the app
// keeps working offline and the versions stay pinned in package.json.
const NODE_MODULES = join(__dirname, 'node_modules');
app.use('/vendor/marked', express.static(join(NODE_MODULES, 'marked/lib')));
app.use('/vendor/dompurify', express.static(join(NODE_MODULES, 'dompurify/dist')));

app.use(router);

// Express identifies error handlers by arity -- all four params must stay.
//
// body-parser raises its own failures with a `status` already on them -- 413 for
// a body over the limit, 400 for malformed JSON -- and reporting those as 500
// told an uploader "the server is broken" when the honest answer was "that file
// is too big." Anything without a status is still ours, and still a 500.
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500
    ? err.status
    : 500;
  // A client mistake is not worth a stack trace in the log; ours is.
  if (status === 500) console.error(err);

  const message =
    status === 413
      ? 'Too large'
      : status === 500
        ? 'Something went wrong'
        : 'Bad request';
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`notes listening on http://localhost:${PORT}`);
});
