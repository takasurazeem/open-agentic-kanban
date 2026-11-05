// Production server: serves the built UI from dist/ and the API on one port.
// Usage: npm run build && npm start   (PORT defaults to 5173)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiMiddleware } from './api.mjs';
import { DATA_FILE } from './store.mjs';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 5173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

http
  .createServer((req, res) =>
    apiMiddleware(req, res, () => {
      const url = new URL(req.url, 'http://local');
      let file = path.join(dist, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(dist, 'index.html');
      }
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
      // Hashed assets can be cached forever; the HTML must always be revalidated.
      res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
      fs.createReadStream(file).pipe(res);
    }),
  )
  .listen(port, () => {
    console.log(`Open Agentic Kanban on http://localhost:${port}  (data: ${DATA_FILE})`);
  });
