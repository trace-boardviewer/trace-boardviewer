import { describe, expect, it } from 'vitest';
import { partKeyText, pinKeyText } from '../note-keys';
import {
  DEFAULT_PACK_LICENSE, READINGS_LIMITS, ReadingsError, canonicalName, readingKeyText, validateEvent, validateEvents, validateFamilyHeader, validatePack,
  validatePinSet, validateReading, validateReadings,
} from './schema';
import { invalidReadings } from './testing-corpus';

const voltage = (extra: Record<string, unknown> = {}) => ({ id: 'r1', kind: 'voltage', target: { ref: 'U7', pin: '3' }, value: 1.8, unit: 'V', conditions: { power: 'powered' }, source: 'measured', ...extra });
const hex = (digit: string) => digit.repeat(64);
const fails = (run: () => unknown, message: string, code = 'READINGS_INVALID') => {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ReadingsError);
  expect((error as ReadingsError).code).toBe(code);
  expect((error as ReadingsError).message).toBe(message);
};

describe('validateReading', () => {
  it('returns a new object in canonical form: fixed key order, unknown fields dropped, names NFKC-normalized and trimmed (case kept)', () => {
    const raw = {
      note: 'after reflow', takenAt: '2026-10-07T10:11:12Z', source: 'known-good', conditions: { meter: 'UT61E+', power: 'powered', state: 'S0', extra: 1 },
      unit: 'V', value: 3.3, target: { net: 'ＰＰ3Ｖ3 ', pin: undefined }, kind: 'voltage', id: 'r1', geometry: { x: 1, y: 2 }, path: 'C:/boards/x.brd',
    };
    const reading = validateReading(raw);
    expect(reading).toEqual({ id: 'r1', kind: 'voltage', target: { net: 'PP3V3' }, value: 3.3, unit: 'V', conditions: { power: 'powered', state: 'S0', meter: 'UT61E+' }, source: 'known-good', takenAt: '2026-10-07T10:11:12Z', note: 'after reflow' });
    expect(Object.keys(reading)).toEqual(['id', 'kind', 'target', 'value', 'unit', 'conditions', 'source', 'takenAt', 'note']);
    expect(reading).not.toBe(raw);
    expect(JSON.stringify(reading)).not.toMatch(/geometry|path|"x"/);
  });

  it('holds a value in the SI unit of its kind, OL, or connected for continuity; never -0', () => {
    expect(validateReading(voltage({ value: -0 })).value).toBe(0);
    expect(Object.is(validateReading(voltage({ value: -0 })).value, -0)).toBe(false);
    expect(validateReading(voltage({ value: -12 })).value).toBe(-12);
    expect(validateReading({ ...voltage(), kind: 'resistance', unit: 'ohm', value: 4700, conditions: { power: 'unpowered' } }).unit).toBe('ohm');
    const open = validateReading({ id: 'r2', kind: 'diode', target: { net: 'PP3V3' }, ol: true, conditions: { power: 'unpowered' }, source: 'measured' });
    expect(open).toEqual({ id: 'r2', kind: 'diode', target: { net: 'PP3V3' }, ol: true, conditions: { power: 'unpowered' }, source: 'measured' });
    expect(validateReading({ id: 'c1', kind: 'continuity', target: { ref: 'F1' }, connected: false, conditions: { power: 'unpowered' }, source: 'measured' }).connected).toBe(false);
  });

  it('a pin reading may record the net it was on (a check, not the key); the reference point is a net or a part / pin, never both', () => {
    expect(validateReading(voltage({ target: { ref: 'U7', pin: '3', net: 'PP1V8' } })).target).toEqual({ ref: 'U7', pin: '3', net: 'PP1V8' });
    expect(validateReading(voltage({ conditions: { power: 'powered', reference: { ref: 'U7', pin: '1' } } })).conditions.reference).toEqual({ ref: 'U7', pin: '1' });
    fails(() => validateReading(voltage({ conditions: { power: 'powered', reference: { ref: 'U7', net: 'GND' } } })), 'Invalid readings: reading.conditions.reference.');
  });

  it('an imported reading names its licence and provenance; any reading may', () => {
    fails(() => validateReading(voltage({ source: 'imported', license: 'ODbL-1.0' })), 'Invalid readings: reading.provenance (an imported reading names its licence and provenance).');
    const imported = validateReading(voltage({ source: 'imported', license: 'ODbL-1.0', provenance: { origin: 'openboarddata', title: '820-00165', importedAt: '2026-10-07T10:00Z' } }));
    expect(imported.provenance).toEqual({ origin: 'openboarddata', title: '820-00165', importedAt: '2026-10-07T10:00Z' });
    expect(validateReading(voltage({ license: 'CC-BY-4.0' })).license).toBe('CC-BY-4.0');
    expect(validateReading(voltage({ license: 'LicenseRef-shop' })).license).toBe('LicenseRef-shop');
  });

  it('names the first field that is wrong', () => {
    for (const { raw, field } of invalidReadings()) fails(() => validateReading(raw), `Invalid readings: ${field}.`);
  });

  it('bounds every text', () => {
    const L = READINGS_LIMITS;
    expect(validateReading(voltage({ note: 'n'.repeat(L.note), raw: 'r'.repeat(L.raw) })).note).toHaveLength(L.note);
    expect(validateReading(voltage({ target: { ref: 'U'.repeat(L.name), pin: 'P'.repeat(L.name), net: 'N'.repeat(L.net) } })).target.net).toHaveLength(L.net);
    expect(validateReading(voltage({ value: L.value })).value).toBe(L.value);
    expect(validateReading(voltage({ tolerance: { abs: L.value, rel: L.rel } })).tolerance).toEqual({ abs: L.value, rel: L.rel });
  });
});

