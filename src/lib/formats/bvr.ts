/*
 * BVR raw boardview reader (BVRAW_FORMAT_1 and BVRAW_FORMAT_3). Section and record layouts follow OpenBoardView's
 * BVRFile.cpp and BVR3File.cpp (MIT, Copyright (c) 2016 Chloridite and OpenBoardView contributors; see
 * assets/licenses/openboardview-MIT.txt). The code below is original.
 */
import type { Board, BoardSide, Point } from '../types';
import { BoardFormatError, decodeText, stitchOutlines, type ParseInput, type RawPart, type RawPin } from './common';
import { assemble, build, decimal, indexOfAscii, integer, MAX_OUTLINE_POINTS, MAX_PARTS, MAX_PINS, reject, scanSections, splitLines, Tally, type Model, type PendingPart, type Nail, type Source } from './bdv';

const BVR_FORMAT = 'BVR raw boardview';
const MIL = 0.0254;
const SIGNATURE = 'BVRAW_FORMAT_';

/** The version digits of a "BVRAW_FORMAT_<n>" line (optionally indented, after an optional UTF-8 BOM), or undefined. */
function version(data: Uint8Array): number | undefined {
  for (let at = indexOfAscii(data, SIGNATURE); at >= 0; at = indexOfAscii(data, SIGNATURE, at + 1)) {
    let back = at - 1;
    while (back >= 0 && (data[back] === 32 || data[back] === 9)) back--;
    const lineStart = back < 0 || data[back] === 10 || data[back] === 13 || back === 2 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
    let end = at + SIGNATURE.length, digits = '';
    while (end < data.length && data[end] >= 48 && data[end] <= 57 && digits.length < 9) digits += String.fromCharCode(data[end++]);
    const boundary = end >= data.length || !/[A-Za-z0-9_]/.test(String.fromCharCode(data[end]));
    if (lineStart && digits && boundary) return Number(digits);
  }
  return undefined;
}

/** `<<Layout>>`, `<<Pin>>` and `<<Nail>>` are each followed by one unused header line (BVRFile.cpp). */
const LAYOUT = '<<Layout>>', PIN = '<<Pin>>', NAIL = '<<Nail>>';
const HEADERS: ReadonlyMap<string, number> = new Map([[LAYOUT, 1], [PIN, 1], [NAIL, 1]]);

