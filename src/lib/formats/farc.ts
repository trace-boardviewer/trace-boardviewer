/* Original bounded reader for Fabmaster FARC ASCII jobs and their FAZ ZIP wrapper, MIT.
 * Reads absolute FABXYDATA pin positions rather than reconstructing or guessing footprint transforms.
 * Routing, tester settings and library text are never evaluated. The imported subset is documented in docs/FARC.md.
 */
import type { Board, BoardSide, Point } from '../types';
import { asciiPrefix, BoardFormatError, buildBoard, decodeText, MAX_IMPORT_BYTES, note, stitchOutlines, type ParseInput, type RawPart, type RawPin } from './common';
import { readZip } from './zip';
import type { StructureHook } from './structure-hook';

type Value = number | string | Value[] | { flags: Value[] };
const FORMAT = 'Fabmaster FARC', MIL = 0.0254;
const ZIP_LIMITS = { maxArchiveBytes: MAX_IMPORT_BYTES, maxEntries: 4096, maxExtractedBytes: MAX_IMPORT_BYTES, maxRatio: 250, maxCandidates: 64 };
const invalid = (message: string): never => { throw new BoardFormatError(`${FORMAT}: ${message}`, 'INVALID_FORMAT', 'farc'); };
const unsupported = (message: string): never => { throw new BoardFormatError(`${FORMAT}: ${message}`, 'UNSUPPORTED_VARIANT', 'farc'); };
const list = (value: Value | undefined): Value[] => Array.isArray(value) ? value : invalid('expected a list.');
const number = (value: Value | undefined): number => typeof value === 'number' && Number.isFinite(value) ? value : invalid('expected a finite number.');
const integer = (value: Value | undefined): number => Number.isSafeInteger(number(value)) && number(value) >= 0 ? number(value) : invalid('expected a nonnegative integer.');
const string = (value: Value | undefined): string => typeof value === 'string' ? value : invalid('expected a string.');
const flags = (value: Value | undefined): string[] => value && typeof value === 'object' && !Array.isArray(value) && 'flags' in value ? value.flags.map(string) : invalid('expected bracketed flags.');

