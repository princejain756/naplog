import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = 3217;
const HOST = '127.0.0.1';

const STATIC_FILES = new Map([
  ['/', [new URL('./public/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/style.css', [new URL('./public/style.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/app.js', [new URL('./public/app.js', import.meta.url), 'text/javascript; charset=utf-8']],
]);

export function createServer() {
  return createHttpServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const entry = STATIC_FILES.get(pathname);
    if (entry) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed.');
        return;
      }
      const [fileUrl, contentType] = entry;
      res.writeHead(200, { 'content-type': contentType });
      res.end(await readFile(fileUrl));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Naplog listening at http://${HOST}:${PORT}`);
  });
}
