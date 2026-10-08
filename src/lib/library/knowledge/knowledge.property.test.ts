/**
 * Property-based tests (fast-check) of the Library's recognition modules: every function is total on any text, its output is
 * bounded and well-formed, and its work grows linearly with the text, counted in examined characters (no clock).
 *
 * Every property runs with a FIXED seed so the suite is deterministic; to explore more:
 *   FC_RUNS_FACTOR=20 pnpm test src/lib/library/knowledge/knowledge.property   twenty times as many cases per property
 *   FC_SEED=1234 ...                                                           another fixed seed
 *   FC_SEED=random ...                                                         a fresh seed every run (printed on failure)
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BOARD_NUMBER_SHAPES } from './board-number-shapes';
import { recognizeBoardNumbers } from './board-numbers';
import { MAX_MATCHES, MAX_TEXT_LENGTH, RECOGNITION_SCOPES, foldCode, type RecognitionScope, type WorkMeter } from './chars';
import { deviceTypeHints, documentTypeHints, vendorHints } from './hints';
import { DEVICE_TYPES, DOCUMENT_TYPES, VENDORS } from './lexicon';
import { analyzePath } from './names';
import { PART_CATEGORIES, PART_FAMILIES } from './part-families';
import { matchTier, normalizePartNumber } from './part-numbers';
import { compareRevisions, parseRevisions } from './revision';
import { TOKEN_CLASSES, classifyToken, countTokenClasses, tokenizeText } from './tokens';
import { expectBoundedWork, expectScaling } from '../../../test-support/timing';

const DEFAULT_SEED = 20261007;
const seed = ((): number => {
  const text = process.env.FC_SEED;
  if (text === undefined || text === '') return DEFAULT_SEED;
  if (text === 'random') return Math.floor(Math.random() * 0x7fffffff);
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : DEFAULT_SEED;
})();
const factor = ((): number => { const value = Number(process.env.FC_RUNS_FACTOR); return Number.isFinite(value) && value > 0 ? value : 1; })();
const params = (runs = 100): { seed: number; numRuns: number } => ({ seed, numRuns: Math.max(1, Math.ceil(runs * factor)) });

// ---------------------------------------------------------------------------------------------------------------
// Text generators
// ---------------------------------------------------------------------------------------------------------------

/** Any text of UTF-16 units, lone surrogates and control characters included. */
const anyText = (max = 300): fc.Arbitrary<string> => fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: max }).map(codes => String.fromCharCode(...codes));
const asciiText = (max = 300): fc.Arbitrary<string> => fc.string({ unit: 'binary-ascii', maxLength: max });

/** Pieces that look like what the recognisers read, glued with separators: far more likely to reach deep code than random bytes. */
const FRAGMENTS = [
  ...BOARD_NUMBER_SHAPES.map(shape => shape.example), '820-01234-A', '051-9876', 'REV A', 'Rev.B', 'R1.0', 'EVT2', 'v2.5', 'MLB-A', 'MacBook', 'laptop', 'Dell', 'Latitude', 'schematic', 'boardview',
  'U7000', 'R12', 'C5001A', 'PP3V3_S0', '+5V', 'GND', '4K7', '100nF', 'SOT-23-5', '0402', 'TPS51225RUKR', 'LM358DR', 'ISL95857HRTZ-T', 'IC-', 'U7100_', 'TI-', 'Sheet', 'of', '12', '2024-10-07', '3/12',
  'DNP', 'NC', '+36', 'tel', 'A1706', 'MB-', 'LA-', 'NM-', 'DA0', '6050A', '48.4', '109-', 'CN-0', 'SM-', '820', '051', '(', ')', '-', '_', '.', '/', ' ', '  ', '\t', '#', '+', ' ', '–', '０', 'é', 'ł', 'я',
];
const structured = (max = 40): fc.Arbitrary<string> => fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: max }).chain(parts => fc.array(fc.constantFrom('', ' ', '-', '_', '/', ', '), { minLength: parts.length, maxLength: parts.length }).map(glue => parts.map((part, index) => part + (glue[index] ?? '')).join('')));
const text = (): fc.Arbitrary<string> => fc.oneof({ weight: 1, arbitrary: anyText() }, { weight: 1, arbitrary: asciiText() }, { weight: 3, arbitrary: structured() });

