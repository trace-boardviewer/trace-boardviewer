import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import schema from '../../../electron/diagnostic-schema.json';
import {
  CONTAINERS, ENCODINGS, ERROR_CODES, FORMAT_IDS, HEADER_CODES, HEADER_COUNTS, HOOK_IDS, LINE_ENDINGS, PITCHES, STAGES, UNIT_KINDS, VARIANTS,
  KEYWORDS, EXTENSIONS, MAGIC_LABELS, REDACTION_VERSION, SCHEMA_ID, type DiagnosticReport,
} from './report';

const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../../electron/diagnostics.cjs') as {
  validateReport(value: unknown, options?: { reviewed?: boolean }): DiagnosticReport;
  serializeReport(report: DiagnosticReport): string;
  schemaDescription(): string;
  roundSig2(value: number): number;
};
const GOLDEN = new URL('./schema.golden.txt', import.meta.url);

/** A minimal valid report of an unrecognized file: the smallest thing the schema accepts. */
export function minimalReport(): DiagnosticReport {
  return {
    schema: SCHEMA_ID,
    app: { version: '1.3.0', adapterSet: '0123abcd', os: 'win32' },
    privacy: { redaction: REDACTION_VERSION, level: 1, reviewedByUser: false, dedupe: false },
    input: {
      extension: '.brd', sizeLog2: 12, companions: { count: 0, extensions: [] }, container: 'none', textLike: false, encoding: 'binary', lineEndings: 'n/a',
      entropy: Array.from({ length: 16 }, () => 7.9), magic: 'none',
    },
    detection: { outcome: 'unrecognized', selected: null, format: null, ambiguous: false, adapters: [] },
    structure: null, result: null, plausibility: null,
    keys: { supplied: false, parity: 'n/a' },
    performance: { parseMs: 12, peakHeapLog2: null },
    dedupe: null,
  };
}

const reject = (mutate: (report: any) => void, level: 1 | 2 = 1) => {
  const report: any = minimalReport();
  report.privacy.level = level;
  mutate(report);
  expect(() => diagnostics.validateReport(report)).toThrow(/Invalid diagnostic report/);
};