describe('validateReadings', () => {
  it('requires distinct ids and at most 100,000 readings', () => {
    fails(() => validateReadings([voltage(), voltage()]), 'Invalid readings: readings[1].id (duplicate).');
    fails(() => validateReadings(new Array(READINGS_LIMITS.readings + 1).fill(null)), 'Invalid readings: at most 100000 readings fit in one list.', 'READINGS_TOO_MANY');
    expect(validateReadings([])).toEqual([]);
  });
});

describe('names and keys', () => {
  it('canonicalName is NFKC + trim with the printable-ASCII fast path giving the same result', () => {
    for (const name of ['U7', ' U7 ', 'ＵＳＢ', 'Ω', 'ﬁ1', 'A B', '\tX', 'x'.repeat(256)]) {
      const expected = name.normalize('NFKC').trim();
      expect(canonicalName(name, 256)).toBe(expected === '' ? null : expected);
    }
    expect(canonicalName('   ', 256)).toBeNull();
    expect(canonicalName('x'.repeat(257), 256)).toBeNull();
    expect(canonicalName(5, 256)).toBeNull();
  });

  it('readingKeyText of a part or pin equals partKeyText / pinKeyText of note-keys.ts; a net key never equals a part key', () => {
    for (const [ref, pin] of [['U7', '3'], ['R/1', '2'], ['U@2', 'A1'], ['50%', '1'], ['A\u0001', 'x']]) {
      const target = validateReading(voltage({ target: { ref, pin } })).target;
      expect(readingKeyText(target)).toBe(pinKeyText(ref, pin));
      expect(readingKeyText({ ref: target.ref })).toBe(partKeyText(ref));
    }
    expect(readingKeyText({ net: 'PP3V3' })).toBe('@net:PP3V3');
    expect(readingKeyText({ ref: 'net:PP3V3' })).not.toBe(readingKeyText({ net: 'PP3V3' }));
    expect(readingKeyText({ ref: '@net:PP3V3' })).not.toBe(readingKeyText({ net: 'PP3V3' }));
    expect(readingKeyText({ ref: 'U7', pin: '3', net: 'X' })).toBe(readingKeyText({ ref: 'U7', pin: '3' }));
  });
});

