/*
 * IPC-D-356 / IPC-D-356A test-netlist adapter. Original TRACE module (MIT); the record reader and its provenance are in
 * ipc356-reader.ts.
 *
 * A bare-board test netlist lists every pad that a probe can reach: net, reference designator, pin, position, access side,
 * hole and pad size. The nets are therefore exact, the pad positions are real and the pad sizes are real, but the file has no
 * component bodies, no board outline and no pad shapes. This adapter rebuilds the components from their pads:
 *   - one component per reference designator, its pins are the records of that reference (records of one pin at one place
 *     are one pad, e.g. a through-hole record plus the surface-mount record of its top ring);
 *   - the body of a component is the bounding box of its pads (estimated geometry: the shared builder reports it as an
 *     estimated outline, and the notes say so) and the board outline is the extent of all pads;
 *   - a feature with a zero Y size is a round pad of the X size, any other size is the bounding rectangle at its rotation;
 *   - vias and tooling holes have no pin: they are counted, vias can be kept as one-pin test points on request.
 */
import type { Board, BoardSide } from '../types';
import { BoardFormatError, buildBoard, decodeText, note, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';
import { IPC356_FORMAT, readIpc356, sniffIpc356, type Ipc356Document, type Ipc356Feature } from './ipc356-reader';

export { IPC356_FORMAT, IPC356_MAX_FEATURES, IPC356_MAX_RECORD_LINE, ipc356Units, looksLikeIpc356, readIpc356, readIpc356Record, sniffIpc356 } from './ipc356-reader';
export type { Ipc356Document, Ipc356Feature, Ipc356Header, Ipc356Kind, Ipc356Limits, Ipc356Record, Ipc356Sniff, Ipc356Stats, Ipc356Tail, Ipc356Units } from './ipc356-reader';

export interface Ipc356Options {
  /** Millimetres per file unit. Replaces the UNITS record, and is required when that record is not one of CUST 0, CUST 1, SI. */
  unitsToMm?: number;
  /** Access code of the bottom side. Default: the highest access code in the file (the layer-number convention of the writers checked). */
  bottomAccess?: number;
  /** Direction of the R field. Default "clockwise": the writer checked (KiCad) stores 360 minus its own counter-clockwise pad orientation; not verified against the standard text. */
  rotation?: "clockwise" | "counterclockwise";
  /** "skip" (default): vias are counted and not shown. "points": each via becomes a one-pin test point part named VIA:<n>. */
  vias?: 'skip' | 'points';
}

/** The adapter claims bytes the sniffer is at least this sure about. */
export const IPC356_CLAIM_CONFIDENCE = 0.5;
const MAX_PARTS = 250_000, MAX_PINS = 1_000_000;
const NET_FIELD = 14, REF_FIELD = 6;

interface PinAcc { number: string; net: string; side: BoardSide; smd: boolean; x: number; y: number; xSize: number; ySize: number; rotation: number }
interface PartAcc { ref: string; pins: PinAcc[]; index: Map<string, PinAcc> }

/** File units to millimetres, rounded to a picometre so that 10000 steps of 0.0001 inch are 25.4 and not 25.400000000000002. */
type Scale = (raw: number) => number;
const scaler = (mmPerUnit: number): Scale => raw => Math.round(raw * mmPerUnit * 1e9) / 1e9;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const mergeSides = (a: BoardSide, b: BoardSide): BoardSide => a === b ? a : 'both';
const area = (pin: { xSize: number; ySize: number }) => (pin.xSize || pin.ySize) * (pin.ySize || pin.xSize);

function padGeometry(pin: PinAcc, clockwise: boolean, mm: Scale): Partial<RawPin> {
  const { xSize, ySize } = pin;
  if (xSize <= 0 && ySize <= 0) return {};
  // IPC-D-356: a zero Y size means a round feature whose diameter is the X size. Zero X with a Y size is read the same way.
  if (xSize <= 0 || ySize <= 0) { const diameter = mm(Math.max(xSize, ySize)); return { shape: 'round', radius: diameter / 2, width: diameter, height: diameter }; }
  return { shape: xSize === ySize ? 'square' : 'rect', width: mm(xSize), height: mm(ySize), radius: mm(Math.min(xSize, ySize)) / 2, rotation: clockwise ? (360 - pin.rotation) % 360 : pin.rotation };
}

/** The part's side is where its surface-mount pads are; a part with only through-hole pads is on both sides, as its pads are. */
function partSide(part: PartAcc): BoardSide {
  const smd = new Set(part.pins.filter(pin => pin.smd).map(pin => pin.side));
  const sides = smd.size ? smd : new Set(part.pins.map(pin => pin.side));
  return sides.size === 1 ? [...sides][0] : 'both';
}

export function buildIpc356Board(input: ParseInput, document: Ipc356Document, options: Ipc356Options = {}): Board {
  const { header, features, stats } = document;
  const notes: string[] = [];
  let mmPerUnit: number;
  if (options.unitsToMm !== undefined) {
    if (!(options.unitsToMm > 0) || !Number.isFinite(options.unitsToMm)) throw new BoardFormatError(`${IPC356_FORMAT}: the unit option must be a positive number of millimetres.`, 'INVALID_FORMAT', IPC356_FORMAT);
    mmPerUnit = options.unitsToMm;
  } else if (header.units) mmPerUnit = header.units.mmPerUnit;
  else if (header.unknownUnits !== undefined) {
    throw new BoardFormatError(`${IPC356_FORMAT}: the UNITS record "${header.unknownUnits.slice(0, 40)}" is not one of CUST 0 (0.0001 inch), CUST 1 or SI (0.001 mm); the unit has to be given explicitly.`, 'UNSUPPORTED_VARIANT', IPC356_FORMAT);
  } else {
    mmPerUnit = 0.00254;
    notes.push('The file has no UNITS parameter record; coordinates are read as 0.0001 inch (UNITS CUST 0), the default of the format.');
  }
  if (!features.length) throw new BoardFormatError(`${IPC356_FORMAT}: no test record was found.`, 'INVALID_FORMAT', IPC356_FORMAT);
  let maxAccess = 0;
  for (const feature of features) if (feature.access !== undefined && feature.access > maxAccess) maxAccess = feature.access;
  const mm = scaler(mmPerUnit);
  const bottom = options.bottomAccess ?? maxAccess, clockwise = options.rotation !== "counterclockwise";

  let tooling = 0, vias = 0, unnamed = 0, merged = 0, netConflicts = 0, innerAccess = 0, noAccess = 0, continuations = 0, relaxed = 0;
  const viaNets = new Set<string>(), viaFeatures: Ipc356Feature[] = [], netNames = new Set<string>(), questionNets = new Set<string>(), refNames = new Set<string>();
  const parts = new Map<string, PartAcc>();
  const sideOf = (feature: Ipc356Feature): BoardSide => {
    const access = feature.access;
    if (access === undefined) { noAccess++; return feature.kind === 'surface-mount' ? 'top' : 'both'; }
    if (access === 0) return 'both';
    if (access === 1) return 'top';
    if (access === bottom) return 'bottom';
    innerAccess++; return 'both';
  };
  for (const feature of features) {
    if (feature.continuation) continuations++;
    if (feature.relaxed) relaxed++;
    if (feature.kind === 'tooling') { tooling++; continue; }
    const net = feature.net.toUpperCase() === 'N/C' ? '' : feature.net;
    if (feature.ref.toUpperCase() === 'VIA' && !feature.pin) {
      vias++; if (net) viaNets.add(net);
      if (options.vias === 'points') viaFeatures.push({ ...feature, net });
      continue;
    }
    if (!feature.ref) { unnamed++; continue; }
    if (net.length >= NET_FIELD) netNames.add(net);
    if (net.includes('?')) questionNets.add(net);
    if (feature.ref.length >= REF_FIELD) refNames.add(feature.ref);
    let part = parts.get(feature.ref);
    if (!part) {
      if (parts.size >= MAX_PARTS) throw new BoardFormatError(`${IPC356_FORMAT}: component count exceeds the import limit.`, 'LIMIT_EXCEEDED', IPC356_FORMAT);
      part = { ref: feature.ref, pins: [], index: new Map() }; parts.set(feature.ref, part);
    }
    const side = sideOf(feature), smd = feature.kind === 'surface-mount';
    const key = `${feature.pin}\u0000${feature.x}\u0000${feature.y}`, existing = part.index.get(key);
    if (existing) {
      merged++;
      existing.side = mergeSides(existing.side, side); existing.smd ||= smd;
      if (!existing.net) existing.net = net; else if (net && net !== existing.net) netConflicts++;
      if (area(feature) > area(existing)) Object.assign(existing, { xSize: feature.xSize, ySize: feature.ySize, rotation: feature.rotation });
      continue;
    }
    if (part.pins.length >= MAX_PINS) throw new BoardFormatError(`${IPC356_FORMAT}: pin count exceeds the import limit.`, 'LIMIT_EXCEEDED', IPC356_FORMAT);
    const pin: PinAcc = { number: feature.pin, net, side, smd, x: feature.x, y: feature.y, xSize: feature.xSize, ySize: feature.ySize, rotation: feature.rotation };
    part.pins.push(pin); part.index.set(key, pin);
  }

  const rawParts: RawPart[] = [], rawPins: RawPin[] = [];
  for (const part of parts.values()) {
    const key = `part:${rawParts.length}`;
    // A pad with no pin number (a mounting pad) takes the smallest free number, flagged as made up: never an identity.
    const taken = new Set(part.pins.map(pin => pin.number).filter(Boolean));
    let next = 1;
    rawParts.push({ key, ref: part.ref, side: partSide(part) });
    for (const pin of part.pins) {
      let number = pin.number, generated = false;
      if (!number) { while (taken.has(String(next))) next++; number = String(next); taken.add(number); generated = true; }
      rawPins.push({ part: key, number, ...(generated ? { numberGenerated: true } : {}), name: number, net: pin.net, side: pin.side, x: mm(pin.x), y: mm(pin.y), ...padGeometry(pin, clockwise, mm) });
    }
  }
  viaFeatures.forEach((via, index) => {
    if (rawParts.length >= MAX_PARTS) throw new BoardFormatError(`${IPC356_FORMAT}: component count exceeds the import limit.`, 'LIMIT_EXCEEDED', IPC356_FORMAT);
    const key = `via:${index}`, side = sideOf(via);
    rawParts.push({ key, ref: `VIA:${index + 1}`, refGenerated: true, side, position: { x: mm(via.x), y: mm(via.y) } });
    const pin: PinAcc = { number: '1', net: via.net, side, smd: false, x: via.x, y: via.y, xSize: via.xSize, ySize: via.ySize, rotation: via.rotation };
    rawPins.push({ part: key, number: '1', numberGenerated: true, name: '1', net: via.net, side, x: mm(via.x), y: mm(via.y), ...padGeometry(pin, clockwise, mm) });
  });
  if (!rawParts.length) throw new BoardFormatError(`${IPC356_FORMAT}: the file holds no component pad (${plural(vias, 'via', 'vias')} and ${plural(tooling, 'tooling record', 'tooling records')} only).`, 'INVALID_FORMAT', IPC356_FORMAT);
  if (rawPins.length > MAX_PINS) throw new BoardFormatError('Board record count exceeds the import limit.', 'LIMIT_EXCEEDED', IPC356_FORMAT);

  // English format diagnostics through the formatNote catalog entry, like the other boardview adapters.
  notes.unshift('IPC-D-356 is a bare-board test netlist: nets, pad positions and pad sizes are exact, but the file has no component bodies, board outline or pad shapes. Component bodies are the boxes around their pads and the outline is the extent of all pads (estimated); a feature with no Y size is drawn round, any other as a rectangle.');
  if (tooling) notes.push(`${plural(tooling, 'tooling or mechanical hole record (367) is', 'tooling or mechanical hole records (367) are')} not shown: ${tooling === 1 ? 'it carries' : 'they carry'} no pin.`);
  if (vias && options.vias === 'points') notes.push(`${plural(vias, 'via is', 'vias are')} shown as one-pin test points named VIA:<n>; their pin numbers are made up.`);
  else if (vias) notes.push(`${plural(vias, 'via is', 'vias are')} not shown${viaNets.size ? ` (on ${plural(viaNets.size, 'net', 'nets')})` : ''}: the board model has no vias.`);
  if (unnamed) notes.push(`${plural(unnamed, 'record without a reference designator is', 'records without a reference designator are')} not shown.`);
  if (continuations) notes.push(`${plural(continuations, 'continuation record (operation code 0xx) was', 'continuation records (operation code 0xx) were')} read as ${continuations === 1 ? 'an additional pad' : 'additional pads'} of the record before ${continuations === 1 ? 'it' : 'them'}.`);
  if (stats.ignoredContinuations || stats.strayContinuations) notes.push(`${plural(stats.ignoredContinuations + stats.strayContinuations, 'continuation line was', 'continuation lines were')} ignored: ${stats.strayContinuations ? 'no record before it, or ' : ''}no readable pad.`);
  if (stats.unsupported.length) notes.push(`Records of operation code ${stats.unsupported.slice(0, 8).map(({ code, count }) => `${code} (${count})`).join(', ')}${stats.unsupported.length > 8 ? ', …' : ''} are not read.`);
  if (relaxed) notes.push(`${plural(relaxed, 'record did', 'records did')} not follow the fixed columns and ${relaxed === 1 ? 'was' : 'were'} split on blanks instead.`);
  if (merged) notes.push(`${plural(merged, 'record is', 'records are')} at the same position as another record of the same pin and ${merged === 1 ? 'was' : 'were'} merged into one pad.`);
  if (netConflicts) notes.push(`${plural(netConflicts, 'merged record names', 'merged records name')} a different net than the first; the first net is kept.`);
  if (bottom > 2) notes.push(`Access codes go up to A${String(bottom).padStart(2, '0')}: A00 is read as both sides, A01 as the top side, A${String(bottom).padStart(2, '0')} as the bottom side${innerAccess ? `, the ${plural(innerAccess, 'feature', 'features')} in between as inner (shown on both sides)` : ''}.`);
  else if (innerAccess) notes.push(`${plural(innerAccess, 'feature has', 'features have')} an access code that is neither top nor bottom and ${innerAccess === 1 ? 'is' : 'are'} shown on both sides.`);
  if (noAccess) notes.push(`${plural(noAccess, 'record has', 'records have')} no access code; surface-mount records are placed on top, through-hole records on both sides.`);
  if (netNames.size) notes.push(`${plural(netNames.size, 'net name fills', 'net names fill')} the whole ${NET_FIELD}-character net field and may have been shortened by the writing tool; nets that differ only in the cut part would be merged.`);
  if (questionNets.size) notes.push(`${plural(questionNets.size, 'net name contains', 'net names contain')} a "?": the writing tool may have put it where the name had a blank.`);
  if (refNames.size) notes.push(`${plural(refNames.size, 'reference designator fills', 'reference designators fill')} the whole ${REF_FIELD}-character field and may have been shortened by the writing tool; parts that differ only in the cut part would be merged into one.`);
  if (stats.unknownLines) notes.push(`${plural(stats.unknownLines, 'line was', 'lines were')} not recognised and ignored.`);
  if (!stats.end) notes.push('The file has no 999 end record: it may be incomplete.');

  const raw: RawBoard = { format: IPC356_FORMAT, unitsToMm: 1, parts: rawParts, pins: rawPins, warnings: notes.map(note) };
  return buildBoard(input, raw);
}

/**
 * Adapter entry, the same shape as the other adapters: null for bytes that are not an IPC-D-356 netlist, a Board for a netlist,
 * a BoardFormatError for a netlist that is malformed or over a limit.
 */
export function parseIpc356(input: ParseInput, options: Ipc356Options = {}): Board | null {
  if (sniffIpc356(input.data).confidence < IPC356_CLAIM_CONFIDENCE) return null;
  return buildIpc356Board(input, readIpc356(decodeText(input.data)), options);
}
