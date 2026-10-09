'use strict';

const crypto = require('node:crypto');
const contract = require('../shared/bug-report-contract.cjs');
const fileConfig = require('./bug-report-config.json');

const STATE_NAME = 'bug-report-state.json';
const STATE_MAX_BYTES = 24 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HANDLE_TTL_MS = 10 * 60 * 1000;
const SEND_TIMEOUT_MS = 15 * 1000;
const MAX_REPLY_BYTES = 1024;
const FEATURE = Object.freeze({
  id: 'bug-report', hosts: Object.freeze(['trace-bug-report.trace-boardviewer.workers.dev']), methods: Object.freeze(['POST']), paths: Object.freeze(['/v1/reports']),
  maxBytes: MAX_REPLY_BYTES, timeoutMs: SEND_TIMEOUT_MS, maxInFlight: 1, bodyStatuses: Object.freeze([200, 201]), acceptedStatuses: Object.freeze([200, 201]),
  responseHeaders: Object.freeze(['retry-after']), headers: Object.freeze({ Accept: 'application/json' }),
  requestBody: Object.freeze({ contentType: 'application/json', maxBytes: contract.MAX_BYTES }), requiresUserAction: true,
});
const PLATFORM = Object.freeze({ win32: 'windows', darwin: 'macos', linux: 'linux' });
const ERRORS = new Set(['offline', 'timeout', 'cancelled', 'invalid', 'too-large', 'rate-limited', 'unavailable', 'storage', 'conflict', 'busy', 'stale-preview', 'unknown']);

