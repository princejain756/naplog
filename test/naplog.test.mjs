import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLines, validateDigest, digestLogs } from '../digest.mjs';
import { createServer } from '../server.mjs';

const validIncident = {
  title: 'Database connection timeouts',
  observation: 'report-worker timed out three times at 5000ms.',
  nextCheck: 'Check whether the database accepted connections at that time.',
  evidence: [3, 5],
};

function okResponse(incidents) {
  return new Response(
    JSON.stringify({
      message: { role: 'assistant', content: JSON.stringify({ incidents }) },
      done: true,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('prepareLines', () => {
  test('rejects non-string and blank input', () => {
    assert.throws(() => prepareLines(42), /string/);
    assert.throws(() => prepareLines(''), /empty/i);
    assert.throws(() => prepareLines('   \n\t  \n'), /empty/i);
  });

  test('numbers lines by original position, skipping blanks', () => {
    const lines = prepareLines('alpha\n\n   \nbeta\n\ngamma');
    assert.deepEqual(lines, [
      { id: 1, text: 'alpha' },
      { id: 4, text: 'beta' },
      { id: 6, text: 'gamma' },
    ]);
  });

  test('enforces the line and byte limits', () => {
    const tooMany = Array.from({ length: 121 }, (_, i) => `line ${i}`).join('\n');
    assert.throws(() => prepareLines(tooMany), /120/);
    assert.throws(() => prepareLines('x'.repeat(65537)), /bytes/i);
  });
});

describe('validateDigest', () => {
  test('accepts a valid digest and empty incidents', () => {
    assert.doesNotThrow(() => validateDigest({ incidents: [validIncident] }));
    assert.doesNotThrow(() => validateDigest({ incidents: [] }));
  });

  test('rejects missing fields and bad evidence', () => {
    assert.throws(() => validateDigest(null));
    assert.throws(() => validateDigest({}), /incidents/);
    assert.throws(() => validateDigest({ incidents: [{ ...validIncident, title: ' ' }] }), /title/);
    assert.throws(() => validateDigest({ incidents: [{ ...validIncident, evidence: [] }] }), /evidence/);
    assert.throws(() => validateDigest({ incidents: [{ ...validIncident, evidence: ['3'] }] }), /evidence/);
  });
});

describe('digestLogs', () => {
  test('posts the numbered lines to the loopback endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return okResponse([validIncident]);
    };
    const result = await digestLogs('alpha\n\nerror beta', { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.stream, false);
    assert.equal(sent.messages[1].role, 'user');
    assert.ok(sent.messages[1].content.includes('3: error beta'));
    assert.deepEqual(result.lines, [
      { id: 1, text: 'alpha' },
      { id: 3, text: 'error beta' },
    ]);
    assert.equal(result.incidents.length, 1);
  });

  test('rejects HTTP errors and unparseable content', async () => {
    await assert.rejects(
      digestLogs('line', { fetchImpl: async () => new Response('boom', { status: 500 }) }),
      /HTTP 500/,
    );
    await assert.rejects(
      digestLogs('line', {
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: { content: 'nope' } }), { status: 200 }),
      }),
      /JSON/,
    );
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

  test('serves the static files the page needs', async () => {
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
  });

  test('answers unknown paths and wrong methods', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/digest`)).status, 405);
  });

  test('POST /api/digest validates content type and body', async () => {
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
  });
});
