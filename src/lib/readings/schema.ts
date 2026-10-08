/**
 * Readings schema v1: the record of one measurement, the shareable pack, and the events of the repair store.
 *
 * Pure TypeScript (no DOM, no Electron). `electron/readings.cjs` is the native twin of every validator here: the same bounds, field
 * order, codes and messages. `readings-parity.test.ts` runs both on one corpus and requires identical results. The format is
 * documented in docs/READINGS_FORMAT.md (with a JSON Schema); `readings-doc.test.ts` keeps the enums of that document equal to these.
 *
 * A reading holds names and values only: no coordinates, no file path, no user name (free-text fields hold only what someone typed).
 *  - target: a part (`ref`), a pin (`ref` + `pin`) or a net (`net`). Names are NFKC-normalized and trimmed, case kept; `pin` needs
 *    `ref`; `net` next to `ref` is the net the pin was on when measured (a check, not the key). Text form of the key: `readingKeyText`.
 *  - value: diode, voltage and resistance hold either `value` (a number in the SI unit of the kind: V, V, ohm) with that `unit`, or
 *    `ol: true` (the meter shows OL: open or over range). Continuity holds `connected` (true: the meter beeps) and nothing else.
 *  - conditions: `power` (unpowered | powered), an optional typed `state` label (S0, S5, standby ...), the point the other lead sits
 *    on (`reference`; absent = board ground), the lead `polarity` (absent = not recorded), `meterMode` (voltage only: dc | ac;
 *    absent = dc) and the typed `meter` model.
 *  - source: `measured` (on the board in hand), `known-good` (on a working board, or typed from a trusted reference) or `imported`
 *    (a reference value from someone else; then `license` (SPDX id) and `provenance` are required). Any reading may carry them.
 *
 * Validators return a NEW object in canonical form (names normalized, unknown fields dropped, fixed key order) or throw a
 * `ReadingsError` whose `code` is stable: READINGS_INVALID (shape or bounds), READINGS_TOO_MANY (count limit).
 */
import { FINGERPRINT_VERSION } from '../board-fingerprint';
import { escapeKeyName } from '../note-keys';
import type { PinSet } from '../board-fingerprint';

export const READINGS_FORMAT = 'trace-readings';
export const READINGS_VERSION = 1;
export const DEFAULT_PACK_LICENSE = 'CC0-1.0';

export const READING_KINDS = ['diode', 'voltage', 'resistance', 'continuity'] as const;
export type ReadingKind = typeof READING_KINDS[number];
export type NumericKind = Exclude<ReadingKind, 'continuity'>;
export const READING_UNITS = ['V', 'ohm'] as const;
export type ReadingUnit = typeof READING_UNITS[number];
/** The unit every numeric kind is stored in. */
export const UNIT_OF: Readonly<Record<NumericKind, ReadingUnit>> = Object.freeze({ diode: 'V', voltage: 'V', resistance: 'ohm' });
export const POWER_STATES = ['unpowered', 'powered'] as const;
export type PowerState = typeof POWER_STATES[number];
export const POLARITIES = ['red-on-reference', 'black-on-reference'] as const;
export type Polarity = typeof POLARITIES[number];
export const METER_MODES = ['dc', 'ac'] as const;
export type MeterMode = typeof METER_MODES[number];
export const READING_SOURCES = ['measured', 'known-good', 'imported'] as const;
export type ReadingSource = typeof READING_SOURCES[number];
export const PROVENANCE_ORIGINS = ['trace-pack', 'csv', 'openboarddata', 'note'] as const;
export type ProvenanceOrigin = typeof PROVENANCE_ORIGINS[number];
export const EVENT_TYPES = ['family.create', 'family.link', 'family.rename', 'reading.add', 'reading.replace', 'reading.remove'] as const;
export type RepairEventType = typeof EVENT_TYPES[number];

export const READINGS_LIMITS = Object.freeze({
  /** Readings in one board family, and in one pack. */
  readings: 100_000,
  /** Events in one append call. */
  events: 100_000,
  id: 64, name: 256, net: 512, raw: 64, state: 32, meter: 64, note: 2000, title: 256, attribution: 1000, sourceId: 128,
  label: 256, boardNumber: 128, license: 64, licenses: 32, timestamp: 40, members: 256, fileKeys: 256, pinPairs: 1_000_000,
  /** Largest magnitude of a value (SI unit) and of an absolute tolerance. */
  value: 1e12,
  /** Largest relative tolerance (10 = 1000 %). */
  rel: 10,
});

