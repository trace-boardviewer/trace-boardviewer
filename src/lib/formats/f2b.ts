/* Original TRACE implementation (MIT). Unisoft F2B stores an MFC object graph.
 * Format facts were independently checked against the vendor's paired F2B/FBA
 * samples: https://www.unisoft-cim.com/view-markup_download.htm and its FBA
 * specification. No vendor implementation or input-board fragments are used.
 */
import { BoardFormatError, buildBoard, MAX_IMPORT_BYTES, note, type BoardParser, type RawPart, type RawPin } from './common';
import type { StructureHook, StructureSink } from './structure-hook';

const MAX_RECORDS = 2_000_000, MAX_STRING_BYTES = 64 * 1024;
const decoder = new TextDecoder('windows-1252');
const TRACE_CLASS = new TextEncoder().encode('CTraceList');
type Component = { kind: 'component'; id: number; ref: string; pinCount: number };
type PartNumber = { kind: 'partNumber'; id: number; name: string };
type Pin = { x: number; y: number; flags: number; number: number; net: number; component?: Component };

function fail(message: string, code: 'INVALID_FORMAT' | 'UNSUPPORTED_VARIANT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never {
  throw new BoardFormatError(`F2B: ${message}`, code, 'unisoft-f2b');
}

/** The first list's class name has a fixed, version-independent position. */
export function sniffF2b(data: Uint8Array): number | undefined {
  if (data.length < 38 || data[23] !== TRACE_CLASS.length || !TRACE_CLASS.every((byte, n) => data[24 + n] === byte)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), version = view.getUint32(0, true);
  return version > 0 && version <= 255 && view.getUint16(34, true) === 1 ? version : undefined;
}

