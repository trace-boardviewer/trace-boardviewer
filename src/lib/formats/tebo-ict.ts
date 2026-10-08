/** Original bounded reader for the validated Tebo-ict v3.0 BOARD / BOARD_XY export pair. */
import type { Board, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, MAX_IMPORT_BYTES, note, number, type ParseInput, type RawPart, type RawPin } from './common';

export const TEBO_ICT_FORMAT = 'Tebo ICT companion pair';
const MAGIC = '!Tebo-ict v3.0';
const DECIMAL = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const XY = new RegExp(`^(${DECIMAL})\\s*,\\s*(${DECIMAL})\\s*(;)?$`);
const PAD = new RegExp(`^(${DECIMAL})\\s*,\\s*(${DECIMAL})\\s+(\\S+)\\s+(?:(TOP)\\s+)?(NO_PROBE|MANDATORY)\\s*;$`);
const baseName = (name: string): string => name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
function reject(message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_VARIANT' | 'COMPANIONS_REQUIRED' = 'INVALID_FORMAT'): never {
  throw new BoardFormatError(`Tebo ICT: ${message}`, code, TEBO_ICT_FORMAT);
}
export function hasTeboIctHeader(data: Uint8Array): boolean {
  try { return /^\s*!Tebo-ict v3\.0(?:\r\n|\r|\n|$)/.test(decodeText(data.subarray(0, 256))); }
  catch { return false; }
}
function sourceLines(data: Uint8Array): string[] {
  if (data.length > MAX_IMPORT_BYTES) reject('input exceeds the byte limit.', 'LIMIT_EXCEEDED');
  let text: string; try { text = decodeText(data); } catch { reject('invalid text encoding.'); }
  if (text.includes('\0')) reject('binary bytes in a text export.');
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 2_000_000) reject('line count exceeds the import limit.', 'LIMIT_EXCEEDED');
  for (const line of lines) if (line.length > 32768 || line.split(/[\s,;]+/).some(field => field.length > 8192)) reject('text field exceeds the import limit.', 'LIMIT_EXCEEDED');
  const first = lines.find(line => line.trim());
  if (first?.trim() !== MAGIC) reject('unsupported export version.', 'UNSUPPORTED_VARIANT');
  return lines.map(line => line.trim()).filter(line => line && !line.startsWith('!'));
}
function identity(value: string): string {
  if (!value || /[\s,;"']/u.test(value)) reject('unsupported quoted or compound name.', 'UNSUPPORTED_VARIANT');
  return value;
}
function pinIdentity(value: string): { ref: string; pin: string } {
  const at = value.indexOf('.');
  if (at <= 0 || at === value.length - 1 || value.indexOf('.', at + 1) >= 0) reject('a pin must have one explicit Ref.Pin identity.', 'UNSUPPORTED_VARIANT');
  return { ref: identity(value.slice(0, at)), pin: identity(value.slice(at + 1)) };
}
function sameNames(a: ReadonlySet<string>, b: ReadonlySet<string>, message: string): void {
  if (a.size !== b.size || [...a].some(name => !b.has(name))) reject(message);
}
export interface TeboIctGeometry {
  outline: Point[];
  nodes: Set<string>;
  noAccess: number;
  pins: Array<Point & { identity: string; ref: string; pin: string; side: 'top' | 'bottom'; probe: 'NO_PROBE' | 'MANDATORY' }>;
  devices: Map<string, 'bottom'>;
}
export function readTeboIctGeometry(data: Uint8Array): TeboIctGeometry {
  const rows = sourceLines(data), result: TeboIctGeometry = { outline: [], nodes: new Set(), noAccess: 0, pins: [], devices: new Map() };
  let at = 0;
  if (!/^scale\s+1\s*;$/i.test(rows[at++] ?? '')) reject('only the validated scale 1 geometry variant is supported.', 'UNSUPPORTED_VARIANT');
  if (!/^units\s+inches\s*;$/i.test(rows[at++] ?? '')) reject('only explicit inch units are supported.', 'UNSUPPORTED_VARIANT');
  if (rows[at++] !== 'OUTLINE') reject('missing OUTLINE section.');
  let closed = false;
  while (at < rows.length && !closed) {
    const match = XY.exec(rows[at++]); if (!match) reject('malformed or unterminated outline.');
    if (result.outline.length >= 200_000) reject('outline point limit exceeded.', 'LIMIT_EXCEEDED');
    result.outline.push({ x: number(match[1], 'outline X'), y: number(match[2], 'outline Y') }); closed = !!match[3];
  }
  if (!closed || result.outline.length < 3) reject('a complete outline needs at least three points.');
  while (rows[at]?.startsWith('NODE ')) {
    const match = /^NODE\s+(\S+?)(?:\s+(NO_ACCESS))?\s*;$/.exec(rows[at++]); if (!match) reject('unsupported NODE declaration.', 'UNSUPPORTED_VARIANT');
    const net = identity(match[1]); if (result.nodes.has(net)) reject('duplicate NODE declaration.');
    if (result.nodes.size >= 1_000_000) reject('NODE count limit exceeded.', 'LIMIT_EXCEEDED');
    result.nodes.add(net); if (match[2]) result.noAccess++;
  }
  if (!result.nodes.size || rows[at++] !== 'OTHER' || rows[at++] !== 'ALTERNATES') reject('missing NODE declarations or OTHER ALTERNATES section.');
  const seenPins = new Set<string>();
  while (at < rows.length && rows[at] !== 'DEVICES') {
    const match = PAD.exec(rows[at++]); if (!match) reject('unsupported or incomplete physical pin record.', 'UNSUPPORTED_VARIANT');
    const id = identity(match[3]), { ref, pin } = pinIdentity(id);
    if (seenPins.has(id)) reject('duplicate physical pin identity.'); seenPins.add(id);
    if (result.pins.length >= 1_000_000) reject('pin count limit exceeded.', 'LIMIT_EXCEEDED');
    result.pins.push({ identity: id, ref, pin, x: number(match[1], 'pin X'), y: number(match[2], 'pin Y'), side: match[4] ? 'top' : 'bottom', probe: match[5] as 'NO_PROBE' | 'MANDATORY' });
  }
  if (!result.pins.length || rows[at++] !== 'DEVICES') reject('missing physical pins or DEVICES section.');
  const owners = new Set(result.pins.map(pin => pin.ref));
  if (owners.size > 250_000) reject('component count limit exceeded.', 'LIMIT_EXCEEDED');
  while (at < rows.length && rows[at] !== 'END') {
    const match = /^(\S+)\s+BOTTOM\s*;$/.exec(rows[at++]); if (!match) reject('only the validated bottom-device declarations are supported.', 'UNSUPPORTED_VARIANT');
    const ref = identity(match[1]); if (result.devices.has(ref)) reject('duplicate device declaration.');
    if (!owners.has(ref)) reject('a declared device has no physical pins.'); result.devices.set(ref, 'bottom');
  }
  if (rows[at++] !== 'END' || at !== rows.length) reject('missing final END or unexpected trailing geometry.');
  return result;
}
export interface TeboIctProgram { pinNets: Map<string, string>; nodes: Set<string> }
export function readTeboIctProgram(data: Uint8Array): TeboIctProgram {
  const rows = sourceLines(data), at = rows.indexOf('CONNECTIONS'), nodesAt = rows.indexOf('NODES', at + 1), devicesAt = rows.indexOf('DEVICES', nodesAt + 1);
  if (at < 0 || nodesAt <= at || devicesAt <= nodesAt || rows.at(-1) !== 'END') reject('missing CONNECTIONS, NODES, DEVICES or final END.');
  if (rows.indexOf('CONNECTIONS', at + 1) >= 0 || rows.indexOf('NODES', nodesAt + 1) >= 0 || rows.indexOf('DEVICES', devicesAt + 1) >= 0) reject('duplicate electrical section.');
  const result: TeboIctProgram = { pinNets: new Map(), nodes: new Set() }, groups = new Set<string>();
  let net: string | undefined, count = 0;
  for (const row of rows.slice(at + 1, nodesAt)) {
    const fields = row.match(/[^\s;]+|;/g) ?? [];
    for (const field of fields) {
      if (field === ';') {
        if (!net || !count) reject('empty connection group.'); groups.add(net); net = undefined; count = 0; continue;
      }
      if (!net) { net = identity(field); if (groups.has(net)) reject('duplicate connection net.'); continue; }
      const id = identity(field); pinIdentity(id);
      if (result.pinNets.has(id)) reject('duplicate or conflicting electrical pin identity.');
      if (result.pinNets.size >= 1_000_000) reject('connection pin count limit exceeded.', 'LIMIT_EXCEEDED');
      result.pinNets.set(id, net); count++;
    }
  }
  if (net || !result.pinNets.size) reject('unterminated or empty CONNECTIONS section.');
  for (const row of rows.slice(nodesAt + 1, devicesAt)) {
    const match = /^(\S+?)\s*;$/.exec(row); if (!match) reject('unsupported electrical NODES declaration.', 'UNSUPPORTED_VARIANT');
    const name = identity(match[1]); if (result.nodes.has(name)) reject('duplicate electrical NODE declaration.'); result.nodes.add(name);
  }
  sameNames(groups, result.nodes, 'CONNECTIONS and electrical NODES disagree.');
  return result;
}
/** Select only the known same-directory roles, rejecting conflicting case/path duplicates. */
function companion(input: ParseInput, names: readonly string[]): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  for (const [name, data] of Object.entries(input.companions ?? {})) if (names.includes(baseName(name))) {
    if (!(data instanceof Uint8Array)) reject('a companion must be a byte array.');
    if (found && (found.length !== data.length || found.some((byte, at) => byte !== data[at]))) reject('conflicting copies of a companion role.'); found = data;
  }
  return found;
}
export function parseTeboIct(input: ParseInput): Board | null {
  if (!hasTeboIctHeader(input.data)) return null;
  const rows = sourceLines(input.data), geometryRole = rows.includes('OUTLINE'), programRole = rows.includes('CONNECTIONS');
  if (geometryRole === programRole) reject('unsupported or ambiguous export role.', 'UNSUPPORTED_VARIANT');
  const other = companion(input, geometryRole ? ['board', 'board.ict'] : ['board_xy', 'board_xy.ict']);
  if (!other) reject(`both BOARD and BOARD_XY are required; missing ${geometryRole ? 'BOARD' : 'BOARD_XY'}.`, 'COMPANIONS_REQUIRED');
  if (input.data.length + other.length > MAX_IMPORT_BYTES) reject('the companion pair exceeds the byte limit.', 'LIMIT_EXCEEDED');
  const geometry = readTeboIctGeometry(geometryRole ? input.data : other), program = readTeboIctProgram(geometryRole ? other : input.data);
  sameNames(geometry.nodes, program.nodes, 'the two files declare different node sets.');
  if (geometry.pins.length !== program.pinNets.size || geometry.pins.some(pin => !program.pinNets.has(pin.identity))) reject('physical and electrical pin identities do not match completely.');
  const parts = new Map<string, RawPart>(), pins: RawPin[] = [];
  for (const pin of geometry.pins) {
    const declared = geometry.devices.get(pin.ref), part = parts.get(pin.ref);
    if (!part) parts.set(pin.ref, { key: pin.ref, ref: pin.ref, side: declared ?? pin.side });
    else if (!declared && part.side !== pin.side) part.side = 'both';
    pins.push({ part: pin.ref, number: pin.pin, x: pin.x, y: pin.y, net: program.pinNets.get(pin.identity), side: pin.side });
  }
  const noProbe = geometry.pins.filter(pin => pin.probe === 'NO_PROBE').length;
  const warnings = [note('The paired export supplies electrical pin points and an outline. Physical pad dimensions, component bodies, values, packages and copper traces are not imported.'),
    note('Explicit BOTTOM device declarations set component sides. Other component sides follow their physical pins; mixed pin sides are shown on both sides. TOP pin access is explicit; omitted TOP uses the HP3070 bottom-access convention. Coordinates remain Y-up and are not mirrored.')];
  if (noProbe || geometry.noAccess) warnings.push(note(`${noProbe} NO_PROBE pin annotations and ${geometry.noAccess} NO_ACCESS node annotations were checked. Electrical points are retained; probe availability is not modeled.`));
  const folders = input.name.split(/[\\/]/); folders.pop(); const folder = folders.pop();
  const pairedName = folder && !/^[A-Za-z]:$/.test(folder) ? `${folder}.ict` : 'board.ict';
  // A complete pair has the same visible model and name whichever role the user selects.
  return buildBoard({ ...input, name: pairedName }, { format: TEBO_ICT_FORMAT, parts: [...parts.values()], pins, outline: geometry.outline, unitsToMm: 25.4, warnings });
}
