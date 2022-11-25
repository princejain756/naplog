import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = 3217;
const HOST = '127.0.0.1';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Naplog</title>
</head>
<body>
  <h1>Naplog</h1>
  <p>Let the logs wait.</p>
  <p>A morning brief from local AI, built from a pasted batch of log lines.</p>
</body>
</html>
`;

export function createServer() {
  return createHttpServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
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
