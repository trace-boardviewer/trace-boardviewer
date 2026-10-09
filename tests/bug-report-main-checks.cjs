'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const contract = require('../shared/bug-report-contract.cjs');
const { createBugReportService, FEATURE, STATE_NAME, STATE_MAX_BYTES, RETENTION_MS, transportError } = require('../electron/bug-reports.cjs');

const ENDPOINT = 'https://trace-bug-report.trace-boardviewer.workers.dev/v1/reports';
const INPUT = Object.freeze({
  description: 'Synthetic issue 🧪', includeDiagnostics: true,
  context: { surface: 'board', lastImport: { outcome: 'failed', stage: 'parse', formatId: 'kicad', extensionClass: '.kicad_pcb', errorCode: 'INTERNAL' } },
});
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function memoryStore(seed = null) {
  const files = new Map(seed ? [[STATE_NAME, seed]] : []);
  return {
    files,
    async read(name) { return files.has(name) ? structuredClone(files.get(name)) : null; },
    async update(name, updater, options) {
      const next = await updater(files.has(name) ? structuredClone(files.get(name)) : null);
      assert.ok(Buffer.byteLength(JSON.stringify(next)) <= options.maxBytes);
      files.set(name, structuredClone(next));
      return structuredClone(next);
    },
    async flush() {},
  };
}
function ack(body, status = 201) {
  const report = JSON.parse(body);
  return { ok: true, status, headers: {}, body: Buffer.from(JSON.stringify({
    schema: contract.ACK_SCHEMA, reportId: report.reportId,
    payloadHash: crypto.createHash('sha256').update(body, 'utf8').digest('hex'), status: 'received',
  })) };
}
function setup({ store = memoryStore(), replies, enabled = true, now = () => 10_000_000, random = (() => { let n = 0; return () => uuid(++n); })(), egressCall, version = '1.3.1', language = 'hu' } = {}) {
  const calls = [];
  const egress = { request: async (...args) => { calls.push(args); return egressCall ? egressCall(...args) : (replies?.shift?.() ?? ack(args[2].body)); } };
  const service = createBugReportService({
    store, egress, getVersion: () => version, platform: 'linux', arch: 'x64', locale: () => language, now, randomUUID: random,
    config: { enabled, endpoint: ENDPOINT },
  });
  return { service, store, calls };
}

test('main report descriptor is fixed, action-only, exact-route and bounded', () => {
  assert.deepEqual(FEATURE, {
    id: 'bug-report', hosts: ['trace-bug-report.trace-boardviewer.workers.dev'], methods: ['POST'], paths: ['/v1/reports'],
    maxBytes: 1024, timeoutMs: 15_000, maxInFlight: 1, bodyStatuses: [200, 201], acceptedStatuses: [200, 201],
    responseHeaders: ['retry-after'], headers: { Accept: 'application/json' },
    requestBody: { contentType: 'application/json', maxBytes: 16_384 }, requiresUserAction: true,
  });
  assert.equal(STATE_MAX_BYTES, 24 * 1024);
  assert.equal(RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
});

test('prepare is local only, projects closed context and main-owned metadata, and returns exact canonical bytes', async () => {
  const { service, calls } = setup();
  const result = await service.prepare(INPUT);
  assert.equal(result.status, 'prepared');
  assert.equal(calls.length, 0, 'preview never sends');
  assert.equal(result.report.reportId, uuid(1));
  assert.deepEqual(result.report.diagnostics, {
    app: { version: '1.3.1', platform: 'linux', arch: 'x64' }, locale: 'hu', surface: 'board', lastImport: INPUT.context.lastImport,
  });
  assert.equal(result.canonicalText, contract.canonicalizeBugReport(result.report));
  assert.equal(result.payloadHash, crypto.createHash('sha256').update(result.canonicalText, 'utf8').digest('hex'));
});

test('diagnostics-off preview has null diagnostics, and malformed or oversized context is rejected before storage/network', async () => {
  const { service, calls } = setup();
  const off = await service.prepare({ ...INPUT, includeDiagnostics: false });
  assert.equal(off.report.diagnostics, null);
  const projected = await service.prepare({ ...INPUT, context: { surface: 'board', lastImport: { surprise: 'x'.repeat(100_000) } } });
  assert.equal(projected.status, 'prepared');
  assert.equal(projected.report.diagnostics.lastImport, null);
  assert.equal(projected.canonicalText.includes('surprise'), false);
  assert.equal((await service.prepare({ ...INPUT, description: 'x'.repeat(8193) })).status, 'error');
  assert.equal(calls.length, 0);
});

test('send writes the pending retry identity before one explicit request and validates exact durable acknowledgement', async () => {
  const { service, store, calls } = setup();
  const preview = await service.prepare(INPUT);
  const result = await service.send({ prepareId: preview.prepareId });
  assert.equal(result.status, 'received');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], FEATURE.id);
  assert.equal(calls[0][1], ENDPOINT);
  assert.equal(calls[0][2].method, 'POST');
  assert.equal(calls[0][2].body, preview.canonicalText);
  assert.equal(calls[0][2].userAction, true);
  assert.equal(calls[0][2].signal instanceof AbortSignal, true);
  assert.equal(store.files.get(STATE_NAME).pending, null, 'verified acknowledgement clears pending content');
  assert.equal(JSON.stringify(calls[0]).includes('Synthetic issue'), true, 'the exact user-approved body is the request body');
});

