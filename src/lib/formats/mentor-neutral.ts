/** Mentor Boardstation neutral records. Original reader of the placed COMP/C_PIN subset.
 * Field meanings were checked against independent format documentation and real exports:
 * https://github.com/AlexeyInwerp/BoardRipper/blob/main/docs/formats/MENTOR_NEUTRAL_FORMAT.md
 * No code from that project is incorporated. Pin coordinates are already absolute; pads and traces are not inferred.
 */
import type { Board, BoardSide } from '../types';
import { BoardFormatError, buildBoard, decodeText, MAX_IMPORT_BYTES, note, number, type ParseInput, type RawPart, type RawPin } from './common';
import { mentorNeutral } from './recognizers';

export const MENTOR_FORMAT = 'Mentor Neutral';
const MENTOR_ID = 'mentor-neutral';
const MAX_PARTS = 250_000, MAX_PINS = 1_000_000, MAX_LINES = 2_000_000, MAX_LINE = 1 << 20, MAX_RECORD = 65_536;
const BOARD_HEADER = /^BOARD\s+\S+\s+OFFSET\s+x:\s*[+-]?[\d.]+\s+y:\s*[+-]?[\d.]+\s+ORIENTATION\s+[+-]?[\d.]+\s*$/im;
const UNITS = new Map([['inches', 25.4], ['inch', 25.4], ['mils', .0254], ['mil', .0254], ['mm', 1]]);
interface Part extends RawPart { side: BoardSide; placed: boolean; sideMissing: boolean; pinKeys: Map<string, RawPin> }
const rawNumber = (token: string, label: string): number => number(token, `Mentor ${label}`);
const side = (token: string, fail: (message: string) => never): BoardSide => token === '1' ? 'top' : token === '2' ? 'bottom' : fail('component/pin side must be 1 (top) or 2 (bottom).');

/** Strict tokens for records consumed by this reader; opaque properties are never passed through this tokenizer. */
function fields(text: string, fail: (message: string) => never): string[] {
  if (text.length > MAX_RECORD) fail('a component or pin record exceeds 65536 characters.');
  const found: string[] = [];
  let at = 0;
  while (at < text.length) {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    if (at === text.length) break;
    const quote = text[at] === '"' || text[at] === "'" ? text[at++] : undefined;
    const start = at;
    if (quote) {
      while (at < text.length && text[at] !== quote) at++;
      if (at === text.length) fail('unterminated quoted field.');
      found.push(text.slice(start, at++));
      if (at < text.length && !/\s/.test(text[at])) fail('a quoted field must end at whitespace.');
    } else {
      while (at < text.length && !/\s/.test(text[at])) at++;
      found.push(text.slice(start, at));
    }
    if (found.length > 16) fail('too many fields in a component or pin record.');
  }
  return found;
}

