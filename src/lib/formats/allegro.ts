/*
 * Original TRACE reader (MIT). Allegro's keyed binary database is described in
 * https://dev-docs.kicad.org/en/import-formats/allegro/ and the associated FORMAT.md.
 * This reader uses the format's record widths and references; it never searches
 * arbitrary payload bytes for plausible components. No external parser code is used.
 */
import type { Point } from '../types';
import { BoardFormatError, buildBoard, MAX_IMPORT_BYTES, note, stitchOutline, type BoardParser, type RawPart, type RawPin } from './common';
import { allegro } from './recognizers';
import type { StructureSink, StructureHook } from './structure-hook';

const MAX_RECORDS = 2_000_000, MAX_STRINGS = 1_000_000, MAX_STRING_BYTES = 64 * 1024;
type RecordInfo = { tag: number; offset: number; length: number; key: number };
type Database = ReturnType<typeof readDatabase>;
function fail(message: string, code: 'INVALID_FORMAT' | 'UNSUPPORTED_VARIANT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never {
  throw new BoardFormatError(`Allegro: ${message}`, code, 'allegro-brd');
}
const align4 = (n: number) => Math.ceil(n / 4) * 4;

/** Fixed byte lengths, including the four-byte record prefix. Dynamic records are handled below. */
function fixedLengths(version: number): Readonly<Record<number, number>> {
  const modern = version >= 172 ? 4 : 0, latest = version >= 174 ? 4 : 0;
  return {
    1: 80 + modern, 4: 20 + latest, 5: 60 + modern * 2, 6: 36 + modern, 7: 40 + modern * 2,
    8: 24 + modern * 2, 9: 44 + modern + latest, 10: 68 + modern + latest, 12: 56 + modern * 2 + latest,
    13: 40 + modern + latest, 14: 60 + modern * 2, 15: 56 + modern + latest, 16: 32 + modern + latest,
    17: 24 + latest, 18: 24 + (version >= 165 ? 4 : 0) + latest, 20: 32 + modern,
    21: 40 + modern, 22: 40 + modern, 23: 40 + modern, 27: 56 + modern,
    32: 40 + latest * 10, 34: 40 + modern, 35: 68 + (version >= 164 ? 16 : 0) + latest,
    36: 52 + modern, 38: 20 + modern + latest, 40: 68 + modern * 2,
    43: 68 + (version >= 164 ? 4 : 0) + modern, 44: 36 + modern * 2,
    45: 64 + modern * 2, 46: 36 + modern, 47: 32, 48: 44 + modern * 3 + latest,
    50: 76 + modern * 2, 51: 72 + modern * 2, 52: 32 + modern,
    53: 124, 55: 428 + latest, 56: (version >= 166 ? 52 : 64) + latest, 57: 60, 58: 16 + latest,
  };
}

