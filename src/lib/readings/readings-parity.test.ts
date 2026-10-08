import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FINGERPRINT_VERSION } from '../board-fingerprint';
import { CSV_COLUMNS, packToCsv, readingsToCsv } from './csv';
import { applyEvents, checkEvents } from './model';
import type { ReadingsState } from './model';
import { buildPack, serializePack } from './pack';
import * as schema from './schema';
import { invalidReadings, pick, randomReadings, rawReading, seeded } from './testing-corpus';
import type { Random } from './testing-corpus';

/**
 * TS / native parity: electron/readings.cjs is the twin of schema.ts, model.ts (reducer), pack.ts (writer) and csv.ts (writer). Both run
 * on one corpus (valid, invalid and mutated inputs; event sequences with conflicts) and must give identical results: the same canonical
 * value, or an error with the same code and message, and identical bytes from the writers.
 */
interface Native {
  READINGS_FORMAT: string; READINGS_VERSION: number; FINGERPRINT_VERSION: number; READING_KINDS: readonly string[]; UNIT_OF: Record<string, string>;
  POWER_STATES: readonly string[]; POLARITIES: readonly string[]; METER_MODES: readonly string[]; READING_SOURCES: readonly string[]; PROVENANCE_ORIGINS: readonly string[];
  EVENT_TYPES: readonly string[]; LIMITS: Record<string, number>; CSV_COLUMNS: readonly string[];
  validateReading(raw: unknown): unknown; validateReadings(raw: unknown): unknown; validatePack(raw: unknown): schema.ReadingsPack; validateEvent(raw: unknown): unknown;
  validateEvents(raw: unknown): schema.RepairEvent[]; validateFamilyHeader(raw: unknown): unknown; validatePinSet(raw: unknown, field: string): unknown;
  checkEvents(state: unknown, events: unknown, familyId?: string): void; applyEvents(state: unknown, events: unknown): ReadingsState;
  serializePack(pack: unknown): string; readingsToCsv(readings: unknown): string; packToCsv(pack: unknown): string;
  canonicalName(value: unknown, max: number): string | null;
}
const native = createRequire(import.meta.url)('../../../electron/readings.cjs') as Native;

type Outcome = { ok: true; value: unknown } | { ok: false; name: string; code: string; message: string };
function outcome(run: () => unknown): Outcome {
  try { return { ok: true, value: run() }; }
  catch (error) {
    const caught = error as { name: string; code: string; message: string };
    return { ok: false, name: caught.name, code: caught.code, message: caught.message };
  }
}
const same = (ts: () => unknown, cjs: () => unknown, label: string) => expect(outcome(cjs), label).toEqual(outcome(ts));

const JUNK: readonly unknown[] = [undefined, null, '', ' ', 0, -1, 1.5, NaN, Infinity, true, false, [], {}, 'x'.repeat(70), 'OL', -0, 1e13, [1], { a: 1 }];
/** A copy of `value` with one field somewhere replaced by junk (or removed). */
function mutate(random: Random, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return pick(random, JUNK);
  const copy: Record<string, unknown> = Array.isArray(value) ? ([...value] as unknown as Record<string, unknown>) : { ...(value as Record<string, unknown>) };
  const keys = Object.keys(copy);
  if (keys.length === 0 || random() < 0.15) { copy[pick(random, ['extra', 'ol', 'value', 'pin', 'licenses'])] = pick(random, JUNK); return copy; }
  const key = pick(random, keys);
  if (random() < 0.5 && copy[key] !== null && typeof copy[key] === 'object') copy[key] = mutate(random, copy[key]);
  else if (random() < 0.2) delete copy[key];
  else copy[key] = pick(random, JUNK);
  return copy;
}

