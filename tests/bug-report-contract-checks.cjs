'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../shared/bug-report-contract.cjs');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/bug-report-contract.vectors.json'), 'utf8'));

test('canonical report vectors stay stable across runtimes', () => {
  for (const vector of vectors.vectors) {
    const canonical = contract.canonicalizeBugReport(vector.report);
    assert.equal(canonical, vector.canonical, vector.name);
    assert.equal(crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'), vector.sha256, vector.name);
  }
});

test('closed projection rejects unknown and deep fields before serialization', () => {
  const base = vectors.vectors[0].report;
  assert.equal(contract.validateBugReport({ ...base, filename: 'C:\\Private\\board.brd' }).ok, false);
  const deep = JSON.parse('{"schema":"trace-bug-report/1","reportId":"123e4567-e89b-42d3-a456-426614174000","description":"x","diagnostics":null,"extra":{"a":{"b":{"c":1}}}}');
  assert.equal(contract.validateBugReport(deep).error, 'INVALID_SHAPE');
  assert.throws(() => contract.canonicalizeBugReport(deep), /INVALID_SHAPE/);
});

test('canonical bytes ignore input object property order', () => {
  const source = vectors.vectors[1].report;
  const reordered = {
    diagnostics: {
      lastImport: { errorCode: null, extensionClass: '.cad', formatId: 'gencad', stage: 'done', outcome: 'opened' },
      surface: 'board', locale: 'en', app: { arch: 'x64', platform: 'linux', version: '1.3.1' }
    },
    description: source.description, reportId: source.reportId, schema: source.schema
  };
  assert.equal(contract.canonicalizeBugReport(reordered), vectors.vectors[1].canonical);
});

test('description bounds count Unicode code points and UTF-8 bytes', () => {
  const base = vectors.vectors[0].report;
  assert.equal(contract.validateBugReport({ ...base, description: '🛠️'.repeat(2000) }).ok, false);
  assert.equal(contract.validateBugReport({ ...base, description: 'a'.repeat(2001) }).ok, false);
  assert.equal(contract.validateBugReport({ ...base, description: 'ok\u0000no' }).ok, false);
  assert.equal(contract.validateBugReport({ ...base, description: 'line\rbreak' }).ok, false);
  assert.equal(contract.validateBugReport({ ...base, description: '\ud800' }).ok, false);
  assert.equal(contract.validateBugReport({ ...base, description: '🛠️'.repeat(1000) }).ok, true);
});

test('oversized raw descriptions reject before Unicode, UTF-8 or normalization work', () => {
  const base = vectors.vectors[0].report;
  const oversized = 'x'.repeat(contract.MAX_DESCRIPTION_RAW_CODE_UNITS + 1);
  const originalFrom = Array.from;
  const originalEncoder = globalThis.TextEncoder;
  const originalReplace = String.prototype.replace;
  let touched = 0;
  try {
    Array.from = function (...args) { touched++; return originalFrom.apply(this, args); };
    globalThis.TextEncoder = class extends originalEncoder { constructor(...args) { touched++; super(...args); } };
    String.prototype.replace = function (...args) { if (this.valueOf() === oversized) touched++; return originalReplace.apply(this, args); };
    assert.equal(contract.validateBugReport({ ...base, description: oversized }).error, 'INVALID_DESCRIPTION');
    assert.throws(() => contract.projectBugReport({ ...base, description: oversized }), /INVALID_DESCRIPTION/);
    assert.equal(touched, 0);
  } finally {
    Array.from = originalFrom;
    globalThis.TextEncoder = originalEncoder;
    String.prototype.replace = originalReplace;
  }
});

test('bounded raw allowance accepts normalized CRLF while enforcing output limits', () => {
  const base = vectors.vectors[0].report;
  const projected = contract.projectBugReport({ ...base, description: 'x\r\n'.repeat(1000) });
  assert.equal(Array.from(projected.description).length, 2000);
  assert.equal(projected.description.includes('\r'), false);
  assert.throws(() => contract.projectBugReport({ ...base, description: 'x'.repeat(8192) + '\r\n' }), /INVALID_DESCRIPTION/);
});

test('diagnostic projection copies only closed enums and never message or path values', () => {
  const projected = contract.projectBugReport({
    reportId: '123e4567-e89b-42d3-a456-426614174000',
    description: 'Issue\r\ncontinues\u0000',
    diagnostics: {
      app: { version: '1.3.1', platform: 'linux', arch: 'x64', home: '/private/name' },
      locale: 'en', surface: 'board',
      lastImport: { outcome: 'failed', stage: 'parse', formatId: 'NOT_AN_ADAPTER', extensionClass: '.brd', errorCode: 'C:\\secret\\x' , message: 'private board text' },
      exception: 'private exception'
    }
  });
  const json = contract.canonicalizeBugReport(projected);
  assert.match(projected.description, /Issue\ncontinues/);
  assert.equal(projected.diagnostics.lastImport.formatId, null);
  assert.equal(projected.diagnostics.lastImport.errorCode, null);
  for (const secret of ['/private/name', 'private exception', 'private board text', 'C:\\secret']) assert.equal(json.includes(secret), false);
});

test('acknowledgement requires exact closed schema, identity and hash', () => {
  const ack = { schema: contract.ACK_SCHEMA, reportId: 'id', payloadHash: 'a'.repeat(64), status: 'received' };
  assert.equal(contract.isValidAcknowledgement(ack, 'id', 'a'.repeat(64)), true);
  assert.equal(contract.isValidAcknowledgement({ ...ack, url: 'https://example.invalid' }, 'id', 'a'.repeat(64)), false);
  assert.equal(contract.isValidAcknowledgement({ ...ack, status: 'queued' }, 'id', 'a'.repeat(64)), false);
});

test('generated Worker bundle is standalone and loads the shared contract', async () => {
  const bundlePath = path.resolve(__dirname, '../services/bug-report-worker/bundle.mjs');
  const source = fs.readFileSync(bundlePath, 'utf8');
  assert.equal(/\b(?:import\s|require\s*\()/.test(source), false);
  const bundled = await import(require('node:url').pathToFileURL(bundlePath).href + `?check=${Date.now()}`);
  const response = await bundled.default.fetch(new Request('https://receiver.example/missing', { method: 'GET' }), {});
  assert.equal(response.status, 404);
});
