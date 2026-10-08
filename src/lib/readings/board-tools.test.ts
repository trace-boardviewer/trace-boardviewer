import { describe, expect, it } from 'vitest';
import { describeBoard } from '../board-fingerprint';
import { buildBoard, textInput } from '../formats/common';
import type { RawPin } from '../formats/common';
import type { Board, BoardNote } from '../types';
import { captureBack, captureComment, captureGoTo, captureProgress, captureReadings, captureRecord, captureSkip, captureSteps, createCaptureSession, naturalCompare } from './capture';
import { readingsCoverage } from './coverage';
import { createFamilyEvent, linkEvent, matchFamily, needsLink, similarCandidates } from './family';
import type { FamilySummary } from './family';
import { noteReadingId, planNoteMigration } from './migrate';
import { applyEvents, checkEvents } from './model';
import { validateReading } from './schema';
import type { Reading } from './schema';

type PartSpec = { ref: string; pins: Array<[number: string, net: string]>; generatedRef?: boolean };
/** A synthetic board: parts with numbered pins on named nets (coordinates are irrelevant to readings). */
function board(parts: PartSpec[], extraPins: RawPin[] = []): Board {
  return buildBoard(textInput('', 'synthetic.board'), {
    format: 'synthetic', unitsToMm: 1,
    parts: parts.map((part, index) => ({ key: `${part.ref}#${index}`, ref: part.ref, ...(part.generatedRef ? { refGenerated: true } : {}), side: 'top' as const, position: { x: index * 10, y: 0 } })),
    pins: [...parts.flatMap((part, index) => part.pins.map(([number, net], pin) => ({ part: `${part.ref}#${index}`, number, net, x: index * 10 + pin, y: 0 }))), ...extraPins],
    outline: [{ x: -5, y: -5 }, { x: 500, y: -5 }, { x: 500, y: 50 }, { x: -5, y: 50 }],
  });
}

const LOGIC: PartSpec[] = [
  { ref: 'U1', pins: [['1', 'PP3V3_S5'], ['2', 'GND'], ['3', 'PP1V8_S0'], ['4', 'I2C_SDA'], ['5', 'I2C_SCL'], ['6', '']] },
  { ref: 'U2', pins: [['1', 'PP3V3_S5'], ['2', 'GND'], ['3', 'PP5V']] },
  { ref: 'R1', pins: [['1', 'I2C_SDA'], ['2', 'PP3V3_S5']] },
  { ref: 'C1', pins: [['1', 'PP1V8_S0'], ['2', 'GND']] },
  { ref: 'TP10', pins: [['1', 'USB_DP']] },
  { ref: 'TP2', pins: [['1', 'I2C_SCL']] },
  { ref: 'TP3', pins: [['1', 'GND']] },
  { ref: 'J1', pins: [['1', 'PP5V_USB'], ['2', 'USB_DP'], ['3', 'USB_DN'], ['4', 'GND']] },
];

let counter = 0;
const reading = (target: Record<string, string>, extra: Record<string, unknown> = {}): Reading => validateReading({
  id: `q${++counter}`, kind: 'diode', target, value: 0.4, unit: 'V', conditions: { power: 'unpowered' }, source: 'known-good', ...extra,
});

