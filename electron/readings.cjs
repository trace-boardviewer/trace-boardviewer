'use strict';

// Native twin of the readings schema, the family reducer and the pack / CSV writers in src/lib/readings (schema.ts, model.ts,
// pack.ts, csv.ts). main.cjs cannot import TypeScript, so the rules are duplicated here with the same bounds, field order, codes and
// messages; src/lib/readings/readings-parity.test.ts runs both on one corpus and requires identical results and identical bytes.
// The format is documented in docs/READINGS_FORMAT.md. Texts are English with a stable `code`; main.cjs translates what users see.

const READINGS_FORMAT = 'trace-readings';
const READINGS_VERSION = 1;
// Twin of FINGERPRINT_VERSION in src/lib/board-fingerprint.ts.
const FINGERPRINT_VERSION = 1;
const READING_KINDS = Object.freeze(['diode', 'voltage', 'resistance', 'continuity']);
const UNIT_OF = Object.freeze({ diode: 'V', voltage: 'V', resistance: 'ohm' });
const POWER_STATES = Object.freeze(['unpowered', 'powered']);
const POLARITIES = Object.freeze(['red-on-reference', 'black-on-reference']);
const METER_MODES = Object.freeze(['dc', 'ac']);
const READING_SOURCES = Object.freeze(['measured', 'known-good', 'imported']);
const PROVENANCE_ORIGINS = Object.freeze(['trace-pack', 'csv', 'openboarddata', 'note']);
const EVENT_TYPES = Object.freeze(['family.create', 'family.link', 'family.rename', 'reading.add', 'reading.replace', 'reading.remove']);
const LIMITS = Object.freeze({
  readings: 100000, events: 100000,
  id: 64, name: 256, net: 512, raw: 64, state: 32, meter: 64, note: 2000, title: 256, attribution: 1000, sourceId: 128,
  label: 256, boardNumber: 128, license: 64, licenses: 32, timestamp: 40, members: 256, fileKeys: 256, pinPairs: 1000000,
  value: 1e12, rel: 10,
});

class ReadingsError extends Error {
  constructor(code, message) { super(message); this.name = 'ReadingsError'; this.code = code; }
}
const invalid = (field) => new ReadingsError('READINGS_INVALID', `Invalid readings: ${field}.`);

const L = LIMITS;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LICENSE_PATTERN = /^(?:LicenseRef-[A-Za-z0-9.-]{1,53}|[A-Za-z0-9][A-Za-z0-9.+-]{0,63})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_ASCII = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max;
const isTimestamp = (value) => typeof value === 'string' && value.length <= L.timestamp && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const inList = (list, value) => typeof value === 'string' && list.includes(value);
const isLicense = (value) => typeof value === 'string' && value.length <= L.license && LICENSE_PATTERN.test(value);
const isReadingId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isHexKey = (value) => typeof value === 'string' && HEX64.test(value);

function canonicalName(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  const name = PRINTABLE_ASCII.test(value) ? value : value.normalize('NFKC').trim();
  return name.length >= 1 && name.length <= max ? name : null;
}