export function parseMentorNeutral(input: ParseInput): Board | null {
  if (input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Mentor Neutral: input exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED', MENTOR_ID);
  const text = decodeText(input.data);
  if (!mentorNeutral(text.slice(0, 4096)) && !BOARD_HEADER.test(text.slice(0, 4096))) return null;
  const rows = text.split(/\r\n|\r|\n/);
  if (rows.length > MAX_LINES) throw new BoardFormatError('Mentor Neutral: line count exceeds the import limit.', 'LIMIT_EXCEEDED', MENTOR_ID);
  const parts: Part[] = [], pins: RawPin[] = [], byRef = new Map<string, Part>();
  let current: Part | undefined, scale: number | undefined, boardSeen = false, originMissing = 0, omitted = 0, duplicates = 0, recoveredSides = 0, opaqueNuls = 0;
  const ignored = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const fail = (message: string): never => { throw new BoardFormatError(`Mentor Neutral line ${index + 1}: ${message}`, 'INVALID_FORMAT', MENTOR_ID); };
    if (raw.length > MAX_LINE) throw new BoardFormatError('Mentor Neutral: line exceeds the import limit.', 'LIMIT_EXCEEDED', MENTOR_ID);
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const keyword = /^\S+/.exec(line)![0];
    if (!['BOARD', 'B_UNITS', 'COMP', 'C_PIN'].includes(keyword)) { if (line.includes('\0')) opaqueNuls++; if (ignored.size < 32) ignored.add(keyword.slice(0, 32)); continue; }
    if (keyword === 'BOARD') {
      const match = /^BOARD\s+\S+\s+OFFSET\s+x:\s*(\S+)\s+y:\s*(\S+)\s+ORIENTATION\s+(\S+)\s*$/.exec(line);
      if (!match || boardSeen) return fail('missing, malformed or repeated BOARD declaration.');
      if (rawNumber(match[1], 'board X offset') !== 0 || rawNumber(match[2], 'board Y offset') !== 0 || rawNumber(match[3], 'board orientation') !== 0) throw new BoardFormatError('Mentor Neutral: nonzero board offset/orientation is not validated.', 'UNSUPPORTED_VARIANT', MENTOR_ID);
      boardSeen = true; continue;
    }
    if (keyword === 'B_UNITS') {
      const f = fields(line, fail);
      if (f.length !== 2 || scale !== undefined) fail('missing, unknown or repeated B_UNITS declaration.');
      scale = UNITS.get(f[1].toLowerCase().replace(/\.$/, ''));
      if (scale === undefined) throw new BoardFormatError('Mentor Neutral: unsupported coordinate unit.', 'UNSUPPORTED_VARIANT', MENTOR_ID);
      continue;
    }
    const f = fields(line, fail);
    if (keyword === 'COMP') {
      if (f.length !== 5 && f.length !== 9) fail('COMP needs reference, part number, device and shape, followed by optional X/Y/side/rotation.');
      if (!f[1] || byRef.has(f[1])) fail('empty or duplicate component reference.');
      if (parts.length >= MAX_PARTS) throw new BoardFormatError('Mentor Neutral: component count exceeds the import limit.', 'LIMIT_EXCEEDED', MENTOR_ID);
      const placed = f.length === 9;
      const sideMissing = placed && f[7] === '\0';
      if (f.some((v, i) => v.includes('\0') && !(sideMissing && i === 7))) fail('embedded NUL in a consumed component field.');
      current = { key: String(parts.length), ref: f[1], value: f[3], package: f[4], side: placed && !sideMissing ? side(f[7], fail) : 'both', placed, sideMissing, pinKeys: new Map(), ...(placed ? { position: { x: rawNumber(f[5], 'component X'), y: rawNumber(f[6], 'component Y') }, rotation: rawNumber(f[8], 'component rotation') } : {}) };
      parts.push(current); byRef.set(current.ref!, current); continue;
    }
    if (f.length !== 9 || !current) return fail('C_PIN needs an owning COMP and identity, X/Y/layer/side/rotation/padstack/net fields.');
    if (line.includes('\0')) fail('embedded NUL in a consumed pin field.');
    const prefix = `${current.ref}-`;
    if (!f[1].startsWith(prefix) || f[1].length === prefix.length) fail('C_PIN identity does not match its owning COMP.');
    if (!/^\d{1,15}$/.test(f[4]) || !Number.isSafeInteger(Number(f[4]))) fail('invalid pin layer index.');
    const pinSide = side(f[5], fail), x = rawNumber(f[2], 'pin X'), y = rawNumber(f[3], 'pin Y');
    const rotation = rawNumber(f[6], 'pin rotation');
    if (current.sideMissing && !current.pinKeys.size) { current.side = pinSide; recoveredSides++; }
    if (current.placed && current.side !== pinSide) fail('C_PIN side conflicts with its owning COMP.');
    if (!current.placed) {
      if (!current.pinKeys.size) { current.side = pinSide; originMissing++; }
      else if (current.side !== pinSide) current.side = 'both';
    }
    const pin: RawPin = { part: current.key, number: f[1].slice(prefix.length), x, y, side: pinSide, rotation, net: f[8] === '$NONE$' ? '' : f[8], radius: 0 };
    const previous = current.pinKeys.get(pin.number);
    if (previous) {
      if (previous.x !== pin.x || previous.y !== pin.y || previous.side !== pin.side || previous.net !== pin.net || previous.rotation !== pin.rotation) fail('conflicting repeated C_PIN identity.');
      duplicates++; continue;
    }
    if (pins.length >= MAX_PINS) throw new BoardFormatError('Mentor Neutral: pin count exceeds the import limit.', 'LIMIT_EXCEEDED', MENTOR_ID);
    current.pinKeys.set(pin.number, pin); pins.push(pin);
  }
  if (!boardSeen || scale === undefined || !parts.length || !pins.length) throw new BoardFormatError('Mentor Neutral: this export lacks the validated BOARD/B_UNITS/COMP/C_PIN record set.', 'UNSUPPORTED_VARIANT', MENTOR_ID);
  if (parts.some(part => part.sideMissing && !part.pinKeys.size)) throw new BoardFormatError('Mentor Neutral: a NUL component side has no explicit pin sides from which to recover it.', 'INVALID_FORMAT', MENTOR_ID);
  const drawable = parts.filter(part => { if (part.placed || part.pinKeys.size) return true; omitted++; return false; });
  const warnings = [note('Mentor Neutral: only placed component and absolute pin records are imported. Pad dimensions, traces, vias, mechanical additions and board outline are not inferred.')];
  if (originMissing) warnings.push(note(`Mentor Neutral: ${originMissing} BOM-only components have positioned C_PIN records; their body positions are estimated from those pins.`));
  if (omitted) warnings.push(note(`Mentor Neutral: ${omitted} unplaced components without pin geometry were omitted.`));
  if (duplicates) warnings.push(note(`Mentor Neutral: ${duplicates} identical repeated C_PIN records were coalesced.`));
  if (recoveredSides) warnings.push(note(`Mentor Neutral: ${recoveredSides} component side fields contain NUL; their sides were recovered from agreeing explicit C_PIN sides.`));
  if (opaqueNuls) warnings.push(note(`Mentor Neutral: ${opaqueNuls} ancillary records contain NUL bytes; those unused records were ignored.`));
  if (ignored.size) warnings.push(note(`Mentor Neutral: ancillary records were not imported: ${[...ignored].join(', ')}.`));
  return buildBoard(input, { format: MENTOR_FORMAT, unitsToMm: scale, parts: drawable, pins, warnings });
}
