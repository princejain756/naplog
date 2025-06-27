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