function validatePoint(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  const point = {};
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

function validateConditions(raw, kind, field) {
  if (!isObject(raw)) throw invalid(field);
  if (!inList(POWER_STATES, raw.power)) throw invalid(`${field}.power`);
  const conditions = { power: raw.power };
  if (raw.state !== undefined) { if (!isText(raw.state, L.state)) throw invalid(`${field}.state`); conditions.state = raw.state; }
  if (raw.reference !== undefined) {
    const reference = validatePoint(raw.reference, `${field}.reference`);
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

function validateProvenance(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  if (!inList(PROVENANCE_ORIGINS, raw.origin)) throw invalid(`${field}.origin`);
  const provenance = { origin: raw.origin };
  if (raw.title !== undefined) { if (!isText(raw.title, L.title)) throw invalid(`${field}.title`); provenance.title = raw.title; }
  if (raw.attribution !== undefined) { if (!isText(raw.attribution, L.attribution)) throw invalid(`${field}.attribution`); provenance.attribution = raw.attribution; }
  if (raw.sourceId !== undefined) { if (!isText(raw.sourceId, L.sourceId)) throw invalid(`${field}.sourceId`); provenance.sourceId = raw.sourceId; }
  if (raw.importedAt !== undefined) { if (!isTimestamp(raw.importedAt)) throw invalid(`${field}.importedAt`); provenance.importedAt = raw.importedAt; }
  return provenance;
}

function validateReading(raw, field = 'reading') {
  if (!isObject(raw)) throw invalid(field);
  if (!isReadingId(raw.id)) throw invalid(`${field}.id`);
  if (!inList(READING_KINDS, raw.kind)) throw invalid(`${field}.kind`);
  const kind = raw.kind;
  const target = validatePoint(raw.target, `${field}.target`);
  const reading = { id: raw.id, kind, target };
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
      reading.value = value + 0;
      reading.unit = UNIT_OF[kind];
    }
    if (raw.ol !== undefined) reading.ol = true;
  }
  if (raw.raw !== undefined) { if (!isText(raw.raw, L.raw)) throw invalid(`${field}.raw`); reading.raw = raw.raw; }
  reading.conditions = validateConditions(raw.conditions, kind, `${field}.conditions`);
  if (raw.tolerance !== undefined) {
    const tolerance = raw.tolerance;
    if (!isObject(tolerance) || (tolerance.abs === undefined && tolerance.rel === undefined)) throw invalid(`${field}.tolerance`);
    const result = {};
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

function validateReadings(raw, field = 'readings') {
  if (!Array.isArray(raw)) throw invalid(field);
  if (raw.length > L.readings) throw new ReadingsError('READINGS_TOO_MANY', `Invalid readings: at most ${L.readings} readings fit in one list.`);
  const ids = new Set();
  const list = new Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const reading = validateReading(raw[index], `${field}[${index}]`);
    if (ids.has(reading.id)) throw invalid(`${field}[${index}].id (duplicate)`);
    ids.add(reading.id);
    list[index] = reading;
  }
  return list;
}

function validatePinSet(raw, field) {
  if (!Array.isArray(raw)) throw invalid(field);
  let pairs = 0;
  let previousRef = null;
  const set = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!Array.isArray(entry) || entry.length !== 2 || !isText(entry[0], L.name) || !Array.isArray(entry[1]) || entry[1].length === 0) throw invalid(`${field}[${index}]`);
    const ref = entry[0];
    if (ref !== ref.trim().toUpperCase() || (previousRef !== null && !(previousRef < ref))) throw invalid(`${field}[${index}]`);
    previousRef = ref;
    let previousPin = null;
    const pins = [];
    for (const pin of entry[1]) {
      if (!isText(pin, L.name) || pin !== pin.trim().toUpperCase() || pin.startsWith('~') || (previousPin !== null && !(previousPin < pin))) throw invalid(`${field}[${index}]`);
      if (++pairs > L.pinPairs) throw invalid(`${field} (too many pins)`);
      previousPin = pin;
      pins.push(pin);
    }
    set.push([ref, pins]);
  }
  return set;
}

const pinSetSize = (set) => { let size = 0; for (const [, pins] of set) size += pins.length; return size; };

function validateFileKeys(raw, field) {
  if (!Array.isArray(raw) || raw.length > L.fileKeys) throw invalid(field);
  const seen = new Set();
  return raw.map((key, index) => {
    if (!isHexKey(key) || seen.has(key)) throw invalid(`${field}[${index}]`);
    seen.add(key);
    return key;
  });
}

function validateMember(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  if (!isHexKey(raw.fingerprint)) throw invalid(`${field}.fingerprint`);
  if (raw.fingerprintVersion !== FINGERPRINT_VERSION) throw invalid(`${field}.fingerprintVersion`);
  const member = { fingerprint: raw.fingerprint, fingerprintVersion: FINGERPRINT_VERSION, fileKeys: validateFileKeys(raw.fileKeys, `${field}.fileKeys`) };
  if (raw.label !== undefined) { if (!isText(raw.label, L.label)) throw invalid(`${field}.label`); member.label = raw.label; }
  return member;
}

