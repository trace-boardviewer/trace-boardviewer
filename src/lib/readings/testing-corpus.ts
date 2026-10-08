/**
 * Seeded generators of readings, packs and events for the property and parity tests (pack.test.ts, csv.test.ts,
 * readings-parity.test.ts). Deterministic: the same seed gives the same corpus, so a failure names the seed that reproduces it.
 * Not used by the application.
 */
import { DEFAULT_PACK_LICENSE, READING_KINDS, UNIT_OF, validateReading } from './schema';
import type { NumericKind, Reading } from './schema';

export type Random = () => number;

/** mulberry32: a small, fast, seeded PRNG in [0, 1). */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(random: Random, list: readonly T[]): T => list[Math.floor(random() * list.length)];
const chance = (random: Random, p: number): boolean => random() < p;

// Names a board file can hold, including the awkward ones: escapes of the key text form, non-ASCII, NFKC-sensitive forms, formula
// starters for CSV, quotes, separators and line breaks.
const REFS = ['U7', 'R1', 'C100', 'PU8100', 'J1', 'TP12', 'Q3', 'R/1', 'U@2', '50%', 'ＩＣ1', 'Ω1', 'µC1', '=1', '+5', '-R', '@X', 'A"B', 'A,B', "it's"];
const PINS = ['1', '2', '3', 'A1', 'B12', 'AB7', '0', '~1x', 'PAD', 'G', '1/2', 'Ⅳ'];
const NETS = ['PP3V3_S5', 'PP1V8_AON', '+5V', '-12V', 'GND', 'VCC', 'NET 1', 'N$12', '=CALC', 'A,B;C', 'line\nbreak', 'quote"d', 'PPBUS_G3H', '/MCU/SDA', 'ＶＣＣ'];
const TEXTS = ['', 'checked twice', 'after reflow', '=SUM(A1)', '+1', '-', '@home', '\tindent', "'quoted", 'multi\nline', 'comma, here', 'emoji ✓', 'Ω', 'a'.repeat(300)];
const STATES = ['S0', 'S5', 'G3H', 'standby', 'on', 'Off'];
const METERS = ['UT61E+', 'Fluke 87V', 'BM869s', 'OWON B35T+'];
const LICENSES = [DEFAULT_PACK_LICENSE, 'ODbL-1.0', 'CC-BY-4.0', 'LicenseRef-shop-internal'];
const TIMES = ['2026-10-07T10:11:12Z', '2026-10-07T10:11:12.345Z', '2026-01-02T03:04+02:00', '2025-12-31T23:59:59.999999999-05:30'];

function numberFor(random: Random, kind: NumericKind): number {
  const shapes = [0, 0.412, 1e-9, 5e-324, 0.1 + 0.2, 3.3, 12, 4700, 2.2e6, 1e12, random(), random() * 1000];
  let value = pick(random, shapes);
  if (kind === 'diode') value = Math.min(value, 10);
  if (kind === 'voltage' && chance(random, 0.2)) value = -value;
  return value;
}

/** A reading object as a caller might send it (not yet canonical). */
export function rawReading(random: Random, id: string): Record<string, unknown> {
  const kind = pick(random, READING_KINDS);
  const reading: Record<string, unknown> = { id, kind };
  const shape = random();
  if (shape < 0.45) reading.target = { ref: pick(random, REFS), pin: pick(random, PINS), ...(chance(random, 0.5) ? { net: pick(random, NETS) } : {}) };
  else if (shape < 0.6) reading.target = { ref: pick(random, REFS) };
  else reading.target = { net: pick(random, NETS) };
  if (kind === 'continuity') reading.connected = chance(random, 0.5);
  else if (chance(random, 0.15)) reading.ol = true;
  else { reading.value = numberFor(random, kind); reading.unit = UNIT_OF[kind]; }
  if (chance(random, 0.4)) reading.raw = pick(random, ['0.412', '412m', '4k7', 'OL', '3V3', '=1', 'beep']);
  const conditions: Record<string, unknown> = { power: kind === 'voltage' ? 'powered' : pick(random, ['unpowered', 'powered']) };
  if (chance(random, 0.4)) conditions.state = pick(random, STATES);
  if (chance(random, 0.25)) conditions.reference = chance(random, 0.5) ? { net: pick(random, NETS) } : { ref: pick(random, REFS), ...(chance(random, 0.5) ? { pin: pick(random, PINS) } : {}) };
  if (chance(random, 0.3)) conditions.polarity = pick(random, ['red-on-reference', 'black-on-reference']);
  if (kind === 'voltage' && chance(random, 0.3)) conditions.meterMode = pick(random, ['dc', 'ac']);
  if (chance(random, 0.3)) conditions.meter = pick(random, METERS);
  reading.conditions = conditions;
  if (kind !== 'continuity' && chance(random, 0.3)) {
    const tolerance: Record<string, unknown> = {};
    if (chance(random, 0.6)) tolerance.abs = pick(random, [0, 0.02, 0.05, 1, 1e12]);
    if (!('abs' in tolerance) || chance(random, 0.5)) tolerance.rel = pick(random, [0, 0.05, 0.1, 10]);
    reading.tolerance = tolerance;
  }
  const source = pick(random, ['measured', 'known-good', 'imported'] as const);
  reading.source = source;
  if (source === 'imported' || chance(random, 0.2)) reading.license = pick(random, LICENSES);
  if (source === 'imported' || chance(random, 0.15)) {
    const provenance: Record<string, unknown> = { origin: pick(random, ['trace-pack', 'csv', 'openboarddata', 'note']) };
    if (chance(random, 0.5)) provenance.title = pick(random, ['820-00165', 'Main board rev B', '=X']);
    if (chance(random, 0.4)) provenance.attribution = pick(random, ['Contains information from a public dataset.', 'Typed by the shop']);
    if (chance(random, 0.4)) provenance.sourceId = pick(random, ['r1', 'note-1', 'x:y']);
    if (chance(random, 0.5)) provenance.importedAt = pick(random, TIMES);
    reading.provenance = provenance;
  }
  if (chance(random, 0.5)) reading.takenAt = pick(random, TIMES);
  const note = pick(random, TEXTS);
  if (note !== '' && chance(random, 0.4)) reading.note = note;
  return reading;
}

