import { createRequire } from 'node:module';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import schema from '../../../electron/diagnostic-schema.json';
import { findLeaks } from './canary-check';
import { ALL_BUILDERS, secretsOf, type BuiltFile } from './canary-kit';
import { collectDiagnostic, projectReport } from './collect';
import { MAGIC_LABELS, type DiagnosticReport } from './report';

/*
 * Property tests (fast-check, fixed seeds so a failure reproduces): random bytes, random synthetic boards with hostile names and
 * damaged copies of valid files always produce a report that the closed schema accepts at both levels, within the size bound, and
 * that holds none of the strings the input carried. A mutation of an accepted report either is rejected or still consists of
 * whitelisted values only.
 */
const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../../electron/diagnostics.cjs') as {
  validateReport(value: unknown, options?: { reviewed?: boolean }): DiagnosticReport;
  serializeReport(report: DiagnosticReport): string;
  MAX_BYTES: number;
};
const ENV = { os: 'darwin' as const, appVersion: '1.3.0', dedupe: '0011223344556677' };
const SEED = 20261007;
const RUNS = (count: number) => ({ numRuns: count, seed: SEED, endOnFailure: true });

/** Validates both projections and returns the saved texts. */
function checked(report: DiagnosticReport): string[] {
  return ([1, 2] as const).map(level => {
    const projected = projectReport(report, { level, dedupe: level === 2, reviewed: true });
    const copy = diagnostics.validateReport(projected, { reviewed: true });
    const text = diagnostics.serializeReport(copy);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(diagnostics.MAX_BYTES);
    expect(JSON.parse(text)).toEqual(copy);
    return text;
  });
}

// --- Generators ------------------------------------------------------------------------------------------------------------------
const unique = fc.stringMatching(/^ZQ[A-Za-z0-9]{10}$/);
/** Names as hostile as a real file can make them: any unicode, controls, quotes, separators of every format, long runs. */
const hostileSuffix = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 12 }), fc.string({ unit: 'binary', maxLength: 12 }), fc.constantFrom('', '"', '\\', '<>', '$HEADER', '(net', '!!', '|RECORD=Net|', '‮', '\u0000', 'é'.repeat(30)),
);
const name = fc.tuple(unique, hostileSuffix).map(([token, suffix]) => ({ token, text: `${token}${suffix}`.replace(/[\r\n\t ]/g, '_') }));
const number = fc.double({ min: 1, max: 9999, noNaN: true }).map(value => value.toFixed(4));

interface Spec { parts: Array<{ ref: ReturnType<typeof name> extends fc.Arbitrary<infer T> ? T : never; net: ReturnType<typeof name> extends fc.Arbitrary<infer T> ? T : never; x: string; y: string }> }
const spec = fc.array(fc.record({ ref: name, net: name, x: number, y: number }), { minLength: 1, maxLength: 6 }).map((parts): Spec => ({ parts }));
const tokensOf = (value: Spec) => value.parts.flatMap(part => [part.ref.token, part.net.token]);

