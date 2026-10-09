'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createEgress, ERROR_CLASSES } = require('../electron/net/egress.cjs');

const HOST = 'reports.example.org';
const URL = `https://${HOST}/v1/reports`;
const BODY = '{"schema":"trace-bug-report/1","description":"Synthetic report 🧪"}';
const POST_FEATURE = Object.freeze({
  id: 'bug-report', hosts: [HOST], methods: ['POST'], paths: ['/v1/reports'], maxBytes: 1024, timeoutMs: 2000, maxInFlight: 1,
  headers: { Accept: 'application/json' }, responseHeaders: ['retry-after'], bodyStatuses: [200, 201], acceptedStatuses: [200, 201],
  requestBody: { contentType: 'application/json', maxBytes: 128 }, requiresUserAction: true,
});

function make({ fetchImpl = async () => new Response('{"ok":true}', { status: 201 }), feature = POST_FEATURE, ...options } = {}) {
  const layer = createEgress({ fetchImpl, version: '1.3.1', ...options });
  layer.register(feature);
  return layer;
}

test('POST requires a strictly bounded JSON feature and action-only policy', () => {
  assert.throws(() => createEgress({ fetchImpl: async () => new Response(null), version: '1.3.1' }).register({ ...POST_FEATURE, requestBody: undefined }));
  for (const patch of [
    { requestBody: { contentType: 'text/plain', maxBytes: 20 } },
    { requestBody: { contentType: 'application/json', maxBytes: 16385 } },
    { requestBody: { contentType: 'application/json', maxBytes: 20, headers: {} } },
    { requiresUserAction: false },
    { acceptedStatuses: undefined },
    { acceptedStatuses: [202] },
    { methods: ['GET', 'POST'], requiresUserAction: true },
    { methods: ['HEAD', 'POST'], requiresUserAction: true },
  ]) assert.throws(() => createEgress({ fetchImpl: async () => new Response(null), version: '1.3.1' }).register({ ...POST_FEATURE, ...patch }));
});

test('POST sends only canonical string bytes with fixed content type; body never enters results or activity', async () => {
  let observed;
  const layer = make({ fetchImpl: async (_url, init) => { observed = init; return new Response('{"ack":true}', { status: 201 }); } });
  const result = await layer.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true });
  assert.equal(result.ok, true);
  assert.equal(observed.method, 'POST');
  assert.equal(observed.body, BODY);
  assert.equal(observed.headers['Content-Type'], 'application/json');
  assert.equal(observed.credentials, 'omit');
  assert.equal(observed.redirect, 'error');
  assert.equal(JSON.stringify(result).includes(BODY), false);
  assert.equal(JSON.stringify(layer.activity()).includes(BODY), false);
  assert.equal(layer.activity().entries[0].bytes, Buffer.byteLength('{"ack":true}'));
});

test('POST rejects missing action, arbitrary options, GET bodies, binary values, malformed Unicode and oversized UTF-8 before fetch', async () => {
  let calls = 0;
  const layer = make({ fetchImpl: async () => { calls++; return new Response(null, { status: 201 }); } });
  for (const options of [
    { method: 'POST', body: BODY },
    { method: 'POST', body: BODY, userAction: true, headers: {} },
    { method: 'POST', body: Buffer.from(BODY), userAction: true },
    { method: 'POST', body: '\ud800', userAction: true },
    { method: 'POST', body: '{ "a":1}', userAction: true },
    { method: 'POST', body: '{"a":"\\ud800"}', userAction: true },
    { method: 'POST', body: JSON.stringify({ nested: Array.from({ length: 33 }, () => null).reduce((value) => ({ value }), null) }), userAction: true },
    { method: 'POST', body: '🧪'.repeat(33), userAction: true },
    { method: 'GET', body: BODY, userAction: true },
  ]) {
    const result = await layer.request('bug-report', URL, options);
    assert.equal(result.ok, false);
    assert.ok(['not-allowed', 'too-large', 'method'].includes(result.error), `unexpected result for ${String(options.method)}: ${result.error}`);
  }
  assert.equal(calls, 0);
});

test('POST checks cheap and exact UTF-8 bounds before parsing or walking JSON', async () => {
  let calls = 0;
  const bytes = Buffer.byteLength(BODY, 'utf8');
  const exact = make({ feature: { ...POST_FEATURE, requestBody: { contentType: 'application/json', maxBytes: bytes } }, fetchImpl: async () => { calls++; return new Response('{}', { status: 201 }); } });
  assert.equal((await exact.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true })).ok, true);

  const tooSmall = make({ feature: { ...POST_FEATURE, requestBody: { contentType: 'application/json', maxBytes: bytes - 1 } }, fetchImpl: async () => { calls++; return new Response('{}', { status: 201 }); } });
  assert.deepEqual(await tooSmall.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true }), { ok: false, error: 'too-large' });

  // This is valid canonical JSON, but too large. The parser/stringifier sentinels prove refusal precedes JSON work.
  const oversizedCanonical = JSON.stringify({ value: 'x'.repeat(200) });
  const bounded = make({ fetchImpl: async () => { calls++; return new Response('{}', { status: 201 }); } });
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  let jsonWork = 0;
  try {
    JSON.parse = (...args) => { jsonWork++; return parse(...args); };
    JSON.stringify = (...args) => { jsonWork++; return stringify(...args); };
    assert.deepEqual(await bounded.request('bug-report', URL, { method: 'POST', body: oversizedCanonical, userAction: true }), { ok: false, error: 'too-large' });
  } finally {
    JSON.parse = parse;
    JSON.stringify = stringify;
  }
  assert.equal(jsonWork, 0);
  assert.equal(calls, 1);
});