export interface ReadingTarget { ref?: string; pin?: string; net?: string }
/** Where the other lead sits: a net, a part or a pin. Absent in the conditions means board ground. */
export interface ReadingPoint { ref?: string; pin?: string; net?: string }
export interface ReadingConditions {
  power: PowerState;
  state?: string;
  reference?: ReadingPoint;
  polarity?: Polarity;
  meterMode?: MeterMode;
  meter?: string;
}
export interface ReadingTolerance { abs?: number; rel?: number }
export interface ReadingProvenance {
  origin: ProvenanceOrigin;
  /** Name of the set (pack title, OpenBoardData board id). */
  title?: string;
  /** Attribution text the source asks for. */
  attribution?: string;
  /** The record's id in its source (the original reading id, a note id). */
  sourceId?: string;
  importedAt?: string;
}
export interface Reading {
  id: string;
  kind: ReadingKind;
  target: ReadingTarget;
  value?: number;
  unit?: ReadingUnit;
  ol?: true;
  connected?: boolean;
  /** What the technician typed or the source wrote, verbatim. */
  raw?: string;
  conditions: ReadingConditions;
  tolerance?: ReadingTolerance;
  source: ReadingSource;
  license?: string;
  provenance?: ReadingProvenance;
  takenAt?: string;
  note?: string;
}
export interface PackBoard {
  fingerprint?: string;
  fingerprintVersion?: number;
  label?: string;
  boardNumber?: string;
  fileKeys?: string[];
  pinSet?: PinSet;
}
export interface ReadingsPack {
  format: typeof READINGS_FORMAT;
  version: typeof READINGS_VERSION;
  /** SPDX id of the pack; applies to every reading that carries no `license` of its own. */
  license: string;
  /** Every licence in the pack (the pack's first, then the others sorted). Required as soon as one reading carries another licence. */
  licenses?: string[];
  title?: string;
  attribution?: string;
  createdAt?: string;
  board: PackBoard;
  readings: Reading[];
}
export interface FamilyMember { fingerprint: string; fingerprintVersion: number; fileKeys: string[]; label?: string }
/** A board family: the boards (fingerprints, file keys) the technician confirmed to be the same board. */
export interface FamilyHeader { id: string; name?: string; createdAt: string; members: FamilyMember[]; pinSet?: PinSet }
export type RepairEvent =
  | { type: 'family.create'; family: FamilyHeader }
  | { type: 'family.link'; member: FamilyMember; similarity?: number }
  | { type: 'family.rename'; name: string }
  | { type: 'reading.add'; reading: Reading }
  | { type: 'reading.replace'; reading: Reading }
  | { type: 'reading.remove'; id: string };

export class ReadingsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ReadingsError'; this.code = code; }
}
const invalid = (field: string): ReadingsError => new ReadingsError('READINGS_INVALID', `Invalid readings: ${field}.`);

const L = READINGS_LIMITS;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LICENSE_PATTERN = /^(?:LicenseRef-[A-Za-z0-9.-]{1,53}|[A-Za-z0-9][A-Za-z0-9.+-]{0,63})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_ASCII = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max;
export const isTimestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= L.timestamp && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const inList = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** The identity form of a reference, pin number or net name: NFKC and trim, case kept (the rule of note-keys.ts). Null when empty or too long. */
export function canonicalName(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  // Printable ASCII without blanks at either end is already canonical: the common case is decided without normalize().
  const name = PRINTABLE_ASCII.test(value) ? value : value.normalize('NFKC').trim();
  return name.length >= 1 && name.length <= max ? name : null;
}

