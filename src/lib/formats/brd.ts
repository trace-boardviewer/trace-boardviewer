/*
 * Format mappings adapted from OpenBoardView (MIT).
 * Copyright (c) 2016 Chloridite and OpenBoardView contributors.
 * See assets/licenses/openboardview-MIT.txt for the upstream notice.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, MAX_IMPORT_BYTES, note, number, tokens, vendorDisconnected, type ParseInput, type RawPart, type RawPin } from './common';

const MIL = 0.0254;
/** The first four bytes of an encoded file; they decode to "str_" (BRDFile.cpp:41). */
const ENCODED_HEADER = [0x23, 0xe2, 0x63, 0x28];
const LANDREX = 'Landrex / TestLink BRD', BRD2 = 'TOPTEST BRD2';
/** Maps vendor placeholders (BRDBoard.cpp:13,60,178: UNCONNECTED<n> is the exporter's "no net") to '' and counts the affected pins. */
function netFilter() {
  let count = 0;
  return {
    net: (name: string | undefined) => { if (!name) return ''; if (vendorDisconnected(name)) { count++; return ''; } return name; },
    warnings: (): ParseIssue[] => count ? [note(`${count} ${count === 1 ? 'pin' : 'pins'} marked UNCONNECTED by the exporter ${count === 1 ? 'is' : 'are'} shown without a net.`)] : [],
  };
}
/** Upper bound for any section (the largest declared count a header may carry), so a flood of rows never builds a huge array. */
const MAX_ROWS = 1_000_000;
function integer(value: string | undefined, label: string, maximum = MAX_ROWS): number {
  const result = number(value, label);
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new BoardFormatError(`Invalid ${label}.`);
  return result;
}
/** BRDFile.cpp:132 and BRD2File.cpp:159: a test point is on top only for side code 1; every other code is bottom. */
const nailSide = (value: string | undefined): BoardSide => integer(value, 'test point side') === 1 ? 'top' : 'bottom';
/** BRD2File.cpp:106-111,124-129: 1 top, 2 bottom, 0 both; the upstream reader knows no other code. */
function sideCode(value: string | undefined, label: string): BoardSide {
  const code = integer(value, label);
  if (code > 2) throw new BoardFormatError(`BRD2: unknown ${label} code ${code}.`, 'INVALID_FORMAT', BRD2);
  return code === 1 ? 'top' : code === 2 ? 'bottom' : 'both';
}
function requireCount(actual: number, expected: number | undefined, label: string, format: string) {
  if (expected === undefined || actual !== expected) throw new BoardFormatError(`${format === BRD2 ? 'BRD2' : 'BRD'}: ${label} count does not match its header.`, 'INVALID_FORMAT', format);
}
interface Nail extends Point { probe: string; side: BoardSide; net: string }
/** Every test point becomes a one-pin TP:<probe> component on its own side. */
function addNails(parts: RawPart[], pins: RawPin[], nails: Nail[]) {
  nails.forEach((nail, index) => {
    const key = `nail:${index}`;
    parts.push({ key, ref: `TP:${nail.probe}`, side: nail.side, position: { x: nail.x, y: nail.y } });
    pins.push({ part: key, number: nail.probe, name: nail.probe, net: nail.net, side: nail.side, x: nail.x, y: nail.y });
  });
}

/**
 * Landrex/TestLink BRD (plain or rotated-byte encoded) and TOPTEST BRD2 text boardviews.
 * Recognition: the encoded signature, or "str_length:" plus "var_data:" lines, or a "BRDOUT:" line; anything else is not BRD.
 */