/** Linear tokenizer with explicit depth, token and text budgets; no recursive work on unbounded nesting. */
function values(text: string): Value[] {
  let at = 0, tokens = 0;
  const space = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  function read(depth: number): Value {
    if (depth > 64 || ++tokens > 3_000_000) throw new BoardFormatError(`${FORMAT}: section token budget exceeded.`, 'LIMIT_EXCEEDED', 'farc');
    space(); const ch = text[at++];
    if (ch === '(' || ch === '[') {
      const end = ch === '(' ? ')' : ']', items: Value[] = [];
      while (true) { space(); if (text[at] === end) { at++; return ch === '(' ? items : { flags: items }; } if (at >= text.length) invalid('unterminated list.'); items.push(read(depth + 1)); }
    }
    if (ch === ')' || ch === ']') invalid('unexpected list terminator.');
    if (ch === '"') {
      let out = '';
      while (at < text.length) { const char = text[at++]; if (char === '"') return out; if (char === '\\' && text[at] === '"') { out += '"'; at++; } else out += char; }
      return invalid('unterminated string.');
    }
    const start = at - 1;
    while (at < text.length && !/[\s()\[\]"]/.test(text[at])) at++;
    const word = text.slice(start, at);
    if (!word) return invalid('empty token.');
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(word)) { const value = Number(word); if (!Number.isFinite(value)) invalid('numeric overflow.'); return value; }
    return word;
  }
  const result: Value[] = [];
  while (at < text.length) { space(); if (at < text.length) result.push(read(0)); }
  return result;
}

export const isFarc = (data: Uint8Array): boolean => /^\s*:SECTION FABMASTER \d+\r?\n/.test(asciiPrefix(data, 128));
/** Some FAZ jobs have a misleading .fz suffix. The fixed ZIP local filename is only a bounded job clue;
 * the ZIP directory, CRCs and the unique FAR member still determine whether it is a valid board. */
export function isFarcZip(data: Uint8Array): boolean {
  if (data.length < 30 || data[0] !== 0x50 || data[1] !== 0x4b || data[2] !== 3 || data[3] !== 4) return false;
  const length = data[26] | data[27] << 8;
  return length > 0 && length <= 256 && 30 + length <= data.length && /^iperror\.asc$/i.test(asciiPrefix(data.subarray(30, 30 + length), length));
}
export function farcText(input: ParseInput): string | null {
  if (input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError(`${FORMAT}: input exceeds 64 MiB.`, 'LIMIT_EXCEEDED', 'farc');
  if (isFarc(input.data)) return decodeText(input.data);
  if (!/\.faz$/i.test(input.name) && !isFarcZip(input.data)) return null;
  const entries = readZip(input.data, ZIP_LIMITS).filter(entry => !entry.skipped && /\.far$/i.test(entry.path));
  if (entries.length !== 1) return invalid('FAZ must contain exactly one FAR board.');
  const data = entries[0].read(MAX_IMPORT_BYTES);
  if (!isFarc(data)) return invalid('FAZ board does not have the FARC ASCII header.');
  return decodeText(data);
}

export function farcSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let end = 0, open: { name: string; start: number } | undefined;
  // Scan delimiters once. A repeated unterminated SECTION must not trigger a quadratic search for EOSECTION.
  for (const match of text.matchAll(/^:(?:SECTION|EOSECTION)[^\r\n]*\r?$/gm)) {
    const header = /^:SECTION ([A-Z_]+) (\d+)[ \t]*\r?$/.exec(match[0]);
    if (header) {
      if (open || text.slice(end, match.index).trim()) invalid('missing section boundary.');
      if (header[2] !== '1') unsupported('unsupported section revision.');
      if (sections.has(header[1])) invalid('duplicate section.');
      open = { name: header[1], start: match.index! + match[0].length };
    } else {
      if (!/^:EOSECTION[ \t]*\r?$/.test(match[0]) || !open) invalid('invalid section boundary.');
      sections.set(open!.name, text.slice(open!.start, match.index)); open = undefined;
      if (sections.size > 128) throw new BoardFormatError(`${FORMAT}: too many sections.`, 'LIMIT_EXCEEDED', 'farc');
    }
    end = match.index! + match[0].length;
  }
  const terminal = sections.get('EOARCHIVE');
  if (open || text.slice(end).trim() || [...sections.keys()].at(-1) !== 'EOARCHIVE' || terminal === undefined || !/^\s*\d+\s*$/.test(terminal)) invalid('missing archive terminator.');
  if (!sections.has('FABMASTER')) invalid('missing archive header.');
  return sections;
}

export function parseFarc(input: ParseInput): Board | null {
  const text = farcText(input); if (text === null) return null;
  const sections = farcSections(text);
  const section = (name: string): Value[] => values(sections.get(name) ?? invalid(`missing ${name} section.`));
  const counted = (name: string, max: number): Value[][] => {
    const data = section(name), count = integer(data[0]);
    if (count > max) throw new BoardFormatError(`${FORMAT}: ${name} count exceeds its budget.`, 'LIMIT_EXCEEDED', 'farc');
    const records = list(data[1]); if (data.length !== 2 || count !== records.length) invalid(`${name} count mismatch.`);
    return records.map(list);
  };
  const partRecords = counted('PARTS', 250_000), netRecords = counted('NETS', 1_000_000);
  const parts: RawPart[] = [], pins: RawPin[] = [], partById = new Map<number, RawPart>(), packageByPart = new Map<number, string>();
  for (const row of partRecords) {
    if (row.length !== 15) unsupported('unsupported component layout.');
    const id = integer(row[0]), ref = string(row[1]), device = list(row[2]), pkg = list(row[3]);
    if (!id || partById.has(id) || !ref) invalid('empty or repeated component identity.');
    const sideFlags = flags(row[7]); if (sideFlags.some(flag => !['BOTTOM', 'SELECTED'].includes(flag))) unsupported('unknown placement flag.');
    const side: BoardSide = sideFlags.includes('BOTTOM') ? 'bottom' : 'top';
    const deviceName = string(device[0]), separator = deviceName.indexOf('|');
    const part: RawPart = { key: String(id), ref, value: separator < 0 ? deviceName : deviceName.slice(separator + 1), package: string(pkg[0]), side, position: { x: number(row[4]), y: number(row[5]) }, rotation: number(row[6]) / 10 };
    row.slice(8).forEach(number); parts.push(part); partById.set(id, part); packageByPart.set(id, string(pkg[1]));
  }
  const nets = new Map<number, string | undefined>(), membership = new Map<string, number>();
  for (const row of netRecords) {
    if (row.length !== 6) unsupported('unsupported net layout.');
    const id = integer(row[0]), signal = integer(row[1]), netName = string(row[2]); integer(row[3]);
    if (!id || id !== signal || nets.has(id)) invalid('conflicting net identity.');
    const netFlags = flags(row[4]); if (netFlags.some(flag => flag !== 'NCPINS')) unsupported('unknown net flag.');
    nets.set(id, netFlags.includes('NCPINS') ? undefined : netName || undefined);
    for (const member of list(row[5])) {
      const pair = list(member); if (pair.length !== 2) invalid('invalid net member.');
      const key = `${integer(pair[0])}:${integer(pair[1])}`; if (membership.has(key)) invalid('a pin belongs to several nets.'); membership.set(key, id);
    }
  }
  const packages = new Map<string, Map<number, string>>();
  const packageSection = section('PACKAGE'); if (packageSection.length !== 1) invalid('invalid package section.');
  for (const raw of list(packageSection[0])) {
    const pkg = list(raw), name = string(pkg[0]).replace(/\.otl$/i, ''), pinNames = new Map<number, string>();
    if (packages.has(name) || pkg.length < 4) invalid('conflicting package identity.');
    for (const rawPin of list(pkg[3])) { const pin = list(rawPin); if (pin.length !== 5) unsupported('unsupported package pin layout.'); const id = integer(pin[0]); number(pin[1]); number(pin[2]); flags(pin[4]); if (!id || pinNames.has(id)) invalid('repeated package pin.'); pinNames.set(id, string(pin[3])); }
    packages.set(name, pinNames);
  }
  const xy = section('FABXYDATA'), declared = integer(xy[0]), counts = list(xy[1]), records = list(xy[2]);
  if (declared > 1_000_000) throw new BoardFormatError(`${FORMAT}: pin budget exceeded.`, 'LIMIT_EXCEEDED', 'farc');
  if (declared !== records.length || integer(counts[0]) !== partRecords.length || integer(counts[5]) !== netRecords.length) invalid('FABXYDATA count mismatch.');
  const seenPins = new Set<string>(), mixedSides = new Set<string>(); let sourcePins = 0, vias = 0, targets = 0, recordIndex = 0;
  for (const raw of records) {
    const row = list(raw); if (row.length !== 23) unsupported('unsupported XY record layout.');
    const x = number(row[0]), y = number(row[1]), netId = integer(row[2]), partId = integer(row[3]), pinIndex = integer(row[4]), kind = string(row[5]), id = ++recordIndex;
    // Fields 7/8 are sparse tester bookkeeping, not unique physical-pin identities; zero and repeated values are valid.
    integer(row[7]);
    integer(row[6]); integer(row[8]); const attributes = flags(row[9]); list(row[10]).forEach(number); row.slice(11, 14).forEach(integer); if (string(row[14]) !== kind) invalid('XY type disagreement.'); row.slice(15).forEach(number);
    if (kind === 'TARGET') { if (!attributes.includes('UNUSED')) unsupported('active target record.'); targets++; continue; }
    if (netId && !nets.has(netId)) invalid('XY record names an unknown net.');
    const net = nets.get(netId);
    if (/^[TBD]PIN$/.test(kind)) {
      const part = partById.get(partId) ?? invalid('missing component.'), key = `${partId}:${pinIndex}`;
      if (seenPins.has(key)) invalid('repeated pin.');
      const names = packages.get(packageByPart.get(partId)!) ?? invalid('missing package.'); if (!names.has(pinIndex)) invalid('missing package pin.');
      if ((membership.get(key) ?? 0) !== netId) invalid('NETS and FABXYDATA disagree about a pin.');
      const side: BoardSide = kind === 'TPIN' ? 'top' : kind === 'BPIN' ? 'bottom' : 'both';
      if (side !== 'both' && part.side !== side && part.side !== 'both') { part.side = 'both'; mixedSides.add(part.key); }
      const pinName = names.get(pinIndex)!; pins.push({ part: part.key, number: pinName || String(pinIndex), numberGenerated: !pinName, x, y, net, side }); seenPins.add(key); sourcePins++;
    } else if (/^[TBD]VIA$/.test(kind)) {
      if (partId || pinIndex) invalid('via points at a component.');
      const side: BoardSide = kind === 'TVIA' ? 'top' : kind === 'BVIA' ? 'bottom' : 'both', key = `via:${id}`;
      parts.push({ key, ref: `${attributes.includes('TPOINT') ? 'TP' : 'VIA'}:${id}`, refGenerated: true, side }); pins.push({ part: key, number: '1', numberGenerated: true, x, y, net, side }); vias++;
    } else unsupported('unknown XY record type.');
  }
  if (integer(counts[1]) !== sourcePins || sourcePins + vias + targets !== declared || [...membership.keys()].some(key => !seenPins.has(key))) invalid('pin membership/count mismatch.');
  const outlineValues = section('FORMAT'); if (outlineValues.length !== 1) invalid('invalid outline section.');
  const segments: Array<readonly [Point, Point]> = [];
  for (const raw of list(outlineValues[0])) {
    const primitive = list(raw); if (primitive.length !== 4 || string(primitive[0]) !== 'TRACK') unsupported('unsupported outline primitive.'); number(primitive[1]); flags(primitive[2]);
    const loop = list(primitive[3]).map(rawPoint => { const point = list(rawPoint); if (point.length !== 2) invalid('invalid outline point.'); return { x: number(point[0]), y: number(point[1]) }; });
    if (loop.length < 2) invalid('outline path has fewer than two points.');
    if (segments.length + loop.length > 1_000_000) throw new BoardFormatError(`${FORMAT}: outline budget exceeded.`, 'LIMIT_EXCEEDED', 'farc');
    for (let index = 1; index < loop.length; index++) segments.push([loop[index - 1], loop[index]]);
  }
  const stitched = stitchOutlines(segments);
  return buildBoard(input, { format: FORMAT, parts, pins, unitsToMm: MIL, outlines: stitched.loops, warnings: [note('FARC uses mil coordinates. Pins use absolute FABXYDATA positions and package pin names; pad sizes are estimated. Vias are displayed as generated one-pin components. Routing and tester settings are not imported. The legacy EOARCHIVE numeric marker is not an independently verified checksum.'), ...(mixedSides.size ? [note(`FARC: ${mixedSides.size} placements have pins on both physical sides and are visible on both sides.`)] : []), ...(stitched.openChains ? [note(`FARC: ${stitched.openChains} open outline chains were omitted; they were not closed artificially.`)] : [])] });
}

const FARC_WORDS = [':SECTION', ':EOSECTION', 'FABMASTER', 'PARTS', 'NETS', 'PACKAGE', 'FABXYDATA', 'FORMAT', 'EOARCHIVE'];
/** Counts section structure only; payload strings and coordinates never leave the hook. */
export const farcHook: StructureHook = {
  id: 'farc', kind: 'text', keywords: FARC_WORDS, steps: ['header', 'container'],
  collect(input, sink) {
    sink.units('mil', MIL); sink.padAngle('absolute');
    const ascii = isFarc(input.data), wrapped = !ascii;
    if (!ascii && !isFarcZip(input.data) && !(input.extension === '.faz' && input.data[0] === 0x50 && input.data[1] === 0x4b && input.data[2] === 3 && input.data[3] === 4)) return;
    sink.variant(wrapped ? 'farc-faz' : 'farc-ascii'); sink.reached('header');
    let text: string | null;
    try { text = farcText({ name: wrapped ? 'job.faz' : 'job.far', data: input.data }); } catch { return; }
    if (text === null) return; sink.reached('container');
    let sections: Map<string, string>; try { sections = farcSections(text); } catch { return; }
    sink.code('version', 1); sink.count('sections', sections.size);
    for (const [name, body] of sections) {
      sink.keyword(':SECTION'); sink.keyword(name); sink.section(name);
      for (const line of body.split(/\r?\n/)) sink.line(line);
      sink.keyword(':EOSECTION');
      const count = /^\s*(\d+)\s*\(/.exec(body)?.[1];
      if (count !== undefined) { if (name === 'PARTS') sink.count('declaredParts', Number(count)); else if (name === 'NETS') sink.count('declaredNets', Number(count)); else if (name === 'FABXYDATA') sink.count('declaredPins', Number(count)); }
    }
  },
};
