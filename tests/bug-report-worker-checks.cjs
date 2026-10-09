'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const contract = require('../shared/bug-report-contract.cjs');
const workerModule = require('../services/bug-report-worker/worker.mjs');
const worker = workerModule.worker || workerModule.default;
const schema = fs.readFileSync(path.join(__dirname, '../services/bug-report-worker/schema.sql'), 'utf8');

// Native SQLite-backed D1 statement wrapper, including batching in one transaction.
function sqliteD1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-bug-report-'));
  const db = new DatabaseSync(path.join(dir, 'reports.sqlite'));
  db.exec(schema);
  const wrap = (sql, values = []) => ({
    bind(...next) { return wrap(sql, next); },
    run() { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
    first() { return db.prepare(sql).get(...values) || null; },
    all() { return { results: db.prepare(sql).all(...values) }; }
  });
  return {
    dir, db,
    prepare: sql => wrap(sql),
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(statement => statement.run()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

function report(id = crypto.randomUUID(), description = 'Synthetic report') {
  return { schema: contract.SCHEMA, reportId: id, description, diagnostics: null };
}
function request(body, options = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', Origin: 'null', 'CF-Connecting-IP': options.ip || '192.0.2.4', ...(options.headers || {}) });
  const method = options.method || 'POST';
  return new Request(options.url || 'https://receiver.example/v1/reports', {
    method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: options.rawBody !== undefined ? options.rawBody : JSON.stringify(body) })
  });
}
async function send(db, value, options = {}) { return worker.fetch(request(value, options), { BUG_REPORT_DB: db }); }
function count(db, sql, ...args) { return Number(db.prepare(sql).get(...args).n); }

test('fixed route, method, origin and media policy reject public read paths', async () => {
  const store = sqliteD1();
  try {
    for (const [url, method, status] of [
      ['https://receiver.example/reports', 'GET', 404],
      ['https://receiver.example/v1/reports?list=1', 'POST', 400],
      ['https://receiver.example/v1/reports', 'OPTIONS', 405],
      ['https://receiver.example/v1/reports', 'GET', 405]
    ]) assert.equal((await worker.fetch(request({}, { url, method }), { BUG_REPORT_DB: store })).status, status);
    assert.equal((await send(store, report(), { headers: { Origin: 'https://site.example' } })).status, 403);
    assert.equal((await send(store, report(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await worker.fetch(request(report(), { headers: { 'Content-Encoding': 'gzip' } }), { BUG_REPORT_DB: store })).status, 415);
    assert.equal((await worker.fetch(request(report(), { headers: { Origin: 'null' } }), {})).status, 503);
  } finally { store.close(); }
});

test('invalid UTF-8, oversized content, deep JSON and unknown fields fail before storage', async () => {
  const store = sqliteD1();
  try {
    const invalid = await worker.fetch(new Request('https://receiver.example/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0xff]) }), { BUG_REPORT_DB: store });
    assert.equal(invalid.status, 400);
    const large = await worker.fetch(new Request('https://receiver.example/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(16385) }), { BUG_REPORT_DB: store });
    assert.equal(large.status, 413);
    const deepText = '{"a":'.repeat(10) + '0' + '}'.repeat(10);
    assert.equal((await worker.fetch(request(null, { rawBody: deepText }), { BUG_REPORT_DB: store })).status, 400);
    assert.equal((await send(store, { ...report(), path: '/private/board.brd' })).status, 400);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports'), 0);
  } finally { store.close(); }
});

test('stream deadline, absent Origin and D1 failures have bounded fixed outcomes', async () => {
  const store = sqliteD1();
  try {
    const timeoutRequest = new Request('https://receiver.example/v1/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({ start() {} }), duplex: 'half'
    });
    const started = Date.now();
    const timed = await worker.fetch(timeoutRequest, { BUG_REPORT_DB: store });
    assert.equal(timed.status, 400);
    assert.ok(Date.now() - started < 7000);
    assert.equal((await worker.fetch(request(report(), { headers: { Origin: null } }), { BUG_REPORT_DB: store })).status, 201);
    const failingDb = { prepare() { throw new Error('synthetic database failure'); } };
    const failed = await worker.fetch(request(report()), { BUG_REPORT_DB: failingDb });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'temporarily_unavailable' });
  } finally { store.close(); }
});

test('HTTP source bucket accepts twenty requests per window and rejects the next', async () => {
  const store = sqliteD1();
  try {
    const results = await Promise.all(Array.from({ length: 21 }, (_, i) => send(store, report(crypto.randomUUID(), `Synthetic ${i}`), { ip: '198.51.100.9' })));
    assert.equal(results.filter(result => result.status === 201).length, 20);
    const denied = results.find(result => result.status === 429);
    assert.ok(denied);
    assert.equal(denied.headers.get('Retry-After'), '60');
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports'), 20);
  } finally { store.close(); }
});

test('SQLite commit, durable acknowledgement, duplicate idempotency and changed-payload conflict', async () => {
  const store = sqliteD1();
  try {
    const value = report(crypto.randomUUID(), 'Unicode: λ 東京 🧰');
    const first = await send(store, value);
    assert.equal(first.status, 201);
    const ack = await first.json();
    const canonical = contract.canonicalizeBugReport(value);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    assert.deepEqual(ack, { schema: contract.ACK_SCHEMA, reportId: value.reportId, payloadHash: hash, status: 'received' });
    assert.equal(store.db.prepare('SELECT payload_json FROM bug_reports WHERE report_id = ?').get(value.reportId).payload_json, canonical);
    assert.equal((await send(store, value)).status, 200);
    assert.equal((await send(store, { ...value, description: 'changed bytes' })).status, 409);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports WHERE report_id = ?', value.reportId), 1);
  } finally { store.close(); }
});

test('concurrent identical submissions commit one row and return only durable receipts', async () => {
  const store = sqliteD1();
  try {
    const value = report(crypto.randomUUID(), 'Concurrent retry');
    const replies = await Promise.all(Array.from({ length: 16 }, () => send(store, value)));
    assert.equal(replies.filter(result => result.status === 201).length, 1);
    assert.equal(replies.filter(result => result.status === 200).length, 15);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports WHERE report_id = ?', value.reportId), 1);
  } finally { store.close(); }
});

test('trigger admission atomically enforces per-source and global request caps', async () => {
  const store = sqliteD1();
  try {
    const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10); const windowStart = Math.floor(now / 600000) * 600000;
    const insert = store.db.prepare('INSERT OR IGNORE INTO bug_report_admissions(admission_id, source_hash, window_start, day, admitted_at) VALUES (?, ?, ?, ?, ?)');
    const outcomes = await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve(insert.run(crypto.randomUUID(), 'same-source', windowStart, day, now))));
    assert.equal(outcomes.reduce((sum, result) => sum + Number(result.changes), 0), 20);
    assert.equal(Number(store.db.prepare('SELECT attempts FROM bug_report_source_counts WHERE source_hash = ? AND window_start = ?').get('same-source', windowStart).attempts), 20);
    const globalInsert = store.db.prepare('INSERT OR IGNORE INTO bug_report_admissions(admission_id, source_hash, window_start, day, admitted_at) VALUES (?, ?, ?, ?, ?)');
    const remaining = 1980;
    for (let i = 0; i < remaining + 10; i++) globalInsert.run(crypto.randomUUID(), 'source-' + i, windowStart, day, now);
    assert.equal(Number(store.db.prepare('SELECT attempts FROM bug_report_request_counts WHERE day = ?').get(day).attempts), 2000);
    const denied = globalInsert.run(crypto.randomUUID(), 'another-source', windowStart, day, now);
    assert.equal(Number(denied.changes), 0);
  } finally { store.close(); }
});

test('separate SQLite connections racing the source trigger never exceed twenty', async () => {
  const store = sqliteD1();
  try {
    store.db.exec('PRAGMA journal_mode = WAL');
    const source = `const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=5000');
      const insert = db.prepare('INSERT OR IGNORE INTO bug_report_admissions(admission_id, source_hash, window_start, day, admitted_at) VALUES (?, ?, ?, ?, ?)');
      parentPort.once('message', () => { let count = 0; try { for(let i=0;i<30;i++) count += Number(insert.run(workerData.prefix+i,'shared-race-source',workerData.windowStart,workerData.day,workerData.now).changes); parentPort.postMessage({count}); } catch(e) { parentPort.postMessage({error:e.code || e.message}); } finally { db.close(); } });`;
    const filename = path.join(store.dir, 'reports.sqlite');
    const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10); const windowStart = Math.floor(now / 600000) * 600000;
    const workers = Array.from({ length: 8 }, (_, i) => new Worker(source, { eval: true, workerData: { filename, prefix: `race-${i}-`, now, day, windowStart } }));
    const exits = workers.map(thread => new Promise(resolve => thread.once('exit', resolve)));
    const replies = workers.map(thread => new Promise((resolve, reject) => {
      thread.once('message', resolve); thread.once('error', reject);
    }));
    for (const thread of workers) thread.postMessage('go');
    const counts = await Promise.all(replies);
    await Promise.all(exits);
    assert.equal(counts.filter(item => item.error).length, 0, JSON.stringify(counts));
    assert.equal(counts.reduce((sum, item) => sum + item.count, 0), 20);
    assert.equal(Number(store.db.prepare('SELECT attempts FROM bug_report_source_counts WHERE source_hash=? AND window_start=?').get('shared-race-source', windowStart).attempts), 20);

    const globalRace = `const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=5000');
      const insert = db.prepare('INSERT OR IGNORE INTO bug_report_admissions(admission_id,source_hash,window_start,day,admitted_at) VALUES (?,?,?,?,?)');
      parentPort.once('message', () => { let count=0; try { for(let i=0;i<300;i++) count += Number(insert.run(workerData.prefix+i,workerData.prefix+i,workerData.windowStart,workerData.day,workerData.now).changes); parentPort.postMessage({count}); } catch(e) { parentPort.postMessage({error:e.code || e.message}); } finally { db.close(); } });`;
    const globalWorkers = Array.from({ length: 8 }, (_, i) => new Worker(globalRace, { eval: true, workerData: { filename, prefix: `global-${i}-`, now, day, windowStart } }));
    const globalExits = globalWorkers.map(thread => new Promise(resolve => thread.once('exit', resolve)));
    const globalReplies = globalWorkers.map(thread => new Promise((resolve, reject) => { thread.once('message', resolve); thread.once('error', reject); }));
    for (const thread of globalWorkers) thread.postMessage('go');
    const globalCounts = await Promise.all(globalReplies);
    await Promise.all(globalExits);
    assert.equal(globalCounts.filter(item => item.error).length, 0, JSON.stringify(globalCounts));
    assert.equal(globalCounts.reduce((sum, item) => sum + item.count, 0), 1980);
    assert.equal(Number(store.db.prepare('SELECT attempts FROM bug_report_request_counts WHERE day=?').get(day).attempts), 2000);

    const reportRace = `const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=5000');
      const insert = db.prepare('INSERT OR IGNORE INTO bug_reports(report_id,payload_hash,payload_json,received_at,received_day,expires_at) VALUES (?,?,?,?,?,?)');
      parentPort.once('message', () => { let count=0; try { for(let i=0;i<50;i++) count += Number(insert.run(workerData.prefix+i,'a'.repeat(64),'{}',1,workerData.day,9999999999).changes); parentPort.postMessage({count}); } catch(e) { parentPort.postMessage({error:e.code || e.message}); } finally { db.close(); } });`;
    const reportWorkers = Array.from({ length: 8 }, (_, i) => new Worker(reportRace, { eval: true, workerData: { filename, prefix: `daily-${i}-`, day } }));
    const reportExits = reportWorkers.map(thread => new Promise(resolve => thread.once('exit', resolve)));
    const reportReplies = reportWorkers.map(thread => new Promise((resolve, reject) => { thread.once('message', resolve); thread.once('error', reject); }));
    for (const thread of reportWorkers) thread.postMessage('go');
    const reportCounts = await Promise.all(reportReplies);
    await Promise.all(reportExits);
    assert.equal(reportCounts.filter(item => item.error).length, 0, JSON.stringify(reportCounts));
    assert.equal(reportCounts.reduce((sum, item) => sum + item.count, 0), 200);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports WHERE received_day=?', day), 200);
  } finally { store.close(); }
});