function bvr3Of(value: Spec): Uint8Array {
  const rows = ['BVRAW_FORMAT_3'];
  for (const part of value.parts) rows.push(`PART_NAME ${part.ref.text}`, 'PART_SIDE T', `PART_ORIGIN ${part.x} ${part.y}`, 'PIN_NUMBER 1', 'PIN_SIDE T', 'PIN_ORIGIN 0 0', 'PIN_RADIUS 5', `PIN_NET ${part.net.text}`, 'PIN_END', 'PART_END');
  return new TextEncoder().encode(rows.join('\n') + '\n');
}
function gencadOf(value: Spec): Uint8Array {
  const rows = ['$HEADER', 'GENCAD 1.4', 'UNITS MM', '$ENDHEADER', '$BOARD', 'RECTANGLE 0 0 9999 9999', '$ENDBOARD', '$PADS', 'PAD P ROUND -1', 'CIRCLE 0 0 0.2', '$ENDPADS', '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS',
    '$SHAPES', 'SHAPE S', 'PIN 1 PS 0 0 TOP 0 0', '$ENDSHAPES', '$COMPONENTS'];
  value.parts.forEach((part, index) => rows.push(`COMPONENT "${part.ref.text.replace(/"/g, '')}${index}"`, `PLACE ${part.x} ${part.y}`, 'LAYER TOP', 'ROTATION 0', 'SHAPE S 0 0'));
  rows.push('$ENDCOMPONENTS', '$SIGNALS');
  value.parts.forEach((part, index) => rows.push(`SIGNAL "${part.net.text.replace(/"/g, '')}${index}"`, `NODE "${part.ref.text.replace(/"/g, '')}${index}" 1`));
  rows.push('$ENDSIGNALS');
  return new TextEncoder().encode(rows.join('\n') + '\n');
}
function kicadOf(value: Spec): Uint8Array {
  const esc = (text: string) => text.replace(/[\\"]/g, '_');
  const rows = ['(kicad_pcb (version 20240108) (generator "pcbnew")', ' (net 0 "")'];
  value.parts.forEach((part, index) => rows.push(` (net ${index + 1} "${esc(part.net.text)}")`));
  value.parts.forEach((part, index) => rows.push(` (footprint "L:${esc(part.ref.text)}" (layer "F.Cu") (at ${part.x} ${part.y} 0) (property "Reference" "${esc(part.ref.text)}${index}") (property "Value" "${esc(part.net.text)}")`,
    `  (pad "${index + 1}" smd rect (at 1 1 0) (size 1 1) (layers "F.Cu") (net ${index + 1} "${esc(part.net.text)}")))`));
  rows.push(' (gr_rect (start 0 0) (end 9999 9999) (layer "Edge.Cuts")))');
  return new TextEncoder().encode(rows.join('\n') + '\n');
}
function samsungOf(value: Spec): Uint8Array {
  const rows = ['###Panel Added: x'];
  value.parts.forEach((part, index) => rows.push(`COMP ${part.ref.text}${index} P 0 0 ${part.x} ${part.y} 1 0`, `C_PIN ${part.ref.text}${index}-1 ${part.x} ${part.y} 0 0 0 X /${part.net.text}`));
  return new TextEncoder().encode(rows.join('\n') + '\n');
}
const EMITTERS: Array<[string, string, (value: Spec) => Uint8Array]> = [['board.bvr', 'bvr3', bvr3Of], ['board.cad', 'gencad', gencadOf], ['board.kicad_pcb', 'kicad', kicadOf], ['board.cad', 'samsung', samsungOf]];

describe('property: every input yields a valid, content-free report', () => {
  it('random bytes (random, text-like, magic-prefixed) never break the collector or the schema', async () => {
    const magic = fc.constantFrom(...[
      [0x1f, 0x8b, 8], [0x50, 0x4b, 3, 4], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0xef, 0xbb, 0xbf], [0xff, 0xfe, 0x41, 0], [0x23, 0xe2, 0x63, 0x28], [0x58, 0x5a, 0x5a, 0x50, 0x43, 0x42], [0x78, 0x9c], [],
    ].map(bytes => Uint8Array.from(bytes)));
    const bytes = fc.tuple(magic, fc.uint8Array({ maxLength: 4096 })).map(([head, tail]) => Uint8Array.from([...head, ...tail]));
    const textual = fc.array(fc.string({ unit: 'binary', maxLength: 60 }), { maxLength: 80 }).map(rows => new TextEncoder().encode(rows.join('\n')));
    await fc.assert(fc.asyncProperty(fc.oneof(bytes, textual), fc.constantFrom('a.brd', 'b.cad', 'c.kicad_pcb', 'd.fz', 'e.pcb', 'f.bdv', 'g.asc', 'noext', 'h.unknownext'), async (data, fileName) => {
      const report = await collectDiagnostic({ name: fileName, data }, ENV);
      checked(report);
      expect(report.performance.parseMs).toBeGreaterThanOrEqual(0);
    }), RUNS(120));
  });

  for (const [fileName, label, emit] of EMITTERS) {
    it(`random ${label} boards with hostile names: valid reports that hold none of the names`, async () => {
      let runs = 0, opened = 0;
      await fc.assert(fc.asyncProperty(spec, async value => {
        const report = await collectDiagnostic({ name: fileName, data: emit(value) }, ENV);
        runs++; if (report.detection.outcome === 'opened') opened++;
        for (const text of checked(report)) expect(findLeaks(text, { strings: tokensOf(value) }), label).toEqual([]);
      }), RUNS(40));
      // The property must exercise the hooks and the result facts, not only the error paths.
      expect(opened, `${label}: ${opened} of ${runs} boards opened`).toBeGreaterThanOrEqual(runs / 2);
    });
  }

  it('damaged copies of the seeded files (random byte changes, cuts and insertions) stay valid and leak nothing', async () => {
    const files: BuiltFile[] = ALL_BUILDERS.map(build => build());
    const damage = fc.record({
      index: fc.nat({ max: files.length - 1 }),
      edits: fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 255 }), fc.constantFrom('set', 'insert', 'delete')), { maxLength: 24 }),
      cut: fc.option(fc.double({ min: 0.05, max: 1, noNaN: true }), { nil: undefined }),
    });
    await fc.assert(fc.asyncProperty(damage, async ({ index, edits, cut }) => {
      const file = files[index];
      let data = Array.from(file.data);
      for (const [where, byte, kind] of edits) {
        const at = Math.min(data.length - 1, Math.floor(where * data.length));
        if (at < 0) break;
        if (kind === 'set') data[at] = byte; else if (kind === 'insert') data.splice(at, 0, byte); else data.splice(at, 1);
      }
      if (cut !== undefined) data = data.slice(0, Math.floor(data.length * cut));
      const report = await collectDiagnostic({ name: file.name, data: Uint8Array.from(data), ...(file.companions ? { companions: file.companions } : {}), ...(file.options ? { options: file.options } : {}) }, ENV);
      for (const text of checked(report)) expect(findLeaks(text, secretsOf(file)), file.label).toEqual([]);
    }), RUNS(150));
  });
});