/** A bounded record pass, shared with the content-free diagnostic hook. */
function readDatabase(data: Uint8Array, sink?: StructureSink) {
  if (data.length > MAX_IMPORT_BYTES) fail('database exceeds the import byte limit.', 'LIMIT_EXCEEDED');
  const recognized = allegro(data);
  if (!recognized) fail('missing native database signature.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (offset: number, length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > data.length) fail('truncated or out-of-range record.');
  };
  const u32 = (offset: number) => { need(offset, 4); return view.getUint32(offset, true); };
  const i32 = (offset: number) => { need(offset, 4); return view.getInt32(offset, true); };
  const u16 = (offset: number) => { need(offset, 2); return view.getUint16(offset, true); };
  const magic = u32(0) & 0xffffff00;
  const version = new Map([[0x130000, 160], [0x130400, 162], [0x130500, 162], [0x130c00, 164], [0x131000, 165], [0x131500, 166], [0x140400, 172], [0x140900, 174], [0x141500, 175]]).get(magic);
  if (!version) {
    if (recognized.versionCode) sink?.code('version', recognized.versionCode);
    fail(`native database layout 0x${magic.toString(16).padStart(8, '0')} is unsupported; this reader requires a documented 16.0–17.5 layout. Export GenCAD from the original software.`, 'UNSUPPORTED_VARIANT');
  }
  need(0, 0x1200);
  const stringCount = u32(0x194), divisor = u32(0x26c), unitCode = data[0x180], declaredObjects = u32(20);
  if (stringCount > MAX_STRINGS || declaredObjects > MAX_RECORDS) fail('declared database count exceeds the record limit.', 'LIMIT_EXCEEDED');
  if (!divisor || divisor > 1e9 || unitCode < 1 || unitCode > 5) fail('invalid units or coordinate divisor.');
  sink?.code('version', version); sink?.code('unitCode', unitCode); sink?.count('blocks', declaredObjects);
  sink?.units('mil', 0.0254 / divisor); sink?.padAngle('absolute'); sink?.reached('header');
  const strings = new Map<number, string>(), records = new Map<number, RecordInfo>(), all: RecordInfo[] = [];
  const decoder = new TextDecoder('windows-1252');
  let offset = 0x1200;
  for (let n = 0; n < stringCount; n++) {
    const key = u32(offset); offset += 4;
    const end = data.indexOf(0, offset);
    if (end < 0 || end - offset > MAX_STRING_BYTES) fail('unterminated or oversized string table entry.');
    if (!key || strings.has(key)) fail('duplicate or empty string table key.');
    strings.set(key, decoder.decode(data.subarray(offset, end)));
    offset += align4(end - offset + 1); need(offset, 0);
  }
  const fixed = fixedLengths(version), modern = version >= 172, latest = version >= 174;
  while (offset < data.length && data[offset] !== 0) {
    if (all.length >= MAX_RECORDS) fail('database exceeds the record limit.', 'LIMIT_EXCEEDED');
    const start = offset, tag = data[start];
    let length = fixed[tag], keyOffset = 4;
    if (tag === 3) {
      const head = modern ? 24 : 16, subtype = data[start + (modern ? 16 : 12)], count = u16(start + (modern ? 18 : 14));
      const payloads: Record<number, number> = { 0x65: 0, 0x64: 4, 0x66: 4, 0x67: 4, 0x6a: 4, 0x69: 8, 0xf6: 80 };
      let extra = payloads[subtype];
      if ([0x68, 0x6b, 0x6d, 0x6e, 0x6f, 0x71, 0x73, 0x78].includes(subtype)) extra = align4(count);
      if (subtype === 0x6c) extra = 4 + u32(start + head) * 4;
      if (subtype === 0x70 || subtype === 0x74) extra = 4 + u16(start + head + 2) + u16(start + head) * 4;
      if (extra === undefined) fail(`unsupported property subtype 0x${subtype?.toString(16)}.`, 'UNSUPPORTED_VARIANT');
      length = head + extra;
    } else if (tag === 28) {
      const layers = u16(start + (modern ? 44 : 50));
      if (layers > 256) fail('padstack layer count exceeds the limit.', 'LIMIT_EXCEEDED');
      length = (modern ? 192 : version >= 165 ? 88 : 84) + ((modern ? 21 : version >= 165 ? 11 : 10) + layers * (modern ? 4 : 3)) * (modern ? 36 : 28) - (modern ? 0 : 4) + data[start + 2] * (modern ? 40 : 32);
    } else if (tag === 29) length = 24 + u16(start + 20) * 256 + u16(start + 22) * (version >= 162 ? 56 : 48) + (modern ? 4 : 0);
    else if (tag === 30) length = 24 + align4(u32(start + 20)) + (modern ? 4 : 0);
    else if (tag === 31) length = 28 + u16(start + 26) * (version >= 162 ? 280 : 240) + (modern ? 8 : 4);
    else if (tag === 33) { length = u32(start + 4); keyOffset = 8; if (length < 12) fail('invalid blob length.'); }
    else if (tag === 39) { length = u32(0x18c) - 1 - start; keyOffset = -1; if (length < 4) fail('invalid constraint-manager extent.'); }
    else if (tag === 42) { length = 8 + (latest ? 4 : 0) + u16(start + 2) * (version <= 164 ? 36 : 12); keyOffset = length - 4; }
    else if (tag === 49) length = (latest ? 28 : 24) + align4(u16(start + 22));
    else if (tag === 54) {
      const sub = u16(start + 2), count = u32(start + (modern ? 16 : 12));
      const widths: Record<number, number> = { 2: 88 + (version >= 164 ? 12 : 0) + (modern ? 8 : 0), 3: (modern ? 64 : 32) + (latest ? 4 : 0), 5: version >= 175 ? 32 : 28, 6: modern ? 8 : 208, 8: 32 + (modern ? 32 : 0) + (latest ? 4 : 0), 11: 1016, 12: 232, 13: 200, 15: 20, 16: 108, 18: 1052 };
      if (widths[sub] === undefined) fail(`unsupported definition-table subtype 0x${sub.toString(16)}.`, 'UNSUPPORTED_VARIANT');
      length = 28 + (modern ? 4 : 0) + (latest ? 4 : 0) + count * widths[sub];
    } else if (tag === 59) { length = (modern ? 180 : 176) + align4(u32(start + 4)); keyOffset = -1; }
    else if (tag === 60) length = (latest ? 16 : 12) + u32(start + (latest ? 12 : 8)) * 4;
    if (length === undefined) fail(`unsupported record type 0x${tag.toString(16)}.`, 'UNSUPPORTED_VARIANT');
    need(start, length);
    if (length < 4) fail('record does not advance the database cursor.');
    const key = keyOffset < 0 ? 0 : u32(start + keyOffset), record = { tag, key, offset: start, length };
    if (key) { if (records.has(key)) fail('duplicate object key.'); records.set(key, record); }
    all.push(record); sink?.block(tag, length, 8); offset += length;
  }
  // Real databases end at a complete record. Synthetic/export padding may use
  // zero bytes, but an unparsed nonzero suffix is never part of this layout.
  if (data.subarray(offset).some(byte => byte !== 0)) fail('unexpected data after the database terminator.');
  if (declaredObjects !== records.size + strings.size) fail(`object and string counts do not match the complete database (declared ${declaredObjects}, read ${records.size + strings.size}).`);
  return { version, modern, strings, records, all, u32, i32, u16, divisor, data };
}

