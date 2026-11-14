import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApi } from '../src/app.js';
import { DOCS } from '../src/openapi.js';

test('every registered route is documented, and every documentation entry has a route', async () => {
  const api = createApi(openDb(':memory:'), { version: '9.9.9' });
  const have = new Set(api.routes.map((r) => `${r.method} ${r.pattern}`));
  const missing = [...have].filter((k) => !(k in DOCS));
  const stale = Object.keys(DOCS).filter((k) => !have.has(k));
  assert.deepEqual(missing, [], `routes without docs in src/openapi.js: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `docs without a route: ${stale.join(', ')}`);
});

test('openapi.json is public and structurally valid; docs page is served inline', async () => {
  const api = createApi(openDb(':memory:'), { version: '9.9.9' });
  const spec = await api('GET', '/api/openapi.json', {}, {}, {});
  assert.equal(spec.openapi, '3.0.3');
  assert.equal(spec.info.version, '9.9.9');
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p));
  assert.equal(new Set(ops.map((o) => o.operationId)).size, ops.length);       // unique operation ids
  assert.ok(spec.paths['/api/networks/{id}/entries'].post.requestBody.content['application/json'].schema.required.includes('ip'));
  assert.deepEqual(spec.paths['/api/auth/login'].post.security, []);
  assert.equal(spec.paths['/api/networks/{id}'].get.parameters[0].in, 'path');
  assert.ok(!JSON.stringify(spec).includes('{id}}'));
  const docs = await api('GET', '/api/docs', {}, {}, {});
  assert.equal(docs.inline, true);
  assert.match(docs.raw, /simpleIPAM API/);
});