test('disabled endpoint and journal write failure make no transport call', async () => {
  const disabled = setup({ enabled: false });
  const preview = await disabled.service.prepare(INPUT);
  assert.equal((await disabled.service.send({ prepareId: preview.prepareId })).error, 'unavailable');
  assert.equal(disabled.calls.length, 0);
  const wrongEndpoint = setup({ enabled: true });
  wrongEndpoint.service = createBugReportService({
    store: wrongEndpoint.store, egress: { request: async (...args) => { wrongEndpoint.calls.push(args); return ack(args[2].body); } },
    getVersion: () => '1.3.1', config: { enabled: true, endpoint: 'https://evil.example/v1/reports' },
  });
  const wrongPreview = await wrongEndpoint.service.prepare(INPUT);
  assert.equal((await wrongEndpoint.service.send({ prepareId: wrongPreview.prepareId })).error, 'unavailable');
  assert.equal(wrongEndpoint.calls.length, 0);
  let writes = 0;
  const brokenStore = { async read() { return null; }, async update(_name, updater) { writes++; if (writes > 1) throw new Error('disk full'); return updater(null); } };
  const broken = setup({ store: brokenStore });
  const blockedPreview = await broken.service.prepare(INPUT);
  assert.equal((await broken.service.send({ prepareId: blockedPreview.prepareId })).error, 'storage');
  assert.equal(broken.calls.length, 0);
});

test('failed delivery keeps exact pending bytes and restart retry reuses the same report id and hash', async () => {
  let clock = 10_000_000;
  const store = memoryStore();
  const first = setup({ store, now: () => clock, egressCall: async () => ({ ok: false, error: 'network' }) });
  const prepared = await first.service.prepare(INPUT);
  assert.equal((await first.service.send({ prepareId: prepared.prepareId })).error, 'offline');
  const saved = structuredClone(store.files.get(STATE_NAME).pending);
  assert.equal(saved.canonicalText, prepared.canonicalText);
  const second = setup({ store, now: () => clock, version: '1.4.0', language: 'de' });
  const retry = await second.service.prepare(INPUT);
  assert.equal(retry.report.reportId, prepared.report.reportId);
  assert.equal(retry.canonicalText, prepared.canonicalText);
  assert.equal(retry.payloadHash, prepared.payloadHash);
  assert.equal((await second.service.send({ prepareId: retry.prepareId })).status, 'received');
});