function ownRecord(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length >= required.length && keys.length <= required.length + optional.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function safeResult(error, retryAfterSeconds) {
  const closed = ERRORS.has(error) ? error : 'unknown';
  return { status: 'error', error: closed, ...(Number.isInteger(retryAfterSeconds) ? { retryAfterSeconds } : {}) };
}
function validateLastImport(value) {
  if (value === null) return null;
  if (!ownRecord(value, ['outcome', 'stage', 'formatId', 'extensionClass', 'errorCode'])) return null;
  return contract.OUTCOMES.includes(value.outcome) && contract.STAGES.includes(value.stage) &&
    (value.formatId === null || contract.FORMATS.includes(value.formatId)) && contract.EXTENSIONS.includes(value.extensionClass) &&
    (value.errorCode === null || contract.ERROR_CODES.includes(value.errorCode)) ? {
      outcome: value.outcome, stage: value.stage, formatId: value.formatId, extensionClass: value.extensionClass, errorCode: value.errorCode,
    } : null;
}
function validateRequest(value, allowed) {
  if (!ownRecord(value, allowed)) throw Object.assign(new Error('Invalid request.'), { code: 'invalid' });
}
function sanitizeDraftInput(value) {
  validateRequest(value, ['description', 'includeDiagnostics', 'context']);
  if (typeof value.description !== 'string' || value.description.length > contract.MAX_DESCRIPTION_RAW_CODE_UNITS || typeof value.includeDiagnostics !== 'boolean') {
    throw Object.assign(new Error('Invalid request.'), { code: 'invalid' });
  }
  let context = { surface: 'other', lastImport: null };
  if (value.context !== null) {
    if (!ownRecord(value.context, ['surface', 'lastImport']) || !contract.SURFACES.includes(value.context.surface)) {
      throw Object.assign(new Error('Invalid request.'), { code: 'invalid' });
    }
    context = { surface: value.context.surface, lastImport: validateLastImport(value.context.lastImport) };
  }
  return { description: value.description, includeDiagnostics: value.includeDiagnostics, context };
}
function stateValue(raw, now) {
  if (raw === null) return { version: 1, draft: null, pending: null };
  if (!ownRecord(raw, ['version', 'draft', 'pending']) || raw.version !== 1) throw new TypeError('Invalid local report state.');
  const validItem = (item, pending) => {
    if (item === null) return null;
    if (!ownRecord(item, pending ? ['version', 'savedAt', 'canonicalText', 'payloadHash'] : ['version', 'savedAt', 'input']) ||
        item.version !== 1 || !Number.isSafeInteger(item.savedAt)) throw new TypeError('Invalid local report state.');
    if (now - item.savedAt > RETENTION_MS) return null;
    if (item.savedAt > now + 60_000) throw new TypeError('Invalid local report state.');
    if (pending) {
      if (typeof item.canonicalText !== 'string' || item.canonicalText.length > contract.MAX_BYTES || typeof item.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.payloadHash)) throw new TypeError('Invalid local report state.');
      const checked = contract.validateBugReport(parseJson(item.canonicalText));
      if (!checked.ok || contract.canonicalizeBugReport(checked.value) !== item.canonicalText || sha256(item.canonicalText) !== item.payloadHash) throw new TypeError('Invalid local report state.');
      return { version: 1, savedAt: item.savedAt, canonicalText: item.canonicalText, payloadHash: item.payloadHash };
    }
    try {
      const input = sanitizeDraftInput(item.input);
      return { version: 1, savedAt: item.savedAt, input };
    } catch { throw new TypeError('Invalid local report state.'); }
  };
  return { version: 1, draft: validItem(raw.draft, false), pending: validItem(raw.pending, true) };
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function sha256(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

function createBugReportService({ store, egress, getVersion, platform = process.platform, arch = process.arch, locale = () => 'en', now = Date.now, randomUUID = crypto.randomUUID, config = fileConfig } = {}) {
  if (!store || typeof store.update !== 'function' || typeof store.read !== 'function' || !egress || typeof egress.request !== 'function') throw new TypeError('Bug report service dependencies are incomplete.');
  const endpoint = config && config.enabled === true && config.endpoint === FEATURE_ENDPOINT() ? config.endpoint : null;
  let active = null;
  let sending = null;
  let closed = false;
  let lifecycleEpoch = 0;

  function metadata() {
    const version = typeof getVersion === 'function' ? getVersion() : '';
    return {
      version: typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : '0.0.0',
      platform: PLATFORM[platform] || 'other', arch: ['x64', 'arm64'].includes(arch) ? arch : 'other',
    };
  }
  function diagnosticsFor(input) {
    if (!input.includeDiagnostics) return null;
    const selectedLocale = typeof locale === 'function' ? locale() : locale;
    return {
      app: metadata(), locale: contract.LOCALES.includes(selectedLocale) ? selectedLocale : 'en',
      surface: input.context.surface, lastImport: input.context.lastImport,
    };
  }
  function project(input, id) {
    return contract.projectBugReport({ reportId: id, description: input.description, diagnostics: diagnosticsFor(input) });
  }
  function draftMatchesReport(draft, report) {
    if (!draft || !report) return false;
    let projected;
    try { projected = project(draft, report.reportId); }
    catch { return false; }
    if (projected.description !== report.description) return false;
    if (projected.diagnostics === null) return report.diagnostics === null;
    return Boolean(report.diagnostics && projected.diagnostics.surface === report.diagnostics.surface &&
      JSON.stringify(projected.diagnostics.lastImport) === JSON.stringify(report.diagnostics.lastImport));
  }
  function writeState(update) {
    if (closed) return Promise.reject(Object.assign(new Error('Storage is closing.'), { code: 'storage' }));
    return store.update(STATE_NAME, (raw) => update(stateValue(raw, now())), { maxBytes: STATE_MAX_BYTES });
  }
  async function readState() {
    if (closed) throw Object.assign(new Error('Storage is closing.'), { code: 'storage' });
    try { return await store.update(STATE_NAME, (raw) => stateValue(raw, now()), { maxBytes: STATE_MAX_BYTES }); }
    catch { throw Object.assign(new Error('Storage unavailable.'), { code: 'storage' }); }
  }
  function requireActive(handle) {
    if (closed || !active || !ownRecord(handle, ['prepareId']) || handle.prepareId !== active.prepareId) {
      throw Object.assign(new Error('Preview is no longer current.'), { code: 'stale-preview' });
    }
    if (now() > active.expiresAt) {
      active = null;
      throw Object.assign(new Error('Preview is no longer current.'), { code: 'stale-preview' });
    }
    return active;
  }
  async function prepare(raw) {
    if (closed) return safeResult('unavailable');
    if (sending) return safeResult('busy');
    const epoch = lifecycleEpoch;
    try {
      const input = sanitizeDraftInput(raw);
      const saved = await readState();
      if (closed || epoch !== lifecycleEpoch) return safeResult('stale-preview');
      let report;
      if (saved.pending) {
        const pendingReport = parseJson(saved.pending.canonicalText);
        const projected = project(input, pendingReport.reportId);
        const priorDiagnostics = pendingReport.diagnostics;
        const projectedDiagnostics = projected.diagnostics;
        const sameDiagnostics = projectedDiagnostics === null ? priorDiagnostics === null : Boolean(priorDiagnostics &&
          priorDiagnostics.surface === projectedDiagnostics.surface &&
          JSON.stringify(priorDiagnostics.lastImport) === JSON.stringify(projectedDiagnostics.lastImport));
        const sameContent = pendingReport.description === projected.description && sameDiagnostics;
        report = sameContent ? pendingReport : project(input, randomUUID());
      } else report = project(input, randomUUID());
      if (closed || epoch !== lifecycleEpoch) return safeResult('stale-preview');
      const canonicalText = contract.canonicalizeBugReport(report);
      const prepareId = crypto.randomBytes(24).toString('hex');
      active = { prepareId, expiresAt: now() + HANDLE_TTL_MS, report, canonicalText, payloadHash: sha256(canonicalText) };
      return { status: 'prepared', prepareId, report, canonicalText, payloadHash: active.payloadHash };
    } catch (error) { return safeResult(error?.code === 'storage' ? 'storage' : 'invalid'); }
  }
  async function send(raw) {
    if (sending) return safeResult('busy');
    let prepared;
    try { validateRequest(raw, ['prepareId']); prepared = requireActive(raw); }
    catch (error) { return safeResult(error?.code || 'stale-preview'); }
    if (!endpoint) return safeResult('unavailable');
    const state = { controller: new AbortController(), prepareId: prepared.prepareId, attempted: false, cancelled: false, epoch: lifecycleEpoch };
    sending = state;
    try {
      await writeState((current) => ({
        ...current,
        pending: { version: 1, savedAt: now(), canonicalText: prepared.canonicalText, payloadHash: prepared.payloadHash },
      }));
    } catch {
      if (sending === state) sending = null;
      return safeResult('storage');
    }
    if (state.controller.signal.aborted || closed || state.epoch !== lifecycleEpoch || !active || active.prepareId !== state.prepareId) {
      if (sending === state) sending = null;
      return safeResult('cancelled');
    }
    state.attempted = true;
    let response;
    try {
      response = await egress.request(FEATURE.id, endpoint, {
        method: 'POST', body: prepared.canonicalText, userAction: true, signal: state.controller.signal,
        timeoutMs: SEND_TIMEOUT_MS, maxBytes: MAX_REPLY_BYTES,
      });
    } catch { response = { ok: false, error: 'network' }; }
    if (state.cancelled || state.controller.signal.aborted || closed || state.epoch !== lifecycleEpoch || !active || active.prepareId !== state.prepareId) {
      if (sending === state) sending = null;
      return safeResult('cancelled');
    }
    if (!response || response.ok !== true || !Buffer.isBuffer(response.body) || response.body.length > MAX_REPLY_BYTES || ![200, 201].includes(response.status)) {
      const result = transportError(response);
      if (sending === state) sending = null;
      return result;
    }
    const ack = parseJson(response.body.toString('utf8'));
    if (!contract.isValidAcknowledgement(ack, prepared.report.reportId, prepared.payloadHash)) {
      if (sending === state) sending = null;
      return safeResult('unknown');
    }
    state.acknowledged = true;
    try {
      await writeState((current) => ({
        ...current,
        draft: current.draft?.input && draftMatchesReport(current.draft.input, prepared.report) ? null : current.draft,
        pending: current.pending?.canonicalText === prepared.canonicalText && current.pending.payloadHash === prepared.payloadHash ? null : current.pending,
      }));
    } catch { /* Durable acknowledgement is authoritative; retry remains safe with the same identity. */ }
    if (sending === state) sending = null;
    active = null;
    return { status: 'received', reportId: prepared.report.reportId, payloadHash: prepared.payloadHash };
  }
  function cancel(raw) {
    try { validateRequest(raw, ['prepareId']); } catch { return safeResult('invalid'); }
    if (!sending || sending.prepareId !== raw.prepareId || sending.acknowledged) return safeResult('stale-preview');
    sending.cancelled = true;
    sending.controller.abort();
    return { status: 'cancelled', uncertain: sending.attempted };
  }
  async function getDraft() {
    try {
      const saved = await readState();
      if (!saved.draft && !saved.pending) return { status: 'empty' };
      return { status: 'available', draft: saved.draft?.input ?? null, pending: saved.pending ? { report: parseJson(saved.pending.canonicalText), canonicalText: saved.pending.canonicalText, payloadHash: saved.pending.payloadHash } : null };
    } catch { return safeResult('storage'); }
  }
  async function saveDraft(raw) {
    if (sending) return safeResult('busy');
    let input;
    try { input = sanitizeDraftInput(raw); }
    catch { return safeResult('invalid'); }
    try {
      await writeState((current) => ({ ...current, draft: { version: 1, savedAt: now(), input } }));
      active = null;
      return { status: 'saved' };
    } catch { return safeResult('storage'); }
  }
  async function discardDraft() {
    if (sending) return safeResult('busy');
    try {
      await writeState(() => ({ version: 1, draft: null, pending: null }));
      active = null;
      return { status: 'discarded' };
    } catch { return safeResult('storage'); }
  }
  function invalidateWindow() {
    lifecycleEpoch++;
    active = null;
    if (sending) { sending.controller.abort(); sending.cancelled = true; }
  }
  async function beginShutdown() {
    lifecycleEpoch++;
    closed = true;
    active = null;
    if (sending) { sending.controller.abort(); sending.cancelled = true; }
    try { await store.flush?.(); } catch { /* Existing accepted queue writes remain owned by the profile store. */ }
  }
  return Object.freeze({ prepare, send, cancel, getDraft, saveDraft, discardDraft, invalidateWindow, beginShutdown });
}

function transportError(response) {
  const error = response?.error;
  const status = Number.isInteger(response?.status) ? response.status : null;
  const retryText = response?.headers?.['retry-after'];
  const retryAfter = typeof retryText === 'string' && /^\d{1,10}$/.test(retryText) ? Math.max(1, Math.min(3600, Number(retryText))) : null;
  if (error === 'cancelled') return safeResult('cancelled');
  if (error === 'timeout') return safeResult('timeout');
  if (status === 429 || status === 503) return safeResult('rate-limited', retryAfter ?? undefined);
  if (status === 409) return safeResult('conflict');
  if (status === 413 || error === 'too-large') return safeResult('too-large');
  if (status === 400 || status === 415) return safeResult('invalid');
  if (error === 'network') return safeResult('offline');
  if (error === 'storage') return safeResult('storage');
  if (error === 'busy') return safeResult('busy');
  if (['disabled', 'not-registered', 'not-allowed'].includes(error)) return safeResult('unavailable');
  if (error === 'http-status') return safeResult(status === 409 ? 'conflict' : 'unavailable');
  return safeResult('unknown');
}
function FEATURE_ENDPOINT() { return 'https://trace-bug-report.trace-boardviewer.workers.dev/v1/reports'; }

module.exports = Object.freeze({ FEATURE, CONFIG: fileConfig, STATE_NAME, STATE_MAX_BYTES, RETENTION_MS, HANDLE_TTL_MS, SEND_TIMEOUT_MS, MAX_REPLY_BYTES, createBugReportService, transportError });