function validatePoint(raw: unknown, field: string): ReadingPoint {
  if (!isObject(raw)) throw invalid(field);
  const point: ReadingPoint = {};
  if (raw.ref !== undefined) {
    const ref = canonicalName(raw.ref, L.name); if (ref === null) throw invalid(`${field}.ref`); point.ref = ref;
  }
  if (raw.pin !== undefined) {
    if (point.ref === undefined) throw invalid(`${field}.pin`);
    const pin = canonicalName(raw.pin, L.name); if (pin === null) throw invalid(`${field}.pin`); point.pin = pin;
  }
  if (raw.net !== undefined) {
    const net = canonicalName(raw.net, L.net); if (net === null) throw invalid(`${field}.net`); point.net = net;
  }
  if (point.ref === undefined && point.net === undefined) throw invalid(field);
  return point;
}

function validateConditions(raw: unknown, kind: ReadingKind, field: string): ReadingConditions {
  if (!isObject(raw)) throw invalid(field);
  if (!inList(POWER_STATES, raw.power)) throw invalid(`${field}.power`);
  const conditions: ReadingConditions = { power: raw.power };
  if (raw.state !== undefined) { if (!isText(raw.state, L.state)) throw invalid(`${field}.state`); conditions.state = raw.state; }
  if (raw.reference !== undefined) {
    const reference = validatePoint(raw.reference, `${field}.reference`);
    // The reference is ONE point: a net, or a part / pin (never both).
    if (reference.net !== undefined && reference.ref !== undefined) throw invalid(`${field}.reference`);
    conditions.reference = reference;
  }
  if (raw.polarity !== undefined) { if (!inList(POLARITIES, raw.polarity)) throw invalid(`${field}.polarity`); conditions.polarity = raw.polarity; }
  if (raw.meterMode !== undefined) {
    if (kind !== 'voltage' || !inList(METER_MODES, raw.meterMode)) throw invalid(`${field}.meterMode`);
    conditions.meterMode = raw.meterMode;
  }
  if (raw.meter !== undefined) { if (!isText(raw.meter, L.meter)) throw invalid(`${field}.meter`); conditions.meter = raw.meter; }
  return conditions;
}

function validateProvenance(raw: unknown, field: string): ReadingProvenance {
  if (!isObject(raw)) throw invalid(field);
  if (!inList(PROVENANCE_ORIGINS, raw.origin)) throw invalid(`${field}.origin`);
  const provenance: ReadingProvenance = { origin: raw.origin };
  if (raw.title !== undefined) { if (!isText(raw.title, L.title)) throw invalid(`${field}.title`); provenance.title = raw.title; }
  if (raw.attribution !== undefined) { if (!isText(raw.attribution, L.attribution)) throw invalid(`${field}.attribution`); provenance.attribution = raw.attribution; }
  if (raw.sourceId !== undefined) { if (!isText(raw.sourceId, L.sourceId)) throw invalid(`${field}.sourceId`); provenance.sourceId = raw.sourceId; }
  if (raw.importedAt !== undefined) { if (!isTimestamp(raw.importedAt)) throw invalid(`${field}.importedAt`); provenance.importedAt = raw.importedAt; }
  return provenance;
}

export const isLicense = (value: unknown): value is string => typeof value === 'string' && value.length <= L.license && LICENSE_PATTERN.test(value);
export const isReadingId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
export const isHexKey = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value);