function validateFamilyHeader(raw, field = 'family') {
  if (!isObject(raw)) throw invalid(field);
  if (!isHexKey(raw.id)) throw invalid(`${field}.id`);
  const header = { id: raw.id };
  if (raw.name !== undefined) { if (!isText(raw.name, L.label)) throw invalid(`${field}.name`); header.name = raw.name; }
  if (!isTimestamp(raw.createdAt)) throw invalid(`${field}.createdAt`);
  header.createdAt = raw.createdAt;
  if (!Array.isArray(raw.members) || raw.members.length === 0 || raw.members.length > L.members) throw invalid(`${field}.members`);
  const fingerprints = new Set();
  header.members = raw.members.map((item, index) => {
    const member = validateMember(item, `${field}.members[${index}]`);
    if (fingerprints.has(member.fingerprint)) throw invalid(`${field}.members[${index}].fingerprint (duplicate)`);
    fingerprints.add(member.fingerprint);
    return member;
  });
  if (raw.pinSet !== undefined) header.pinSet = validatePinSet(raw.pinSet, `${field}.pinSet`);
  return header;
}

function validatePack(raw) {
  if (!isObject(raw)) throw invalid('pack');
  if (raw.format !== READINGS_FORMAT) throw invalid('format');
  if (raw.version !== READINGS_VERSION) throw invalid('version');
  if (!isLicense(raw.license)) throw invalid('license');
  const pack = { format: READINGS_FORMAT, version: READINGS_VERSION, license: raw.license };
  let declared = null;
  if (raw.licenses !== undefined) {
    if (!Array.isArray(raw.licenses) || raw.licenses.length < 2 || raw.licenses.length > L.licenses || raw.licenses[0] !== raw.license) throw invalid('licenses');
    declared = new Set();
    for (let index = 0; index < raw.licenses.length; index++) {
      const license = raw.licenses[index];
      if (!isLicense(license) || declared.has(license) || (index > 1 && !(raw.licenses[index - 1] < license))) throw invalid(`licenses[${index}]`);
      declared.add(license);
    }
    pack.licenses = [...raw.licenses];
  }
  if (raw.title !== undefined) { if (!isText(raw.title, L.title)) throw invalid('title'); pack.title = raw.title; }
  if (raw.attribution !== undefined) { if (!isText(raw.attribution, L.attribution)) throw invalid('attribution'); pack.attribution = raw.attribution; }
  if (raw.createdAt !== undefined) { if (!isTimestamp(raw.createdAt)) throw invalid('createdAt'); pack.createdAt = raw.createdAt; }
  if (!isObject(raw.board)) throw invalid('board');
  const board = {};
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
    if (license !== undefined && license !== pack.license && !(declared && declared.has(license))) throw invalid(`readings[${index}].license (not listed in licenses)`);
  }
  if (declared) {
    const used = new Set([pack.license]);
    for (const reading of pack.readings) if (reading.license !== undefined) used.add(reading.license);
    if (used.size !== declared.size) throw invalid('licenses (lists a licence no reading carries)');
  }
  return pack;
}