describe('readingsCoverage', () => {
  const logic = board(LOGIC);
  it('counts rails and signals with a reading; ground and no-connect nets are never counted', () => {
    const empty = readingsCoverage(logic, []);
    expect(empty.rails).toEqual({ total: 4, covered: 0, percent: 0 });
    expect(empty.signals).toEqual({ total: 4, covered: 0, percent: 0 });
    expect(empty.uncovered).toEqual(['PP3V3_S5', 'PP1V8_S0', 'PP5V', 'PP5V_USB', 'I2C_SCL', 'I2C_SDA', 'USB_DP', 'USB_DN']);
    expect(empty.railList.map(rail => [rail.net, rail.pinCount, rail.expectedVolts])).toEqual([['PP3V3_S5', 3, 3.3], ['PP1V8_S0', 2, 1.8], ['PP5V', 1, 5], ['PP5V_USB', 1, 5]]);
  });
  it('a net reading covers its net; a pin reading covers the net its pin is on (looked up by reference and pin number)', () => {
    const report = readingsCoverage(logic, [reading({ net: 'PP3V3_S5' }), reading({ ref: 'R1', pin: '1' }), reading({ ref: 'U9', pin: '1' }), reading({ ref: 'C1' })]);
    expect(report.rails.covered).toBe(1);
    expect(report.signals.covered).toBe(1);
    expect(report.nets).toEqual({ total: 8, covered: 2, percent: 25 });
    expect(report.railList.find(rail => rail.net === 'PP3V3_S5')?.covered).toBe(true);
    expect(report.uncovered).not.toContain('I2C_SDA');
    // Pins: every numbered pin on a counted net; covered when its net is.
    expect(report.pins.total).toBe(14);
    expect(report.pins.covered).toBe(5);
  });
  it('filters by kind, power, state (ignoring case) and source', () => {
    const readings = [reading({ net: 'PP3V3_S5' }, { kind: 'voltage', value: 3.3, conditions: { power: 'powered', state: 'S0' }, source: 'measured' })];
    expect(readingsCoverage(logic, readings, { kind: 'diode' }).rails.covered).toBe(0);
    expect(readingsCoverage(logic, readings, { kind: 'voltage', power: 'powered', state: ' s0 ' }).rails.covered).toBe(1);
    expect(readingsCoverage(logic, readings, { state: 'S5' }).rails.covered).toBe(0);
    expect(readingsCoverage(logic, readings, { sources: ['known-good'] }).rails.covered).toBe(0);
  });
});

describe('golden-board capture', () => {
  const logic = board(LOGIC);
  it('orders the walk: main rails, sub-rails, one pin per test point, then connector pins; ground and no-connect never; each net once', () => {
    const steps = captureSteps(logic);
    expect(steps.map(step => [step.group, step.target])).toEqual([
      ['main-rail', { net: 'PP3V3_S5' }], ['main-rail', { net: 'PP1V8_S0' }], ['main-rail', { net: 'PP5V' }],
      ['sub-rail', { net: 'PP5V_USB' }],
      ['test-point', { ref: 'TP2', pin: '1', net: 'I2C_SCL' }], ['test-point', { ref: 'TP10', pin: '1', net: 'USB_DP' }],
      ['connector-pin', { ref: 'J1', pin: '3', net: 'USB_DN' }],
    ]);
    expect(captureSteps(logic, { scope: ['PP5V_USB', 'USB_DN'] }).map(step => step.net)).toEqual(['PP5V_USB', 'USB_DN']);
  });
  it('record, skip, back, go to and comment; the result is known-good readings with the typed text kept', () => {
    let session = createCaptureSession(logic, { kind: 'diode', conditions: { power: 'unpowered', meter: 'UT61E+' } });
    const bad = captureRecord(session, '3V3x', '2026-10-07T10:00Z');
    expect(bad.error).toBe('unrecognized');
    expect(bad.session).toBe(session);
    session = captureRecord(session, '412m', '2026-10-07T10:00Z').session;
    session = captureSkip(session);
    session = captureComment(session, 'pad lifted');
    session = captureRecord(session, 'OL', '2026-10-07T10:01Z').session;
    session = captureBack(session);
    session = captureRecord(session, '0.65', '2026-10-07T10:02Z').session;
    expect(captureProgress(session)).toEqual({ total: 7, recorded: 2, skipped: 1, remaining: 4 });
    session = captureGoTo(session, 7);
    expect(captureRecord(session, '0.4', '2026-10-07T10:03Z').error).toBe('done');
    expect(captureGoTo(session, 99)).toBe(session);
    let id = 0;
    const readings = captureReadings(session, () => `cap${++id}`);
    expect(readings).toEqual([
      { id: 'cap1', kind: 'diode', target: { net: 'PP3V3_S5' }, value: 0.412, unit: 'V', raw: '412m', conditions: { power: 'unpowered', meter: 'UT61E+' }, source: 'known-good', takenAt: '2026-10-07T10:00Z' },
      { id: 'cap2', kind: 'diode', target: { net: 'PP5V' }, value: 0.65, unit: 'V', raw: '0.65', conditions: { power: 'unpowered', meter: 'UT61E+' }, source: 'known-good', takenAt: '2026-10-07T10:02Z' },
    ]);
    expect(session.entries[1]).toEqual({ status: 'skipped', note: 'pad lifted' });
  });
  it('natural order of references and pin numbers', () => {
    expect(['R10', 'R2', 'R1', 'C1', 'R02'].sort(naturalCompare)).toEqual(['C1', 'R1', 'R2', 'R02', 'R10']);
  });
});

