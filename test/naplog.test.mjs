import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

let server;
let base;

before(() => {
  server = createServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(() => server.close());

test('serves the landing page', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Naplog/);
});
