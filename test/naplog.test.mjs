import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLines, validateDigest, digestLogs, DigestError } from '../digest.mjs';
import { createServer } from '../server.mjs';
import contract from '../contract.json' with { type: 'json' };

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

  test('enforces the line and byte limits from the contract', () => {
    const tooMany = Array.from({ length: contract.maxLines + 1 }, (_, i) => `line ${i}`).join('\n');
    assert.throws(() => prepareLines(tooMany), new RegExp(`${contract.maxLines}`));
    assert.throws(() => prepareLines('x'.repeat(contract.maxInputBytes + 1)), /bytes/i);
  });
});

describe('validateDigest', () => {
  const ids = new Set([1, 2, 3, 4, 5]);

  test('accepts a valid digest and empty incidents', () => {
    assert.doesNotThrow(() => validateDigest({ incidents: [validIncident] }, ids));
    assert.doesNotThrow(() => validateDigest({ incidents: [] }, ids));
  });

  test('rejects non-plain-objects and unknown top-level keys', () => {
    assert.throws(() => validateDigest(null, ids));
    assert.throws(() => validateDigest([], ids));
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

  test('rejects empty strings and enforces length bounds', () => {
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, title: '   ' }] }, ids),
      /title/,
    );
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, title: 't'.repeat(101) }] }, ids),
      /title/,
    );
    assert.throws(
      () => validateDigest({ incidents: [{ ...validIncident, nextCheck: 'n'.repeat(251) }] }, ids),
      /nextCheck/,
    );
  });

  test('allows at most five incidents', () => {
    assert.throws(
      () => validateDigest({ incidents: Array(6).fill(validIncident) }, ids),
      /5|incident/i,
    );
    assert.doesNotThrow(() => validateDigest({ incidents: Array(5).fill(validIncident) }, ids));
  });

  test('rejects bad evidence arrays', () => {
    const bad = [
      { ...validIncident, evidence: [] },
      { ...validIncident, evidence: 'not-array' },
      { ...validIncident, evidence: [3, 3] },
      { ...validIncident, evidence: [3.5] },
      { ...validIncident, evidence: [0] },
      { ...validIncident, evidence: [99] },
      { ...validIncident, evidence: ['3'] },
    ];
    for (const incident of bad) {
      assert.throws(() => validateDigest({ incidents: [incident] }, ids), /evidence|line|id/i);
    }
  });
});

describe('digestLogs', () => {
  test('posts the numbered lines to the loopback endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return okResponse([{ ...validIncident, evidence: [1, 3] }]);
    };
    const result = await digestLogs('alpha\n\nerror beta', { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, contract.ollamaUrl);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.options, contract.options);
    assert.ok(sent.messages[1].content.includes('3: error beta'));
    assert.deepEqual(result.lines, [
      { id: 1, text: 'alpha' },
      { id: 3, text: 'error beta' },
    ]);
    assert.equal(result.incidents.length, 1);
  });

  test('rejects on HTTP errors without exposing the upstream body', async () => {
    await assert.rejects(
      digestLogs('line', {
        fetchImpl: async () => new Response('password=hunter2 upstream detail', { status: 500 }),
      }),
      (err) => {
        assert.equal(err.code, 'upstream_http');
        assert.ok(!err.message.includes('hunter2'));
        return true;
      },
    );
  });

  test('rejects an unparseable or incomplete envelope', async () => {
    for (const body of [
      'not json at all',
      JSON.stringify({ message: { content: '{}' }, done: false }),
      JSON.stringify({ message: {}, done: true }),
    ]) {
      await assert.rejects(
        digestLogs('line', { fetchImpl: async () => new Response(body, { status: 200 }) }),
        (err) => err.code === 'invalid_model_output',
      );
    }
  });

  test('rejects non-JSON content and out-of-range evidence', async () => {
    const badContent = JSON.stringify({ message: { content: 'all good' }, done: true });
    await assert.rejects(
      digestLogs('line', { fetchImpl: async () => new Response(badContent, { status: 200 }) }),
      (err) => err.code === 'invalid_model_output',
    );

    const badSchema = JSON.stringify({
      message: { content: JSON.stringify({ incidents: [{ ...validIncident, evidence: [77] }] }) },
      done: true,
    });
    await assert.rejects(
      digestLogs('line', { fetchImpl: async () => new Response(badSchema, { status: 200 }) }),
      /evidence|line|id/i,
    );
  });

  test('maps fetch aborts to timeout failures', async () => {
    await assert.rejects(
      digestLogs('line', {
        fetchImpl: async () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        },
      }),
      (err) => err.code === 'timeout',
    );
  });

  test('reaches the fixed loopback endpoint, never a remote one', async () => {
    let seen;
    await digestLogs('line', {
      fetchImpl: async (url) => {
        seen = url;
        return okResponse([]);
      },
    });
    assert.equal(new URL(seen).host, '127.0.0.1:11434');
  });

  test('raises DigestError, not a bare Error', async () => {
    await assert.rejects(
      digestLogs('  ', { fetchImpl: async () => okResponse([]) }),
      DigestError,
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

  test('POST /api/digest rejects bad log input with a useful code', async () => {
    const res = await fetch(`${base}/api/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   \n  ' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'bad_input');
  });
});