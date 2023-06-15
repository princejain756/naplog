import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digestLogs } from './digest.mjs';

const PORT = 3217;
const HOST = '127.0.0.1';
// JSON-escaping can inflate text up to 6 bytes per char; allow the full raw
// text limit in escaped form plus a small envelope margin.
const MAX_BODY_BYTES = 65536 * 6 + 512;

const STATIC_FILES = new Map([
  ['/', [new URL('./public/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/style.css', [new URL('./public/style.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/app.js', [new URL('./public/app.js', import.meta.url), 'text/javascript; charset=utf-8']],
]);

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    // Keep draining after the limit so the socket stays usable and the client
    // still receives the response.
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(new Error('Request body too large.'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function handleDigest(req, res) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, { error: 'Content-Type must be application/json.', code: 'bad_type' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req, MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON.', code: 'bad_input' });
    return;
  }
  if (!payload || typeof payload.text !== 'string') {
    sendJson(res, 400, { error: 'Body must be JSON with a "text" string.', code: 'bad_input' });
    return;
  }
  try {
    sendJson(res, 200, await digestLogs(payload.text));
  } catch (err) {
    sendJson(res, 502, { error: err.message, code: 'digest_failed' });
  }
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (STATIC_FILES.has(pathname)) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed.', code: 'method_not_allowed' });
          return;
        }
        const [fileUrl, contentType] = STATIC_FILES.get(pathname);
        const contents = await readFile(fileUrl);
        res.writeHead(200, { 'content-type': contentType });
        res.end(contents);
        return;
      }

      if (pathname === '/api/digest') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed.', code: 'method_not_allowed' });
          return;
        }
        await handleDigest(req, res);
        return;
      }

      sendJson(res, 404, { error: 'Not found.', code: 'not_found' });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal error.', code: 'internal' });
      } else {
        res.end();
      }
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Naplog listening at http://${HOST}:${PORT}`);
  });
}