describe('trace-format-diagnostic/1 whitelist', () => {
  it('matches the golden description: a field or a list member cannot be added without the golden changing in the same commit', () => {
    const actual = diagnostics.schemaDescription();
    if (process.env.UPDATE_DIAGNOSTIC_GOLDEN === '1') writeFileSync(GOLDEN, actual);
    expect(existsSync(GOLDEN), 'schema.golden.txt is missing (UPDATE_DIAGNOSTIC_GOLDEN=1 writes it)').toBe(true);
    expect(actual).toBe(readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('keeps the literal lists of report.ts identical to the enumerations of the schema', () => {
    const lists: Array<[string, readonly string[]]> = [
      ['stage', STAGES], ['errorCode', ERROR_CODES], ['formatId', FORMAT_IDS], ['hookId', HOOK_IDS], ['variant', VARIANTS], ['unitKind', UNIT_KINDS],
      ['headerCode', HEADER_CODES], ['headerCount', HEADER_COUNTS], ['container', CONTAINERS], ['encoding', ENCODINGS], ['lineEndings', LINE_ENDINGS], ['pitch', PITCHES],
    ];
    for (const [name, list] of lists) expect([...list], name).toEqual((schema.enums as Record<string, string[]>)[name]);
    expect(SCHEMA_ID).toBe(schema.$id);
  });

  it('has enumerations without duplicates, in printable ASCII, and no member that could hold a free-form string', () => {
    for (const [name, values] of Object.entries(schema.enums)) {
      expect(new Set(values).size, `${name} has duplicates`).toBe(values.length);
      for (const value of values) {
        expect(value, `${name}: ${value}`).toMatch(/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/);
        expect(value.length, `${name}: ${value}`).toBeLessThanOrEqual(40);
      }
    }
    expect(KEYWORDS.size).toBe(schema.enums.keyword.length);
    expect(EXTENSIONS.has('other') && EXTENSIONS.has('none')).toBe(true);
    expect(MAGIC_LABELS.has('none')).toBe(true);
    // The extension list is lowercase public suffixes only.
    for (const extension of schema.enums.extension) expect(extension).toMatch(/^(?:none|other|\.[a-z0-9_]{1,10})$/);
  });

  it('accepts the minimal report and writes it in canonical form', () => {
    const report = diagnostics.validateReport(minimalReport());
    expect(report).toEqual(minimalReport());
    const text = diagnostics.serializeReport(report);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(report);
  });

  it('rejects extra keys anywhere, unknown enumeration members and wrong types', () => {
    reject(report => { report.extra = 1; });
    reject(report => { report.app.host = 'x'; });
    reject(report => { report.input.fileName = 'board.brd'; });
    reject(report => { report.input.companions.names = []; });
    reject(report => { report.app.os = 'freebsd'; });
    reject(report => { report.input.extension = '.exe'; });
    reject(report => { report.input.magic = 'U12'; });
    reject(report => { report.input.encoding = 'latin1'; });
    reject(report => { report.detection.outcome = 'maybe'; });
    reject(report => { report.keys.parity = 'unknown'; });
    reject(report => { report.schema = 'trace-format-diagnostic/2'; });
    reject(report => { report.privacy.reviewedByUser = 'yes'; });
    reject(report => { report.input.entropy = report.input.entropy.slice(1); });
    reject(report => { report.input.entropy[0] = 7.93; });
    reject(report => { report.performance.parseMs = 1234; }); // not rounded to two significant digits
    reject(report => { report.app.version = '1.3.0-beta'; });
    reject(report => { report.app.adapterSet = 'XYZ'; });
    reject(report => { report.dedupe = 'abcdef0123456789'; }); // present although privacy.dedupe is false
  });

  it('rejects strings anywhere a fact must be a number or a member of a list, including keys of records', () => {
    const structure = {
      hook: 'gencad', kind: 'text', variant: 'gencad-1.4', headerOk: true, linesLog2: 10, keywords: { '$HEADER': 1 }, fields: {}, numbers: null,
      sections: [], header: { codes: {}, counts: {} }, blocks: null,
    };
    const accepted: any = minimalReport();
    accepted.structure = structure;
    expect(() => diagnostics.validateReport(accepted)).not.toThrow();
    reject(report => { report.structure = { ...structure, keywords: { U12: 1 } }; });
    reject(report => { report.structure = { ...structure, keywords: { '$HEADER': 'U12' } }; });
    reject(report => { report.structure = { ...structure, keywords: { '$HEADER': 123 } }; });
    reject(report => { report.structure = { ...structure, hook: 'my-hook' }; });
    reject(report => { report.structure = { ...structure, header: { codes: { serial: 5 }, counts: {} } }; });
    reject(report => { report.structure = { ...structure, header: { codes: { version: 1.5 }, counts: {} } }; });
    reject(report => { report.structure = { ...structure, sections: [{ name: 'U12', records: 10 }] }; });
    reject(report => { report.structure = { ...structure, blocks: { tagBits: 8, tags: { x: 1 }, lengths: {} } }; });
  });

  it('keeps level-2 fields out of level-1 reports and accepts them in level-2 reports', () => {
    const structure = (extra: object) => ({
      hook: 'gencad', kind: 'text', variant: null, headerOk: false, linesLog2: 4, keywords: {}, fields: {}, numbers: null,
      sections: [{ name: '$HEADER', records: 4, ...extra }], header: { codes: {}, counts: {} }, blocks: null,
    });
    const shapes = { distinctShapes: 2, shapes: [{ shape: 'A A 9.9', count: 2 }] };
    reject(report => { report.structure = structure(shapes); }, 1);
    const level2: any = minimalReport();
    level2.privacy.level = 2;
    level2.structure = structure(shapes);
    expect(() => diagnostics.validateReport(level2)).not.toThrow();
    // A shape is built from the collapse alphabet only: letters and digits would be content.
    for (const shape of ['U12', 'abc', '9 9\n9', 'AéA', 'x'.repeat(10)]) {
      const bad: any = minimalReport();
      bad.privacy.level = 2;
      bad.structure = structure({ distinctShapes: 1, shapes: [{ shape, count: 1 }] });
      expect(() => diagnostics.validateReport(bad), shape).toThrow(/Invalid diagnostic report/);
    }
  });

  it('refuses objects that smuggle data past a plain copy: accessors, symbols, prototypes and oversize input', () => {
    const accessor: any = minimalReport();
    Object.defineProperty(accessor.app, 'version', { get: () => '1.3.0', enumerable: true });
    expect(() => diagnostics.validateReport(accessor)).toThrow(/accessor/);
    const symbol: any = minimalReport();
    symbol.app[Symbol('x')] = 1;
    expect(() => diagnostics.validateReport(symbol)).toThrow(/symbol/);
    const proto: any = JSON.parse(JSON.stringify(minimalReport()).replace('"app":{', '"app":{"__proto__":{"polluted":true},'));
    expect(() => diagnostics.validateReport(proto)).toThrow(/Invalid diagnostic report/);
    expect(({} as any).polluted).toBeUndefined();
    expect(() => diagnostics.validateReport(Object.assign(Object.create({ inherited: 1 }), minimalReport()))).toThrow(/expected an object/);
    expect(() => diagnostics.validateReport('{}')).toThrow(/expected an object/);
    expect(() => diagnostics.validateReport(null)).toThrow(/expected an object/);
    const wide: any = minimalReport();
    wide.input.companions.extensions = Array.from({ length: 9 }, () => '.asc');
    expect(() => diagnostics.validateReport(wide)).toThrow(/length out of range/);
  });

  it('requires the review flag on the save path only', () => {
    expect(() => diagnostics.validateReport(minimalReport(), { reviewed: true })).toThrow(/not reviewed/);
    const reviewed = minimalReport();
    reviewed.privacy.reviewedByUser = true;
    expect(() => diagnostics.validateReport(reviewed, { reviewed: true })).not.toThrow();
  });

  it('rounds counts to two significant digits and nothing else', () => {
    expect(diagnostics.roundSig2(0)).toBe(0);
    expect(diagnostics.roundSig2(1234)).toBe(1200);
    expect(diagnostics.roundSig2(99)).toBe(99);
    expect(diagnostics.roundSig2(101)).toBe(100);
  });
});
