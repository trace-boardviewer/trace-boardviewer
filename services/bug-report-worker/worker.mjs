import contract from '../../shared/bug-report-contract.cjs';

const MAX_BODY_BYTES = contract.MAX_BYTES;
const BODY_DEADLINE_MS = 5000;
const RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;
const REPORT_CLEANUP_LIMIT = 500;
const COUNTER_CLEANUP_LIMIT = 2500;

function reply(status, value, extra = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  return new Response(JSON.stringify(value), { status, headers });
}

const errors = Object.freeze({
  bad: () => reply(400, { error: 'invalid_request' }),
  tooLarge: () => reply(413, { error: 'request_too_large' }),
  media: () => reply(415, { error: 'unsupported_media_type' }),
  method: () => reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' }),
  forbidden: () => reply(403, { error: 'origin_not_allowed' }),
  unavailable: () => reply(503, { error: 'temporarily_unavailable' }),
  sourceLimit: () => reply(429, { error: 'rate_limited' }, { 'Retry-After': '60' }),
  globalLimit: () => reply(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '3600' }),
  conflict: () => reply(409, { error: 'report_conflict' })
});

function hasExcessiveDepth(text) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      depth++;
      if (depth > 8) return true;
    } else if (c === '}' || c === ']') depth--;
  }
  return false;
}

async function readBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return { kind: 'large' };
  if (!request.body) return { kind: 'invalid' };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const read = (async () => {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) return { kind: 'ok', bytes: concat(chunks, size) };
        size += item.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return { kind: 'large' };
        }
        chunks.push(item.value);
      }
    } catch {
      return { kind: 'invalid' };
    }
  })();
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), BODY_DEADLINE_MS); });
  const result = await Promise.race([read, timeout]);
  clearTimeout(timer);
  if (result.kind === 'timeout') void reader.cancel().catch(() => {});
  return result;
}

function concat(chunks, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }
function windowKey(now) { return Math.floor(now / 600000) * 600000; }
async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
function dbStatement(db, sql, ...values) { return db.prepare(sql).bind(...values); }
function changes(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }

async function dailySalt(db, day, now) {
  const candidate = crypto.getRandomValues(new Uint8Array(32));
  await dbStatement(db,
    'INSERT OR IGNORE INTO bug_report_daily_salts(day, salt, created_at) VALUES (?, ?, ?)', day, candidate, now).run();
  const row = await dbStatement(db, 'SELECT salt FROM bug_report_daily_salts WHERE day = ?', day).first();
  if (!row?.salt) throw new Error('salt unavailable');
  return row.salt instanceof Uint8Array ? row.salt : new Uint8Array(row.salt);
}

async function sourceBucket(db, request, day, now) {
  const salt = await dailySalt(db, day, now);
  const ip = request.headers.get('CF-Connecting-IP') || 'missing-source-address';
  const text = new TextEncoder().encode(ip);
  const joined = new Uint8Array(salt.byteLength + text.byteLength);
  joined.set(salt); joined.set(text, salt.byteLength);
  return sha256Hex(joined);
}

async function classifyDenied(db, bucket, windowStart, day) {
  const source = await dbStatement(db,
    'SELECT attempts FROM bug_report_source_counts WHERE source_hash = ? AND window_start = ?', bucket, windowStart).first();
  if (Number(source?.attempts || 0) >= 20) return errors.sourceLimit();
  const global = await dbStatement(db, 'SELECT attempts FROM bug_report_request_counts WHERE day = ?', day).first();
  if (Number(global?.attempts || 0) >= 2000) return errors.globalLimit();
  return errors.unavailable();
}

async function submit(db, request, report, canonical, hash, now) {
  const day = dayKey(now);
  const windowStart = windowKey(now);
  const bucket = await sourceBucket(db, request, day, now);
  const admissionId = crypto.randomUUID();
  const receivedAt = Math.floor(now / 1000);
  const expiresAt = Math.floor((now + RETENTION_MS) / 1000);
  const results = await db.batch([
    dbStatement(db, 'INSERT INTO bug_report_admissions(admission_id, source_hash, window_start, day, admitted_at) VALUES (?, ?, ?, ?, ?)', admissionId, bucket, windowStart, day, now),
    dbStatement(db,
      'INSERT OR IGNORE INTO bug_reports(report_id, payload_hash, payload_json, received_at, received_day, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bug_report_admissions WHERE admission_id = ?)',
      report.reportId, hash, canonical, receivedAt, day, expiresAt, admissionId)
  ]);
  if (changes(results?.[0]) === 0) return classifyDenied(db, bucket, windowStart, day);
  const row = await dbStatement(db, 'SELECT payload_hash FROM bug_reports WHERE report_id = ?', report.reportId).first();
  if (!row) return errors.globalLimit();
  if (row.payload_hash !== hash) return errors.conflict();
  const inserted = changes(results?.[1]) > 0;
  return reply(inserted ? 201 : 200, { schema: contract.ACK_SCHEMA, reportId: report.reportId, payloadHash: hash, status: 'received' });
}

async function handlePost(request, env) {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== 'null') return errors.forbidden();
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) || request.headers.has('Content-Encoding')) return errors.media();
  const body = await readBody(request);
  if (body.kind === 'large') return errors.tooLarge();
  if (body.kind !== 'ok') return errors.bad();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes); } catch { return errors.bad(); }
  if (hasExcessiveDepth(text)) return errors.bad();
  let report;
  try { report = JSON.parse(text); } catch { return errors.bad(); }
  if (!contract.validateBugReport(report).ok) return errors.bad();
  const canonical = contract.canonicalizeBugReport(report);
  if (new TextEncoder().encode(canonical).byteLength > MAX_BODY_BYTES) return errors.tooLarge();
  const hash = await sha256Hex(new TextEncoder().encode(canonical));
  if (!env?.BUG_REPORT_DB) return errors.unavailable();
  try { return await submit(env.BUG_REPORT_DB, request, report, canonical, hash, Date.now()); }
  catch { return errors.unavailable(); }
}

async function fetchHandler(request, env) {
  let url;
  try { url = new URL(request.url); } catch { return errors.bad(); }
  if (url.protocol !== 'https:' || url.search || url.hash) return errors.bad();
  if (url.pathname === '/health' && request.method === 'GET') return reply(200, { status: 'ok' });
  if (url.pathname !== '/v1/reports') return reply(404, { error: 'not_found' });
  if (request.method !== 'POST') return errors.method();
  return handlePost(request, env);
}

async function cleanupBatch(db, table, predicate, beforeValue, limit) {
  return dbStatement(db,
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} < ? LIMIT ${limit})`, beforeValue).run();
}

async function scheduledHandler(_controller, env) {
  if (!env?.BUG_REPORT_DB) return;
  const now = Date.now();
  try {
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_reports', 'expires_at', Math.floor(now / 1000), REPORT_CLEANUP_LIMIT);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_admissions', 'admitted_at', now - COUNTER_RETENTION_MS, COUNTER_CLEANUP_LIMIT);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_source_counts', 'window_start', now - COUNTER_RETENTION_MS, COUNTER_CLEANUP_LIMIT);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_request_counts', 'created_at', now - COUNTER_RETENTION_MS, 2);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_daily_salts', 'created_at', now - COUNTER_RETENTION_MS, 2);
  } catch { /* Scheduled cleanup is retried on the next invocation. */ }
}

export const worker = Object.freeze({ fetch: fetchHandler, scheduled: scheduledHandler });
export default worker;