test('restart retry compares normalized content and keeps exact canonical bytes for CRLF and control cleanup', async () => {
  const store = memoryStore();
  const first = setup({ store, egressCall: async () => ({ ok: false, error: 'network' }) });
  const input = { ...INPUT, description: 'Line one\nLine two' };
  const prepared = await first.service.prepare(input);
  await first.service.send({ prepareId: prepared.prepareId });
  const restarted = setup({ store, version: '9.8.7', language: 'fr' });
  const retry = await restarted.service.prepare({ ...INPUT, description: 'Line one\r\nLine\u0001 two' });
  assert.equal(retry.report.reportId, prepared.report.reportId);
  assert.equal(retry.canonicalText, prepared.canonicalText);
  assert.equal(retry.payloadHash, prepared.payloadHash);
});

test('editing after a send attempt creates new identity and exact preview; stale handles cannot send', async () => {
  const { service, calls } = setup({ egressCall: async () => ({ ok: false, error: 'timeout' }) });
  const first = await service.prepare(INPUT);
  assert.equal((await service.send({ prepareId: first.prepareId })).error, 'timeout');
  const edited = await service.prepare({ ...INPUT, description: 'Synthetic revised issue 🧪' });
  assert.notEqual(edited.report.reportId, first.report.reportId);
  assert.notEqual(edited.canonicalText, first.canonicalText);
  assert.equal((await service.send({ prepareId: first.prepareId })).error, 'stale-preview');
  assert.equal(calls.length, 1);
});

test('an old caller handle cannot clear a newer current preview', async () => {
  const client = setup();
  const oldPreview = await client.service.prepare(INPUT);
  const currentPreview = await client.service.prepare({ ...INPUT, description: 'Current preview' });
  assert.equal((await client.service.send({ prepareId: oldPreview.prepareId })).error, 'stale-preview');
  assert.equal((await client.service.send({ prepareId: currentPreview.prepareId })).status, 'received');
});

test('editing the diagnostic context after an attempt creates a new identity', async () => {
  const { service } = setup({ egressCall: async () => ({ ok: false, error: 'network' }) });
  const first = await service.prepare(INPUT);
  await service.send({ prepareId: first.prepareId });
  const changed = await service.prepare({ ...INPUT, context: { ...INPUT.context, surface: 'settings' } });
  assert.notEqual(changed.report.reportId, first.report.reportId);
  assert.equal(changed.report.diagnostics.surface, 'settings');
});

test('matching acknowledgement is required; 202, wrong id, wrong hash and extra keys never report received', async (t) => {
  for (const [name, response] of [
    ['202', (body) => ack(body, 202)],
    ['wrong id', (body) => ({ ...ack(body), body: Buffer.from(JSON.stringify({ ...JSON.parse(ack(body).body), reportId: uuid(99) })) })],
    ['wrong hash', (body) => ({ ...ack(body), body: Buffer.from(JSON.stringify({ ...JSON.parse(ack(body).body), payloadHash: 'f'.repeat(64) })) })],
    ['extra field', (body) => ({ ...ack(body), body: Buffer.from(JSON.stringify({ ...JSON.parse(ack(body).body), note: 'not allowed' })) })],
  ]) {
    await t.test(name, async () => {
      const client = setup({ egressCall: async (_id, _url, options) => response(options.body) });
      const preview = await client.service.prepare(INPUT);
      assert.equal((await client.service.send({ prepareId: preview.prepareId })).status, 'error');
      assert.ok(client.store.files.get(STATE_NAME).pending, 'uncertain/rejected delivery remains retryable');
    });
  }
});

