import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digestLogs, DigestError } from './digest.mjs';
import contract from './contract.json' with { type: 'json' };

const PORT = 3217;
const HOST = '127.0.0.1';
// JSON-escaping can inflate text up to 6 bytes per char; allow the full raw
// text limit in escaped form plus a small envelope margin.
const MAX_BODY_BYTES = contract.maxInputBytes * 6 + 512;

const SAMPLE_FILE = new URL('./sample.log', import.meta.url);

const STATIC_FILES = new Map([
  ['/', [new URL('./public/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/style.css', [new URL('./public/style.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/app.js', [new URL('./public/app.js', import.meta.url), 'text/javascript; charset=utf-8']],
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function setBaseHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function boundPort(server) {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : PORT;
}

function requestAllowed(server, req) {
  const port = boundPort(server);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = (req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (!allowedOrigins.has(origin)) return false;
  }
  return true;
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    // Keep draining after the limit so the socket stays usable and the client
    // still receives the 413 response.
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
        reject(new DigestError('too_large', `Request body over the ${limit} byte limit.`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function digestErrorStatus(err) {
  switch (err && err.code) {
    case 'bad_input':
      return 400;
    case 'timeout':
      return 504;
    case 'ollama_unreachable':
    case 'upstream_http':
    case 'invalid_model_output':
      return 502;
    default:
      return 500;
  }
}

export function createServer({ digest = digestLogs, statusFetch = globalThis.fetch } = {}) {
  let digestInFlight = false;

  async function handleStatus() {
    const tagsUrl = new URL('/api/tags', contract.ollamaUrl).href;
    try {
      const res = await statusFetch(tagsUrl, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const names = Array.isArray(body.models)
        ? body.models.map((m) => (m && typeof m.name === 'string' ? m.name : ''))
        : [];
      const ready = names.some((name) => name === contract.model);
      return {
        ready,
        model: contract.model,
        message: ready
          ? `Local model ${contract.model} is available.`
          : `Model not pulled yet. Run: ollama pull ${contract.model}`,
      };
    } catch {
      return {
        ready: false,
        model: contract.model,
        message: `Local Ollama is not reachable on ${new URL(contract.ollamaUrl).host}. Start it, then run: ollama pull ${contract.model}`,
      };
    }
  }

  async function handleDigest(req, res) {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(res, 415, { error: 'Content-Type must be application/json.', code: 'bad_type' });
      return;
    }
    let payload;
    try {
      const raw = await readRequestBody(req, MAX_BODY_BYTES);
      payload = JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'too_large') {
        sendJson(res, 413, { error: err.message, code: 'too_large' });
      } else {
        sendJson(res, 400, { error: 'Request body is not valid JSON.', code: 'bad_input' });
      }
      return;
    }
    if (!payload || typeof payload.text !== 'string') {
      sendJson(res, 400, { error: 'Body must be JSON with a "text" string.', code: 'bad_input' });
      return;
    }
    // Check and set back to back with no await between them, so two requests
    // that parse together still serialize on the single inference slot.
    if (digestInFlight) {
      sendJson(res, 429, {
        error: 'A digest is already running. Try again shortly.',
        code: 'busy',
      });
      return;
    }
    digestInFlight = true;
    try {
      const result = await digest(payload.text);
      sendJson(res, 200, result);
    } catch (err) {
      const status = digestErrorStatus(err);
      const code = err && err.code ? err.code : 'internal';
      // Only the safe, prepared error message crosses the wire; upstream bodies
      // and log contents are never echoed back or logged.
      const message = err instanceof DigestError ? err.message : 'Digest failed.';
      sendJson(res, status, { error: message, code });
    } finally {
      digestInFlight = false;
    }
  }

  const server = createHttpServer(async (req, res) => {
    setBaseHeaders(res);
    try {
      if (!requestAllowed(server, req)) {
        sendJson(res, 403, { error: 'Forbidden.', code: 'forbidden' });
        return;
      }
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

      if (pathname === '/api/status') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed.', code: 'method_not_allowed' });
          return;
        }
        sendJson(res, 200, await handleStatus());
        return;
      }

      if (pathname === '/api/sample') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed.', code: 'method_not_allowed' });
          return;
        }
        sendJson(res, 200, { text: await readFile(SAMPLE_FILE, 'utf8') });
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
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Naplog listening at http://${HOST}:${PORT}`);
  });
}