const withMeter = <T>(run: (meter: WorkMeter) => T): { value: T; steps: number } => { const meter = { steps: 0 }; const value = run(meter); return { value, steps: meter.steps }; };

// ---------------------------------------------------------------------------------------------------------------
// Board numbers
// ---------------------------------------------------------------------------------------------------------------

/** One generator per shape: text written the way the shape says, with invented digits and letters. */
const SHAPE_GENERATORS: ReadonlyArray<[id: string, arbitrary: fc.Arbitrary<string>]> = [
  ['logic-board-820', fc.stringMatching(/^820-[0-9]{5}$/)],
  ['schematic-051', fc.stringMatching(/^051-[0-9]{4,5}$/)],
  ['la-code', fc.stringMatching(/^LA-[A-Z0-9]{4}P$/).filter(value => /[0-9]/.test(value.slice(3, 7)))],
  ['nm-code', fc.stringMatching(/^NM-[A-Z][0-9]{3}$/)],
  ['da0-code', fc.stringMatching(/^DA0[A-Z0-9]{3}MB[A-Z0-9]{3}$/).filter(value => /[0-9]/.test(value.slice(8)))],
  ['dotted-48', fc.stringMatching(/^[0-9]{2}\.[0-9][A-Z]{2}[0-9]{2}\.[0-9]{3}$/)],
  ['inventec-6050a', fc.stringMatching(/^6050A[0-9]{7}$/)],
  ['samsung-ba', fc.stringMatching(/^(BA41|BA59|BA92|BA94)-[0-9]{5}[A-Z]?$/)],
  ['samsung-bn', fc.stringMatching(/^(BN41|BN44|BN94)-[0-9]{5}[A-Z]?$/)],
  ['amd-109', fc.stringMatching(/^109-[A-Z][0-9]{5}-[0-9]{2}$/)],
  ['nvidia-699', fc.stringMatching(/^(600|699)-[0-9][A-Z][0-9]{3}-[0-9]{4}-[0-9]{3}$/)],
  ['cn-dell', fc.stringMatching(/^(CN|TW|MX|PH|MY|TH|BR)-0[A-Z0-9]{5}$/).filter(value => /[0-9]/.test(value.slice(4)) && /[A-Z]/.test(value.slice(4)))],
  ['model-sm', fc.stringMatching(/^SM-[A-Z][0-9]{3}[A-Z]([A-Z0-9])?$/)],
  ['model-gt', fc.stringMatching(/^GT-[A-Z][0-9]{4}[A-Z]?$/)],
  ['asus-60n', fc.stringMatching(/^60N[A-Z]0[A-Z0-9]{3}-MB[0-9]{4}$/)],
  ['lenovo-fru', fc.stringMatching(/^5B[0-9]{2}[A-Z][0-9]{5}$/)],
  ['hp-spare', fc.stringMatching(/^[JKLMNP][0-9]{5}-[0-9]{3}$/)],
  ['sony-console', fc.stringMatching(/^(CUH|CFI|CECH|SCPH)-[0-9]{4}([A-Z]{1,2})?$/)],
];
const BEFORE = ['', 'x ', 'folder/', 'Board ', '(', '[', 'a_', 'Model-X '] as const;
const AFTER = ['', ' ', '.pdf', '_rev', ')', ']', ' final', '/'] as const;