test('cancel aborts only the current prepared send and reports post-attempt uncertainty', async () => {
  let started;
  const gate = new Promise((resolve) => { started = resolve; });
  const client = setup({ egressCall: async (_id, _url, options) => { started(); await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true })); return { ok: false, error: 'cancelled' }; } });
  const preview = await client.service.prepare(INPUT);
  const sending = client.service.send({ prepareId: preview.prepareId });
  await gate;
  assert.equal((await client.service.prepare({ ...INPUT, description: 'Synthetic B' })).error, 'busy');
  assert.equal((await client.service.saveDraft({ ...INPUT, description: 'Synthetic B' })).error, 'busy');
  assert.equal((await client.service.discardDraft()).error, 'busy');
  assert.equal((await client.service.send({ prepareId: 'b'.repeat(48) })).error, 'busy');
  assert.deepEqual(client.service.cancel({ prepareId: preview.prepareId }), { status: 'cancelled', uncertain: true });
  assert.equal((await sending).error, 'cancelled');
  assert.ok(client.store.files.get(STATE_NAME).pending);
});

test('window invalidation during deferred state read cannot resurrect a preview handle', async () => {
  let release;
  let entered;
  const enteredRead = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const base = memoryStore();
  const store = { ...base, async update(name, updater, options) { entered(); await gate; return base.update(name, updater, options); } };
  const client = setup({ store });
  const preparing = client.service.prepare(INPUT);
  await enteredRead;
  client.service.invalidateWindow();
  release();
  const result = await preparing;
  assert.equal(result.error, 'stale-preview');
  assert.equal((await client.service.send({ prepareId: '0'.repeat(48) })).error, 'stale-preview');
  assert.equal(client.calls.length, 0);
});

test('window invalidation during deferred journal write prevents the transport request', async () => {
  let release;
  let entered;
  let shouldBlock = false;
  const enteredWrite = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const base = memoryStore();
  const store = { ...base, async update(name, updater, options) {
    const next = await updater(base.files.has(name) ? structuredClone(base.files.get(name)) : null);
    if (shouldBlock && next.pending) { entered(); await gate; }
    base.files.set(name, structuredClone(next));
    return structuredClone(next);
  } };
  const client = setup({ store });
  const preview = await client.service.prepare(INPUT);
  shouldBlock = true;
  const sending = client.service.send({ prepareId: preview.prepareId });
  await enteredWrite;
  client.service.invalidateWindow();
  release();
  assert.equal((await sending).error, 'cancelled');
  assert.equal(client.calls.length, 0);
  assert.ok(store.files.get(STATE_NAME).pending);
});

test('draft storage failures report storage and keep the existing recoverable draft', async () => {
  const seed = memoryStore();
  const client = setup({ store: seed });
  assert.equal((await client.service.saveDraft(INPUT)).status, 'saved');
  const before = structuredClone(seed.files.get(STATE_NAME).draft);
  seed.update = async () => { throw new Error('disk full'); };
  const result = await client.service.saveDraft({ ...INPUT, description: 'New draft' });
  assert.deepEqual(result, { status: 'error', error: 'storage' });
  assert.deepEqual(seed.files.get(STATE_NAME).draft, before);
});

test('verified acknowledgement clears the matching saved draft and pending retry', async () => {
  const store = memoryStore();
  const first = setup({ store });
  assert.equal((await first.service.saveDraft(INPUT)).status, 'saved');
  const reopened = setup({ store });
  const saved = await reopened.service.getDraft();
  const preview = await reopened.service.prepare(saved.draft);
  assert.equal((await reopened.service.send({ prepareId: preview.prepareId })).status, 'received');
  assert.deepEqual(await reopened.service.getDraft(), { status: 'empty' });
});