/** Strict, canonical form of one reading. */
export function validateReading(raw: unknown, field = 'reading'): Reading {
  if (!isObject(raw)) throw invalid(field);
  if (!isReadingId(raw.id)) throw invalid(`${field}.id`);
  if (!inList(READING_KINDS, raw.kind)) throw invalid(`${field}.kind`);
  const kind = raw.kind;
  const target = validatePoint(raw.target, `${field}.target`);
  const reading: Reading = { id: raw.id, kind, target } as Reading;
  if (kind === 'continuity') {
    if (raw.value !== undefined || raw.unit !== undefined || raw.ol !== undefined) throw invalid(`${field}.value`);
    if (typeof raw.connected !== 'boolean') throw invalid(`${field}.connected`);
    reading.connected = raw.connected;
  } else {
    if (raw.connected !== undefined) throw invalid(`${field}.connected`);
    if (raw.ol !== undefined) {
      if (raw.ol !== true || raw.value !== undefined || raw.unit !== undefined) throw invalid(`${field}.ol`);
    } else {
      const value = raw.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > L.value || (kind !== 'voltage' && value < 0)) throw invalid(`${field}.value`);
      if (raw.unit !== UNIT_OF[kind]) throw invalid(`${field}.unit`);
      reading.value = value + 0; // `+ 0`: never -0
      reading.unit = UNIT_OF[kind];
    }
    if (raw.ol !== undefined) reading.ol = true;
  }
  if (raw.raw !== undefined) { if (!isText(raw.raw, L.raw)) throw invalid(`${field}.raw`); reading.raw = raw.raw; }
  reading.conditions = validateConditions(raw.conditions, kind, `${field}.conditions`);
  if (raw.tolerance !== undefined) {
    const tolerance = raw.tolerance;
    if (!isObject(tolerance) || (tolerance.abs === undefined && tolerance.rel === undefined)) throw invalid(`${field}.tolerance`);
    const result: ReadingTolerance = {};
    if (tolerance.abs !== undefined) {
      if (typeof tolerance.abs !== 'number' || !Number.isFinite(tolerance.abs) || tolerance.abs < 0 || tolerance.abs > L.value) throw invalid(`${field}.tolerance.abs`);
      result.abs = tolerance.abs + 0;
    }
    if (tolerance.rel !== undefined) {
      if (typeof tolerance.rel !== 'number' || !Number.isFinite(tolerance.rel) || tolerance.rel < 0 || tolerance.rel > L.rel) throw invalid(`${field}.tolerance.rel`);
      result.rel = tolerance.rel + 0;
    }
    reading.tolerance = result;
  }
  if (!inList(READING_SOURCES, raw.source)) throw invalid(`${field}.source`);
  reading.source = raw.source;
  if (raw.license !== undefined) { if (!isLicense(raw.license)) throw invalid(`${field}.license`); reading.license = raw.license; }
  if (raw.provenance !== undefined) reading.provenance = validateProvenance(raw.provenance, `${field}.provenance`);
  if (reading.source === 'imported' && (reading.license === undefined || reading.provenance === undefined)) throw invalid(`${field}.provenance (an imported reading names its licence and provenance)`);
  if (raw.takenAt !== undefined) { if (!isTimestamp(raw.takenAt)) throw invalid(`${field}.takenAt`); reading.takenAt = raw.takenAt; }
  if (raw.note !== undefined) { if (!isText(raw.note, L.note)) throw invalid(`${field}.note`); reading.note = raw.note; }
  return reading;
}

/** A list of readings with distinct ids, at most `READINGS_LIMITS.readings`. */
export function validateReadings(raw: unknown, field = 'readings'): Reading[] {
  if (!Array.isArray(raw)) throw invalid(field);
  if (raw.length > L.readings) throw new ReadingsError('READINGS_TOO_MANY', `Invalid readings: at most ${L.readings} readings fit in one list.`);
  const ids = new Set<string>();
  const list = new Array<Reading>(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const reading = validateReading(raw[index], `${field}[${index}]`);
    if (ids.has(reading.id)) throw invalid(`${field}[${index}].id (duplicate)`);
    ids.add(reading.id);
    list[index] = reading;
  }
  return list;
}

/** A (ref, pin) set exactly as `boardPinSet` writes it: references and pins trimmed and upper-cased, both levels sorted and distinct. */
export function validatePinSet(raw: unknown, field: string): PinSet {
  if (!Array.isArray(raw)) throw invalid(field);
  let pairs = 0;
  let previousRef: string | null = null;
  const set: Array<readonly [string, readonly string[]]> = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!Array.isArray(entry) || entry.length !== 2 || !isText(entry[0], L.name) || !Array.isArray(entry[1]) || entry[1].length === 0) throw invalid(`${field}[${index}]`);
    const ref: string = entry[0];
    if (ref !== ref.trim().toUpperCase() || (previousRef !== null && !(previousRef < ref))) throw invalid(`${field}[${index}]`);
    previousRef = ref;
    let previousPin: string | null = null;
    const pins: string[] = [];
    for (const pin of entry[1] as unknown[]) {
      if (!isText(pin, L.name) || pin !== pin.trim().toUpperCase() || pin.startsWith('~') || (previousPin !== null && !(previousPin < pin))) throw invalid(`${field}[${index}]`);
      if (++pairs > L.pinPairs) throw invalid(`${field} (too many pins)`);
      previousPin = pin;
      pins.push(pin);
    }
    set.push([ref, pins]);
  }
  return set;
}

