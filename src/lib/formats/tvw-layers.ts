/**
 * Original bounded TVW layer decoder. Record facts: MIT teboviewformat revision
 * 0dde0a73ab61af81b284b7b1478783a691bbd1a6, plus independent byte inspection of selected
 * real exports. No external reader implementation.
 * Coordinates and dimensions are disk centimils, with disk Y/X converted to Point X/Y.
 */
import type { BoardSide, Point } from '../types';
import { BoardFormatError, MAX_IMPORT_BYTES } from './common';

const COORD = 2_000_000, MAX_DEFINITIONS = 250_000, MAX_PADS = 1_000_000, MAX_VERTICES = 1_000_000;
const decoder = new TextDecoder('windows-1252');
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
interface Definition { width: number; height: number; shapeType: number; polygon?: Point[] }
interface Budget { definitions: number; pads: number; vertices: number; lines: number }
export interface TvwLayerPad extends Point {
  /** -1 is preserved as the signed no-network value; all other indices must be in the caller's net table. */
  net: number;
  dcode: number;
  side: BoardSide;
  sourceOffset: number;
  width: number;
  height: number;
  shapeType: number;
  /** Local pad geometry in Point axes, when explicitly supplied by the file. */
  bounds?: Bounds;
  polygon?: Point[];
}
export interface TvwLayer { name: string; side: 'top' | 'bottom'; sourceOffset: number; pads: TvwLayerPad[]; end: number }
/**
 * One entry of the FULL list of layer headers, in file order. A pin list refers to a layer by the zero-based index into this
 * list, so entries of every kind (aux, silk, mask, inner, ...) are counted. Only a TOP or BOTTOM entry has a decoded `layer`;
 * the body of any other kind is never interpreted.
 */
export interface TvwLayerHeader { index: number; name: string; type: number; sourceOffset: number; layer?: TvwLayer }
export interface TvwLayerResult { layers: TvwLayer[]; skippedLayers: number; headers: TvwLayerHeader[] }
/** The header type word: 1 is a TOP layer and 2 a BOTTOM layer; every other value is a kind that is counted but never read. */
export const TVW_LAYER_TOP = 1, TVW_LAYER_BOTTOM = 2;
const MAX_HEADERS = 1024, MAX_OTHER_TYPE = 255;

const invalid = (): never => { throw new BoardFormatError('TVW: incomplete or unsupported layer structure.', 'INVALID_FORMAT', 'tvw'); };
const limit = (message: string): never => { throw new BoardFormatError(`TVW: ${message}`, 'LIMIT_EXCEEDED', 'tvw'); };
class Cursor {
  readonly view: DataView;
  constructor(readonly data: Uint8Array, public at: number) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  need(bytes: number) { if (this.at + bytes > this.data.length) invalid(); }
  u8() { this.need(1); return this.data[this.at++]; }
  u32() { this.need(4); const result = this.view.getUint32(this.at, true); this.at += 4; return result; }
  i32() { this.need(4); const result = this.view.getInt32(this.at, true); this.at += 4; return result; }
  coordinate() { const value = this.i32(); if (Math.abs(value) > COORD) invalid(); return value; }
  dimension() { const value = this.coordinate(); if (value < 0) invalid(); return value; }
  point(): Point { const y = this.coordinate(), x = this.coordinate(); return { x, y }; }
  text() {
    const length = this.u8(); this.need(length);
    const bytes = this.data.subarray(this.at, this.at + length); this.at += length;
    if (bytes.some(byte => byte < 32 || byte === 127)) invalid();
    return decoder.decode(bytes);
  }
  bounds(): Bounds {
    const minY = this.coordinate(), minX = this.coordinate(), maxY = this.coordinate(), maxX = this.coordinate();
    if (minX > maxX || minY > maxY) invalid();
    return { minX, minY, maxX, maxY };
  }
}