test('verified acknowledgement wins cancel, navigation and shutdown during durable cleanup', async (t) => {
  for (const action of ['cancel', 'navigation', 'shutdown']) {
    await t.test(action, async () => {
      let release;
      let entered;
      let blockCleanup = false;
      const enteredCleanup = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const base = memoryStore();
      const store = { ...base, async update(name, updater, options) {
        const before = base.files.has(name) ? structuredClone(base.files.get(name)) : null;
        const next = await updater(before);
        if (blockCleanup && before?.pending && !next.pending) { entered(); await gate; }
        base.files.set(name, structuredClone(next));
        return structuredClone(next);
      } };
      const client = setup({ store });
      const preview = await client.service.prepare(INPUT);
      blockCleanup = true;
      const sending = client.service.send({ prepareId: preview.prepareId });
      await enteredCleanup;
      if (action === 'cancel') {
        assert.deepEqual(client.service.cancel({ prepareId: preview.prepareId }), { status: 'error', error: 'stale-preview' });
      } else if (action === 'navigation') client.service.invalidateWindow();
      else void client.service.beginShutdown();
      release();
      assert.equal((await sending).status, 'received');
      assert.equal(store.files.get(STATE_NAME).pending, null);
      assert.equal(store.files.get(STATE_NAME).draft, null);
    });
  }
});

test('unrelated blank and oversized saved drafts survive ack while their delivered retry is cleared', async (t) => {
  for (const description of ['', 'x'.repeat(3000)]) {
    await t.test(description.length ? 'oversized' : 'blank', async () => {
      const store = memoryStore();
      const client = setup({ store });
      const unrelatedDraft = { ...INPUT, description };
      assert.equal((await client.service.saveDraft(unrelatedDraft)).status, 'saved');
      const preview = await client.service.prepare(INPUT);
      assert.equal((await client.service.send({ prepareId: preview.prepareId })).status, 'received');
      const result = await client.service.getDraft();
      assert.equal(result.status, 'available');
      assert.deepEqual(result.draft, unrelatedDraft);
      assert.equal(result.pending, null);
    });
  }
});

test('valid acknowledgement stays received when cleanup storage fails and exact retry identity remains', async () => {
  const base = memoryStore();
  let failCleanup = false;
  const store = { ...base, async update(name, updater, options) {
    const before = base.files.has(name) ? structuredClone(base.files.get(name)) : null;
    const next = await updater(before);
    if (failCleanup && before?.pending && !next.pending) throw new Error('disk failure');
    base.files.set(name, structuredClone(next));
    return structuredClone(next);
  } };
  const first = setup({ store });
  const preview = await first.service.prepare(INPUT);
  failCleanup = true;
  assert.equal((await first.service.send({ prepareId: preview.prepareId })).status, 'received');
  const retained = store.files.get(STATE_NAME).pending;
  assert.equal(retained.canonicalText, preview.canonicalText);
  assert.equal(retained.payloadHash, preview.payloadHash);
  failCleanup = false;
  const reopened = setup({ store, version: '4.0.0', language: 'uk' });
  const retry = await reopened.service.prepare(INPUT);
  assert.equal(retry.report.reportId, preview.report.reportId);
  assert.equal(retry.canonicalText, preview.canonicalText);
  assert.equal(retry.payloadHash, preview.payloadHash);
});

test('discard explicitly clears an uncertain local retry journal without claiming remote deletion', async () => {
  const client = setup({ egressCall: async () => ({ ok: false, error: 'timeout' }) });
  const preview = await client.service.prepare(INPUT);
  assert.equal((await client.service.send({ prepareId: preview.prepareId })).error, 'timeout');
  assert.ok((await client.service.getDraft()).pending);
  assert.deepEqual(await client.service.discardDraft(), { status: 'discarded' });
  assert.deepEqual(await client.service.getDraft(), { status: 'empty' });
  assert.equal(client.calls.length, 1);
});

test('acknowledgement racing cancellation keeps the retry journal and never claims receipt', async () => {
  let requestStarted;
  let release;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const answer = new Promise((resolve) => { release = resolve; });
  const client = setup({ egressCall: async () => { requestStarted(); return answer; } });
  const preview = await client.service.prepare(INPUT);
  const sent = client.service.send({ prepareId: preview.prepareId });
  await started;
  client.service.cancel({ prepareId: preview.prepareId });
  release(ack(preview.canonicalText));
  assert.equal((await sent).error, 'cancelled');
  assert.equal(client.store.files.get(STATE_NAME).pending.canonicalText, preview.canonicalText);
});