function validateEvent(raw, field = 'event') {
  if (!isObject(raw)) throw invalid(field);
  switch (raw.type) {
    case 'family.create': return { type: 'family.create', family: validateFamilyHeader(raw.family, `${field}.family`) };
    case 'family.link': {
      const event = { type: 'family.link', member: validateMember(raw.member, `${field}.member`) };
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

function validateEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('events');
  if (raw.length > L.events) throw new ReadingsError('READINGS_TOO_MANY', `Invalid readings: at most ${L.events} events fit in one append.`);
  return raw.map((event, index) => validateEvent(event, `events[${index}]`));
}

// ---------------------------------------------------------------------------------------------------------------
// Family reducer (twin of src/lib/readings/model.ts)
// ---------------------------------------------------------------------------------------------------------------

function mergeMember(family, member) {
  const existing = family.members.find((item) => item.fingerprint === member.fingerprint);
  if (!existing) { family.members.push({ ...member, fileKeys: [...member.fileKeys] }); return; }
  for (const key of member.fileKeys) if (!existing.fileKeys.includes(key)) existing.fileKeys.push(key);
  if (existing.label === undefined && member.label !== undefined) existing.label = member.label;
}

function renamed(family, name) {
  const next = { id: family.id, name, createdAt: family.createdAt, members: family.members };
  if (family.pinSet !== undefined) next.pinSet = family.pinSet;
  return next;
}

function memberLimits(family, member, index) {
  const existing = family.members.find((item) => item.fingerprint === member.fingerprint);
  if (!existing) {
    if (family.members.length >= L.members) throw new ReadingsError('READINGS_INVALID', `Invalid readings: events[${index}].member (a family holds at most ${L.members} boards).`);
    return;
  }
  let keys = existing.fileKeys.length;
  for (const key of member.fileKeys) if (!existing.fileKeys.includes(key)) keys++;
  if (keys > L.fileKeys) throw new ReadingsError('READINGS_INVALID', `Invalid readings: events[${index}].member.fileKeys (a board holds at most ${L.fileKeys} file keys).`);
}

function checkEvents(state, events, familyId) {
  let family = state ? state.family : null;
  const added = new Set();
  const removed = new Set();
  let count = state ? state.readings.size : 0;
  let scratch = null;
  const has = (id) => added.has(id) || (state !== null && state.readings.has(id) && !removed.has(id));
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'family.create') {
      if (family) throw new ReadingsError('READINGS_FAMILY_EXISTS', `Readings conflict: events[${index}] creates a board family that exists already.`);
      if (familyId !== undefined && event.family.id !== familyId) throw new ReadingsError('READINGS_INVALID', `Invalid readings: events[${index}].family.id (another family).`);
      family = event.family;
      continue;
    }
    if (!family) throw new ReadingsError('READINGS_NO_FAMILY', `Readings conflict: events[${index}] needs a board family; the first event of a family is family.create.`);
    switch (event.type) {
      case 'family.link':
        if (!scratch) scratch = { ...family, members: family.members.map((member) => ({ ...member, fileKeys: [...member.fileKeys] })) };
        memberLimits(scratch, event.member, index);
        mergeMember(scratch, event.member);
        break;
      case 'family.rename':
        break;
      case 'reading.add':
        if (has(event.reading.id)) throw new ReadingsError('READINGS_CONFLICT', `Readings conflict: events[${index}] adds reading ${event.reading.id}, which exists already.`);
        if (removed.has(event.reading.id)) removed.delete(event.reading.id); else added.add(event.reading.id);
        if (++count > L.readings) throw new ReadingsError('READINGS_TOO_MANY', `At most ${L.readings} readings can be saved for one board family.`);
        break;
      case 'reading.replace':
        if (!has(event.reading.id)) throw new ReadingsError('READINGS_CONFLICT', `Readings conflict: events[${index}] replaces reading ${event.reading.id}, which does not exist.`);
        break;
      case 'reading.remove':
        if (!has(event.id)) throw new ReadingsError('READINGS_CONFLICT', `Readings conflict: events[${index}] removes reading ${event.id}, which does not exist.`);
        if (added.has(event.id)) added.delete(event.id); else removed.add(event.id);
        count--;
        break;
      default:
        break;
    }
  }
}

// `encode(reading, index)` is what the state keeps per reading: the reading itself (the twin of model.ts), or its JSON line (the store).
function applyEvents(state, events, encode = (reading) => reading) {
  let current = state;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'family.create') {
      current = { family: { ...event.family, members: event.family.members.map((member) => ({ ...member, fileKeys: [...member.fileKeys] })) }, readings: new Map() };
      continue;
    }
    if (!current) throw new ReadingsError('READINGS_NO_FAMILY', 'Readings conflict: the first event of a family is family.create.');
    switch (event.type) {
      case 'family.link': mergeMember(current.family, event.member); break;
      case 'family.rename': current.family = renamed(current.family, event.name); break;
      case 'reading.add': case 'reading.replace': current.readings.set(event.reading.id, encode(event.reading, index)); break;
      case 'reading.remove': current.readings.delete(event.id); break;
      default: break;
    }
  }
  if (!current) throw new ReadingsError('READINGS_NO_FAMILY', 'Readings conflict: the first event of a family is family.create.');
  return current;
}

// ---------------------------------------------------------------------------------------------------------------
// Writers (twins of serializePack in pack.ts and readingsToCsv in csv.ts)
// ---------------------------------------------------------------------------------------------------------------