function readBoard(db: Database): { parts: RawPart[]; pins: RawPin[]; outline: Point[]; approximated: number } {
  const { modern, u32, i32, strings, records } = db;
  const get = (key: number, tag: number): RecordInfo => {
    const record = records.get(key);
    if (!record || record.tag !== tag) fail(`missing or wrong-type 0x${tag.toString(16)} reference.`);
    return record;
  };
  const string = (key: number) => { if (!key) return ''; const value = strings.get(key); if (value === undefined) fail('missing string reference.'); return value; };
  const parts: RawPart[] = [], pins: RawPin[] = [], ownedPads = new Set<number>();
  const copperLayers = db.all.filter(record => record.tag === 28).reduce((max, record) => Math.max(max, db.data[record.offset + 3] + db.u16(record.offset + (modern ? 44 : 50))), 0);
  const packages = new Map<number, string>();
  for (const definition of db.all.filter(record => record.tag === 43)) {
    const name = string(u32(definition.offset + 8)), seen = new Set<number>();
    let key = u32(definition.offset + 36);
    while (key && key !== definition.key) {
      if (seen.has(key) || packages.has(key)) fail('cycle or repeated footprint instance in definition list.');
      seen.add(key); const instance = get(key, 45); packages.set(key, name); key = u32(instance.offset + 8);
    }
  }
  let approximated = 0, textSteps = 0, outlineSteps = 0;
  for (const instance of db.all.filter(record => record.tag === 45)) {
    if (parts.length >= 250_000) fail('component count exceeds the limit.', 'LIMIT_EXCEEDED');
    const at = instance.offset, side = db.data[at + 2];
    if (side !== 0 && side !== 1) fail(`unsupported footprint layer code ${side}; supported placed layers are 0 (top) and 1 (bottom). Export GenCAD from the original software.`, 'UNSUPPORTED_VARIANT');
    const instanceRef = u32(at + (modern ? 40 : 12)), info = instanceRef ? get(instanceRef, 7) : undefined;
    if (info && u32(info.offset + (modern ? 24 : 12)) !== instance.key) fail('component instance links disagree.');
    const ref = info ? string(u32(info.offset + (modern ? 28 : 20))) : '', key = String(instance.key);
    let textKey = u32(at + (modern ? 52 : 44)), value = '';
    const textSeen = new Set<number>();
    while (textKey && textKey !== instance.key) {
      if (++textSteps > MAX_RECORDS) fail('component text traversal exceeds the record limit.', 'LIMIT_EXCEEDED');
      if (textSeen.has(textKey)) fail('cycle in component text list.'); textSeen.add(textKey);
      const text = records.get(textKey);
      if (!text || ![3, 48].includes(text.tag)) fail('invalid component text reference.');
      if (text.tag === 48 && db.data[text.offset + 2] === 2) {
        const graphic = get(u32(text.offset + (modern ? 28 : 12) + (db.version >= 174 ? 4 : 0)), 49);
        const length = db.u16(graphic.offset + 22), start = graphic.offset + (db.version >= 174 ? 28 : 24);
        value = new TextDecoder('windows-1252').decode(db.data.subarray(start, start + length)).replace(/\0.*$/s, '');
      }
      textKey = u32(text.offset + 8);
    }
    parts.push({ key, ...(ref ? { ref } : { ref: `MECHANICAL-${parts.length + 1}`, refGenerated: true }), package: packages.get(instance.key) ?? '', value, side: side ? 'bottom' : 'top', rotation: u32(at + (modern ? 28 : 24)) / 1000, position: { x: i32(at + (modern ? 32 : 28)), y: i32(at + (modern ? 36 : 32)) } });
    let padKey = u32(at + (modern ? 48 : 40));
    const seen = new Set<number>();
    while (padKey && padKey !== instance.key) {
      if (seen.has(padKey) || ownedPads.has(padKey)) fail('cycle or repeated placed pad in component list.');
      if (pins.length >= 1_000_000) fail('pin count exceeds the limit.', 'LIMIT_EXCEEDED');
      seen.add(padKey); ownedPads.add(padKey);
      const placed = get(padKey, 50), p = placed.offset, shift = modern ? 4 : 0;
      if (u32(p + 24 + shift) !== instance.key) fail('placed pad parent disagrees with the component.');
      const geometry = get(u32(p + 32 + shift), 13), stack = get(u32(geometry.offset + (db.version >= 174 ? 28 : 24)), 28);
      const numberKey = u32(p + 44 + shift), numberRecord = numberKey ? get(numberKey, 8) : undefined;
      const number = numberRecord ? string(u32(numberRecord.offset + (modern ? 16 : 8))) : '';
      const netKey = u32(p + 12);
      let net = '';
      if (netKey) { const assign = get(netKey, 4); const netRecord = get(u32(assign.offset + 12), 27); net = string(u32(netRecord.offset + 12)); }
      const layerCount = db.u16(stack.offset + (modern ? 44 : 50)), fixed = modern ? 21 : db.version >= 165 ? 11 : 10, width = modern ? 36 : 28;
      const first = stack.offset + (modern ? 192 : db.version >= 165 ? 88 : 84), layerIndex = side ? layerCount - 1 : 0;
      const shapeAt = first + (fixed + layerIndex * (modern ? 4 : 3) + 2) * width;
      const drill = u32(stack.offset + (modern ? 64 : 16));
      const shapeCode = layerCount ? db.data[shapeAt] : drill ? 2 : 0;
      const w = layerCount ? i32(shapeAt + (modern ? 8 : 4)) : drill, h = layerCount ? i32(shapeAt + (modern ? 12 : 8)) : drill;
      if (w < 0 || h < 0) fail('negative pad dimensions.');
      const padType = modern ? db.data[stack.offset + 28] >> 4 : db.u16(stack.offset + 44);
      const throughType = modern ? [0, 3, 8].includes(padType) : [0, 0x400].includes(padType);
      // Multilayer copper alone does not establish a hole. Require a drilled
      // through/slot/NPTH type spanning the stack; zero-layer mechanical holes
      // have no copper entries but still pass physically through the board.
      const through = drill > 0 && throughType && (layerCount === 0 || (db.data[stack.offset + 3] === 0 && layerCount === copperLayers));
      const padRotation = u32(geometry.offset + (modern ? (db.version >= 174 ? 44 : 40) : 36)) / 1000;
      const padAngle = padRotation * Math.PI / 180, partAngle = parts.at(-1)!.rotation! * Math.PI / 180;
      const geomShift = db.version >= 174 ? 4 : 0, offsetAt = shapeAt + (modern ? 20 : 12);
      const offsetX = layerCount ? i32(offsetAt) : 0, offsetY = layerCount ? i32(offsetAt + 4) : 0;
      let localX = i32(geometry.offset + 16 + geomShift) + offsetX * Math.cos(padAngle) - offsetY * Math.sin(padAngle);
      const localY = i32(geometry.offset + 20 + geomShift) + offsetX * Math.sin(padAngle) + offsetY * Math.cos(padAngle);
      if (side) localX = -localX;
      const origin = parts.at(-1)!.position!;
      const pin: RawPin = { part: key, number, net, x: origin.x + localX * Math.cos(partAngle) - localY * Math.sin(partAngle), y: origin.y + localX * Math.sin(partAngle) + localY * Math.cos(partAngle), side: through ? 'both' : side ? 'bottom' : 'top', rotation: parts.at(-1)!.rotation! + (side ? -1 : 1) * padRotation };
      if (w > 0 && h > 0 && shapeCode) { pin.width = w; pin.height = h; pin.radius = Math.min(w, h) / 2; pin.shape = shapeCode === 2 && w === h ? 'round' : w === h ? 'square' : 'rect'; if (![2, 5, 6].includes(shapeCode)) approximated++; }
      if (!number) pin.numberGenerated = true;
      pins.push(pin); padKey = u32(p + 20 + shift);
    }
  }
  const segments: Array<readonly [Point, Point]> = [];
  for (const shape of db.all.filter(record => record.tag === 40 || record.tag === 20)) {
    const at = shape.offset, cls = db.data[at + 2], layer = db.data[at + 3];
    if (!(cls === 1 || cls === 4) || !(layer === 0xea || layer === 0xfd)) continue;
    let next = u32(at + (shape.tag === 40 ? modern ? 40 : 32 : modern ? 24 : 20));
    const seen = new Set<number>();
    while (next && next !== shape.key) {
      if (++outlineSteps > MAX_RECORDS) fail('board-outline traversal exceeds the record limit.', 'LIMIT_EXCEEDED');
      if (seen.has(next)) fail('cycle in board-outline segments.'); seen.add(next);
      const segment = records.get(next);
      if (!segment || ![1, 21, 22, 23].includes(segment.tag)) fail('invalid board-outline segment reference.');
      if (u32(segment.offset + 12) !== shape.key) fail('board-outline segment parent disagrees with its shape.');
      const coords = segment.offset + (modern ? 28 : 24);
      segments.push([{ x: i32(coords), y: i32(coords + 4) }, { x: i32(coords + 8), y: i32(coords + 12) }]);
      if (segment.tag === 1) approximated++;
      next = u32(segment.offset + 8);
    }
  }
  if (!parts.length || !pins.length) fail('database has no placed components with pins.');
  return { parts, pins, outline: stitchOutline(segments), approximated };
}

export const parseAllegro: BoardParser = input => {
  if (!allegro(input.data)) return null;
  const db = readDatabase(input.data), raw = readBoard(db);
  return buildBoard(input, { format: 'Allegro BRD', unitsToMm: 0.0254 / db.divisor, parts: raw.parts, pins: raw.pins, outline: raw.outline,
    warnings: [note('Allegro: component bodies are estimated from placed pads. Tracks, copper fills, graphics and text are not displayed.'), ...(raw.approximated ? [note(`Allegro: ${raw.approximated} curved or custom shapes use bounding rectangles or straight chords.`)] : [])] });
};

export const allegroHook: StructureHook = {
  id: 'allegro-brd', kind: 'binary', keywords: [], steps: ['header'],
  collect(input, sink) { try { readDatabase(input.data, sink); } catch { /* A partial, content-free structure is still useful. */ } },
};
