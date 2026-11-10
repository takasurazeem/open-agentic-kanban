// Production server: serves the built UI from dist/ and the API on one port.
// Usage: npm run build && npm start   (PORT defaults to 5173)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiMiddleware } from './api.mjs';
import { DATA_DIR } from './store.mjs';
import { flushAll } from './gitsync.mjs';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1'; // local only by default; there is no auth
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
  .listen(port, host, () => {
    console.log(`Open Agentic Kanban on http://${host}:${port}  (data: ${DATA_DIR})`);
  });

// Commit any pending data changes before exiting (launchd / Ctrl-C).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => flushAll().finally(() => process.exit(0)));
}