export function parseBrd(input: ParseInput): Board | null {
  const encoded = input.data.length >= ENCODED_HEADER.length && ENCODED_HEADER.every((byte, index) => input.data[index] === byte);
  if (encoded && input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED', LANDREX);
  // BRDFile.cpp:43-50: every byte except CR, LF and NUL is rotated left by two bits and inverted.
  let text: string;
  try { text = decodeText(encoded ? input.data.map(byte => byte === 0 || byte === 10 || byte === 13 ? byte : ~((byte >>> 6) | (byte << 2)) & 0xff) : input.data); }
  catch (error) {
    if (error instanceof BoardFormatError && error.code === 'LIMIT_EXCEEDED') throw error;
    // Invalid UTF-16 behind a byte-order mark (decodeText throws a TypeError or a format error): binary content this text format does not recognize.
    if (encoded) throw new BoardFormatError('BRD: the decoded content is not valid text.', 'INVALID_FORMAT', LANDREX);
    return null;
  }
  // Horizontal whitespace only: `^\s*` would cross newlines and make a blank-line flood quadratic (minutes for a few hundred thousand lines).
  if (!encoded && /^[ \t]*BRDOUT:/m.test(text)) return parseBrd2(input, text);
  if (!encoded && !(/^[ \t]*str_length:[ \t]*$/m.test(text) && /^[ \t]*var_data:[ \t]*$/m.test(text))) return null;
  return parseLandrex(input, text);
}

function parseLandrex(input: ParseInput, text: string): Board {
  const fail = (message: string): never => { throw new BoardFormatError(`BRD: ${message}`, 'INVALID_FORMAT', LANDREX); };
  const sections = new Map<string, string[]>();
  let section = '';
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // BRDFile.cpp:60-83: the section names, including the Pins1/Pins2 aliases of Parts/Pins.
    const heading = /^(str_length|var_data|Format|format|Parts|Pins1|Pins|Pins2|Nails):$/.exec(line);
    if (heading) {
      section = heading[1];
      if (section === 'format') section = 'Format';
      if (section === 'Pins1') section = 'Parts';
      if (section === 'Pins2') section = 'Pins';
      if (sections.has(section)) fail(`duplicate ${section} section.`);
      sections.set(section, []); continue;
    }
    const rows = sections.get(section);
    if (rows) { if (rows.length >= MAX_ROWS) throw new BoardFormatError(`BRD: the ${section} section exceeds ${MAX_ROWS} rows.`, 'LIMIT_EXCEEDED', LANDREX); rows.push(line); }
  }
  const header = sections.get('var_data');
  if (header?.length !== 1) fail('missing or invalid record counts.');
  const counts = tokens(header![0]);
  if (counts.length !== 4) fail('record counts need four fields.');
  const [outlineCount, partCount, pinCount, nailCount] = counts.map((value, index) => integer(value, 'record count', index === 1 ? 250_000 : 1_000_000));
  const outline = (sections.get('Format') ?? []).map(line => {
    const fields = tokens(line);
    if (fields.length !== 2) fail('outline point needs two coordinates.');
    return { x: number(fields[0]), y: number(fields[1]) };
  });
  const ends: number[] = [];
  const parts: RawPart[] = (sections.get('Parts') ?? []).map((line, index) => {
    const fields = tokens(line);
    if (fields.length !== 3) fail('component needs name, type and pin boundary.');
    const code = integer(fields[1], 'component type', 255);
    const end = integer(fields[2], 'pin boundary', pinCount);
    if (end < (ends.at(-1) ?? 0)) fail('decreasing component pin boundary.');
    ends.push(end);
    // BRDFile.cpp:109-110: type 1 and 4-7 are top, 2 and 8+ are bottom; 0 and 3 keep the default "both".
    const side: BoardSide = code === 1 || code >= 4 && code < 8 ? 'top' : code === 2 || code >= 8 ? 'bottom' : 'both';
    return { key: `part:${index}`, ref: fields[0], side };
  });
  const filter = netFilter();
  const nails: Nail[] = (sections.get('Nails') ?? []).map(line => {
    const fields = tokens(line);
    if (fields.length !== 5) fail('test point needs five fields.');
    return { probe: String(integer(fields[0], 'probe')), x: number(fields[1]), y: number(fields[2]), side: nailSide(fields[3]), net: filter.net(fields[4]) };
  });
  const nailNets = new Map(nails.map(nail => [nail.probe, nail.net]));
  const partPinCounts = new Map<string, number>();
  const pins: RawPin[] = (sections.get('Pins') ?? []).map(line => {
    const fields = tokens(line);
    if (fields.length < 4 || fields.length > 5) fail('pin needs coordinates, probe and component.');
    const parent = integer(fields[3], 'pin component', parts.length);
    if (!parent) fail('pin component is one-based.');
    const part = parts[parent - 1];
    // The format carries no pin numbers: like upstream (BRDBoard.cpp:139-147) pins are numbered 1..n in file order per component.
    const ordinal = (partPinCounts.get(part.key) ?? 0) + 1;
    partPinCounts.set(part.key, ordinal);
    const probe = number(fields[2], 'probe'); // BRDFile.cpp:120: may be negative.
    if (!Number.isInteger(probe)) fail('probe must be an integer.');
    // BRDFile.cpp:145-152 ("Lenovo variant"): a pin without a net takes the net of the test point with the same probe number.
    const net = fields[4] ? filter.net(fields[4]) : nailNets.get(String(probe)) ?? '';
    // BRDFile.cpp:153-157: pin side is the component side.
    return { part: part.key, number: String(ordinal), net, side: part.side, x: number(fields[0]), y: number(fields[1]) };
  });
  requireCount(outline.length, outlineCount, 'outline', LANDREX); requireCount(parts.length, partCount, 'component', LANDREX);
  requireCount(pins.length, pinCount, 'pin', LANDREX); requireCount(nails.length, nailCount, 'test point', LANDREX);
  if (parts.length && ends.at(-1) !== pins.length) fail('final component pin boundary is incomplete.');
  // BRDFile.cpp keeps components without pins and BRDBoard.cpp lists them; this format gives them neither a position nor a body
  // (only pins carry coordinates), so such a component cannot be drawn. It is omitted, disclosed, and the file still opens.
  const owners = new Set(pins.map(pin => pin.part));
  const drawable = parts.filter(part => owners.has(part.key)), omitted = parts.length - drawable.length;
  addNails(drawable, pins, nails);
  // i18n: pending (same English wording as the BDV/ASC/BVR1 note for pinless components)
  const warnings = filter.warnings();
  if (omitted) warnings.push(note(`${omitted} ${omitted === 1 ? 'component' : 'components'} without pins ${omitted === 1 ? 'was' : 'were'} omitted because the file gives no position for ${omitted === 1 ? 'it' : 'them'}.`));
  return buildBoard(input, { format: LANDREX, unitsToMm: MIL, parts: drawable, pins, outline, warnings });
}