function parseBvr1(input: ParseInput, text: string): Board {
  const source: Source = { label: 'BVR1', format: `${BVR_FORMAT} (BVRAW_FORMAT_1)` };
  const tally = new Tally();
  const sections = scanSections(splitLines(text, source), source, HEADERS, tally, /^BVRAW_FORMAT_1$/);
  // `x,y` (comma, optionally followed by blanks) or `x y`.
  const outline: Point[] = (sections.get(LAYOUT) ?? []).map(({ no, text: row }) => {
    const fields = row.split(/\s*,\s*|\s+/);
    if (fields.length !== 2) reject(source, no, 'an outline point needs two coordinates.');
    return { x: decimal(source, no, fields[0], 'outline X'), y: decimal(source, no, fields[1], 'outline Y') };
  });
  if (outline.length > MAX_OUTLINE_POINTS) reject(source, undefined, 'outline point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  const pinRows = sections.get(PIN);
  if (!pinRows) reject(source, undefined, `missing ${PIN} section.`);
  // `part side id name X Y layer net [probe]`: a new component starts whenever the part name differs from the previous pin's.
  const parts: PendingPart[] = [];
  let pinCount = 0;
  for (const { no, text: row } of pinRows) {
    const fields = row.split(/\s+/);
    if (fields.length < 8 || fields.length > 9) reject(source, no, 'a pin needs part, side, id, name, X, Y, layer and net (and optionally a probe).');
    integer(source, no, fields[2], 'pin id'); integer(source, no, fields[6], 'pin layer', true);
    if (fields[8] !== undefined) integer(source, no, fields[8], 'probe');
    if (pinCount++ >= MAX_PINS) reject(source, no, 'pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const side = tally.side(fields[1]);
    let part = parts.at(-1);
    if (part?.ref !== fields[0]) {
      if (parts.length >= MAX_PARTS) reject(source, no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      part = { ref: fields[0], side, pins: [] }; parts.push(part);
    }
    part.pins.push({ number: fields[3], name: fields[3], net: tally.net(fields[7]), side, x: decimal(source, no, fields[4], 'pin X'), y: decimal(source, no, fields[5], 'pin Y') });
  }
  // `tag<TAB>X Y type grid side netId net [probe]`; the tag is not a documented probe number, so test points are numbered in file order.
  const nailRows = sections.get(NAIL) ?? [];
  if (nailRows.length > MAX_PINS) reject(source, undefined, 'test point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  const nails: Nail[] = nailRows.map(({ no, text: row }, index) => {
    const tab = row.indexOf('\t');
    if (tab < 0) reject(source, no, 'a test point needs a tab after its first field.');
    const fields = row.slice(tab + 1).trim().split(/\s+/);
    if (fields.length < 7 || fields.length > 8) reject(source, no, 'a test point needs X, Y, type, grid, side, net id and net (and optionally a probe).');
    integer(source, no, fields[2], 'test point type', true);
    if (fields[7] !== undefined) integer(source, no, fields[7], 'probe');
    return { probe: String(index + 1), x: decimal(source, no, fields[0], 'test point X'), y: decimal(source, no, fields[1], 'test point Y'), side: tally.side(fields[4]), net: tally.net(fields[6]) };
  });
  const model: Model = { outline, parts, nails };
  return assemble(input, source, model, tally);
}

const PART_SIDES: Readonly<Record<string, BoardSide>> = { T: 'top', B: 'bottom', O: 'both' };
interface Bvr3Pin { number?: string; name?: string; side?: BoardSide; origin?: Point; radius?: number; net?: string }
interface Bvr3Part { name: string; side?: BoardSide; origin?: Point; pins: Bvr3Pin[] }

function parseBvr3(input: ParseInput, text: string): Board {
  const format = `${BVR_FORMAT} (BVRAW_FORMAT_3)`;
  const source: Source = { label: 'BVR3', format };
  const tally = new Tally();
  const lines = splitLines(text, source);
  const parts: RawPart[] = [], pins: RawPin[] = [], loops: Point[][] = [], segments: Array<readonly [Point, Point]> = [];
  const ignored = new Set<string>();
  let part: Bvr3Part | undefined, pin: Bvr3Pin | undefined, outlineLines = 0, ignoredOutlines = 0, radii = 0, pointCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const row = lines[index].trim();
    if (!row) continue;
    const no = index + 1;
    const space = row.search(/\s/);
    const keyword = space < 0 ? row : row.slice(0, space);
    const args = space < 0 ? [] : row.slice(space).trim().split(/\s+/);
    const one = (): string => { if (args.length !== 1) reject(source, no, `${keyword} needs exactly one value.`); return args[0]; };
    /** Free text to the end of the line, possibly empty: kicad-boardview writes `PIN_NUMBER `, `PIN_NAME ` and `PIN_NET ` with no value for fiducials, mounting holes and unconnected pads, and net names may contain blanks. */
    const rest = (): string => space < 0 ? '' : row.slice(space).trim();
    const pair = (label: string): Point => {
      if (args.length !== 2) reject(source, no, `${keyword} needs two coordinates.`);
      return { x: decimal(source, no, args[0], `${label} X`), y: decimal(source, no, args[1], `${label} Y`) };
    };
    const side = (): BoardSide => {
      const value = one();
      if (!Object.hasOwn(PART_SIDES, value)) reject(source, no, `${keyword} must be T, B or O, not "${value.slice(0, 20)}".`);
      return PART_SIDES[value];
    };
    const inPart = (): Bvr3Part => part ?? reject(source, no, `${keyword} appears outside a PART_NAME ... PART_END block.`);
    const field = (): Bvr3Pin => { inPart(); return pin ??= {}; };
    const once = <T>(target: object, key: string, value: T): T => {
      if ((target as Record<string, unknown>)[key] !== undefined) reject(source, no, `${keyword} is given twice.`);
      return value;
    };
    switch (keyword) {
      case 'PART_NAME':
        if (part) reject(source, no, 'PART_NAME starts before the previous part reached PART_END.');
        part = { name: rest() || reject(source, no, 'PART_NAME needs a name.'), pins: [] }; // the exporter writes the raw reference; OpenBoardView would keep only its first blank-delimited word
        if (parts.length >= MAX_PARTS) reject(source, no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
        break;
      case 'PART_SIDE': { const current = inPart(); current.side = once(current, 'side', side()); break; }
      case 'PART_ORIGIN': { const current = inPart(); current.origin = once(current, 'origin', pair('part origin')); break; }
      case 'PIN_NUMBER': { const current = field(); current.number = once(current, 'number', rest()); break; }
      case 'PIN_NAME': { const current = field(); current.name = once(current, 'name', rest()); break; }
      case 'PIN_SIDE': { const current = field(); current.side = once(current, 'side', side()); break; }
      case 'PIN_NET': { const current = field(); current.net = once(current, 'net', rest()); break; }
      case 'PIN_ORIGIN': {
        const current = field();
        if (!inPart().origin) reject(source, no, 'PIN_ORIGIN appears before PART_ORIGIN; pin origins are relative to the part.');
        current.origin = once(current, 'origin', pair('pin origin')); break;
      }
      case 'PIN_RADIUS': {
        const current = field(), radius = decimal(source, no, one(), 'pin radius');
        if (radius < 0) reject(source, no, 'negative pin radius.');
        current.radius = once(current, 'radius', radius); radii++; break;
      }
      case 'PIN_END': {
        const owner = inPart();
        if (!pin?.origin) reject(source, no, 'PIN_END without a PIN_ORIGIN.');
        if (pins.length + owner.pins.length >= MAX_PINS) reject(source, no, 'pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
        owner.pins.push(pin); pin = undefined; break;
      }
      case 'PART_END': {
        const owner = inPart();
        if (pin) reject(source, no, 'PART_END while a pin has no PIN_END.');
        if (!owner.origin) reject(source, no, `part ${owner.name} has no PART_ORIGIN.`);
        const key = `part:${parts.length}`, origin = owner.origin;
        if (!owner.side) tally.defaultedSides++;
        parts.push({ key, ref: owner.name, side: owner.side ?? 'both', position: origin });
        owner.pins.forEach((item, ordinal) => {
          if (!item.side) tally.defaultedSides++;
          // A pad with neither PIN_NUMBER nor PIN_NAME (fiducial, mounting hole, unconnected pad) gets "~" and its position in the part, like the KiCad reader
          // numbers its unnumbered pads: the marker cannot be a real pin number of the part, and a board fingerprint leaves such pads out.
          const given = item.number || item.name, number = given || `~${ordinal + 1}`;
          pins.push({ part: key, number, ...(given ? {} : { numberGenerated: true }), name: item.name || number, net: tally.net(item.net ?? ''), side: item.side ?? 'both',
            x: origin.x + item.origin!.x, y: origin.y + item.origin!.y, ...item.radius === undefined ? {} : { radius: item.radius } });
        });
        part = undefined; break;
      }
      case 'OUTLINE_POINTS': {
        outlineLines++;
        if (args.length % 2) reject(source, no, 'OUTLINE_POINTS needs an even number of coordinates.');
        if ((pointCount += args.length / 2) > MAX_OUTLINE_POINTS) reject(source, no, 'outline point count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const loop: Point[] = [];
        for (let k = 0; k < args.length; k += 2) loop.push({ x: decimal(source, no, args[k], 'outline X'), y: decimal(source, no, args[k + 1], 'outline Y') });
        if (loop.length < 3) reject(source, no, 'OUTLINE_POINTS needs at least three points.');
        loops.push(loop); break;
      }
      case 'OUTLINE_SEGMENTED': {
        if (args.length % 4) reject(source, no, 'OUTLINE_SEGMENTED needs four coordinates per segment.');
        if ((pointCount += args.length / 2) > MAX_OUTLINE_POINTS) reject(source, no, 'outline point count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const value = (k: number, label: string) => decimal(source, no, args[k], label);
        for (let k = 0; k < args.length; k += 4) segments.push([{ x: value(k, 'segment X'), y: value(k + 1, 'segment Y') }, { x: value(k + 2, 'segment X'), y: value(k + 3, 'segment Y') }]);
        break;
      }
      case 'PART_MOUNT': case 'PIN_ID': case 'PIN_TYPE': case 'PIN_COMMENT': inPart(); break;
      case 'PART_OUTLINE_RELATIVE': case 'PIN_OUTLINE_RELATIVE': inPart(); ignoredOutlines++; break;
      default:
        if (keyword !== `${SIGNATURE}3`) ignored.add(keyword.slice(0, 40));
    }
  }
  if (pin) reject(source, undefined, 'the file ends inside a pin (missing PIN_END).');
  if (part) reject(source, undefined, `the file ends inside part ${part.name} (missing PART_END).`);
  const stitched = stitchOutlines(segments);
  // i18n: pending
  if (ignored.size) tally.extra.push(`Lines with unrecognized keywords were ignored: ${[...ignored].slice(0, 5).join(', ')}${ignored.size > 5 ? ', …' : ''}.`);
  if (ignoredOutlines) tally.extra.push(`${ignoredOutlines} PART_OUTLINE_RELATIVE/PIN_OUTLINE_RELATIVE ${ignoredOutlines === 1 ? 'record is' : 'records are'} not used: the reference reader does not document custom outlines.`);
  if (outlineLines > 1) tally.extra.push(`${outlineLines} OUTLINE_POINTS lines were read as separate loops; the largest is the board outline.`);
  if (stitched.openChains) tally.extra.push(`${stitched.openChains} OUTLINE_SEGMENTED ${stitched.openChains === 1 ? 'chain does' : 'chains do'} not close and ${stitched.openChains === 1 ? 'is' : 'are'} not drawn.`);
  if (radii) tally.extra.push('BVR3 PIN_RADIUS is applied as the pad radius in mil, like PIN_ORIGIN; OpenBoardView recomputes pad sizes itself, so the unit has not been verified against a vendor file.');
  if (!parts.length) reject(source, undefined, 'no PART_NAME ... PART_END block was found.');
  return build(input, source, { format, unitsToMm: MIL, parts, pins, outlines: [...loops, ...stitched.loops], warnings: tally.issues() });
}

/**
 * BVR raw boardview. The `BVRAW_FORMAT_<n>` line selects the dialect: 1 (inch, tab/blank separated sections) or
 * 3 (mil, keyword records with pad radii); any other number is recognized and refused. BVR1/BVR3 are never recognized by extension.
 */
export function parseBvr(input: ParseInput): Board | null {
  const detected = version(input.data);
  if (detected === undefined) return null;
  if (detected !== 1 && detected !== 3) throw new BoardFormatError(`BVR: BVRAW_FORMAT_${detected} is not supported; only BVRAW_FORMAT_1 and BVRAW_FORMAT_3 are documented.`, 'UNSUPPORTED_VARIANT', BVR_FORMAT);
  const text = decodeText(input.data);
  return detected === 1 ? parseBvr1(input, text) : parseBvr3(input, text);
}