describe('board families: fingerprint matching', () => {
  // The same board from two formats: the second gives the fiducial an adapter-made number (~1) and drops the pinless part.
  const kicad = board([...LOGIC, { ref: 'MH1', pins: [] }], [{ part: 'U1#0', number: '~1', net: '', x: 0, y: 1 }]);
  const exported = board(LOGIC.map(part => ({ ...part, pins: part.pins.map(([number, net]): [string, string] => [number, `/${net}`]) })));
  const revision = board([...LOGIC.slice(0, 7), { ref: 'J1', pins: [['1', 'PP5V_USB'], ['2', 'USB_DP'], ['3', 'USB_DN']] }]);
  const other = board([{ ref: 'U1', pins: [['1', 'A']] }]);

  it('the same board read from two formats has the same fingerprint, so its readings apply to both', async () => {
    const a = await describeBoard(kicad, 'a'.repeat(64));
    const b = await describeBoard(exported, 'b'.repeat(64));
    expect(b.fingerprint).toBe(a.fingerprint);
    const families: FamilySummary[] = [{ id: a.fingerprint, createdAt: '2026-10-07T08:00Z', members: [{ fingerprint: a.fingerprint, fingerprintVersion: 1, fileKeys: ['a'.repeat(64)] }], pairCount: 20 }];
    expect(matchFamily(families, a)).toEqual({ kind: 'same-file', familyId: a.fingerprint });
    expect(matchFamily(families, b)).toEqual({ kind: 'same-fingerprint', familyId: a.fingerprint });
    expect(needsLink(families[0], b)).toBe(true);
    expect(linkEvent(b)).toEqual({ type: 'family.link', member: { fingerprint: a.fingerprint, fingerprintVersion: 1, fileKeys: ['b'.repeat(64)] } });
  });

  it('a similar board (Jaccard >= 0.95) is only offered, with the pins that exist on one side only; nothing links silently', async () => {
    const a = await describeBoard(kicad, 'a'.repeat(64));
    const rev = await describeBoard(revision, 'c'.repeat(64));
    const created = createFamilyEvent(a, { now: '2026-10-07T08:00Z', name: 'Logic board' });
    expect(created).toMatchObject({ type: 'family.create', family: { id: a.fingerprint, name: 'Logic board', pinSet: a.pinSet } });
    const families: FamilySummary[] = [{ id: a.fingerprint, createdAt: '2026-10-07T08:00Z', members: [{ fingerprint: a.fingerprint, fingerprintVersion: 1, fileKeys: [] }], pairCount: 20 }];
    expect(similarCandidates(families, 19)).toEqual([a.fingerprint]);
    expect(similarCandidates(families, 10)).toEqual([]);
    expect(matchFamily(families, rev)).toEqual({ kind: 'none' });
    const offered = matchFamily(families, rev, new Map([[a.fingerprint, a.pinSet]]), 0.95);
    expect(offered).toEqual({ kind: 'similar', candidates: [{ familyId: a.fingerprint, similarity: 19 / 20, unmatchedRecorded: [{ ref: 'J1', pin: '4' }], unmatchedOpen: [] }] });
    // Applied only on confirmation: the link event, checked against the family.
    const state = applyEvents(null, [created]);
    const link = linkEvent(rev, { similarity: 19 / 20, label: 'rev B' });
    expect(() => checkEvents(state, [link])).not.toThrow();
    expect(applyEvents(state, [link]).family.members.map(member => member.label)).toEqual([undefined, 'rev B']);
  });

  it('a different board or one without numbered pins matches nothing', async () => {
    const a = await describeBoard(kicad);
    const families: FamilySummary[] = [{ id: a.fingerprint, createdAt: '2026-10-07T08:00Z', members: [{ fingerprint: a.fingerprint, fingerprintVersion: 1, fileKeys: [] }], pairCount: 20 }];
    const unrelated = await describeBoard(other);
    expect(matchFamily(families, unrelated, new Map([[a.fingerprint, a.pinSet]]))).toEqual({ kind: 'none' });
    const blank = await describeBoard(board([{ ref: 'MH1', pins: [] }]));
    expect(matchFamily(families, blank)).toEqual({ kind: 'none' });
  });
});