describe('readings.cjs is the twin of src/lib/readings', () => {
  it('has the same constants, enumerations and bounds', () => {
    expect(native.READINGS_FORMAT).toBe(schema.READINGS_FORMAT);
    expect(native.READINGS_VERSION).toBe(schema.READINGS_VERSION);
    expect(native.FINGERPRINT_VERSION).toBe(FINGERPRINT_VERSION);
    expect([...native.READING_KINDS]).toEqual([...schema.READING_KINDS]);
    expect({ ...native.UNIT_OF }).toEqual({ ...schema.UNIT_OF });
    expect([...native.POWER_STATES]).toEqual([...schema.POWER_STATES]);
    expect([...native.POLARITIES]).toEqual([...schema.POLARITIES]);
    expect([...native.METER_MODES]).toEqual([...schema.METER_MODES]);
    expect([...native.READING_SOURCES]).toEqual([...schema.READING_SOURCES]);
    expect([...native.PROVENANCE_ORIGINS]).toEqual([...schema.PROVENANCE_ORIGINS]);
    expect([...native.EVENT_TYPES]).toEqual([...schema.EVENT_TYPES]);
    expect({ ...native.LIMITS }).toEqual({ ...schema.READINGS_LIMITS });
    expect([...native.CSV_COLUMNS]).toEqual([...CSV_COLUMNS]);
  });

  it('validates readings identically: generated, invalid and mutated inputs', () => {
    const random = seeded(20261007);
    for (const { raw } of invalidReadings()) same(() => schema.validateReading(raw), () => native.validateReading(raw), JSON.stringify(raw));
    for (let index = 0; index < 1500; index++) {
      const raw = rawReading(random, `r${index}`);
      const input = index % 3 === 0 ? raw : mutate(random, raw);
      same(() => schema.validateReading(input), () => native.validateReading(input), `case ${index}: ${JSON.stringify(input)}`);
    }
    for (const name of ['U7', ' ＵＳＢ ', 'ﬁ', '', '\u0000', 'x'.repeat(300)]) expect(native.canonicalName(name, 256)).toBe(schema.canonicalName(name, 256));
  });

  it('validates packs identically and writes identical bytes (pack and CSV)', () => {
    const random = seeded(7);
    for (let index = 0; index < 120; index++) {
      const readings = randomReadings(random, Math.floor(random() * 25), `p${index}-`);
      const license = pick(random, ['CC0-1.0', 'CC-BY-4.0']);
      const board = { ...(random() < 0.5 ? { fingerprint: 'ab'.repeat(32), fingerprintVersion: 1 } : {}), ...(random() < 0.5 ? { label: 'Board =1, "x"' } : {}), ...(random() < 0.3 ? { pinSet: [['R1', ['1', '2']]] } : {}) };
      const foreign = random() < 0.5 ? 'mark' as const : 'exclude' as const;
      const built = outcome(() => buildPack(readings, { board, license, foreign, ...(random() < 0.5 ? { title: 'Set', attribution: 'Typed by the shop', createdAt: '2026-10-07T10:00Z' } : {}) }).pack);
      if (!built.ok) throw new Error(`buildPack failed: ${built.message}`);
      const pack = built.value as schema.ReadingsPack;
      same(() => schema.validatePack(pack), () => native.validatePack(pack), `pack ${index}`);
      expect(native.serializePack(native.validatePack(pack)), `pack ${index} bytes`).toBe(serializePack(pack));
      expect(native.packToCsv(native.validatePack(pack)), `pack ${index} CSV`).toBe(packToCsv(pack));
      expect(native.readingsToCsv(pack.readings)).toBe(readingsToCsv(pack.readings));
      const broken = mutate(random, index % 2 ? pack : { ...pack, readings: pack.readings.map(reading => (random() < 0.2 ? mutate(random, reading) : reading)) });
      same(() => schema.validatePack(broken), () => native.validatePack(broken), `mutated pack ${index}`);
    }
  });

  it('checks and applies event sequences identically, conflicts and bounds included', () => {
    const random = seeded(99);
    const familyId = 'f'.repeat(64);
    const member = (digit: string, keys: string[] = []) => ({ fingerprint: digit.repeat(64), fingerprintVersion: 1, fileKeys: keys });
    for (let run = 0; run < 60; run++) {
      let tsState: ReadingsState | null = null;
      let cjsState: ReadingsState | null = null;
      const ids: string[] = [];
      for (let step = 0; step < 12; step++) {
        const events: unknown[] = [];
        const count = 1 + Math.floor(random() * 4);
        for (let index = 0; index < count; index++) {
          const roll = random();
          if ((tsState === null && index === 0 && random() < 0.8) || roll < 0.03) events.push({ type: 'family.create', family: { id: random() < 0.9 ? familyId : 'e'.repeat(64), createdAt: '2026-10-07T08:00Z', members: [member('a')] } });
          else if (roll < 0.1) events.push({ type: 'family.link', member: member(pick(random, ['a', 'b', 'c']), random() < 0.5 ? ['1'.repeat(64)] : []), ...(random() < 0.5 ? { similarity: 0.96 } : {}) });
          else if (roll < 0.14) events.push({ type: 'family.rename', name: pick(random, ['Logic board', 'Main']) });
          else if (roll < 0.6) { const id = random() < 0.2 && ids.length ? pick(random, ids) : `r${run}-${step}-${index}`; ids.push(id); events.push({ type: 'reading.add', reading: rawReading(random, id) }); }
          else if (roll < 0.8) events.push({ type: 'reading.replace', reading: rawReading(random, ids.length ? pick(random, ids) : 'none') });
          else events.push({ type: 'reading.remove', id: ids.length && random() < 0.8 ? pick(random, ids) : 'missing' });
        }
        const input = random() < 0.1 ? events.map(event => mutate(random, event)) : events;
        const tsEvents = outcome(() => schema.validateEvents(input));
        same(() => schema.validateEvents(input), () => native.validateEvents(input), `run ${run} step ${step} validate`);
        if (!tsEvents.ok) continue;
        const valid = tsEvents.value as schema.RepairEvent[];
        const checked = outcome(() => checkEvents(tsState, valid, familyId));
        same(() => checkEvents(tsState, valid, familyId), () => native.checkEvents(cjsState, valid, familyId), `run ${run} step ${step} check`);
        if (!checked.ok) continue;
        tsState = applyEvents(tsState, valid);
        cjsState = native.applyEvents(cjsState, JSON.parse(JSON.stringify(valid)));
        expect({ family: cjsState.family, readings: [...cjsState.readings.entries()] }, `run ${run} step ${step} state`).toEqual({ family: tsState.family, readings: [...tsState.readings.entries()] });
      }
    }
  });

  it('validates pin sets, family headers and members identically', () => {
    const random = seeded(31);
    const sets: unknown[] = [
      [], [['C1', ['1', '2']], ['U1', ['A1']]], [['u1', ['1']]], [[' U1', ['1']]], [['U1', ['a1']]], [['U1', ['2', '1']]], [['U2', ['1']], ['U1', ['1']]],
      [['U1', ['~1']]], [['U1', []]], [['U1', ['1', '1']]], [['U1']], [['U1', '1']], [['', ['1']]], [['U1', ['']]], [['X'.repeat(257), ['1']]], 'U1', null,
    ];
    for (const set of sets) {
      same(() => schema.validatePinSet(set, 'pinSet'), () => native.validatePinSet(set, 'pinSet'), JSON.stringify(set));
      const header = { id: 'f'.repeat(64), name: 'Board', createdAt: '2026-10-07T08:00Z', members: [{ fingerprint: 'a'.repeat(64), fingerprintVersion: 1, fileKeys: ['b'.repeat(64)], label: 'rev A' }], pinSet: set };
      same(() => schema.validateFamilyHeader(header), () => native.validateFamilyHeader(header), `header with ${JSON.stringify(set)}`);
      for (let index = 0; index < 20; index++) {
        const broken = mutate(random, header);
        same(() => schema.validateFamilyHeader(broken), () => native.validateFamilyHeader(broken), `mutated header ${JSON.stringify(broken)}`);
      }
    }
  });

  it('enforces the per-family reading limit identically', () => {
    const familyId = 'f'.repeat(64);
    const state: ReadingsState = { family: { id: familyId, createdAt: '2026-10-07T08:00Z', members: [{ fingerprint: familyId, fingerprintVersion: 1, fileKeys: [] }] }, readings: new Map() };
    for (let index = 0; index < schema.READINGS_LIMITS.readings; index++) state.readings.set(`r${index}`, null as unknown as schema.Reading);
    const add = [{ type: 'reading.add', reading: schema.validateReading({ id: 'new', kind: 'continuity', target: { ref: 'F1' }, connected: true, conditions: { power: 'unpowered' }, source: 'measured' }) }] as schema.RepairEvent[];
    same(() => checkEvents(state, add), () => native.checkEvents(state, add), 'limit');
    expect(outcome(() => checkEvents(state, add))).toMatchObject({ ok: false, code: 'READINGS_TOO_MANY' });
    const swap = [{ type: 'reading.remove', id: 'r0' }, ...add] as schema.RepairEvent[];
    same(() => checkEvents(state, swap), () => native.checkEvents(state, swap), 'remove then add');
    expect(outcome(() => checkEvents(state, swap)).ok).toBe(true);
  });
});
