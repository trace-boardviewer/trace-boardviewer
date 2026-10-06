/** XZZ PCB boardview adapter, based on OpenBoardView XZZPCBFile.cpp (format decoded by inflex, MuertoGB and contributors).
 * Copyright (c) 2016 Chloridite and OpenBoardView contributors, MIT.
 *
 * Format facts: "XZZPCB" magic, optionally XOR-obfuscated with the byte at 0x10 up to the plaintext "v6v6555v6v6" marker
 * (the marker and whatever follows it stay clear). u32 LE offsets at 0x20 (block list) and 0x28 (net table) are relative
 * to 0x20; each list starts with its u32 size. Blocks are `u8 type, u32 size, payload`; component blocks (type 7) are
 * DES-ECB encrypted with the user supplied 16-hex-digit key. Coordinates are 1/10000 mil (upstream divides by 10000 to
 * reach its mil world), so one raw unit is 2.54e-6 mm; fractions are preserved here. Upstream recovers no component
 * side from the records, so every component is reported on top, with a warning. Layer-28 lines and arcs are stitched
 * into closed loops: the largest is the outline, the others are disclosed as cutouts, open chains are disclosed and not drawn.
 */
import type { Board, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, MAX_IMPORT_BYTES, note, stitchOutlines, vendorDisconnected, type FormatErrorCode, type ParseInput, type RawPart, type RawPin } from './common';
import { createDes, xzzKeyParityValid } from './crypto';

const FORMAT = 'XZZ PCB';
const UNITS_TO_MM = 2.54e-6; // 1 raw unit = 1/10000 mil = 0.0254 mm / 10000
const SCALE = 10000;         // raw units per mil; arc angles are degrees x 10000
const OUTLINE_LAYER = 28;
const MAGIC = 'XZZPCB', MARKER = 'v6v6555v6v6';
const ARC_SEGMENTS = 9;      // upstream approximates an arc with 10 points
const MAX_NETS = 1_000_000, MAX_SEGMENTS = 1_000_000, MAX_PARTS = 250_000, MAX_PINS = 1_000_000; // budgets applied while reading, before buildBoard
const HEADER_BYTES = 0x2c;   // the block-list (0x20) and net-table (0x28) offset fields end here; neither list may start inside the header
const MIN_PART_BYTES = 26 + 35; // u32 size, 18 unknown bytes, u32 group name length, then the 35-byte 0x06 label record
const MIN_CIPHER_BYTES = Math.ceil(MIN_PART_BYTES / 8) * 8; // the shortest DES-ECB ciphertext that can hold a component record

/** Binary fields are never BOM-sniffed (a name starting FF FE must not select UTF-16): UTF-8 when valid, else windows-1252. */
const utf8 = new TextDecoder('utf-8', { fatal: true }), windows1252 = new TextDecoder('windows-1252');
function field(bytes: Uint8Array): string {
  let value: string;
  try { value = utf8.decode(bytes); } catch { value = windows1252.decode(bytes); }
  // Trailing NULs only. A regular expression for this (a NUL run anchored at the end) is quadratic on a long run of NULs that is
  // followed by anything else, and a name field is as long as its record, which the file chooses.
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}

const matches = (data: Uint8Array, offset: number, text: string, xor = 0) => {
  if (offset + text.length > data.length) return false;
  for (let index = 0; index < text.length; index++) if ((data[offset + index] ^ xor) !== text.charCodeAt(index)) return false;
  return true;
};
function indexOf(data: Uint8Array, text: string): number {
  const first = text.charCodeAt(0);
  for (let index = 0; index + text.length <= data.length; index++) if (data[index] === first && matches(data, index, text)) return index;
  return -1;
}
/** Upstream normalisation: sweep the shorter way between the two angles (degrees), nine chords. */
function arcSegments(center: Point, radius: number, startDegrees: number, endDegrees: number): Array<[Point, Point]> {
  let start = Math.min(startDegrees, endDegrees);
  const end = Math.max(startDegrees, endDegrees);
  if (end - start > 180) start += 360;
  const step = (end - start) / ARC_SEGMENTS;
  const at = (degrees: number): Point => ({ x: center.x + radius * Math.cos(degrees * Math.PI / 180), y: center.y + radius * Math.sin(degrees * Math.PI / 180) });
  const segments: Array<[Point, Point]> = [];
  let previous = at(start);
  for (let index = 1; index <= ARC_SEGMENTS; index++) { const next = at(start + index * step); segments.push([previous, next]); previous = next; }
  return segments;
}