function serializePack(pack) {
  const lines = [];
  const field = (key, value) => lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  field('format', pack.format);
  field('version', pack.version);
  field('license', pack.license);
  if (pack.licenses !== undefined) field('licenses', pack.licenses);
  if (pack.title !== undefined) field('title', pack.title);
  if (pack.attribution !== undefined) field('attribution', pack.attribution);
  if (pack.createdAt !== undefined) field('createdAt', pack.createdAt);
  field('board', pack.board);
  const body = pack.readings.length === 0 ? '[]' : `[\n${pack.readings.map((reading) => `    ${JSON.stringify(reading)}`).join(',\n')}\n  ]`;
  lines.push(`  "readings": ${body}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

const CSV_COLUMNS = Object.freeze([
  'id', 'kind', 'ref', 'pin', 'net', 'value', 'unit', 'ol', 'connected', 'raw', 'power', 'state', 'reference_ref', 'reference_pin', 'reference_net',
  'polarity', 'meter_mode', 'meter', 'tol_abs', 'tol_rel', 'source', 'license', 'origin', 'title', 'attribution', 'source_id', 'imported_at', 'taken_at', 'note',
]);
const FORMULA = /^'*[=+\-@\t\r]/;
const escapeFormula = (text) => (FORMULA.test(text) ? `'${text}` : text);
const NEEDS_QUOTES = /[",\r\n]/;
function textCell(value) {
  if (value === undefined) return '';
  const text = escapeFormula(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const numberCell = (value) => (value === undefined ? '' : String(value));

function csvRow(reading) {
  const c = reading.conditions;
  const p = reading.provenance;
  const reference = c.reference;
  return [
    textCell(reading.id), reading.kind, textCell(reading.target.ref), textCell(reading.target.pin), textCell(reading.target.net),
    numberCell(reading.value), reading.unit ?? '', reading.ol ? 'true' : '', reading.connected === undefined ? '' : String(reading.connected), textCell(reading.raw),
    c.power, textCell(c.state), textCell(reference && reference.ref), textCell(reference && reference.pin), textCell(reference && reference.net),
    c.polarity ?? '', c.meterMode ?? '', textCell(c.meter), numberCell(reading.tolerance && reading.tolerance.abs), numberCell(reading.tolerance && reading.tolerance.rel),
    reading.source, textCell(reading.license), (p && p.origin) ?? '', textCell(p && p.title), textCell(p && p.attribution), textCell(p && p.sourceId), textCell(p && p.importedAt),
    textCell(reading.takenAt), textCell(reading.note),
  ].join(',');
}

function readingsToCsv(readings) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const reading of readings) lines.push(csvRow(reading));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// A CSV export of a pack: each reading without a licence of its own gets the pack's, so every row names its licence.
function packToCsv(pack) {
  return readingsToCsv(pack.readings.map((reading) => (reading.license === undefined ? withLicense(reading, pack.license) : reading)));
}
// The reading with `license` inserted at its canonical place (after `source`).
function withLicense(reading, license) {
  const result = {};
  for (const [key, value] of Object.entries(reading)) {
    result[key] = value;
    if (key === 'source') result.license = license;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Text of a file picked for import (main reads it, the renderer parses it with pack.ts, csv.ts or openboarddata.ts)
// ---------------------------------------------------------------------------------------------------------------

// UTF-8 (with or without a byte order mark) or UTF-16 with a byte order mark; anything else, or text that holds a NUL character,
// is not a readings file. Null when the bytes are not such text.
function decodeImportText(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  let text;
  try {
    if (view[0] === 0xff && view[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(view.subarray(2));
    else if (view[0] === 0xfe && view[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(view.subarray(2));
    else text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(view);
  } catch { return null; }
  return text.includes('\u0000') ? null : text;
}

module.exports = Object.freeze({
  READINGS_FORMAT, READINGS_VERSION, FINGERPRINT_VERSION, READING_KINDS, UNIT_OF, POWER_STATES, POLARITIES, METER_MODES, READING_SOURCES, PROVENANCE_ORIGINS,
  EVENT_TYPES, LIMITS, CSV_COLUMNS, ReadingsError,
  canonicalName, isLicense, isReadingId, isHexKey, isTimestamp,
  validateReading, validateReadings, validatePinSet, pinSetSize, validateMember, validateFamilyHeader, validatePack, validateEvent, validateEvents,
  mergeMember, checkEvents, applyEvents, serializePack, readingsToCsv, packToCsv, decodeImportText,
});