describe('property: board numbers', () => {
  it('is total on any text and its matches are well-formed, ordered and bounded', () => {
    fc.assert(fc.property(text(), fc.constantFrom(...RECOGNITION_SCOPES), (input, scope) => {
      const matches = recognizeBoardNumbers(input, { scope });
      expect(matches.length).toBeLessThanOrEqual(MAX_MATCHES);
      const limit = Math.min(input.length, MAX_TEXT_LENGTH);
      let previousEnd = 0;
      for (const match of matches) {
        expect(match.start).toBeGreaterThanOrEqual(previousEnd);
        expect(match.end).toBeGreaterThan(match.start);
        expect(match.end).toBeLessThanOrEqual(limit);
        previousEnd = match.end;
        expect(match.raw).toBe(input.slice(match.start, match.end));
        expect(match.normalized.length).toBeLessThanOrEqual(40);
        expect(/^[A-Z0-9./-]+$/.test(match.normalized)).toBe(true);
        expect(match.confidence).toBeGreaterThanOrEqual(1);
        expect(match.confidence).toBeLessThanOrEqual(99);
        expect(BOARD_NUMBER_SHAPES.some(shape => shape.id === match.shape)).toBe(true);
        expect(match.scope).toBe(scope);
        if (match.revision !== undefined) expect(match.revision.length).toBeLessThanOrEqual(4);
      }
    }), params(400));
  });

  it('is deterministic', () => {
    fc.assert(fc.property(text(), input => {
      expect(recognizeBoardNumbers(input)).toEqual(recognizeBoardNumbers(input));
    }), params(100));
  });

  it('does not depend on the case of ASCII text', () => {
    fc.assert(fc.property(structured(), input => {
      const lower = recognizeBoardNumbers(input.toLowerCase()).map(match => [match.shape, match.normalized, match.start, match.end]);
      const upper = recognizeBoardNumbers(input.toUpperCase()).map(match => [match.shape, match.normalized, match.start, match.end]);
      // Upper-casing can change the length of some non-ASCII letters; compare only when the lengths agree.
      if (input.toLowerCase().length === input.length && input.toUpperCase().length === input.length) expect(lower).toEqual(upper);
    }), params(200));
  });

  it.each(SHAPE_GENERATORS)('finds a %s number wherever it stands', (id, generator) => {
    fc.assert(fc.property(generator, fc.constantFrom(...BEFORE), fc.constantFrom(...AFTER), (raw, before, after) => {
      const input = `${before}${raw}${after}`;
      const found = recognizeBoardNumbers(input, { scope: 'name' }).filter(match => match.start === before.length && match.end === before.length + raw.length);
      expect(found.map(match => match.shape), input).toContain(id);
      const match = found.find(item => item.shape === id)!;
      expect(match.normalized).toBe(raw.toUpperCase());
    }), params(60));
  });

  it('finds nothing in references, dates, page numbers, part numbers and phone numbers', () => {
    const refdes = fc.stringMatching(/^[A-Z]{1,3}[0-9]{1,4}[A-Z]?$/);
    const date = fc.stringMatching(/^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/);
    const page = fc.stringMatching(/^(page|sheet|p\.|pg) [0-9]{1,3}( of [0-9]{1,3})?$/);
    const part = fc.constantFrom(...PART_FAMILIES.flatMap(family => family.examples));
    const phone = fc.stringMatching(/^\+[0-9]{2} [0-9]{2} [0-9]{3} [0-9]{4}$/);
    fc.assert(fc.property(fc.array(fc.oneof(refdes, date, page, part, phone), { minLength: 1, maxLength: 6 }), pieces => {
      const input = pieces.join('  ');
      const found = recognizeBoardNumbers(input, { scope: 'name' }).filter(match => match.shape !== 'hp-spare' && match.shape !== 'dotted-48');
      expect(found.map(match => match.raw), input).toEqual([]);
    }), params(300));
  });

  it('counts at most a fixed number of steps per character', () => {
    fc.assert(fc.property(text(), input => {
      const { steps } = withMeter(meter => recognizeBoardNumbers(input, { meter }));
      expect(steps).toBeLessThanOrEqual(120 * Math.max(1, Math.min(input.length, MAX_TEXT_LENGTH)));
    }), params(200));
  });

  it('grows linearly on repeated, overlapping prefixes of every shape', () => {
    const units = ['820-820-', 'LA-LA-', 'DA0DA0', '6050A6050A', 'MS-1MS-1', '48.4ZZ01.', '820 820 ', 'BA41-BA41-', '109-A109-', 'CN-0CN-0', 'SM-ASM-', 'NM-ANM-', '051-051-', 'A1706A', 'MB-MB-', '5B20A5B20', '60N60N', 'L12345-L12345-'];
    for (const unit of units) {
      const small = withMeter(meter => recognizeBoardNumbers(unit.repeat(200), { meter })).steps;
      const large = withMeter(meter => recognizeBoardNumbers(unit.repeat(1600), { meter })).steps;
      expect(large, unit).toBeLessThanOrEqual(small * 8 * 1.15 + 200);
      expect(large, unit).toBeLessThanOrEqual(120 * unit.length * 1600);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------------------------------------------

describe('property: revisions', () => {
  it('is total, bounded and well-formed on any text', () => {
    fc.assert(fc.property(text(), input => {
      const matches = parseRevisions(input);
      expect(matches.length).toBeLessThanOrEqual(MAX_MATCHES);
      let previousStart = -1;
      for (const match of matches) {
        expect(match.start).toBeGreaterThanOrEqual(previousStart);
        previousStart = match.start;
        expect(match.end).toBeGreaterThan(match.start);
        expect(match.end).toBeLessThanOrEqual(Math.min(input.length, MAX_TEXT_LENGTH));
        expect(match.normalized.length).toBeGreaterThan(0);
        expect(match.normalized.length).toBeLessThanOrEqual(24);
        expect(match.rank.length).toBeGreaterThanOrEqual(1);
        expect(match.rank.length).toBeLessThanOrEqual(3);
        for (const part of match.rank) expect(Number.isFinite(part)).toBe(true);
        expect(match.confidence).toBeGreaterThanOrEqual(1);
        expect(match.confidence).toBeLessThanOrEqual(99);
      }
    }), params(400));
  });

  it('reads every letter after a label', () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Z]$/), fc.constantFrom('REV ', 'Rev.', 'rev_', 'REV-', 'Revision ', 'REV: '), (letter, label) => {
      const found = parseRevisions(`${label}${letter}`);
      expect(found.map(match => match.normalized)).toEqual([letter]);
    }), params(150));
  });

  it('reads every dotted number after a label, without leading zeros', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 3 }), parts => {
      const found = parseRevisions(`REV ${parts.map(part => String(part).padStart(2, '0')).join('.')}`);
      expect(found).toHaveLength(1);
      expect(found[0].normalized).toBe(parts.join('.'));
      expect(found[0].rank).toEqual(parts);
    }), params(200));
  });

  it('orders revisions as a total order within one scheme and as unknown across schemes', () => {
    const revision = fc.record({ scheme: fc.constantFrom('letter', 'alnum', 'number', 'stage', 'version'), rank: fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 3 }) });
    fc.assert(fc.property(revision, revision, revision, (a, b, c) => {
      expect(compareRevisions(a, a)).toBe(0);
      const ab = compareRevisions(a, b), ba = compareRevisions(b, a);
      if (a.scheme !== b.scheme) { expect(ab).toBeUndefined(); expect(ba).toBeUndefined(); return; }
      expect(ab).toBe(ba === 0 ? 0 : -ba!);
      if (a.scheme === b.scheme && b.scheme === c.scheme && ab! <= 0 && compareRevisions(b, c)! <= 0) expect(compareRevisions(a, c)!).toBeLessThanOrEqual(0);
    }), params(400));
  });

  it('counts at most a fixed number of steps per character, also on repeated units', () => {
    fc.assert(fc.property(text(), input => {
      const { steps } = withMeter(meter => parseRevisions(input, { meter }));
      expect(steps).toBeLessThanOrEqual(120 * Math.max(1, Math.min(input.length, MAX_TEXT_LENGTH)));
    }), params(200));
    for (const unit of ['REV ', 'REV.', 'R1.', 'EVT-', 'v1.', 'MLB-', 'REVA', 'VER ', '820-01234-', 'REV 1.2.3.4.5.6 ']) {
      const small = withMeter(meter => parseRevisions(unit.repeat(200), { meter })).steps;
      const large = withMeter(meter => parseRevisions(unit.repeat(1600), { meter })).steps;
      expect(large, unit).toBeLessThanOrEqual(small * 8 * 1.15 + 200);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Part numbers
// ---------------------------------------------------------------------------------------------------------------

describe('property: part numbers', () => {
  it('is total on any text and its keys are well-formed', () => {
    fc.assert(fc.property(fc.oneof(anyText(120), asciiText(120), structured(12)), input => {
      const keys = normalizePartNumber(input);
      if (keys === null) return;
      expect(keys.original.length).toBeLessThanOrEqual(64);
      expect(keys.exact.length).toBeGreaterThanOrEqual(3);
      expect(keys.exact.length).toBeLessThanOrEqual(48);
      expect(/^[A-Z0-9\-/#+._:]+$/.test(keys.exact)).toBe(true);
      expect(/[0-9]/.test(keys.exact) && /[A-Z]/.test(keys.exact)).toBe(true);
      if (keys.base !== undefined) {
        expect(keys.exact.startsWith(keys.base)).toBe(true);
        expect(keys.family).toBeDefined();
      }
      if (keys.family !== undefined) {
        expect(keys.category).toBeDefined();
        expect(PART_CATEGORIES).toContain(keys.category);
        expect(keys.maker).toBeDefined();
        expect(PART_FAMILIES.some(family => family.id === keys.family)).toBe(true);
        expect(keys.exact).toBe(`${keys.base ?? ''}${keys.base !== undefined ? keys.suffix ?? '' : keys.exact}`);
      } else {
        expect(keys.base).toBeUndefined();
        expect(keys.category).toBeUndefined();
        expect(keys.suffix).toBeUndefined();
      }
    }), params(500));
  });

  it('is idempotent: normalising the exact form gives the same keys', () => {
    fc.assert(fc.property(fc.oneof(asciiText(60), structured(8)), input => {
      const keys = normalizePartNumber(input);
      if (keys === null) return;
      const again = normalizePartNumber(keys.exact);
      expect(again).not.toBeNull();
      expect(again!.exact).toBe(keys.exact);
      expect(again!.base).toBe(keys.base);
      expect(again!.family).toBe(keys.family);
      expect(again!.category).toBe(keys.category);
    }), params(500));
  });

  it('does not depend on the case of ASCII text', () => {
    fc.assert(fc.property(asciiText(60), input => {
      const lower = normalizePartNumber(input.toLowerCase()), upper = normalizePartNumber(input.toUpperCase());
      expect(lower === null).toBe(upper === null);
      if (lower && upper) { expect(lower.exact).toBe(upper.exact); expect(lower.family).toBe(upper.family); expect(lower.base).toBe(upper.base); }
    }), params(300));
  });

  it('keeps the family and the base of a member when a letter suffix is added or changed', () => {
    const members = PART_FAMILIES.filter(family => !family.prefixOnly).flatMap(family => family.examples.map(example => ({ family, core: normalizePartNumber(example)!.base! })));
    fc.assert(fc.property(fc.constantFrom(...members), fc.stringMatching(/^[A-Z]{0,6}$/), fc.constantFrom('', '-', '/', '#', '+'), ({ family, core }, suffix, mark) => {
      const input = `${core}${suffix}${mark}${mark === '' ? '' : 'T'}`;
      const keys = normalizePartNumber(input);
      expect(keys, input).not.toBeNull();
      // A longer family can claim the text only with a longer stem.
      if (keys!.family !== family.id) expect(PART_FAMILIES.find(item => item.id === keys!.family)!.stem.length).toBeGreaterThanOrEqual(family.stem.length);
      else expect(keys!.base).toBe(core);
    }), params(500));
  });

  it('shares the best tier symmetrically for exact, base and family and never above exact for different texts', () => {
    const examples = PART_FAMILIES.flatMap(family => family.examples);
    fc.assert(fc.property(fc.constantFrom(...examples), fc.constantFrom(...examples), (left, right) => {
      const a = normalizePartNumber(left)!, b = normalizePartNumber(right)!;
      const tier = matchTier(a, b);
      if (a.exact === b.exact) expect(tier).toBe('exact');
      if (tier === 'exact') expect(a.exact).toBe(b.exact);
      if (tier === 'base') expect(a.base).toBe(b.base);
      if (tier === 'family') expect(a.family).toBe(b.family);
      if (tier === 'base' || tier === 'family' || tier === 'exact') expect(matchTier(b, a)).toBe(tier);
    }), params(500));
  });

  it('counts at most a fixed number of steps per character and refuses long text', () => {
    fc.assert(fc.property(fc.oneof(anyText(400), asciiText(400)), input => {
      const { steps } = withMeter(meter => normalizePartNumber(input, { meter }));
      expect(steps).toBeLessThanOrEqual(200);
    }), params(200));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Token classes
// ---------------------------------------------------------------------------------------------------------------

describe('property: token classes', () => {
  it('classifies any token into exactly one class with bounded output', () => {
    fc.assert(fc.property(fc.oneof(anyText(100), asciiText(100), structured(6)), fc.constantFrom(...RECOGNITION_SCOPES), (input, scope) => {
      const result = classifyToken(input, { scope });
      expect(TOKEN_CLASSES).toContain(result.class);
      expect(result.text.length).toBeLessThanOrEqual(64);
      expect(result.confidence).toBeGreaterThanOrEqual(1);
      expect(result.confidence).toBeLessThanOrEqual(99);
      expect(typeof result.reason).toBe('string');
      if (result.partTier !== undefined) expect(result.class).toBe('part-number');
      if (result.shape !== undefined) expect(result.class).toBe('board-number');
      if (result.netKind !== undefined) expect(result.class).toBe('net');
      if (result.class === 'part-number') expect(['known', 'text']).toContain(result.partTier);
    }), params(600));
  });

  it('does not depend on the case of a token without lower-case letters', () => {
    fc.assert(fc.property(asciiText(40), input => {
      if (/[a-z]/.test(input)) return;
      expect(classifyToken(input.toUpperCase()).class).toBe(classifyToken(input).class);
    }), params(300));
  });

  it('reads bare digit strings as noise or a package size and never as anything else', () => {
    fc.assert(fc.property(fc.stringMatching(/^[0-9]{1,12}$/), digits => {
      expect(['noise', 'package']).toContain(classifyToken(digits).class);
    }), params(300));
  });

  it('cuts any text into ordered, non-overlapping tokens whose class counts add up', () => {
    fc.assert(fc.property(text(), input => {
      const { tokens, truncated } = tokenizeText(input);
      expect(truncated).toBe(false);
      let previousEnd = 0;
      for (const token of tokens) {
        expect(token.start).toBeGreaterThanOrEqual(previousEnd);
        expect(token.end).toBeGreaterThan(token.start);
        previousEnd = token.end;
        if (token.raw !== '') expect(token.raw).toBe(input.slice(token.start, token.end));
        expect(TOKEN_CLASSES).toContain(token.class);
      }
      const counts = countTokenClasses(tokens);
      expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(tokens.length);
    }), params(300));
  });

  it('counts at most a fixed number of steps per character', () => {
    fc.assert(fc.property(text(), input => {
      const { steps } = withMeter(meter => tokenizeText(input, { meter }));
      expect(steps).toBeLessThanOrEqual(200 * Math.max(1, Math.min(input.length, MAX_TEXT_LENGTH)));
    }), params(200));
    for (const unit of ['U7000 ', 'PP3V3_S0 ', '820-820 ', 'TPS51225RUKR ', '4K7_', 'SOT-23-5 ', 'LA-LA-', '2024-10-07 ', 'R1-R1-']) {
      const small = withMeter(meter => tokenizeText(unit.repeat(200), { meter })).steps;
      const large = withMeter(meter => tokenizeText(unit.repeat(1600), { meter })).steps;
      expect(large, unit).toBeLessThanOrEqual(small * 8 * 1.15 + 200);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hints and names
// ---------------------------------------------------------------------------------------------------------------

describe('property: hints and names', () => {
  const vendorIds = new Set(VENDORS.map(vendor => vendor.id));
  it('give bounded, well-formed hints for any text', () => {
    fc.assert(fc.property(text(), input => {
      const limit = Math.min(input.length, MAX_TEXT_LENGTH);
      for (const hint of vendorHints(input)) { expect(vendorIds.has(hint.id)).toBe(true); expect(hint.start).toBeLessThan(hint.end); expect(hint.end).toBeLessThanOrEqual(limit); expect(hint.confidence).toBeGreaterThan(0); expect(hint.confidence).toBeLessThanOrEqual(100); }
      for (const hint of deviceTypeHints(input)) { expect(DEVICE_TYPES).toContain(hint.id); expect(hint.start).toBeLessThan(hint.end); expect(hint.end).toBeLessThanOrEqual(limit); }
      for (const hint of documentTypeHints(input)) { expect(DOCUMENT_TYPES).toContain(hint.id); expect(hint.confidence).toBeGreaterThan(0); }
      expect(vendorHints(input).length).toBeLessThanOrEqual(MAX_MATCHES);
      expect(deviceTypeHints(input).length).toBeLessThanOrEqual(MAX_MATCHES);
    }), params(400));
  });

  it('count at most a fixed number of steps per character', () => {
    fc.assert(fc.property(text(), input => {
      const { steps } = withMeter(meter => { vendorHints(input, { meter }); deviceTypeHints(input, { meter }); documentTypeHints(input, { meter }); });
      expect(steps).toBeLessThanOrEqual(12 * Math.max(1, Math.min(input.length, MAX_TEXT_LENGTH)) + 12);
    }), params(200));
    for (const unit of ['Dell ', 'graphics card ', 'all-in-one ', 'a b c d ', 'MacBook', 'tv-']) {
      const small = withMeter(meter => deviceTypeHints(unit.repeat(150), { meter })).steps;
      const large = withMeter(meter => deviceTypeHints(unit.repeat(1200), { meter })).steps;
      expect(large, unit).toBeLessThanOrEqual(small * 8 * 1.15 + 200);
    }
  });

  it('analyse any path without failing and keep the results bounded', () => {
    fc.assert(fc.property(fc.oneof(anyText(200), structured(20)), input => {
      const analysis = analyzePath(input);
      expect(analysis.boardNumbers.length).toBeLessThanOrEqual(MAX_MATCHES * 12);
      for (const item of analysis.boardNumbers) expect(['name', 'folder', 'archive']).toContain(item.source);
    }), params(300));
  });

  it('folds each UTF-16 unit to one unit', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffff }), code => {
      const folded = foldCode(code);
      expect(Number.isInteger(folded)).toBe(true);
      expect(folded).toBeGreaterThanOrEqual(0);
      expect(folded).toBeLessThanOrEqual(0xffff);
    }), params(1000));
  });
});

describe('property: scopes', () => {
  it('keeps the shapes of the "names" group out of every other scope', () => {
    const namesOnly = BOARD_NUMBER_SHAPES.filter(shape => shape.scopes === 'names' && !shape.needsDeviceWord);
    fc.assert(fc.property(fc.constantFrom(...namesOnly), fc.constantFrom(...RECOGNITION_SCOPES.filter(scope => !['name', 'folder', 'archive'].includes(scope))), (shape, scope) => {
      expect(recognizeBoardNumbers(shape.example, { scope: scope as RecognitionScope }).filter(match => match.shape === shape.id)).toEqual([]);
    }), params(50));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Running time against the size of the text (relative: sizes are compared with each other, never with a clock)
// ---------------------------------------------------------------------------------------------------------------

describe('scaling: running time grows linearly with the text', () => {
  const repeat = (unit: string) => (size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const SIZES = [4_000, 16_000, 64_000];
  it.each([
    ['many Apple model numbers without a device word', 'A1111 '],
    ['half-written shapes', '820-820-LA-LA-DA0DA0-6050A-'],
    ['many valid numbers', '820-01234-A 051-9876 LA-Z123P '],
    ['long alphanumeric runs', 'x1x2x3x4x5x6x7x8x9x0'],
    ['dashes', '-'],
  ])('board numbers: %s', (_label, unit) => {
    expectScaling(`recognizeBoardNumbers ${unit}`, SIZES, size => { const input = repeat(unit)(size); return () => recognizeBoardNumbers(input); });
  });
  it.each([
    ['labels', 'REV A '], ['dotted groups', 'REV 1.2.3.4.5 '], ['stages', 'EVT-2 DVT PVT '], ['numbers with a revision', '820-01234-A '], ['board words', 'MLB-A MB_B '],
  ])('revisions: %s', (_label, unit) => {
    expectScaling(`parseRevisions ${unit}`, SIZES, size => { const input = repeat(unit)(size); return () => parseRevisions(input); });
  });
  it.each([['words', 'laptop Dell schematic '], ['phrases', 'graphics card all in one '], ['single letters', 'a b c d e f ']])('hints: %s', (_label, unit) => {
    expectScaling(`hints ${unit}`, SIZES, size => { const input = repeat(unit)(size); return () => { vendorHints(input); deviceTypeHints(input); documentTypeHints(input); }; });
  });
  it.each([['references, parts and rails', 'U7000 TPS51225RUKR PP3V3_S0 '], ['values and packages', '4K7 100nF SOT-23-5 0402 '], ['one very long token per line', 'x'.repeat(70) + ' ']])('token classes: %s', (_label, unit) => {
    expectScaling(`tokenizeText ${unit}`, SIZES, size => { const input = repeat(unit)(size); return () => tokenizeText(input); });
  });
  it('part numbers: the work does not grow with the length of the text', () => {
    expectBoundedWork('normalizePartNumber', [1_000, 4_000, 16_000, 64_000], size => { const input = 'TPS51225RUKR '.repeat(Math.ceil(size / 13)).slice(0, size); return () => normalizePartNumber(input); });
  });
  it('names: a long path', () => {
    expectScaling('analyzePath', SIZES, size => { const input = repeat('Apple/MacBook Pro 820-00875-A/')(size); return () => analyzePath(input); });
  });
});