function parseBrd2(input: ParseInput, text: string): Board {
  const fail = (message: string): never => { throw new BoardFormatError(`BRD2: ${message}`, 'INVALID_FORMAT', BRD2); };
  const rows = new Map<string, string[]>();
  const counts = new Map<string, number>();
  let section = '', width = 0, height = 0;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim(); if (!line) continue;
    const heading = /^(BRDOUT|NETS|PARTS|PINS|NAILS):\s*(.*)$/.exec(line);
    if (heading) {
      section = heading[1];
      if (rows.has(section)) fail(`duplicate ${section} section.`);
      const fields = tokens(heading[2]);
      if (fields.length !== (section === 'BRDOUT' ? 3 : 1)) fail(`invalid ${section} header.`);
      counts.set(section, integer(fields[0], 'record count', section === 'PARTS' ? 250_000 : 1_000_000));
      if (section === 'BRDOUT') { width = number(fields[1], 'board width'); height = number(fields[2], 'board height'); }
      rows.set(section, []); continue;
    }
    const list = rows.get(section);
    if (list) { if (list.length >= (counts.get(section) ?? 0)) fail(`${section} count does not match its header.`); list.push(line); }
  }
  for (const required of ['BRDOUT', 'NETS', 'PARTS', 'PINS']) if (!rows.has(required)) fail(`missing ${required} section.`);
  for (const [name, values] of rows) requireCount(values.length, counts.get(name), name, BRD2);
  const outline = rows.get('BRDOUT')!.map(line => {
    const f = tokens(line); if (f.length !== 2) fail('invalid outline point.');
    const point = { x: number(f[0]), y: number(f[1]) };
    if (point.x > width || point.y > height) fail('outline point lies outside the declared board size.'); // BRD2File.cpp:83-84
    return point;
  });
  const nets = new Map<number, string>();
  for (const line of rows.get('NETS')!) {
    const f = tokens(line); if (f.length !== 2) fail('invalid net record.');
    const id = integer(f[0], 'net id', Number.MAX_SAFE_INTEGER);
    if (nets.has(id)) fail('duplicate net id.');
    nets.set(id, f[1]);
  }
  const filter = netFilter();
  let dangling = 0;
  const netOf = (value: string | undefined) => {
    const name = nets.get(integer(value, 'net id', Number.MAX_SAFE_INTEGER));
    if (name === undefined) dangling++; // BRD2File.cpp:131-135,151-157: unknown ids are tolerated as "no net".
    return filter.net(name);
  };
  const pinRows = rows.get('PINS')!;
  const starts: number[] = [];
  const parts: RawPart[] = rows.get('PARTS')!.map((line, index) => {
    const f = tokens(line); if (f.length !== 7) fail('component needs seven fields.');
    const side = sideCode(f[6], 'component side');
    let y1 = number(f[2]), y2 = number(f[4]);
    if (side === 'bottom') { y1 = height - y1; y2 = height - y2; } // BRD2File.cpp:190-193: only bottom bodies are mirrored.
    const x1 = number(f[1]), x2 = number(f[3]);
    // BRD2File.cpp:103,195-199: the sixth field is the 0-based index of the component's first pin; the next component's index ends the range.
    const start = integer(f[5], 'component pin start', pinRows.length);
    if (index === 0 ? start !== 0 : start < starts[index - 1]) fail('component pin ranges must start at 0 and never decrease.');
    starts.push(start);
    return { key: `part:${index}`, ref: f[0], side, bounds: { minX: Math.min(x1, x2), maxX: Math.max(x1, x2), minY: Math.min(y1, y2), maxY: Math.max(y1, y2) } };
  });
  const pins: RawPin[] = [];
  for (let index = 0; index < parts.length; index++) {
    const end = starts[index + 1] ?? pinRows.length;
    let sameSide = false;
    for (let pinIndex = starts[index]; pinIndex < end; pinIndex++) {
      const f = tokens(pinRows[pinIndex]); if (f.length !== 4) fail('pin needs four fields.');
      const side = sideCode(f[3], 'pin side'); const y = number(f[1]);
      sameSide ||= side !== 'both' && side === parts[index].side;
      // BRD2File.cpp:203: every pin that is not on top (bottom and "both") is mirrored by the board height.
      pins.push({ part: parts[index].key, number: String(pinIndex - starts[index] + 1), side, x: number(f[0]), y: side === 'top' ? y : height - y, net: netOf(f[2]) });
    }
    // BRD2File.cpp:204-215: a component with pins but none on its own side is through-hole and visible from both sides.
    // Upstream also flips components without pins to "both"; their declared side is kept here because nothing contradicts it.
    if (end > starts[index] && !sameSide) parts[index].side = 'both';
  }
  if (pins.length !== pinRows.length) fail('unassigned pins.');
  const nails: Nail[] = (rows.get('NAILS') ?? []).map(line => {
    const f = tokens(line); if (f.length !== 5) fail('test point needs five fields.');
    const side = nailSide(f[4]); const y = number(f[2]);
    return { probe: String(integer(f[0], 'probe')), x: number(f[1]), y: side === 'top' ? y : height - y, side, net: netOf(f[3]) }; // BRD2File.cpp:159-165
  });
  addNails(parts, pins, nails);
  const warnings = filter.warnings();
  if (dangling) warnings.push(note(`${dangling} ${dangling === 1 ? 'record references' : 'records reference'} an undefined net id and ${dangling === 1 ? 'is' : 'are'} shown without a net.`));
  return buildBoard(input, { format: BRD2, unitsToMm: MIL, parts, pins, outline, warnings });
}