export function parseXzz(input: ParseInput): Board | null {
  const { data } = input;
  if (data.length < MAGIC.length) return null;
  const xorKey = data.length > 0x10 ? data[0x10] : 0;
  const clear = matches(data, 0, MAGIC), obfuscated = !clear && xorKey !== 0 && matches(data, 0, MAGIC, xorKey);
  if (!clear && !obfuscated) return null;
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError(`${FORMAT}: file exceeds the 64 MiB import limit.`, 'LIMIT_EXCEEDED', 'XZZPCB');
  // keyKind travels only with key errors: the UI opens its key dialog on these two codes and nothing else.
  function fail(message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never {
    throw new BoardFormatError(`${FORMAT}: ${message}`, code, 'XZZPCB', code === 'KEY_REQUIRED' || code === 'INVALID_KEY' ? 'xzz' : undefined);
  }
  let buf = data;
  if (obfuscated) {
    const marker = indexOf(data, MARKER), end = marker < 0 ? data.length : marker;
    buf = data.slice();
    for (let index = 0; index < end; index++) buf[index] ^= xorKey;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (offset: number, context = 'header') => { if (offset < 0 || offset + 4 > buf.length) fail(`truncated ${context}.`); return view.getUint32(offset, true); };
  if (buf.length < HEADER_BYTES) fail('header is truncated.');
  const mainStart = u32(0x20) + 0x20, netStart = u32(0x28) + 0x20;
  if (mainStart < HEADER_BYTES || netStart < HEADER_BYTES) fail('a list offset points into the file header.');
  const mainSize = u32(mainStart, 'block list'), netSize = u32(netStart, 'net table');
  if (netStart + 4 + netSize > buf.length) fail('net table exceeds the file.');
  if (mainStart + 4 + mainSize > buf.length) fail('block list exceeds the file.');

  const nets = new Map<number, string>();
  for (let ptr = netStart + 4, end = netStart + 4 + netSize, records = 0; ptr < end;) {
    if (ptr + 8 > end) fail('truncated net record.');
    const size = view.getUint32(ptr, true), index = view.getUint32(ptr + 4, true);
    if (size < 8 || ptr + size > end) fail('net record length is out of range.');
    if (++records > MAX_NETS) fail(`more than ${MAX_NETS} net records.`, 'LIMIT_EXCEEDED');
    const name = field(buf.subarray(ptr + 8, ptr + size)), prior = nets.get(index);
    // Pins refer to nets by number only: two different names for one id would silently rewire pins by record order.
    if (prior !== undefined && prior !== name) fail(`net id ${index} is defined twice with different names (${JSON.stringify(prior.slice(0, 40))} and ${JSON.stringify(name.slice(0, 40))}).`);
    nets.set(index, name);
    ptr += size;
  }

  const parts: RawPart[] = [], pins: RawPin[] = [], segments: Array<[Point, Point]> = [], warnings: ParseIssue[] = [];
  const unknownBlocks = new Map<number, number>();
  let unknownNets = 0, testPads = 0, disconnected = 0;
  const netName = (index: number) => {
    const name = nets.get(index);
    if (name === undefined) { unknownNets++; return undefined; }
    if (name === 'NC') return undefined; // upstream maps NC to its unconnected sentinel
    // BRDBoard.cpp gives every boardview format the same rule: a net named UNCONNECTED<n> is the exporter's "no net", never a shared electrical net (B06).
    if (vendorDisconnected(name)) { disconnected++; return undefined; }
    return name;
  };
  let des: ((block: Uint8Array) => Uint8Array) | undefined;
  const decrypt = (block: Uint8Array) => {
    if (!des) {
      const key = input.options?.xzzKey?.trim() || fail('component records are DES encrypted and require the 16-hex-digit XZZ key.', 'KEY_REQUIRED');
      if (!/^(?:0x)?[0-9a-f]{16}$/i.test(key)) fail('the XZZ key must contain exactly 16 hexadecimal digits.', 'INVALID_KEY');
      if (!xzzKeyParityValid(key)) fail('the XZZ key does not match the key parity pattern (a digit is mistyped).', 'INVALID_KEY');
      des = createDes(key);
    }
    return des(block);
  };

  /** Structural check of a (decrypted) component record; it also tells plaintext records from ciphertext. */
  const partHeader = (block: Uint8Array) => {
    if (block.length < 4) return undefined;
    const local = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const end = local.getUint32(0, true) + 4; // size excludes its own field; DES padding may follow
    if (end > block.length || end < MIN_PART_BYTES) return undefined;
    const groupLength = local.getUint32(22, true), label = 26 + groupLength; // u32 size, 18 unknown bytes, u32 group name length, group name
    if (groupLength > end || label + 35 > end || block[label] !== 0x06) return undefined;
    const nameLength = local.getUint32(label + 31, true); // 0x06 label record: type, u32 size, 26 bytes of label geometry, u32 name length, name
    if (nameLength > end || label + 35 + nameLength > end) return undefined;
    return { end, namePos: label + 35, nameLength };
  };
  const parsePart = (raw: Uint8Array) => {
    let block = raw, header = partHeader(raw);
    if (!header) {
      // DES-ECB ciphertext comes in whole 8-byte blocks and decrypts to at least the minimal record, so a block of any other
      // length is a damaged plaintext record: report that instead of asking for a key that cannot help.
      if (raw.length % 8 || raw.length < MIN_CIPHER_BYTES) fail(`component record of ${raw.length} bytes is corrupt: it is neither a readable component record nor DES ciphertext (whole 8-byte blocks, at least ${MIN_CIPHER_BYTES} bytes).`);
      block = decrypt(raw);
      header = partHeader(block) ?? fail('the key did not decrypt a valid component record; check the XZZ key.', 'INVALID_KEY');
    }
    const local = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const read = (offset: number) => local.getUint32(offset, true);
    const name = field(block.subarray(header.namePos, header.namePos + header.nameLength));
    const key = `part:${parts.length}`;
    parts.push({ key, ref: name || key, side: 'top' });
    const { end } = header;
    for (let ptr = header.namePos + header.nameLength; ptr < end;) {
      const type = block[ptr++];
      if (type === 0) continue; // alignment padding
      if (ptr + 4 > end) fail(`truncated sub-record in component ${name}.`);
      const size = read(ptr), recordEnd = ptr + 4 + size;
      if (recordEnd > end) fail(`sub-record exceeds component ${name}.`);
      if (type === 0x09) {
        // u32 size, 4 unknown, i32 x, i32 y, 8 unknown, u32 name length, name, 32 unknown, u32 net index
        if (size < 60) fail(`pin record is too short in component ${name}.`);
        const nameLength = read(ptr + 24);
        if (nameLength > size - 60) fail(`pin name exceeds its record in component ${name}.`);
        const pinName = field(block.subarray(ptr + 28, ptr + 28 + nameLength)) || String(pins.length + 1);
        if (pins.length >= MAX_PINS) fail(`more than ${MAX_PINS} pins.`, 'LIMIT_EXCEEDED');
        pins.push({ part: key, number: pinName, name: pinName, net: netName(read(ptr + 60 + nameLength)), side: 'top', x: local.getInt32(ptr + 8, true), y: local.getInt32(ptr + 12, true) });
      } else if (type !== 0x01 && type !== 0x05 && type !== 0x06) {
        fail(`unsupported component sub-record type 0x${type.toString(16).padStart(2, '0')} in ${name}.`);
      }
      ptr = recordEnd;
    }
  };
  const parseTestPad = (block: Uint8Array) => {
    // u32 pad number, i32 x, i32 y, 8 bytes (inner diameter, unknown), u32 name length, name, ..., u32 net index (last 4 bytes)
    if (block.length < 28) fail('test pad record is too short.');
    const local = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const nameLength = local.getUint32(20, true);
    if (nameLength > block.length - 28) fail('test pad name exceeds its record.');
    const name = field(block.subarray(24, 24 + nameLength)) || String(++testPads);
    const key = `pad:${parts.length}`, x = local.getInt32(4, true), y = local.getInt32(8, true);
    parts.push({ key, ref: name, package: 'TESTPAD', side: 'top', position: { x, y } });
    pins.push({ part: key, number: name, name, net: netName(local.getUint32(block.length - 4, true)), side: 'top', x, y });
  };
  const parseDrawing = (block: Uint8Array, arc: boolean) => {
    const needed = arc ? 28 : 24; // layer, then x,y,r,start,end,scale (arc) or x1,y1,x2,y2,scale (line) as 32-bit LE words
    if (block.length < needed) fail(`${arc ? 'arc' : 'line'} record is too short.`);
    const local = new DataView(block.buffer, block.byteOffset, block.byteLength);
    if (local.getUint32(0, true) !== OUTLINE_LAYER) return; // only board-edge geometry (layer 28) is used
    const word = (index: number) => local.getInt32(index * 4, true);
    if (arc) segments.push(...arcSegments({ x: word(1), y: word(2) }, local.getUint32(12, true), word(4) / SCALE, word(5) / SCALE));
    else segments.push([{ x: word(1), y: word(2) }, { x: word(3), y: word(4) }]);
    if (segments.length > MAX_SEGMENTS) fail(`more than ${MAX_SEGMENTS} outline segments.`, 'LIMIT_EXCEEDED');
  };

  for (let ptr = mainStart + 4, end = mainStart + 4 + mainSize; ptr < end;) {
    if (ptr + 5 > end) fail('truncated block header.');
    const type = buf[ptr], size = view.getUint32(ptr + 1, true);
    ptr += 5;
    if (ptr + size > end) fail(`block type 0x${type.toString(16).padStart(2, '0')} exceeds the block list.`);
    const block = buf.subarray(ptr, ptr + size);
    switch (type) {
      case 0x01: parseDrawing(block, true); break;
      case 0x05: parseDrawing(block, false); break;
      case 0x07: parsePart(block); break;
      case 0x09: parseTestPad(block); break;
      case 0x02: case 0x06: break; // vias and text carry no component, pin or outline data
      default: unknownBlocks.set(type, (unknownBlocks.get(type) ?? 0) + 1);
    }
    ptr += size;
    if (parts.length > MAX_PARTS || pins.length > MAX_PINS) fail('record count exceeds the import limit.', 'LIMIT_EXCEEDED');
  }
  if (!parts.length) fail('no component records were found.');
  // OpenBoardView keeps a component block without pin records; it carries no position here, so it is omitted and disclosed instead of rejecting the file.
  const owners = new Set(pins.map(pin => pin.part)), pinless = parts.filter(part => !owners.has(part.key)).length;
  if (pinless) parts.splice(0, parts.length, ...parts.filter(part => owners.has(part.key)));
  warnings.push({ key: 'parse.warning.formatNote', params: { message: `${FORMAT}: component side is not decoded from this format; all ${parts.length} components are shown on top, as in OpenBoardView.` } });
  // i18n: pending (same English wording as the BDV/ASC/BVR1/BRD note)
  if (pinless) warnings.push(note(`${pinless} ${pinless === 1 ? 'component' : 'components'} without pins ${pinless === 1 ? 'was' : 'were'} omitted because the file gives no position for ${pinless === 1 ? 'it' : 'them'}.`));
  if (unknownNets) warnings.push({ key: 'parse.warning.formatNote', params: { message: `${FORMAT}: ${unknownNets} pin(s) reference net indices missing from the net table and were left unconnected.` } });
  // i18n: pending (same English wording as the BRD/BDV/BVR/ASC/FZ adapters)
  if (disconnected) warnings.push(note(`${disconnected} ${disconnected === 1 ? 'pin' : 'pins'} marked UNCONNECTED by the exporter ${disconnected === 1 ? 'is' : 'are'} shown without a net.`));
  if (unknownBlocks.size) {
    const list = [...unknownBlocks].map(([type, count]) => `0x${type.toString(16).padStart(2, '0')} x${count}`).join(', ');
    warnings.push({ key: 'parse.warning.formatNote', params: { message: `${FORMAT}: skipped unrecognized block types (${list}); they may hold drawing data this viewer cannot show.` } });
  }
  // 1 mil join tolerance for chord/line endpoints. Every closed loop is passed on: buildBoard keeps the largest as the outline and discloses the rest as cutouts.
  const { loops, openChains } = stitchOutlines(segments, SCALE);
  if (openChains) warnings.push(note(`${FORMAT}: ${openChains} open outline ${openChains === 1 ? 'chain' : 'chains'} on layer ${OUTLINE_LAYER} ${openChains === 1 ? 'was' : 'were'} not closed and ${openChains === 1 ? 'is' : 'are'} not drawn.`));
  return buildBoard(input, { format: FORMAT, parts, pins, unitsToMm: UNITS_TO_MM, outlines: loops, warnings });
}