/** `count` canonical readings with distinct ids. */
export function randomReadings(random: Random, count: number, prefix = 'r'): Reading[] {
  const list: Reading[] = [];
  for (let index = 0; index < count; index++) list.push(validateReading(rawReading(random, `${prefix}${index}`)));
  return list;
}

/** Invalid inputs, each with the field the validators must name (identical in TS and native). */
export function invalidReadings(): Array<{ raw: unknown; field: string }> {
  const base = (): Record<string, unknown> => ({ id: 'r1', kind: 'voltage', target: { ref: 'U7', pin: '3' }, value: 1.8, unit: 'V', conditions: { power: 'powered' }, source: 'measured' });
  const patch = (change: (reading: Record<string, unknown>) => void): Record<string, unknown> => { const reading = base(); change(reading); return reading; };
  return [
    { raw: null, field: 'reading' },
    { raw: [], field: 'reading' },
    { raw: patch(r => { r.id = ''; }), field: 'reading.id' },
    { raw: patch(r => { r.id = 'a'.repeat(65); }), field: 'reading.id' },
    { raw: patch(r => { r.id = 'r 1'; }), field: 'reading.id' },
    { raw: patch(r => { r.kind = 'current'; }), field: 'reading.kind' },
    { raw: patch(r => { r.target = {}; }), field: 'reading.target' },
    { raw: patch(r => { r.target = { pin: '3' }; }), field: 'reading.target.pin' },
    { raw: patch(r => { r.target = { ref: ' ' }; }), field: 'reading.target.ref' },
    { raw: patch(r => { r.target = { ref: 'x'.repeat(257) }; }), field: 'reading.target.ref' },
    { raw: patch(r => { r.target = { net: 'n'.repeat(513) }; }), field: 'reading.target.net' },
    { raw: patch(r => { r.target = { ref: 'U1', x: 1 }; r.value = Number.NaN; }), field: 'reading.value' },
    { raw: patch(r => { r.value = Infinity; }), field: 'reading.value' },
    { raw: patch(r => { r.value = 2e12; }), field: 'reading.value' },
    { raw: patch(r => { r.value = '1.8'; }), field: 'reading.value' },
    { raw: patch(r => { r.kind = 'diode'; r.value = -0.1; }), field: 'reading.value' },
    { raw: patch(r => { r.kind = 'resistance'; }), field: 'reading.unit' },
    { raw: patch(r => { r.unit = 'mV'; }), field: 'reading.unit' },
    { raw: patch(r => { r.ol = true; }), field: 'reading.ol' },
    { raw: patch(r => { delete r.value; delete r.unit; r.ol = false; }), field: 'reading.ol' },
    { raw: patch(r => { r.connected = true; }), field: 'reading.connected' },
    { raw: patch(r => { r.kind = 'continuity'; }), field: 'reading.value' },
    { raw: patch(r => { r.kind = 'continuity'; delete r.value; delete r.unit; r.connected = 'yes'; }), field: 'reading.connected' },
    { raw: patch(r => { r.raw = 'x'.repeat(65); }), field: 'reading.raw' },
    { raw: patch(r => { r.conditions = { power: 'on' }; }), field: 'reading.conditions.power' },
    { raw: patch(r => { r.conditions = 'powered'; }), field: 'reading.conditions' },
    { raw: patch(r => { r.conditions = { power: 'powered', state: 's'.repeat(33) }; }), field: 'reading.conditions.state' },
    { raw: patch(r => { r.conditions = { power: 'powered', reference: { net: 'GND', ref: 'U1' } }; }), field: 'reading.conditions.reference' },
    { raw: patch(r => { r.conditions = { power: 'powered', polarity: 'red' }; }), field: 'reading.conditions.polarity' },
    { raw: patch(r => { r.kind = 'diode'; r.conditions = { power: 'unpowered', meterMode: 'dc' }; }), field: 'reading.conditions.meterMode' },
    { raw: patch(r => { r.conditions = { power: 'powered', meter: '' }; }), field: 'reading.conditions.meter' },
    { raw: patch(r => { r.tolerance = {}; }), field: 'reading.tolerance' },
    { raw: patch(r => { r.tolerance = { abs: -1 }; }), field: 'reading.tolerance.abs' },
    { raw: patch(r => { r.tolerance = { rel: 11 }; }), field: 'reading.tolerance.rel' },
    { raw: patch(r => { r.source = 'guessed'; }), field: 'reading.source' },
    { raw: patch(r => { r.license = 'not a licence'; }), field: 'reading.license' },
    { raw: patch(r => { r.provenance = { origin: 'web' }; }), field: 'reading.provenance.origin' },
    { raw: patch(r => { r.provenance = { origin: 'csv', importedAt: 'yesterday' }; }), field: 'reading.provenance.importedAt' },
    { raw: patch(r => { r.source = 'imported'; }), field: 'reading.provenance (an imported reading names its licence and provenance)' },
    { raw: patch(r => { r.takenAt = '2026-13-01T00:00Z'; }), field: 'reading.takenAt' },
    { raw: patch(r => { r.takenAt = '2026-10-07'; }), field: 'reading.takenAt' },
    { raw: patch(r => { r.note = 'n'.repeat(2001); }), field: 'reading.note' },
  ];
}