/** Follow counts and MFC references from the start; never search payloads for replacement records. */
function readArchive(data: Uint8Array, sink?: StructureSink) {
  if (data.length > MAX_IMPORT_BYTES) fail('archive exceeds the import byte limit.', 'LIMIT_EXCEEDED');
  const version = sniffF2b(data);
  if (!version) fail('missing archive signature.');
  sink?.code('version', version);
  if (version !== 6 && version !== 8) fail('unsupported archive version; export GenCAD or a net-and-XY file from Unisoft.', 'UNSUPPORTED_VARIANT');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0, steps = 0, nextId = 1;
  const need = (length: number) => { if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length) fail('truncated or out-of-range archive record.'); };
  const advance = (length: number) => { need(length); offset += length; };
  const u16 = () => { need(2); const value = view.getUint16(offset, true); offset += 2; return value; };
  const i16 = () => { need(2); const value = view.getInt16(offset, true); offset += 2; return value; };
  const u32 = () => { need(4); const value = view.getUint32(offset, true); offset += 4; return value; };
  const block = (tag: number, start: number) => { if (++steps > MAX_RECORDS) fail('archive record count exceeds the limit.', 'LIMIT_EXCEEDED'); sink?.block(tag, offset - start, 8); };
  const text = () => {
    need(1); let length = data[offset++];
    if (length === 255) {
      length = u16();
      if (length === 65534) fail('Unicode MFC strings have an unsupported layout.', 'UNSUPPORTED_VARIANT');
      if (length === 65535) length = u32();
    }
    if (length > MAX_STRING_BYTES) fail('archive string exceeds the length limit.', 'LIMIT_EXCEEDED');
    need(length); const value = decoder.decode(data.subarray(offset, offset + length)); offset += length;
    return value;
  };
  const expectVersion = (expected: number) => { if (u16() !== expected) fail('unsupported serialized record version.', 'UNSUPPORTED_VARIANT'); };
  const expectClass = (name: string) => { if (text() !== name) fail('unexpected list class.'); };
  advance(13); need(4); const resolution = view.getFloat32(offset, true); advance(8);
  if (!(resolution > 0) || !Number.isFinite(resolution) || resolution > 1e6) fail('invalid coordinate resolution.');
  const toMm = 25.4 / resolution;
  sink?.units('user', toMm); sink?.padAngle('none'); sink?.reached('header');

  let traceCount = 0;
  for (;;) {
    const start = offset, layer = u16();
    if (layer === 0x7fff) { if (u16() !== 0) fail('invalid pin-list marker.'); break; }
    expectClass('CTraceList'); expectVersion(1);
    const count = u16(); traceCount += count;
    if (traceCount > MAX_RECORDS) fail('trace count exceeds the limit.', 'LIMIT_EXCEEDED');
    advance(count * 28); block(1, start);
  }

  const classes = new Map<number, string>(), objects = new Map<number, Component | PartNumber>();
  const components: Component[] = [], pins: Pin[] = [];
  const object = (expected: 'component' | 'partNumber'): Component | PartNumber | undefined => {
    const start = offset; let tag = u16();
    if (tag === 0x7fff) fail('extended MFC object references are unsupported.', 'UNSUPPORTED_VARIANT');
    if (tag === 0xffff) {
      const schema = u16(), length = u16();
      if (length > 64) fail('invalid runtime class name length.');
      need(length); const name = decoder.decode(data.subarray(offset, offset + length)); offset += length;
      if (schema !== 1 || !['CComponent', 'CPartNumber'].includes(name)) fail('unsupported runtime class or schema.', 'UNSUPPORTED_VARIANT');
      if (nextId >= 0x7fff) fail('MFC object map exceeds the supported reference range.', 'LIMIT_EXCEEDED');
      classes.set(nextId++, name); tag = 0x8000 | (nextId - 1);
    }
    if (!(tag & 0x8000)) {
      if (!tag) return undefined;
      const found = objects.get(tag);
      if (!found || found.kind !== expected) fail('missing or wrong-type MFC object reference.');
      return found;
    }
    const name = classes.get(tag & 0x7fff), wanted = expected === 'component' ? 'CComponent' : 'CPartNumber';
    if (name !== wanted) fail('missing or wrong-type runtime class reference.');
    if (nextId >= 0x7fff) fail('MFC object map exceeds the supported reference range.', 'LIMIT_EXCEEDED');
    const id = nextId++;
    if (expected === 'partNumber') {
      expectVersion(3); const partName = text(); text();
      const count = u32(); if (count > 250_000) fail('part-number reference count exceeds the limit.', 'LIMIT_EXCEEDED');
      need(count);
      for (let n = 0; n < count; n++) { const row = offset; text(); block(7, row); }
      advance(12); const found: PartNumber = { kind: 'partNumber', id, name: partName };
      objects.set(id, found); block(7, start); return found;
    }
    const payloadVersion = u16(), tailLength = new Map([[7, 43], [8, 47], [9, 51]]).get(payloadVersion);
    if (tailLength === undefined) fail('unsupported component payload version.', 'UNSUPPORTED_VARIANT');
    // The four bounds delimit pins, not a native component body.
    advance(8); const ref = text(); for (let n = 0; n < 5; n++) text();
    need(tailLength); const pinCount = view.getUint16(offset, true); advance(tailLength);
    const found: Component = { kind: 'component', id, ref, pinCount };
    components.push(found); objects.set(id, found); block(3, start); return found;
  };

  expectClass('CPinList'); expectVersion(1); const pinCount = u16();
  sink?.count('declaredPins', pinCount); need(pinCount * 14);
  for (let n = 0; n < pinCount; n++) {
    const start = offset; expectVersion(1);
    const x = i16(), y = i16(), flags = u16(), number = i16(), net = u16(), owner = object('component');
    pins.push({ x, y, flags, number, net, component: owner as Component | undefined }); block(2, start);
  }
  const partCount = u16(); sink?.count('declaredParts', partCount); need(partCount * 3);
  const references = new Set<number>();
  for (let n = 0; n < partCount; n++) {
    const start = offset, ref = text(), owner = object('component');
    if (!owner || owner.kind !== 'component' || owner.ref !== ref || references.has(owner.id)) fail('component dictionary references disagree.');
    references.add(owner.id); block(4, start);
  }
  if (components.some(component => !references.has(component.id))) fail('component is missing from the dictionary.');

  expectClass('NetNames'); expectVersion(1); const nameCount = u16(), names = new Map<number, string>();
  sink?.count('netRecords', nameCount); need(nameCount * 3);
  for (let n = 0; n < nameCount; n++) {
    const start = offset, key = u16(), name = text();
    if (names.has(key)) fail('duplicate name dictionary key.'); names.set(key, name); block(5, start);
  }
  const actualPins = new Map<number, number>();
  for (const pin of pins) {
    if (pin.net !== 0xffff && !names.has(pin.net)) fail('missing electrical net reference.');
    if (pin.number < 0 && !names.has(pin.number & 0xffff)) fail('missing alphabetic pin-label reference.');
    if (pin.component) actualPins.set(pin.component.id, (actualPins.get(pin.component.id) ?? 0) + 1);
  }
  if (components.some(component => component.pinCount !== (actualPins.get(component.id) ?? 0))) fail('component pin counts disagree with the pin list.');

  // Saved source/document settings have two version-6 records; their strings
  // are consumed for framing only and never returned or reported.
  const metadata = offset; text(); expectVersion(6); text(); advance(19); expectVersion(6); text(); advance(22); block(6, metadata);
  if (version === 8) {
    const count = u16(); need(count * 3);
    const partNames = new Set<string>();
    for (let n = 0; n < count; n++) {
      const start = offset, name = text(), part = object('partNumber');
      if (!part || part.kind !== 'partNumber' || part.name !== name || partNames.has(name)) fail('part-number dictionary references disagree.');
      partNames.add(name); block(7, start);
    }
    const start = offset;
    for (let n = 0; n < 2; n++) { const count = u32(); if (count > 256) fail('display setting count exceeds the limit.', 'LIMIT_EXCEEDED'); advance(count * 4); }
    u32(); block(8, start);
  }
  if (offset !== data.length) fail('unexpected bytes after the complete archive.');
  return { components, pins, names, toMm };
}

