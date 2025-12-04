import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get as httpGet, request as httpRequest } from 'node:http';
import { prepareLines, validateDigest, digestLogs, DigestError } from '../digest.mjs';
import { createServer } from '../server.mjs';
import contract from '../contract.json' with { type: 'json' };

const validIncident = {
  title: 'Database connection timeouts',
  observation: 'report-worker timed out three times at 5000ms.',
  nextCheck: 'Check whether the database accepted connections at that time.',
  evidence: [3, 5],
};

function digestBody(incidents) {
  return JSON.stringify({
    message: { role: 'assistant', content: JSON.stringify({ incidents }) },
    done: true,
  });
}

function okResponse(incidents) {
  return new Response(digestBody(incidents), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function incidentWith(evidence) {
  return { ...validIncident, evidence };
}

function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
  });
}

function startPost(url, prefix) {
  const req = httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const done = new Promise((resolve, reject) => {
    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
  });
  req.write(prefix);
  return { req, done };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function postJson(url, value) {
  return fetch(`${url}/api/digest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

const stubDigestResult = {
  incidents: [],
  lines: [{ id: 1, text: 'line' }],
  model: 'stub-model',
  cached: false,
  elapsedMs: 1,
};

function stubFetch(behavior) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return behavior(url, init);
  };
  return { calls, fetchImpl };
}

describe('prepareLines', () => {
  test('rejects non-string input', () => {
    assert.throws(() => prepareLines(42), /string/);
    assert.throws(() => prepareLines(null), /string/);
    assert.throws(() => prepareLines(['line']), /string/);
  });

  test('rejects empty and whitespace-only input', () => {
    assert.throws(() => prepareLines(''), /empty/i);
    assert.throws(() => prepareLines('   \n\t  \n'), /empty/i);
  });

  test('rejects input over the UTF-8 byte limit', () => {
    const overBytes = '\u00e9'.repeat(contract.maxInputBytes / 2 + 1); // 2-byte chars
    assert.throws(() => prepareLines(overBytes), /bytes|size|large/i);
  });

  test('accepts input at the byte limit', () => {
    const atLimit = 'x'.repeat(contract.maxInputBytes);
    const lines = prepareLines(atLimit);
    assert.equal(lines.length, 1);
  });

  test('rejects more than the maximum nonempty lines', () => {
    const tooMany = Array.from({ length: contract.maxLines + 1 }, (_, i) => `line ${i}`).join('\n');
    assert.throws(() => prepareLines(tooMany), new RegExp(`${contract.maxLines}`));
    const atMax = Array.from({ length: contract.maxLines }, (_, i) => `line ${i}`).join('\n');
    assert.equal(prepareLines(atMax).length, contract.maxLines);
  });

  test('numbers lines by original position, skipping blanks', () => {
    const lines = prepareLines('alpha\n\n   \nbeta\n\ngamma');
    assert.deepEqual(lines, [
      { id: 1, text: 'alpha' },
      { id: 4, text: 'beta' },
      { id: 6, text: 'gamma' },
    ]);
  });

  test('masks unquoted key=value credentials', () => {
    const [line] = prepareLines('ERROR auth failed password=hunter2 status=500');
    assert.equal(line.text, 'ERROR auth failed password=[REDACTED] status=500');
  });

  test('masks quoted key=value credentials', () => {
    const [line] = prepareLines('ERROR token="abc def 123" api_key=\'sekret\'');
    assert.ok(!line.text.includes('abc def 123'));
    assert.ok(!line.text.includes('sekret'));
    assert.ok(line.text.includes('token=[REDACTED]'));
    assert.ok(line.text.includes('api_key=[REDACTED]'));
  });

  test('masks secret= values and Bearer tokens', () => {
    const [a] = prepareLines('WARN secret=t0psecret rest of line');
    assert.ok(a.text.includes('secret=[REDACTED]'));
    assert.ok(!a.text.includes('t0psecret'));
    const [b] = prepareLines('WARN auth Authorization: Bearer eyJhbGciOiJ9.payload.sig');
    assert.ok(b.text.includes('Bearer [REDACTED]'));
    assert.ok(!b.text.includes('eyJhbGciOiJ9'));
  });

  test('does not mask non-credential key=value pairs', () => {
    const [line] = prepareLines('INFO api health probe status=200 attempt=1');
    assert.equal(line.text, 'INFO api health probe status=200 attempt=1');
  });
});

describe('validateDigest', () => {
  const ids = new Set([1, 2, 3, 4, 5]);

  test('accepts a valid digest and empty incidents', () => {
    assert.doesNotThrow(() => validateDigest({ incidents: [validIncident] }, ids));
    assert.doesNotThrow(() => validateDigest({ incidents: [] }, ids));
  });

  test('rejects non-plain-objects and wrong top-level shape', () => {
    assert.throws(() => validateDigest(null, ids));
    assert.throws(() => validateDigest([], ids));
    assert.throws(() => validateDigest('x', ids));
    assert.throws(() => validateDigest({ incidents: [], extra: 1 }, ids), /extra|key/i);
    assert.throws(() => validateDigest({}, ids), /incidents/);
  });

  test('rejects unknown and missing incident keys', () => {
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, evil: true }] }, ids),
      /evil|key/i,
    );
    const { evidence, ...noEvidence } = validIncident;
    assert.throws(() => validateDigest({ incidents: [noEvidence] }, ids), /evidence/);
  });

  test('rejects empty and whitespace-only strings', () => {
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, title: '' }] }, ids),
      /title/,
    );
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, title: '   ' }] }, ids),
      /title/,
    );
  });

  test('enforces string length bounds', () => {
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, title: 't'.repeat(101) }] }, ids),
      /title/,
    );
    assert.throws(
      () =>
        validateDigest({ incidents: [{ ...validIncident, observation: 'o'.repeat(401) }] }, ids),
      /observation/,
    );
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, nextCheck: 'n'.repeat(251) }] }, ids),
      /nextCheck/,
    );
    assert.doesNotThrow(() =>
      validateDigest({ incidents: [{ ...validIncident, title: 't'.repeat(100) }] }, ids),
    );
  });

  test('allows at most five incidents', () => {
    const six = { incidents: Array(6).fill(validIncident) };
    assert.throws(() => validateDigest(six, ids), /5|incident/i);
    assert.doesNotThrow(() => validateDigest({ incidents: Array(5).fill(validIncident) }, ids));
  });

  test('rejects bad evidence arrays', () => {
    const bad = [
      { ...validIncident, evidence: [] },
      { ...validIncident, evidence: 'not-array' },
      { ...validIncident, evidence: [3, 3] },
      { ...validIncident, evidence: [3.5] },
      { ...validIncident, evidence: [0] },
      { ...validIncident, evidence: [-2] },
      { ...validIncident, evidence: [99] },
      { ...validIncident, evidence: ['3'] },
      { ...validIncident, evidence: Array.from({ length: 121 }, (_, i) => i + 1) },
    ];
    for (const incident of bad) {
      assert.throws(() => validateDigest({ incidents: [incident] }, ids), /evidence|line|id/i);
    }
  });

  test('accepts hostile HTML strings as inert text', () => {
    const hostile = {
      ...validIncident,
      title: '<img src=x onerror=alert(1)>',
      observation: '<script>alert(1)</script>',
    };
    assert.doesNotThrow(() => validateDigest({ incidents: [hostile] }, ids));
  });
});

describe('digestLogs', () => {
  const input = '2026-10-23T01:00:00Z INFO alpha\n\n2026-10-23T01:00:02Z ERROR beta failed';

  test('calls the fixed loopback endpoint with exact contract payload', async () => {
    const { calls, fetchImpl } = stubFetch(() => okResponse([incidentWith([1, 3])]));
    const result = await digestLogs(input + '\nunique-a', { fetchImpl });
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url, contract.ollamaUrl);
    assert.equal(init.method, 'POST');
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, contract.model);
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.format, contract.schema);
    assert.deepEqual(sent.options, contract.options);
    assert.equal(sent.messages.length, 2);
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[0].content, contract.systemPrompt);
    assert.equal(sent.messages[1].role, 'user');
    assert.ok(sent.messages[1].content.startsWith(contract.userPrefix));
    assert.ok(sent.messages[1].content.endsWith(contract.userSuffix));
    assert.ok(sent.messages[1].content.includes('3: 2026-10-23T01:00:02Z ERROR beta failed'));
    assert.equal(result.model, contract.model);
    assert.equal(result.cached, false);
    assert.equal(typeof result.elapsedMs, 'number');
    assert.deepEqual(result.lines, [
      { id: 1, text: '2026-10-23T01:00:00Z INFO alpha' },
      { id: 3, text: '2026-10-23T01:00:02Z ERROR beta failed' },
      { id: 4, text: 'unique-a' },
    ]);
  });

  test('rejects on HTTP errors without exposing upstream body', async () => {
    const upstream = 'password=hunter2 upstream detail';
    const { fetchImpl } = stubFetch(
      () => new Response(upstream, { status: 500 }),
    );
    await assert.rejects(digestLogs('line one\nhttp-fail-a', { fetchImpl }), (err) => {
      assert.ok(!String(err.message).includes('hunter2'));
      assert.ok(!String(err.message).includes('upstream detail'));
      return true;
    });
  });

  test('rejects invalid JSON envelope, done:false, and missing content', async () => {
    for (const [i, body] of [
      'not json at all',
      JSON.stringify({ message: { content: '{}' }, done: false }),
      JSON.stringify({ message: {}, done: true }),
      JSON.stringify({ done: true }),
    ].entries()) {
      const { fetchImpl } = stubFetch(() => new Response(body, { status: 200 }));
      await assert.rejects(digestLogs(`line\nbad-env-${i}`, { fetchImpl }));
    }
  });

  test('rejects non-JSON message.content and schema violations', async () => {
    const badContent = JSON.stringify({
      message: { content: 'sure, here is your summary' },
      done: true,
    });
    let { fetchImpl } = stubFetch(() => new Response(badContent, { status: 200 }));
    await assert.rejects(digestLogs('line\nbad-content-a', { fetchImpl }), /JSON|content/i);

    const badSchema = JSON.stringify({
      message: {
        content: JSON.stringify({ incidents: [{ ...validIncident, evidence: [77] }] }),
      },
      done: true,
    });
    ({ fetchImpl } = stubFetch(() => new Response(badSchema, { status: 200 })));
    await assert.rejects(digestLogs('line\nbad-schema-a', { fetchImpl }), /evidence|line|id/i);
  });

  test('rejects oversized response bodies', async () => {
    const huge = digestBody([incidentWith([1])]).padEnd(70 * 1024, ' ');
    const { fetchImpl } = stubFetch(() => new Response(huge, { status: 200 }));
    await assert.rejects(digestLogs('line\nhuge-body-a', { fetchImpl }), /size|large|limit/i);
  });

  test('maps fetch aborts to timeout failures', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    await assert.rejects(digestLogs('line\ntimeout-a', { fetchImpl }), /timeout|timed out/i);
  });

  test('maps mid-stream aborts to timeout failures', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new DOMException('The operation timed out', 'TimeoutError'));
      },
    });
    const { fetchImpl } = stubFetch(() => new Response(stream, { status: 200 }));
    await assert.rejects(digestLogs('line\nmidstream-a', { fetchImpl }), (err) => {
      assert.equal(err.code, 'timeout');
      return true;
    });
  });

  test('does not cache failures', async () => {
    let n = 0;
    const { calls, fetchImpl } = stubFetch(() => {
      n += 1;
      return new Response('boom', { status: 500 });
    });
    await assert.rejects(digestLogs('line\nnocache-a', { fetchImpl }));
    await assert.rejects(digestLogs('line\nnocache-a', { fetchImpl }));
    assert.equal(calls.length, 2);
  });

  test('caches repeated successful digests', async () => {
    const { calls, fetchImpl } = stubFetch(() => okResponse([incidentWith([1, 3])]));
    const first = await digestLogs('line\n\nline2\ncached-input-a', { fetchImpl });
    const second = await digestLogs('line\n\nline2\ncached-input-a', { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.incidents, first.incidents);
  });

  test('returns copies so callers cannot mutate the cache', async () => {
    const { fetchImpl } = stubFetch(() => okResponse([incidentWith([1, 2])]));
    const first = await digestLogs('line\nisolation-a', { fetchImpl });
    first.incidents[0].title = 'MUTATED';
    first.lines[0].text = 'MUTATED';
    const second = await digestLogs('line\nisolation-a', { fetchImpl });
    assert.equal(second.incidents[0].title, validIncident.title);
    assert.equal(second.lines[0].text, 'line');
  });
});

describe('http server', () => {
  let server;
  let base;

  before(async () => {
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  test('serves the static allowlist only', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /Naplog/);

    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /css/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    assert.equal((await fetch(`${base}/contract.json`)).status, 404);
    assert.equal((await fetch(`${base}/../contract.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/contract.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test('sets no-store and a restrictive same-origin CSP', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  });

  test('rejects unsupported methods and unknown routes correctly', async () => {
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/digest`)).status, 405);
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/missing`, { method: 'DELETE' })).status, 404);
  });

  test('validates Host and Origin headers', async () => {
    // undici fetch silently overrides Host, so spoof it with a raw request
    const badHost = await rawGet(`${base}/`, { host: 'evil.example.com' });
    assert.equal(badHost.statusCode, 403);
    const badOrigin = await fetch(`${base}/`, {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(badOrigin.status, 403);
    const goodOrigin = await fetch(`${base}/`, { headers: { origin: base } });
    assert.equal(goodOrigin.status, 200);
  });

  test('GET /api/sample returns the synthetic sample text', async () => {
    const res = await fetch(`${base}/api/sample`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.text.startsWith('2026-10-23T01:00:00Z INFO scheduler nightly-report started'));
    assert.equal(body.text, await readFile(new URL('../sample.log', import.meta.url), 'utf8'));
  });

  test('GET /api/status reports readiness shape without remote calls', async () => {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.ready, 'boolean');
    assert.equal(body.model, contract.model);
    assert.equal(typeof body.message, 'string');
    if (!body.ready) {
      assert.match(body.message, /ollama pull gemma3:4b/);
    }
  });

  test('POST /api/digest validates content type and body', async () => {
    const noType = await fetch(`${base}/api/digest`, { method: 'POST', body: '{}' });
    assert.equal(noType.status, 415);

    const wrongType = await fetch(`${base}/api/digest`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(wrongType.status, 415);

    const badJson = await fetch(`${base}/api/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(badJson.status, 400);

    const wrongShape = await fetch(`${base}/api/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 42 }),
    });
    assert.equal(wrongShape.status, 400);

    const tooBig = await fetch(`${base}/api/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(contract.maxInputBytes * 7) }),
    });
    assert.equal(tooBig.status, 413);
  });

  test('POST /api/digest accepts escaped text at the UTF-8 limit', async () => {
    const seen = [];
    const scoped = createServer({
      digest: async (text) => {
        seen.push(text);
        return stubDigestResult;
      },
    });
    await listen(scoped);
    try {
      const port = scoped.address().port;
      // control chars JSON-encode to 6 bytes each, so a body at the raw text
      // limit is ~6x larger on the wire and must still pass transport
      const text = '\u0001'.repeat(contract.maxInputBytes);
      const res = await postJson(`http://127.0.0.1:${port}`, { text });
      assert.equal(res.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].length, contract.maxInputBytes);
    } finally {
      scoped.close();
    }
  });

  test('serializes concurrent inference behind a per-server lock', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const scoped = createServer({
      digest: async () => {
        calls += 1;
        await gate;
        return stubDigestResult;
      },
    });
    await listen(scoped);
    try {
      const port = scoped.address().port;
      const base2 = `http://127.0.0.1:${port}`;
      // hold both bodies open so neither request can win the lock before the
      // other has at least reached the handler
      const a = startPost(`${base2}/api/digest`, '{"text":"one');
      const b = startPost(`${base2}/api/digest`, '{"text":"two');
      await new Promise((r) => setImmediate(r));
      a.req.end('"}');
      b.req.end('"}');
      // the loser responds 429 without waiting on the gated digest
      const first = await Promise.race([
        a.done.then((r) => ({ r, winner: b })),
        b.done.then((r) => ({ r, winner: a })),
      ]);
      assert.equal(first.r.status, 429);
      assert.equal(calls, 1);
      release();
      const winner = await first.winner.done;
      assert.equal(winner.status, 200);
      // the lock frees after success: a later request runs normally
      const third = await postJson(base2, { text: 'three' });
      assert.equal(third.status, 200);
      assert.equal(calls, 2);
    } finally {
      scoped.close();
    }
  });

  test('releases the digest lock after a digest failure', async () => {
    let calls = 0;
    const scoped = createServer({
      digest: async () => {
        calls += 1;
        if (calls === 1) throw new DigestError('bad_input', 'nope');
        return stubDigestResult;
      },
    });
    await listen(scoped);
    try {
      const port = scoped.address().port;
      const first = await postJson(`http://127.0.0.1:${port}`, { text: 'one' });
      assert.equal(first.status, 400);
      const second = await postJson(`http://127.0.0.1:${port}`, { text: 'two' });
      assert.equal(second.status, 200);
      assert.equal(calls, 2);
    } finally {
      scoped.close();
    }
  });

  test('GET /api/status requires the exact model tag', async () => {
    const scoped = createServer({
      statusFetch: async () =>
        new Response(JSON.stringify({ models: [{ name: 'gemma3:4b-it-qat' }] }), {
          status: 200,
        }),
    });
    await listen(scoped);
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${scoped.address().port}/api/status`);
    } finally {
      scoped.close();
    }
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.match(body.message, /ollama pull gemma3:4b/);

    const exact = createServer({
      statusFetch: async () =>
        new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }), { status: 200 }),
    });
    await listen(exact);
    try {
      res = await fetch(`http://127.0.0.1:${exact.address().port}/api/status`);
    } finally {
      exact.close();
    }
    assert.equal((await res.json()).ready, true);
  });

  test('POST /api/digest rejects bad log input with a useful error', async () => {
    const res = await fetch(`${base}/api/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   \n  ' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(body.code, 'bad_input');
  });
});