// --- The schema as a whitelist of values ---------------------------------------------------------------------------------------------
const ENUM_SETS = Object.values(schema.enums).map(values => new Set<string>(values));
const SHAPE = new RegExp(schema.definitions.shape.pattern);
const PATTERNS = [/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/, /^[0-9a-f]{8}$/, /^[0-9a-f]{16}$/, /^(?:zero|-?(?:[0-9]|1[0-5]))$/, /^(?:[0-9]|10\+)$/, /^(?:0|[1-9][0-9]{0,4})$/, /^(?:[0-9]|[12][0-9]|3[0-2])$/];
const isWhitelisted = (text: string): boolean => text === schema.$id || ENUM_SETS.some(set => set.has(text)) || PATTERNS.some(pattern => pattern.test(text)) || SHAPE.test(text);
function leaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) leaves(item, into);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { into.push(key); leaves(item, into); }
  return into;
}

describe('property: the validator is a closed whitelist', () => {
  it('every string and every key of a valid report is a whitelisted value, whatever the input was', async () => {
    const files = ALL_BUILDERS.map(build => build());
    await fc.assert(fc.asyncProperty(fc.nat({ max: files.length - 1 }), fc.boolean(), async (index, secondLevel) => {
      const file = files[index];
      const report = await collectDiagnostic({ name: file.name, data: file.data, ...(file.companions ? { companions: file.companions } : {}), ...(file.options ? { options: file.options } : {}) }, ENV);
      const copy = diagnostics.validateReport(projectReport(report, { level: secondLevel ? 2 : 1, dedupe: true, reviewed: true }), { reviewed: true });
      for (const text of leaves(copy)) {
        const fieldName = /^[A-Za-z][A-Za-z0-9]*$/.test(text);
        expect(isWhitelisted(text) || fieldName, `not whitelisted: ${JSON.stringify(text)}`).toBe(true);
      }
    }), RUNS(60));
  });

  it('a report with one arbitrary change is either rejected or still made of whitelisted values only (no field, key or string can be added)', async () => {
    const base = await collectDiagnostic({ name: 'b.cad', data: ALL_BUILDERS[0]().data }, ENV);
    const valid = diagnostics.validateReport(projectReport(base, { level: 2, dedupe: true, reviewed: true }), { reviewed: true });
    const paths: string[][] = [];
    (function walk(value: unknown, path: string[]) {
      paths.push(path);
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, String(index)]));
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    })(valid, []);
    const replacement = fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.constant([]), fc.constant({}), fc.record({ extra: fc.string() }), fc.constantFrom('U12', 'NET_5V0', '$HEADER', 'A9', '1.2.3'));
    fc.assert(fc.property(fc.nat({ max: paths.length - 1 }), replacement, fc.constantFrom('replace', 'add', 'rename'), (pick, value, mode) => {
      const mutated = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      const path = paths[pick];
      if (path.length === 0) return;
      let holder: any = mutated;
      for (const key of path.slice(0, -1)) holder = holder[key];
      const last = path[path.length - 1];
      if (mode === 'replace') holder[last] = value;
      else if (mode === 'add') { if (holder && typeof holder === 'object' && !Array.isArray(holder)) holder[`k${typeof value === 'string' ? value : 'x'}`] = value; else return; }
      else if (holder && typeof holder === 'object' && !Array.isArray(holder)) { holder[typeof value === 'string' && value ? value : 'renamed'] = holder[last]; delete holder[last]; } else return;
      let accepted: DiagnosticReport | null = null;
      try { accepted = diagnostics.validateReport(mutated); } catch { /* rejected: the expected outcome for almost every change */ }
      if (!accepted) return;
      for (const text of leaves(accepted)) expect(isWhitelisted(text) || /^[A-Za-z][A-Za-z0-9]*$/.test(text), `accepted a non-whitelisted value ${JSON.stringify(text)}`).toBe(true);
      expect(accepted).toEqual(JSON.parse(JSON.stringify(accepted)));
    }), RUNS(400));
  });

  it('keeps the magic labels the input facts can produce inside the schema', async () => {
    const files = ALL_BUILDERS.map(build => build());
    for (const file of files) expect(MAGIC_LABELS.has((await collectDiagnostic({ name: file.name, data: file.data, ...(file.companions ? { companions: file.companions } : {}) }, ENV)).input.magic)).toBe(true);
  });
});