/** Shape 5 is a count-delimited macro. Observed primitive 2 is a polygon, primitive 5 a line. */
function customDefinition(cursor: Cursor, budget: Budget): Point[] | undefined {
  if (!cursor.text()) invalid();
  const bounds = cursor.bounds(), count = cursor.u32();
  if (!count || count > 4096) invalid();
  let polygon: Point[] | undefined;
  for (let i = 0; i < count; i++) {
    const type = cursor.u32();
    if (cursor.u32() !== 1 || cursor.u32() !== 0 || cursor.u32() !== 0) invalid();
    if (type === 2) {
      const edges = cursor.u32();
      if (edges < 3 || edges > 65_536) invalid();
      budget.vertices += edges;
      if (budget.vertices > MAX_VERTICES) limit('custom geometry exceeds the vertex limit.');
      cursor.need(edges * 8);
      const points: Point[] = [];
      for (let j = 0; j < edges; j++) {
        const point = cursor.point();
        if (point.x < bounds.minX || point.x > bounds.maxX || point.y < bounds.minY || point.y > bounds.maxY) invalid();
        if (count === 1) points.push(point);
      }
      if (count === 1) polygon = points;
    } else if (type === 5) {
      cursor.point(); cursor.point(); cursor.dimension();
    } else invalid(); // The cursor for an unknown primitive is not guessed.
  }
  return polygon;
}

function definitions(cursor: Cursor, count: number, budget: Budget): Definition[] {
  if (count > MAX_DEFINITIONS) limit('D-code count exceeds the definition limit.');
  const result: Definition[] = [];
  for (let i = 0; i < count; i++) {
    if (++budget.definitions > MAX_DEFINITIONS) limit('D-code count exceeds the definition limit.');
    if (cursor.u32() !== 1) invalid();
    // A disk width measures the first coordinate axis (Y); convert the dimensions as well as the points.
    const height = cursor.dimension(), width = cursor.dimension(), shapeType = cursor.u32(), extra = cursor.u32();
    if (!width || !height) invalid();
    let polygon: Point[] | undefined;
    if (shapeType <= 3) cursor.u32();
    else if (shapeType === 5 && extra === 0) polygon = customDefinition(cursor, budget);
    else invalid();
    result.push({ width, height, shapeType, ...(polygon ? { polygon } : {}) });
  }
  if (cursor.u32() !== 1 || cursor.u32() !== 0 || cursor.u32() !== 1) invalid();
  return result;
}

function netIndex(cursor: Cursor, netCount: number): number {
  const net = cursor.i32();
  if (net < -1 || net >= netCount) invalid();
  return net;
}
function dcodeIndex(cursor: Cursor, defs: Definition[]): number {
  const dcode = cursor.u32();
  if (dcode < 10 || dcode - 10 >= defs.length) invalid();
  return dcode;
}

function readPads(cursor: Cursor, defs: Definition[], side: 'top' | 'bottom', netCount: number, budget: Budget): TvwLayerPad[] {
  const count = cursor.u32();
  if (count > MAX_PADS) limit('pad count exceeds the pin limit.');
  if (cursor.u32() !== 2) invalid();
  const pads: TvwLayerPad[] = [];
  for (let i = 0; i < count; i++) {
    if (++budget.pads > MAX_PADS) limit('pad count exceeds the pin limit.');
    const sourceOffset = cursor.at, net = netIndex(cursor, netCount), dcode = dcodeIndex(cursor, defs), point = cursor.point();
    const definition = defs[dcode - 10], flag = cursor.u8(), details = cursor.u8();
    if (flag > 1 || details > 1) invalid();
    let width = definition.width, height = definition.height, bounds: Bounds | undefined;
    if (details) {
      const extended = cursor.u8();
      if (extended > 1) invalid();
      // Some exports have three additional words before the geometry tag. Their semantics are not interpreted.
      if (extended) { cursor.i32(); cursor.i32(); cursor.i32(); }
      const geometry = cursor.u8();
      if (geometry === 1) {
        bounds = cursor.bounds(); width = bounds.maxX - bounds.minX; height = bounds.maxY - bounds.minY;
        if (!width || !height) invalid();
        const hole = cursor.u8();
        if (hole > 1) invalid();
        if (hole) { cursor.point(); cursor.dimension(); cursor.dimension(); }
      } else if (geometry === 0) {
        // Observed round geometry: fixed words [1,0], a zero byte and radii in disk Y/X order.
        if (cursor.u32() !== 1 || cursor.u32() !== 0 || cursor.u8() !== 0) invalid();
        height = cursor.dimension() * 2; width = cursor.dimension() * 2;
        if (!width || !height) invalid();
      } else invalid();
    }
    cursor.u8(); // Opaque final flag: it is not a board-side indicator.
    pads.push({ ...point, net, dcode, side, sourceOffset, width, height, shapeType: definition.shapeType,
      ...(bounds ? { bounds } : {}), ...(definition.polygon ? { polygon: definition.polygon } : {}) });
  }
  return pads;
}