test('daily NEW cap is atomic and an existing duplicate remains eligible at capacity', async () => {
  const store = sqliteD1();
  try {
    const day = new Date().toISOString().slice(0, 10);
    const seed = store.db.prepare('INSERT INTO bug_reports(report_id, payload_hash, payload_json, received_at, received_day, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
    const value = report(crypto.randomUUID(), 'Already received');
    const canonical = contract.canonicalizeBugReport(value); const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    seed.run(value.reportId, hash, canonical, Math.floor(Date.now() / 1000), day, Math.floor(Date.now() / 1000) + 2592000);
    for (let i = 1; i < 200; i++) seed.run(crypto.randomUUID(), 'a'.repeat(64), '{}', 1, day, 9999999999);
    const duplicate = await send(store, value);
    assert.equal(duplicate.status, 200);
    const newReply = await send(store, report());
    assert.equal(newReply.status, 503);
    assert.equal(newReply.headers.get('Retry-After'), '3600');
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports WHERE received_day = ?', day), 200);
  } finally { store.close(); }
});

test('scheduled cleanup removes salts after the next 04:00 run and uses bounded age indexes', async () => {
  const store = sqliteD1();
  const originalNow = Date.now;
  try {
    const saltTime = Date.UTC(2026, 9, 1, 4, 1);
    store.db.prepare('INSERT INTO bug_report_daily_salts(day, salt, created_at) VALUES (?, ?, ?)').run('2026-10-01', new Uint8Array(32), saltTime);
    Date.now = () => Date.UTC(2026, 9, 2, 4, 0);
    await worker.scheduled({}, { BUG_REPORT_DB: store });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_daily_salts'), 1, '23h59m salt survives the first cleanup');
    Date.now = () => Date.UTC(2026, 9, 3, 4, 0);
    await worker.scheduled({}, { BUG_REPORT_DB: store });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_daily_salts'), 0, '47h59m salt is removed by the next daily cleanup');

    for (const [sql, expected] of [
      ['EXPLAIN QUERY PLAN SELECT rowid FROM bug_report_source_counts WHERE window_start < ? LIMIT 2500', 'bug_report_source_counts_age'],
      ['EXPLAIN QUERY PLAN SELECT rowid FROM bug_report_daily_salts WHERE created_at < ? LIMIT 2', 'bug_report_daily_salts_age'],
      ['EXPLAIN QUERY PLAN SELECT rowid FROM bug_reports WHERE expires_at < ? LIMIT 500', 'bug_reports_expiry']
    ]) assert.match(store.db.prepare(sql).all(Date.now()).map(row => row.detail).join(' '), new RegExp(expected));
  } finally { Date.now = originalNow; store.close(); }
});

test('actual scheduled handler clears ordinary daily volume and catches a bounded outage backlog', async () => {
  const store = sqliteD1();
  const originalNow = Date.now;
  try {
    const now = Date.UTC(2026, 9, 5, 4, 1); const old = now - 26 * 60 * 60 * 1000;
    const day = new Date(old).toISOString().slice(0, 10);
    Date.now = () => now;
    for (let i = 0; i < 2000; i++) {
      store.db.prepare('INSERT INTO bug_report_source_counts(source_hash, window_start, attempts) VALUES (?, ?, ?)').run('ordinary-' + i, old, 1);
      store.db.prepare('INSERT INTO bug_report_admissions(admission_id, source_hash, window_start, day, admitted_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), 'ordinary-' + i, old, day, old);
    }
    assert.equal(Number(store.db.prepare('SELECT attempts FROM bug_report_request_counts WHERE day = ?').get(day).attempts), 2000);
    for (let i = 0; i < 200; i++) {
      store.db.prepare('INSERT INTO bug_reports(report_id, payload_hash, payload_json, received_at, received_day, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), 'a'.repeat(64), '{}', 1, day, 1);
    }
    for (let i = 0; i < 600; i++) {
      const outageDay = new Date(old - (Math.floor(i / 200) + 1) * 86400000).toISOString().slice(0, 10);
      store.db.prepare('INSERT INTO bug_reports(report_id, payload_hash, payload_json, received_at, received_day, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), 'b'.repeat(64), '{}', 1, outageDay, 1);
    }
    await worker.scheduled({}, { BUG_REPORT_DB: store });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_source_counts'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_admissions'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_request_counts'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports'), 300, 'one run removes at most the 500-report batch');

    for (let i = 0; i < 5000; i++) store.db.prepare('INSERT INTO bug_report_source_counts(source_hash, window_start, attempts) VALUES (?, ?, ?)').run('outage-' + i, old, 1);
    await worker.scheduled({}, { BUG_REPORT_DB: store });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_source_counts'), 2500, 'one run deletes only the configured 2500-row batch');
    const nextDay = now + 86400000; const nextOld = nextDay - 26 * 60 * 60 * 1000;
    for (let i = 0; i < 2000; i++) store.db.prepare('INSERT INTO bug_report_source_counts(source_hash, window_start, attempts) VALUES (?, ?, ?)').run('next-day-' + i, nextOld, 1);
    Date.now = () => nextDay;
    await worker.scheduled({}, { BUG_REPORT_DB: store });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_reports'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM bug_report_source_counts'), 2000, 'the 2500-row batch clears ordinary 2000/day intake and repays 500 backlog rows');
  } finally { Date.now = originalNow; store.close(); }
});
