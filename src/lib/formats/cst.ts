/** CAST binary boardview adapter, based on OpenBoardView CSTFile.cpp.
 * Copyright (c) 2016 Chloridite and OpenBoardView contributors, MIT.
 *
 * Format facts: little-endian i16 counts and byte-prefixed strings. `u16 partCount, 4 bytes, u16 4, "CDev"`, then one
 * record per component (name, 4 bytes, layer byte, 6 bytes whose last two are the net count), the net names, unknown
 * data, and a `u16 pinCount, 4 bytes, u16 4, "CPad"` section of 16-byte pin records (part, probe, net, x, y, shape, 4).
 * Coordinates are mils (int16, so at most +-832 mm). Upstream only knows layer 0x0c (top) and 0x01 (bottom); any other
 * layer code is an error here. Upstream selects CST by extension and never checks a magic; the fixed "CDev" section
 * header is the de-facto signature used here so that other content is reported as unrecognized rather than parsed by
 * position. The format carries no body geometry, pad size, outline or physical pin number: components are placed by
 * their test pads (one without any is omitted with a note) and pins are numbered by file order.
 */
import type { Board } from '../types';
import { BoardFormatError, buildBoard, MAX_IMPORT_BYTES, note, type ParseInput, type RawPart, type RawPin } from './common';

/** Binary fields are never BOM-sniffed (a name starting FF FE must not select UTF-16): UTF-8 when valid, else windows-1252. */
const utf8 = new TextDecoder('utf-8', { fatal: true }), windows1252 = new TextDecoder('windows-1252');
function field(bytes: Uint8Array): string {
  let value: string;
  try { value = utf8.decode(bytes); } catch { value = windows1252.decode(bytes); }
  return value.replace(/\0+$/, '');
}

export function parseCst(input: ParseInput): Board | null {
  const { data } = input;
  const looksLikeCst = data.length >= 12 && data[6] === 4 && data[7] === 0 && String.fromCharCode(...data.subarray(8, 12)) === 'CDev';
  if (!looksLikeCst) return null;
  const fail = (message: string): never => { throw new BoardFormatError(`CST: ${message}`, 'INVALID_FORMAT', 'CST'); };
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('CST exceeds the import limit.', 'LIMIT_EXCEEDED', 'CST');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const ensure = (count: number) => { if (!Number.isInteger(count) || count < 0 || offset + count > data.length) fail('truncated binary record.'); };
  const skip = (count: number) => { ensure(count); offset += count; };
  const byte = () => { ensure(1); return data[offset++]; };
  const short = () => { ensure(2); const result = view.getInt16(offset, true); offset += 2; return result; };
  const count = () => { const result = short(); if (result < 0) fail('negative record count.'); return result; };
  const text = (length: number) => { ensure(length); const value = field(data.subarray(offset, offset + length)); offset += length; return value; };
  const partCount = count(); // immutable: pin part ids are validated against this, never against the grown parts array
  skip(4);
  if (text(count()) !== 'CDev') fail('missing CDev section.');
  if (!partCount) fail('no component records.');
  const parts: RawPart[] = [], pins: RawPin[] = [];
  for (let index = 0; index < partCount; index++) {
    const ref = text(byte());
    if (!ref) fail('empty component name.');
    skip(4);
    const layer = byte();
    // Only the two layer codes documented by CSTFile.cpp are known; anything else is reported, never guessed.
    const side = layer === 0x0c ? 'top' : layer === 0x01 ? 'bottom' : fail(`unsupported component layer code 0x${layer.toString(16).padStart(2, '0')} for ${ref}.`);
    parts.push({ key: String(index), ref, side });
    skip(6);
  }
  offset -= 2; // The final two bytes of CDev's trailing record contain the net count.
  const netCount = count(), nets: string[] = [];
  for (let index = 0; index < netCount; index++) nets.push(text(byte()));
  // Unknown data separates the net list from the CPad section; upstream scans for the section name as well.
  let cpad = -1;
  for (let index = offset; index + 4 <= data.length; index++) {
    if (data[index] === 67 && data[index + 1] === 80 && data[index + 2] === 97 && data[index + 3] === 100) { cpad = index; break; }
  }
  if (cpad < 8 || view.getUint16(cpad - 2, true) !== 4) fail('missing CPad section.');
  offset = cpad - 8;
  const pinCount = count();
  skip(10);
  ensure(pinCount * 16);
  let orphan: RawPart | undefined;
  for (let index = 0; index < pinCount; index++) {
    const partId = short(); short(); // ICT probe number is not a physical pin number.
    const netId = short(), x = short(), y = short();
    short(); skip(4); // Shape table and trailing metadata have no known physical geometry.
    if (netId < 0 || netId >= nets.length) fail('pin references an invalid net.');
    if (partId >= partCount) fail(`pin ${index + 1} references component ${partId} but only ${partCount} are declared.`);
    if (partId < 0 && !orphan) { orphan = { key: 'orphan', ref: 'ICT', side: 'both' }; parts.push(orphan); }
    const parent = partId < 0 ? orphan! : parts[partId];
    pins.push({ part: parent.key, number: String(index + 1), net: nets[netId], side: parent.side, x, y, radius: 0 });
  }
  // A CST component is only its test pads (no body geometry, no position), so one without any cannot be drawn.
  const used = new Set(pins.map(pin => pin.part)), drawable = parts.filter(part => used.has(part.key)), omitted = parts.length - drawable.length;
  const warnings = omitted ? [note(`CST: ${omitted} ${omitted === 1 ? 'component owns' : 'components own'} no test pad and ${omitted === 1 ? 'has' : 'have'} no geometry in this format; ${omitted === 1 ? 'it is' : 'they are'} omitted.`)] : [];
  return buildBoard(input, { format: 'CST', parts: drawable, pins, unitsToMm: 0.0254, warnings });
}