test('navigation/close invalidates handles and aborts work; malformed handle payloads fail closed', async () => {
  const client = setup();
  const preview = await client.service.prepare(INPUT);
  assert.equal((await client.service.send({ prepareId: preview.prepareId, url: ENDPOINT })).error, 'invalid');
  client.service.invalidateWindow();
  assert.equal((await client.service.send({ prepareId: preview.prepareId })).error, 'stale-preview');
  const next = await client.service.prepare(INPUT);
  await client.service.beginShutdown();
  assert.equal((await client.service.send({ prepareId: next.prepareId })).error, 'stale-preview');
});

test('transport failures map to closed errors with numeric bounded manual retry delay only', () => {
  assert.deepEqual(transportError({ error: 'http-status', status: 429, headers: { 'retry-after': '0' } }), { status: 'error', error: 'rate-limited', retryAfterSeconds: 1 });
  assert.deepEqual(transportError({ error: 'http-status', status: 503, headers: { 'retry-after': '99999' } }), { status: 'error', error: 'rate-limited', retryAfterSeconds: 3600 });
  assert.deepEqual(transportError({ error: 'http-status', status: 409 }), { status: 'error', error: 'conflict' });
  assert.deepEqual(transportError({ error: 'http-status', status: 413 }), { status: 'error', error: 'too-large' });
  assert.deepEqual(transportError({ error: 'network' }), { status: 'error', error: 'offline' });
});

test('expired persisted state is ignored and accepted draft content remains bounded', async () => {
  const now = 100_000_000;
  const stale = memoryStore({ version: 1, draft: { version: 1, savedAt: now - RETENTION_MS - 1, input: INPUT }, pending: null });
  const client = setup({ store: stale, now: () => now });
  assert.deepEqual(await client.service.getDraft(), { status: 'empty' });
  assert.equal((await client.service.saveDraft(INPUT)).status, 'saved');
  assert.deepEqual((await client.service.getDraft()).draft, INPUT);
});

test('malformed saved state is reported unavailable and preserved byte-for-byte', async () => {
  const corrupted = { version: 99, draft: { private: 'preserve this value' }, pending: null };
  const store = memoryStore(corrupted);
  const client = setup({ store });
  assert.equal((await client.service.getDraft()).error, 'storage');
  assert.deepEqual(store.files.get(STATE_NAME), corrupted);
});

test('source wiring keeps all six IPC handlers main-owned, enables only the fixed report receiver and packages only the shared contract', async () => {
  const root = path.resolve(__dirname, '..');
  const [main, preload, packageJson, config] = await Promise.all([
    fs.readFile(path.join(root, 'electron/main.cjs'), 'utf8'), fs.readFile(path.join(root, 'electron/preload.cjs'), 'utf8'),
    fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse), fs.readFile(path.join(root, 'electron/bug-report-config.json'), 'utf8').then(JSON.parse),
  ]);
  for (const channel of ['prepare', 'send', 'cancel', 'draft-get', 'draft-save', 'draft-discard']) assert.match(main, new RegExp(`handle\\('trace:bug-report-${channel}'`));
  for (const name of ['prepareBugReport', 'sendBugReport', 'cancelBugReport', 'getBugReportDraft', 'saveBugReportDraft', 'discardBugReportDraft']) assert.match(preload, new RegExp(`${name}:`));
  assert.deepEqual(config, { enabled: true, endpoint: ENDPOINT });
  assert.ok(packageJson.build.files.includes('shared/bug-report-contract.cjs'));
  assert.equal(packageJson.build.files.some((file) => file.startsWith('services/bug-report-worker') || file.startsWith('tests/bug-report-')), false);
  assert.doesNotMatch(main, /issues\/new\?template=bug_report\.yml/);
});