export const parseF2b: BoardParser = input => {
  if (!sniffF2b(input.data)) return null;
  const archive = readArchive(input.data), parts: RawPart[] = [], pins: RawPin[] = [];
  const sideOf = (flags: number) => {
    const code = flags & 0xfe, layer = flags >>> 8;
    if (![24, 44, 80, 164].includes(code)) fail('unsupported placed-pin flags.', 'UNSUPPORTED_VARIANT');
    const bottom = code === 44 || code === 164;
    // Saved layer identifiers, when present, must agree with the pin-side code.
    if (layer !== 0 && layer !== (bottom ? 4 : 2) && !(code === 80 && layer === 6)) fail('unsupported placed-pin layer flags.', 'UNSUPPORTED_VARIANT');
    return { side: bottom ? 'bottom' as const : 'top' as const, through: code === 80 || code === 164 };
  };
  const sides = new Map<number, 'top' | 'bottom'>();
  for (const pin of archive.pins) {
    if (!pin.component) continue; // Unowned vias are not placed component pins.
    const identity = pin.component, flags = sideOf(pin.flags), prior = sides.get(identity.id);
    if (prior && prior !== flags.side) fail('placed-pin sides disagree within a component.');
    if (!prior) {
      sides.set(identity.id, flags.side);
      parts.push({ key: String(identity.id), ref: identity.ref || `MECHANICAL-${parts.length + 1}`, ...(identity.ref ? {} : { refGenerated: true }), side: flags.side });
    }
    const number = pin.number < 0 ? archive.names.get(pin.number & 0xffff)! : String(pin.number);
    pins.push({ part: String(identity.id), x: pin.x, y: pin.y, number, net: pin.net === 0xffff ? '' : archive.names.get(pin.net)!, side: flags.through ? 'both' : flags.side, ...(number ? {} : { numberGenerated: true }) });
  }
  if (!parts.length || !pins.length) fail('archive has no placed components with pins.');
  return buildBoard(input, { format: 'Unisoft F2B', parts, pins, unitsToMm: archive.toMm,
    warnings: [note('F2B: component bodies and pad sizes are estimated from pins. Tracks, vias, native outlines, BOM values and annotations are not displayed.')] });
};

export const f2bHook: StructureHook = { id: 'unisoft-f2b', kind: 'binary', keywords: [], steps: ['header'],
  collect(input, sink) { try { readArchive(input.data, sink); } catch { /* Keep only bounded, content-free facts reached before failure. */ } },
};
