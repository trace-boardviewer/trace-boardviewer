'use strict';

// This module is intentionally dependency-free apart from the repository's closed
// diagnostic schema. The Worker build embeds that schema so the deployed module
// uses these exact same enums.
const diagnosticSchema = require('../electron/diagnostic-schema.json');

const SCHEMA = 'trace-bug-report/1';
const ACK_SCHEMA = 'trace-bug-report-ack/1';
const MAX_BYTES = 16 * 1024;
const MAX_DESCRIPTION_CODE_POINTS = 2000;
const MAX_DESCRIPTION_RAW_CODE_UNITS = 8192;
const FORMATS = Object.freeze(diagnosticSchema.enums.formatId.slice());
const EXTENSIONS = Object.freeze(diagnosticSchema.enums.extension.slice());
const LOCALES = Object.freeze(['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk']);
const PLATFORMS = Object.freeze(['windows', 'macos', 'linux', 'other']);
const ARCHES = Object.freeze(['x64', 'arm64', 'other']);
const SURFACES = Object.freeze(['welcome', 'board', 'documents', 'schematic', 'settings', 'other']);
const OUTCOMES = Object.freeze(['reading', 'processing', 'opened', 'failed', 'cancelled', 'key-required', 'timeout', 'worker-failed']);
const STAGES = Object.freeze(['read', 'detect', 'unpack', 'parse', 'done', 'unknown']);
const ERROR_CODES = Object.freeze([...diagnosticSchema.enums.errorCode, 'READ_FAILED', 'WORKER_FAILED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN']);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keysAre = (value, required, optional = []) => isRecord(value) && Object.keys(value).length >= required.length &&
  Object.keys(value).length <= required.length + optional.length && required.every(key => own(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const utf8Length = value => new TextEncoder().encode(value).length;
const codePoints = value => Array.from(value).length;
const enumHas = (values, value) => typeof value === 'string' && values.includes(value);
const uuidV4 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function hasInvalidSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function validateLastImport(value) {
  if (value === null) return true;
  return keysAre(value, ['outcome', 'stage', 'formatId', 'extensionClass', 'errorCode']) &&
    enumHas(OUTCOMES, value.outcome) && enumHas(STAGES, value.stage) &&
    (value.formatId === null || enumHas(FORMATS, value.formatId)) &&
    enumHas(EXTENSIONS, value.extensionClass) &&
    (value.errorCode === null || enumHas(ERROR_CODES, value.errorCode));
}

function validateDiagnostics(value) {
  if (value === null) return true;
  return keysAre(value, ['app', 'locale', 'surface', 'lastImport']) &&
    keysAre(value.app, ['version', 'platform', 'arch']) &&
    typeof value.app.version === 'string' && value.app.version.length > 0 && value.app.version.length <= 32 &&
    /^[0-9A-Za-z.+-]+$/.test(value.app.version) && enumHas(PLATFORMS, value.app.platform) && enumHas(ARCHES, value.app.arch) &&
    enumHas(LOCALES, value.locale) && enumHas(SURFACES, value.surface) && validateLastImport(value.lastImport);
}

function validateBugReport(value) {
  if (!keysAre(value, ['schema', 'reportId', 'description', 'diagnostics'])) return { ok: false, error: 'INVALID_SHAPE' };
  if (value.schema !== SCHEMA || !uuidV4(value.reportId)) return { ok: false, error: 'INVALID_IDENTITY' };
  if (typeof value.description !== 'string' || value.description.length > MAX_DESCRIPTION_RAW_CODE_UNITS) return { ok: false, error: 'INVALID_DESCRIPTION' };
  if (codePoints(value.description) < 1 || codePoints(value.description) > MAX_DESCRIPTION_CODE_POINTS ||
      utf8Length(value.description) > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.description) ||
      value.description.includes('\r') || hasInvalidSurrogate(value.description)) return { ok: false, error: 'INVALID_DESCRIPTION' };
  if (!validateDiagnostics(value.diagnostics)) return { ok: false, error: 'INVALID_DIAGNOSTICS' };
  return { ok: true, value };
}

function canonicalizeBugReport(value) {
  const checked = validateBugReport(value);
  if (!checked.ok) throw new TypeError(checked.error);
  const diagnostics = value.diagnostics === null ? null : {
    app: { version: value.diagnostics.app.version, platform: value.diagnostics.app.platform, arch: value.diagnostics.app.arch },
    locale: value.diagnostics.locale,
    surface: value.diagnostics.surface,
    lastImport: value.diagnostics.lastImport === null ? null : {
      outcome: value.diagnostics.lastImport.outcome,
      stage: value.diagnostics.lastImport.stage,
      formatId: value.diagnostics.lastImport.formatId,
      extensionClass: value.diagnostics.lastImport.extensionClass,
      errorCode: value.diagnostics.lastImport.errorCode
    }
  };
  return JSON.stringify({ schema: value.schema, reportId: value.reportId, description: value.description, diagnostics });
}

function projectBugReport(input) {
  if (!isRecord(input)) throw new TypeError('INVALID_SHAPE');
  if (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_RAW_CODE_UNITS) throw new TypeError('INVALID_DESCRIPTION');
  const description = typeof input.description === 'string'
    ? input.description.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    : '';
  const report = {
    schema: SCHEMA,
    reportId: input.reportId,
    description,
    diagnostics: input.diagnostics === null ? null : projectDiagnostics(input.diagnostics)
  };
  const checked = validateBugReport(report);
  if (!checked.ok) throw new TypeError(checked.error);
  return report;
}

function projectDiagnostics(input) {
  if (!isRecord(input)) return null;
  const app = isRecord(input.app) ? input.app : {};
  const last = isRecord(input.lastImport) ? input.lastImport : null;
  return {
    app: {
      version: typeof app.version === 'string' ? app.version.slice(0, 32) : '',
      platform: enumHas(PLATFORMS, app.platform) ? app.platform : 'other',
      arch: enumHas(ARCHES, app.arch) ? app.arch : 'other'
    },
    locale: enumHas(LOCALES, input.locale) ? input.locale : 'en',
    surface: enumHas(SURFACES, input.surface) ? input.surface : 'other',
    lastImport: last ? {
      outcome: enumHas(OUTCOMES, last.outcome) ? last.outcome : 'failed',
      stage: enumHas(STAGES, last.stage) ? last.stage : 'unknown',
      formatId: enumHas(FORMATS, last.formatId) ? last.formatId : null,
      extensionClass: enumHas(EXTENSIONS, last.extensionClass) ? last.extensionClass : 'other',
      errorCode: enumHas(ERROR_CODES, last.errorCode) ? last.errorCode : null
    } : null
  };
}

function isValidAcknowledgement(value, reportId, payloadHash) {
  return keysAre(value, ['schema', 'reportId', 'payloadHash', 'status']) && value.schema === ACK_SCHEMA &&
    value.reportId === reportId && value.payloadHash === payloadHash && value.status === 'received';
}

module.exports = Object.freeze({
  SCHEMA, ACK_SCHEMA, MAX_BYTES, MAX_DESCRIPTION_CODE_POINTS, MAX_DESCRIPTION_RAW_CODE_UNITS, FORMATS, EXTENSIONS, LOCALES, PLATFORMS, ARCHES,
  SURFACES, OUTCOMES, STAGES, ERROR_CODES, validateBugReport, canonicalizeBugReport, projectBugReport, isValidAcknowledgement
});
