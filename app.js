import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import router from './router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 26715;

const app = express();

app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

// Serve the two browser ESM builds straight out of node_modules, so the app
// keeps working offline and the versions stay pinned in package.json.
const NODE_MODULES = join(__dirname, 'node_modules');
app.use('/vendor/marked', express.static(join(NODE_MODULES, 'marked/lib')));
app.use('/vendor/dompurify', express.static(join(NODE_MODULES, 'dompurify/dist')));

app.use(router);

// Express identifies error handlers by arity -- all four params must stay.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`notes listening on http://localhost:${PORT}`);
});
