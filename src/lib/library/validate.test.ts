import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as ts from './validate';
import { DEFAULT_LIBRARY_SETTINGS, DEFAULT_ROOT_OPTIONS, LIBRARY_ERRORS, LIBRARY_KINDS, FILE_ROLES, FILE_STATES } from './model';
const require = createRequire(import.meta.url);
const cjs = require('../../../electron/library/validate.cjs');
const query = { text: 'part:TPS51225', mode: 'boards', filters: {}, sort: 'relevance', direction: 'asc', limit: 200 };
const target = { kind: 'content', sha256: 'a'.repeat(64) };
const cases: Record<string, unknown> = {
  roots: {}, 'add-root': { label: 'Bench' }, 'remove-root': { rootId: 'root1', forgetCorrections: false }, 'root-options': { rootId: 'root1', options: { ...DEFAULT_ROOT_OPTIONS, exclusions: [] } },
  scan: { mode: 'changes' }, pause: {}, resume: {}, stop: {}, status: {}, settings: { settings: DEFAULT_LIBRARY_SETTINGS }, 'get-settings': {}, query,
  group: { id: 'group1' }, file: { id: 'file1' }, similar: { id: 'group1', basis: 'layout' }, decide: { decision: { kind: 'role', target, role: 'board' } },
  open: { fileId: 'file1', select: { ref: 'U7000' } }, attach: { fileIds: ['file1'] }, reveal: { fileId: 'file1' }, ocr: { contentId: 'content1', pages: 'triage' }, 'delete-index': { keepRoots: true, keepCorrections: true },
};
const board = { kind: 'board', identity: { identifiers: [] }, refs: ['U1'], rails: ['+3V3'], terms: [], adapter: 'gencad', parts: 1, pins: 2, nets: 1, sides: ['top'], fingerprint: 'fp1:' + 'a'.repeat(64), fingerprintVersion: 1, minhash: Array(128).fill(0), components: [{ ref: 'U1', value: 'TPS51225', pinCount: 2, source: 'header' }], passives: [] };
const document = { kind: 'document', identity: { identifiers: [] }, refs: [], rails: [], terms: [], format: 'pdf', role: 'schematic', pages: 2, textLayer: 'no', ocr: 'triage', pageHashes: ['b'.repeat(64), 'c'.repeat(64)] };
const job = { version: 1, type: 'job', jobId: 'job1', contentId: 'content1', generation: 1, extractorVersion: 1, kind: 'pdf', format: 'pdf', name: 'board.pdf', bytes: new Uint8Array([1]), options: { fullText: false, ocr: 'triage' } };
const result = { version: 1, type: 'result', jobId: 'job1', contentId: 'content1', generation: 1, extractorVersion: 1, summary: document };
const both = (method: keyof typeof ts, value: unknown, valid: boolean, other?: unknown) => { expect((ts[method] as Function)(value, other)).toBe(valid); expect(cjs[method](value, other)).toBe(valid); };
describe('library transport validation and native parity', () => {
  it('keeps the generated twin current', () => { execFileSync(process.execPath, ['scripts/library-validate.cjs', '--check']); });
  it.each(Object.entries(cases))('validates %s and refuses extra fields', (operation, args) => {
    for (const value of [args, { ...(args as object), path: '../escape' }, null, [], 'value']) {
      const valid = value === args;
      expect(ts.validateLibraryArgs(operation as never, value)).toBe(valid);
      expect(cjs.validateLibraryArgs(operation, value)).toBe(valid);
      both('validateLibraryRequest', { version: 1, requestId: 'request1', operation, args: value }, valid);
    }
  });
  it.each(['../escape', '/absolute', 'C:/absolute', '//server/share', 'a\\b', 'a:b', 'a/../b', './b', 'a//b', 'CON.txt', 'a.', 'a ', 'a\0b'])('rejects relative path trick %s', path => {
    both('isRelativeLibraryPath', path, false);
    both('validateLibraryDecision', { kind: 'hide', target: { kind: 'file', rootId: 'root1', relativePath: path }, hidden: true }, false);
  });
  it.each(['board.pdf', 'folder/rev B/board.pdf', 'folder/\u00e1.pdf'])('allows normalized relative location %s', path => both('isRelativeLibraryPath', path, true));
  it('accepts every decision and persists no ephemeral content IDs in pair decisions', () => {
    for (const decision of [{ kind: 'merge', groups: ['g1', 'g2'] }, { kind: 'split', groupId: 'g1', contents: ['c1'] }, { kind: 'same', a: target, b: { ...target, sha256: 'b'.repeat(64) } }, { kind: 'different', a: target, b: target }, { kind: 'label', groupId: 'g1', label: 'Bench' }, { kind: 'role', target, role: 'board' }, { kind: 'tag', groupId: 'g1', tag: 'bench', enabled: true }, { kind: 'hide', target, hidden: true }]) both('validateLibraryDecision', decision, true);
    both('validateLibraryDecision', { kind: 'merge', groups: ['g1', 'g1'] }, false);
    both('validateLibraryDecision', { kind: 'same', a: { contentId: 'c1' }, b: target }, false);
  });
  it('rejects hostile trees without invoking accessors', () => {
    let nested: unknown = {}; for (let i = 0; i < 1000; i++) nested = { child: nested };
    const cycle: any = {}; cycle.child = cycle;
    const getter = Object.defineProperty({}, 'label', { enumerable: true, get() { throw new Error('accessed'); } });
    for (const v of [nested, cycle, getter, JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: {} }, Object.create({ label: 'x' }), { label: 'x'.repeat(200000) }, Array(250001).fill(0), new Date(), { label: Symbol('label') }, { label: Infinity }]) {
      both('validateLibraryArgs', 'add-root', false, v);
      both('validateIndexSummary', v, false);
    }
  });
  it('enforces enums and search/page caps', () => {
    for (const kind of LIBRARY_KINDS) expect(ts.validateLibraryArgs('query', { ...query, filters: { kinds: [kind] } })).toBe(true);
    for (const role of FILE_ROLES) expect(ts.validateLibraryArgs('query', { ...query, filters: { roles: [role] } })).toBe(true);
    for (const state of FILE_STATES) expect(ts.validateLibraryArgs('query', { ...query, filters: { states: [state] } })).toBe(true);
    for (const error of LIBRARY_ERRORS) both('validateIndexerToService', { version: 1, type: 'error', jobId: 'j1', generation: 0, error }, true);
    for (const q of [{ ...query, limit: 201 }, { ...query, limit: 0 }, { ...query, text: 'x'.repeat(201) }, { ...query, sort: '__proto__' }, { ...query, filters: { path: 'a' } }, { ...query, filters: { kinds: ['invalid'] } }]) expect(ts.validateLibraryArgs('query', q)).toBe(false);
  });
  it('validates bounded board, document and image summaries', () => {
    for (const s of [board, document, { kind: 'image', width: 32, height: 32 }]) both('validateIndexSummary', s, true);
    for (const s of [{ ...board, minhash: [0] }, { ...board, pins: 1000001 }, { ...board, components: Array(20001).fill(board.components[0]) }, { ...board, rails: Array(2001).fill('VCC') }, { ...board, secretKey: 'secret' }, { ...board, passives: Array(5001).fill({ kind: 'resistor', count: 1 }) }, { ...document, pages: 2001 }, { ...document, pageHashes: ['a'.repeat(64)] }, { ...document, fullText: [{ page: 3, body: 'outside' }] }, { ...document, author: 'forbidden' }]) both('validateIndexSummary', s, false);
  });
  it('validates jobs and matches result identity, generation and permissions', () => {
    both('validateServiceToIndexer', job, true); both('validateIndexerToService', result, true); both('validateResultForJob', result, true, job);
    for (const r of [{ ...result, generation: 2 }, { ...result, contentId: 'c2' }, { ...result, extractorVersion: 2 }, { ...result, summary: { ...document, fullText: [{ page: 1, body: 'secret' }] } }, { ...result, summary: { ...document, ocr: 'all' } }, { ...result, summary: board }]) both('validateResultForJob', r, false, job);
    both('validateServiceToIndexer', { ...job, name: '../escape' }, false);
    both('validateResultForJob', { ...result, summary: { ...document, identity: { identifiers: [{ kind: 'title', raw: 'Board', norm: 'BOARD', source: 'ocr', confidence: 90, page: 3 }] } } }, false, job);
    both('validateResultForJob', { ...result, summary: { ...document, fullText: [{ page: 1, body: 'enabled' }] } }, true, { ...job, options: { ...job.options, fullText: true } });
  });
  it('allows registered network roots but forbids their live watch', () => {
    const root = { id: 'r1', label: 'Bench', state: 'online', network: true, options: { ...DEFAULT_ROOT_OPTIONS, exclusions: [] }, fileCount: 0, realpath: '\\\\server\\share' };
    const config = { version: 1, type: 'configure', roots: [root], settings: DEFAULT_LIBRARY_SETTINGS, generation: 0 };
    both('validateMainToService', config, true);
    both('validateMainToService', { ...config, roots: [{ ...root, options: { ...root.options, watch: true } }] }, false);
  });
  it('validates responses and service events without accepting paths in query rows', () => {
    both('validateLibraryResponse', { version: 1, requestId: 'r1', operation: 'roots', ok: true, result: [] }, true);
    both('validateLibraryResponse', { version: 1, requestId: 'r1', operation: 'roots', ok: true, result: [{ path: '/absolute' }] }, false);
    both('validateServiceToMain', { version: 1, type: 'checkpointed', requestId: 'r1' }, true);
    both('validateLibraryEvent', { version: 1, type: 'changed', generation: 1, groupIds: ['g1'] }, true);
    both('validateLibraryEvent', { version: 2, type: 'changed', generation: 1, groupIds: ['g1'] }, false);
  });
  it('has equal total behaviour on deterministic arbitrary JSON', () => {
    let seed = 42;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let n = 0; n < 1000; n++) {
      const value = { [next() % 2 ? 'label' : '__proto__']: next() % 3 ? String(next()) : { child: next() } };
      expect(ts.validateLibraryArgs('add-root', value)).toBe(cjs.validateLibraryArgs('add-root', value));
      expect(ts.validateIndexSummary(value)).toBe(cjs.validateIndexSummary(value));
    }
  });
});