/** The line-list boundary independently verifies that the last optional pad payload ended at the declared cursor. */
function checkLines(cursor: Cursor, defs: Definition[], netCount: number, budget: Budget) {
  const count = cursor.u32();
  if (count > MAX_PADS) limit('line count exceeds the record limit.');
  if (cursor.u32() !== 0) invalid();
  cursor.need(count * 24);
  for (let i = 0; i < count; i++) {
    if (++budget.lines > MAX_PADS) limit('line count exceeds the record limit.');
    netIndex(cursor, netCount); dcodeIndex(cursor, defs); cursor.point(); cursor.point();
  }
}

/**
 * Every layer header with the known 16-byte prefix is entered in `headers` in file order (the index space of the pin lists).
 * Only structurally declared top/bottom layers are decoded and returned in `layers`; one invalid record drops the entire
 * layer. A layer of any other kind is counted but its body is skipped without interpretation.
 */
export function readTvwLayers(data: Uint8Array, netCount: number): TvwLayerResult {
  if (data.length > MAX_IMPORT_BYTES) limit('file exceeds the 64 MiB import limit.');
  if (!Number.isInteger(netCount) || netCount < 1 || netCount > 100_000) invalid();
  const layers: TvwLayer[] = [], headers: TvwLayerHeader[] = [], budget: Budget = { definitions: 0, pads: 0, vertices: 0, lines: 0 };
  let skippedLayers = 0;
  for (let p = 0; p + 35 <= data.length; p++) {
    if (data[p] || data[p + 1] || data[p + 2] || data[p + 3] || ![1, 3].includes(data[p + 4]) || data[p + 5] || data[p + 6] || data[p + 7]
      || data[p + 8] !== 2 || data[p + 9] || data[p + 10] || data[p + 11] || data[p + 12] !== 1 || data[p + 13] || data[p + 14] || data[p + 15]) continue;
    const cursor = new Cursor(data, p + 16);
    let name: string, type: number, count: number, named: boolean;
    try {
      name = cursor.text(); const initial = cursor.text(); cursor.text(); type = cursor.u32();
      cursor.u32(); cursor.u32(); count = cursor.u32();
      named = Boolean(name && initial);
    } catch { continue; }
    if (!named) continue;
    if (headers.length >= MAX_HEADERS) limit('layer header count exceeds the limit.');
    if (type !== TVW_LAYER_TOP && type !== TVW_LAYER_BOTTOM) {
      // Aux, silk, mask and inner layers occupy an index of the pin lists, but their bodies are never interpreted.
      if (type <= MAX_OTHER_TYPE) headers.push({ index: headers.length, name, type, sourceOffset: p });
      continue;
    }
    if (count < 10) continue;
    const header: TvwLayerHeader = { index: headers.length, name, type, sourceOffset: p };
    headers.push(header);
    try {
      const side = type === TVW_LAYER_TOP ? 'top' : 'bottom', defs = definitions(cursor, count - 10, budget);
      const pads = readPads(cursor, defs, side, netCount, budget), end = cursor.at;
      checkLines(cursor, defs, netCount, budget);
      header.layer = { name, side, sourceOffset: p, pads, end };
      layers.push(header.layer);
      p = cursor.at - 1;
    } catch (error) {
      if (error instanceof BoardFormatError && error.code === 'LIMIT_EXCEEDED') throw error;
      skippedLayers++;
    }
  }
  return { layers, skippedLayers, headers };
}