test('only configured accepted HTTP statuses succeed; rejected status exposes only a bounded numeric Retry-After', async () => {
  const rateLimited = make({ fetchImpl: async () => new Response('private response text', { status: 429, headers: { 'retry-after': '999999', 'content-type': 'text/plain' } }) });
  const result = await rateLimited.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true });
  assert.deepEqual(result, { ok: false, error: 'http-status', status: 429, headers: { 'retry-after': '3600' } });
  assert.equal(JSON.stringify(rateLimited.activity()).includes('private response text'), false);
  const invalidRetry = make({ fetchImpl: async () => new Response('ignored', { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2030 07:28:00 GMT' } }) });
  assert.deepEqual(await invalidRetry.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true }), { ok: false, error: 'http-status', status: 503, headers: {} });
  for (const status of [202, 204, 400, 500]) {
    const rejected = make({ fetchImpl: async () => new Response(null, { status }) });
    assert.equal((await rejected.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true })).error, 'http-status');
  }
  for (const status of [200, 201]) {
    const accepted = make({ fetchImpl: async () => new Response('{}', { status }) });
    assert.equal((await accepted.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true })).ok, true);
  }
});

test('persisted opt-in cannot satisfy action-only admission and same-host path redirects are refused', async () => {
  let calls = 0;
  const actionFeature = { ...POST_FEATURE, optIn: { setting: 'reportsEnabled' } };
  const layer = make({ feature: actionFeature, isEnabled: () => true, fetchImpl: async () => { calls++; return new Response('{}', { status: 201 }); } });
  assert.deepEqual(await layer.request('bug-report', URL, { method: 'POST', body: BODY }), { ok: false, error: 'not-allowed' });
  assert.equal((await layer.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true })).ok, true);
  assert.equal(calls, 1);

  const redirected = make({ fetchImpl: async () => {
    const response = new Response('{}', { status: 201 });
    Object.defineProperty(response, 'url', { value: `https://${HOST}/other` });
    return response;
  } });
  assert.deepEqual(await redirected.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true }), { ok: false, error: 'redirect' });
});

test('pre-aborted request makes no fetch and reports closed cancelled outcome', async () => {
  let calls = 0;
  const layer = make({ fetchImpl: async () => { calls++; return new Response('{}', { status: 201 }); } });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await layer.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true, signal: controller.signal }), { ok: false, error: 'cancelled' });
  assert.equal(calls, 0);
  assert.equal(layer.activity().entries[0].error, 'cancelled');
  assert.ok(ERROR_CLASSES.includes(layer.activity().entries[0].error));
});

test('in-flight cancellation wins against fetch and response readers that ignore abort; place is released once', async () => {
  const controller = new AbortController();
  let calls = 0;
  let finishLate;
  const layer = make({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finishLate = resolve; });
    return new Response('{}', { status: 201 });
  } });
  const first = layer.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
  assert.equal((await layer.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true })).ok, true);
  finishLate(new Response('late', { status: 201 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.activity().entries[0].error, 'cancelled');

  const bodyController = new AbortController();
  const neverReader = { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) };
  const stalledBody = make({ fetchImpl: async () => ({ status: 201, headers: new Headers(), body: { getReader: () => neverReader } }) });
  const pending = stalledBody.request('bug-report', URL, { method: 'POST', body: BODY, userAction: true, signal: bodyController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  bodyController.abort();
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
});

test('legacy GET status semantics remain transport-success semantics', async () => {
  const layer = createEgress({ version: '1.3.1', fetchImpl: async () => new Response('no receipt', { status: 404 }) });
  layer.register({ id: 'legacy-check', hosts: [HOST], methods: ['GET'], paths: ['/v1/reports'], maxBytes: 100, timeoutMs: 1000 });
  const result = await layer.request('legacy-check', URL);
  assert.equal(result.ok, true);
  assert.equal(result.status, 404);
  assert.equal(result.body, null);
});

test('bodyless legacy GET, HEAD and download reject every supplied body value before transport or disk', async () => {
  let fetches = 0;
  let mkdirs = 0;
  const fakeFs = { mkdir: async () => { mkdirs++; }, lstat: async () => ({ isDirectory: () => true }) };
  const downloadDirectory = path.join(os.tmpdir(), 'trace-egress-private-downloads');
  assert.equal(path.isAbsolute(downloadDirectory), true);
  const layer = createEgress({ version: '1.3.1', downloadDirectory, fs: fakeFs, fetchImpl: async () => { fetches++; return new Response('x'); } });
  layer.register({ id: 'legacy-read', hosts: [HOST], methods: ['GET'], maxBytes: 100, timeoutMs: 1000 });
  layer.register({ id: 'legacy-head', hosts: [HOST], methods: ['HEAD'], maxBytes: 100, timeoutMs: 1000 });
  const enabledDownloadFeature = { id: 'legacy-download', hosts: [HOST], methods: ['GET'], maxBytes: 100, timeoutMs: 1000, download: { maxBytes: 100, extension: 'bin' } };
  assert.deepEqual(enabledDownloadFeature.download, { maxBytes: 100, extension: 'bin' });
  layer.register(enabledDownloadFeature);
  for (const body of [undefined, null, '']) {
    assert.deepEqual(await layer.request('legacy-read', URL, { body }), { ok: false, error: 'not-allowed' });
    assert.deepEqual(await layer.request('legacy-head', URL, { body }), { ok: false, error: 'not-allowed' });
    assert.deepEqual(await layer.download('legacy-download', URL, { body }), { ok: false, error: 'not-allowed' });
  }
  assert.equal(fetches, 0);
  assert.equal(mkdirs, 0);
});