describe('planNoteMigration', () => {
  const note = (id: string, target: Record<string, unknown> | null, measurements: Record<string, string>): BoardNote => (
    target ? { id, target, text: 'kept', measurements, updatedAt: '2026-05-01T12:00:00.000Z' } as BoardNote : { id, componentId: 'part:1', pinId: 'pin:2', text: 'old', measurements, updatedAt: '2026-05-01T12:00:00.000Z' } as BoardNote);
  it('turns the typed values of keyed pin notes into readings, keeping the text verbatim, and lists what it leaves', () => {
    const notes: BoardNote[] = [
      note('n1', { ref: 'U7', pin: '3' }, { voltage: '1.8 V', resistance: '4k7', other: 'diode 0.45' }),
      note('n2', { ref: 'U7', pin: '4' }, { other: 'beep' }),
      note('n3', { ref: 'U7', pin: '5' }, { other: 'looks burnt' }),
      note('n4', { ref: 'U7' }, { voltage: '3.3' }),
      note('n5', { ref: 'U7', pin: '6', pinAt: { side: 'top', x: 1, y: 2 } }, { voltage: '3.3' }),
      note('n6', null, { voltage: '3.3' }),
      note('n7', { ref: 'U7', pin: '7' }, { voltage: 'about three volts', resistance: 'x'.repeat(70) }),
      note('n8', { ref: 'U7', pin: '8' }, { voltage: '412' }),
      { id: 'n9', target: { ref: 'U7', pin: '9' }, text: 'no values', updatedAt: '2026-05-01T12:00:00.000Z' },
    ];
    const plan = planNoteMigration(notes);
    expect(plan.readings.map(item => [item.id, item.kind, item.value ?? item.connected, item.raw, item.conditions.power])).toEqual([
      [noteReadingId('n1', 'voltage'), 'voltage', 1.8, '1.8 V', 'powered'],
      [noteReadingId('n1', 'resistance'), 'resistance', 4700, '4k7', 'unpowered'],
      [noteReadingId('n1', 'other'), 'diode', 0.45, 'diode 0.45', 'unpowered'],
      [noteReadingId('n2', 'other'), 'continuity', true, 'beep', 'unpowered'],
      [noteReadingId('n8', 'voltage'), 'voltage', 412, '412', 'powered'],
    ]);
    expect(plan.readings[0]).toMatchObject({ target: { ref: 'U7', pin: '3' }, source: 'measured', provenance: { origin: 'note', sourceId: 'n1' }, takenAt: '2026-05-01T12:00:00.000Z' });
    expect(plan.skipped).toEqual([
      { noteId: 'n3', field: 'other', reason: 'ambiguous' }, { noteId: 'n4', reason: 'not-a-pin' }, { noteId: 'n5', reason: 'anchored' }, { noteId: 'n6', reason: 'not-keyed' },
      { noteId: 'n7', field: 'voltage', reason: 'unparsed' }, { noteId: 'n7', field: 'resistance', reason: 'too-long' },
    ]);
    expect(notes[0]).toEqual(note('n1', { ref: 'U7', pin: '3' }, { voltage: '1.8 V', resistance: '4k7', other: 'diode 0.45' }), 'the notes are not changed');
  });
  it('is idempotent: the ids are derived from the note and field, and a second run with them plans nothing', () => {
    const notes: BoardNote[] = [note('n1', { ref: 'U7', pin: '3' }, { voltage: '1.8' })];
    const first = planNoteMigration(notes);
    expect(planNoteMigration(notes).readings).toEqual(first.readings);
    const second = planNoteMigration(notes, { existingIds: new Set(first.readings.map(item => item.id)) });
    expect(second.readings).toEqual([]);
    expect(second.skipped).toEqual([{ noteId: 'n1', field: 'voltage', reason: 'exists' }]);
    expect(planNoteMigration(notes, { source: 'known-good' }).readings[0].source).toBe('known-good');
  });
});