describe('validatePack', () => {
  const pack = (extra: Record<string, unknown> = {}) => ({ format: 'trace-readings', version: 1, license: DEFAULT_PACK_LICENSE, board: {}, readings: [], ...extra });
  it('is CC0 by default in buildPack and requires format, version, licence and board', () => {
    expect(validatePack(pack())).toEqual(pack());
    fails(() => validatePack(pack({ format: 'other' })), 'Invalid readings: format.');
    fails(() => validatePack(pack({ version: 2 })), 'Invalid readings: version.');
    fails(() => validatePack(pack({ license: '' })), 'Invalid readings: license.');
    fails(() => validatePack(pack({ board: null })), 'Invalid readings: board.');
  });
  it('board identity: fingerprint with its version, file keys and pin set; no geometry or path fields survive', () => {
    const board = { fingerprint: hex('a'), fingerprintVersion: 1, label: 'Logic board', boardNumber: '820-00165', fileKeys: [hex('b')], pinSet: [['R1', ['1', '2']], ['U1', ['1']]], outline: [[0, 0]], path: '/home/x' };
    expect(validatePack(pack({ board })).board).toEqual({ fingerprint: hex('a'), fingerprintVersion: 1, label: 'Logic board', boardNumber: '820-00165', fileKeys: [hex('b')], pinSet: [['R1', ['1', '2']], ['U1', ['1']]] });
    fails(() => validatePack(pack({ board: { fingerprint: hex('a') } })), 'Invalid readings: board.fingerprintVersion.');
    fails(() => validatePack(pack({ board: { fingerprintVersion: 1 } })), 'Invalid readings: board.fingerprintVersion.');
    fails(() => validatePack(pack({ board: { fingerprint: 'A'.repeat(64), fingerprintVersion: 1 } })), 'Invalid readings: board.fingerprint.');
    fails(() => validatePack(pack({ board: { fileKeys: [hex('b'), hex('b')] } })), 'Invalid readings: board.fileKeys[1].');
  });
  it('licences: a reading under another licence needs the pack to list it; the list names exactly the licences that occur', () => {
    const odbl = voltage({ id: 'o1', source: 'imported', license: 'ODbL-1.0', provenance: { origin: 'openboarddata' } });
    fails(() => validatePack(pack({ readings: [odbl] })), 'Invalid readings: readings[0].license (not listed in licenses).');
    expect(validatePack(pack({ licenses: ['CC0-1.0', 'ODbL-1.0'], readings: [odbl] })).licenses).toEqual(['CC0-1.0', 'ODbL-1.0']);
    fails(() => validatePack(pack({ licenses: ['ODbL-1.0', 'CC0-1.0'], readings: [odbl] })), 'Invalid readings: licenses.');
    fails(() => validatePack(pack({ licenses: ['CC0-1.0', 'ODbL-1.0'], readings: [] })), 'Invalid readings: licenses (lists a licence no reading carries).');
    fails(() => validatePack(pack({ licenses: ['CC0-1.0', 'ODbL-1.0', 'CC-BY-4.0'], readings: [odbl] })), 'Invalid readings: licenses[2].');
    expect(validatePack(pack({ readings: [voltage({ license: 'CC0-1.0' })] })).readings[0].license).toBe('CC0-1.0');
  });
});

describe('pin sets, family headers and events', () => {
  it('a pin set is exactly what boardPinSet writes: upper-case, sorted, distinct, no adapter-made numbers', () => {
    expect(validatePinSet([['C1', ['1', '2']], ['U1', ['A1']]], 'pinSet')).toEqual([['C1', ['1', '2']], ['U1', ['A1']]]);
    for (const bad of [[['u1', ['1']]], [['U1', ['2', '1']]], [['U2', ['1']], ['U1', ['1']]], [['U1', ['~1']]], [['U1', []]], [['U1', ['1', '1']]], [['U1']]]) {
      expect(() => validatePinSet(bad, 'pinSet')).toThrow(ReadingsError);
    }
  });
  it('a family header has a 64-hex id, a time, 1 to 256 members with distinct fingerprints', () => {
    const member = { fingerprint: hex('a'), fingerprintVersion: 1, fileKeys: [] };
    expect(validateFamilyHeader({ id: hex('f'), createdAt: '2026-10-07T08:00Z', members: [member], extra: true })).toEqual({ id: hex('f'), createdAt: '2026-10-07T08:00Z', members: [member] });
    fails(() => validateFamilyHeader({ id: hex('f'), createdAt: '2026-10-07T08:00Z', members: [] }), 'Invalid readings: family.members.');
    fails(() => validateFamilyHeader({ id: hex('f'), createdAt: '2026-10-07T08:00Z', members: [member, member] }), 'Invalid readings: family.members[1].fingerprint (duplicate).');
    fails(() => validateFamilyHeader({ id: hex('f'), createdAt: '2026-10-07T08:00Z', members: [{ ...member, fingerprintVersion: 2 }] }), 'Invalid readings: family.members[0].fingerprintVersion.');
  });
  it('events: six types, each validated; an append holds 1 to 100,000 events', () => {
    expect(validateEvent({ type: 'reading.remove', id: 'r1', extra: 1 })).toEqual({ type: 'reading.remove', id: 'r1' });
    expect(validateEvent({ type: 'family.rename', name: 'Logic board' })).toEqual({ type: 'family.rename', name: 'Logic board' });
    expect(validateEvent({ type: 'family.link', member: { fingerprint: hex('a'), fingerprintVersion: 1, fileKeys: [hex('b')] }, similarity: 0.97 })).toEqual({ type: 'family.link', member: { fingerprint: hex('a'), fingerprintVersion: 1, fileKeys: [hex('b')] }, similarity: 0.97 });
    fails(() => validateEvent({ type: 'reading.delete', id: 'r1' }), 'Invalid readings: event.type.');
    fails(() => validateEvent({ type: 'family.link', member: { fingerprint: hex('a'), fingerprintVersion: 1, fileKeys: [] }, similarity: 1.5 }), 'Invalid readings: event.similarity.');
    fails(() => validateEvents([]), 'Invalid readings: events.');
    fails(() => validateEvents([{ type: 'reading.add', reading: voltage({ unit: 'ohm' }) }]), 'Invalid readings: events[0].reading.unit.');
  });
});