function validateFileKeys(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length > L.fileKeys) throw invalid(field);
  const seen = new Set<string>();
  return raw.map((key, index) => {
    if (!isHexKey(key) || seen.has(key)) throw invalid(`${field}[${index}]`);
    seen.add(key);
    return key;
  });
}

export function validateMember(raw: unknown, field: string): FamilyMember {
  if (!isObject(raw)) throw invalid(field);
  if (!isHexKey(raw.fingerprint)) throw invalid(`${field}.fingerprint`);
  if (raw.fingerprintVersion !== FINGERPRINT_VERSION) throw invalid(`${field}.fingerprintVersion`);
  const member: FamilyMember = { fingerprint: raw.fingerprint, fingerprintVersion: FINGERPRINT_VERSION, fileKeys: validateFileKeys(raw.fileKeys, `${field}.fileKeys`) };
  if (raw.label !== undefined) { if (!isText(raw.label, L.label)) throw invalid(`${field}.label`); member.label = raw.label; }
  return member;
}

export function validateFamilyHeader(raw: unknown, field = 'family'): FamilyHeader {
  if (!isObject(raw)) throw invalid(field);
  if (!isHexKey(raw.id)) throw invalid(`${field}.id`);
  const header: FamilyHeader = { id: raw.id } as FamilyHeader;
  if (raw.name !== undefined) { if (!isText(raw.name, L.label)) throw invalid(`${field}.name`); header.name = raw.name; }
  if (!isTimestamp(raw.createdAt)) throw invalid(`${field}.createdAt`);
  header.createdAt = raw.createdAt;
  if (!Array.isArray(raw.members) || raw.members.length === 0 || raw.members.length > L.members) throw invalid(`${field}.members`);
  const fingerprints = new Set<string>();
  header.members = raw.members.map((item, index) => {
    const member = validateMember(item, `${field}.members[${index}]`);
    if (fingerprints.has(member.fingerprint)) throw invalid(`${field}.members[${index}].fingerprint (duplicate)`);
    fingerprints.add(member.fingerprint);
    return member;
  });
  if (raw.pinSet !== undefined) header.pinSet = validatePinSet(raw.pinSet, `${field}.pinSet`);
  return header;
}

/** Strict, canonical form of a readings pack. A reading with a licence other than the pack's requires the `licenses` list naming it. */
export function validatePack(raw: unknown): ReadingsPack {
  if (!isObject(raw)) throw invalid('pack');
  if (raw.format !== READINGS_FORMAT) throw invalid('format');
  if (raw.version !== READINGS_VERSION) throw invalid('version');
  if (!isLicense(raw.license)) throw invalid('license');
  const pack: ReadingsPack = { format: READINGS_FORMAT, version: READINGS_VERSION, license: raw.license } as ReadingsPack;
  let declared: Set<string> | null = null;
  if (raw.licenses !== undefined) {
    if (!Array.isArray(raw.licenses) || raw.licenses.length < 2 || raw.licenses.length > L.licenses || raw.licenses[0] !== raw.license) throw invalid('licenses');
    declared = new Set();
    for (let index = 0; index < raw.licenses.length; index++) {
      const license = raw.licenses[index];
      if (!isLicense(license) || declared.has(license) || (index > 1 && !(raw.licenses[index - 1] < license))) throw invalid(`licenses[${index}]`);
      declared.add(license);
    }
    pack.licenses = [...raw.licenses] as string[];
  }
  if (raw.title !== undefined) { if (!isText(raw.title, L.title)) throw invalid('title'); pack.title = raw.title; }
  if (raw.attribution !== undefined) { if (!isText(raw.attribution, L.attribution)) throw invalid('attribution'); pack.attribution = raw.attribution; }
  if (raw.createdAt !== undefined) { if (!isTimestamp(raw.createdAt)) throw invalid('createdAt'); pack.createdAt = raw.createdAt; }
  if (!isObject(raw.board)) throw invalid('board');
  const board: PackBoard = {};
  if (raw.board.fingerprint !== undefined) {
    if (!isHexKey(raw.board.fingerprint)) throw invalid('board.fingerprint');
    if (raw.board.fingerprintVersion !== FINGERPRINT_VERSION) throw invalid('board.fingerprintVersion');
    board.fingerprint = raw.board.fingerprint;
    board.fingerprintVersion = FINGERPRINT_VERSION;
  } else if (raw.board.fingerprintVersion !== undefined) throw invalid('board.fingerprintVersion');
  if (raw.board.label !== undefined) { if (!isText(raw.board.label, L.label)) throw invalid('board.label'); board.label = raw.board.label; }
  if (raw.board.boardNumber !== undefined) { if (!isText(raw.board.boardNumber, L.boardNumber)) throw invalid('board.boardNumber'); board.boardNumber = raw.board.boardNumber; }
  if (raw.board.fileKeys !== undefined) board.fileKeys = validateFileKeys(raw.board.fileKeys, 'board.fileKeys');
  if (raw.board.pinSet !== undefined) board.pinSet = validatePinSet(raw.board.pinSet, 'board.pinSet');
  pack.board = board;
  pack.readings = validateReadings(raw.readings);
  for (let index = 0; index < pack.readings.length; index++) {
    const license = pack.readings[index].license;
    if (license !== undefined && license !== pack.license && !declared?.has(license)) throw invalid(`readings[${index}].license (not listed in licenses)`);
  }
  if (declared) {
    // The list names exactly the licences that occur: no marking without a reason.
    const used = new Set<string>([pack.license]);
    for (const reading of pack.readings) if (reading.license !== undefined) used.add(reading.license);
    if (used.size !== declared.size) throw invalid('licenses (lists a licence no reading carries)');
  }
  return pack;
}

