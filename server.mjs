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