/** One store event in canonical form. */
export function validateEvent(raw: unknown, field = 'event'): RepairEvent {
  if (!isObject(raw)) throw invalid(field);
  switch (raw.type) {
    case 'family.create': return { type: 'family.create', family: validateFamilyHeader(raw.family, `${field}.family`) };
    case 'family.link': {
      const event: RepairEvent = { type: 'family.link', member: validateMember(raw.member, `${field}.member`) };
      if (raw.similarity !== undefined) {
        if (typeof raw.similarity !== 'number' || !Number.isFinite(raw.similarity) || raw.similarity < 0 || raw.similarity > 1) throw invalid(`${field}.similarity`);
        event.similarity = raw.similarity;
      }
      return event;
    }
    case 'family.rename':
      if (!isText(raw.name, L.label)) throw invalid(`${field}.name`);
      return { type: 'family.rename', name: raw.name };
    case 'reading.add': return { type: 'reading.add', reading: validateReading(raw.reading, `${field}.reading`) };
    case 'reading.replace': return { type: 'reading.replace', reading: validateReading(raw.reading, `${field}.reading`) };
    case 'reading.remove':
      if (!isReadingId(raw.id)) throw invalid(`${field}.id`);
      return { type: 'reading.remove', id: raw.id };
    default: throw invalid(`${field}.type`);
  }
}

/** A non-empty list of events for one append call. */
export function validateEvents(raw: unknown): RepairEvent[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('events');
  if (raw.length > L.events) throw new ReadingsError('READINGS_TOO_MANY', `Invalid readings: at most ${L.events} events fit in one append.`);
  return raw.map((event, index) => validateEvent(event, `events[${index}]`));
}

// ---------------------------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------------------------

/**
 * The text key of a target (for maps and sorting; never stored): a part is its reference and a pin is `ref/pin` in the text form of
 * note-keys.ts (equal to `partKeyText` and `pinKeyText`; the names of a validated target are already normalized, so only the escape is
 * applied); a net is `@net:` plus the escaped net name. An escaped name never holds a raw "@", so no part or pin key can equal a net
 * key: distinct targets have distinct keys. The net checked next to a pin is not part of the key.
 */
export function readingKeyText(target: ReadingTarget): string {
  if (target.ref !== undefined) return target.pin !== undefined ? `${escapeKeyName(target.ref)}/${escapeKeyName(target.pin)}` : escapeKeyName(target.ref);
  return `@net:${escapeKeyName(target.net ?? '')}`;
}
