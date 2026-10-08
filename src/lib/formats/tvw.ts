/**
 * Original TVW reader. Record facts: the MIT teboviewformat document, revision
 * 0dde0a73ab61af81b284b7b1478783a691bbd1a6 (see docs/TVW.md and the license notice).
 * Component framing and UID-to-layer-pad links were checked by byte inspection of real exports.
 * No external TVW implementation is linked or translated.
 */
import type { Board } from '../types';
import { BoardFormatError, buildBoard, MAX_IMPORT_BYTES, type ParseInput, type RawPin } from './common';
import { readTvwLayers, type TvwLayer, type TvwLayerResult } from './tvw-layers';
import { readTvwComponents } from './tvw-components';

const FORMAT = 'TVW boardview', SCALE = 0.000254;
const MAX_NETS = 100_000;
const decoder = new TextDecoder('windows-1252');
interface TextField { value: string; end: number }
interface NetTable { names: string[]; start: number; end: number }
const fail = (message: string, limit = false, unsupported = false): never => {
  throw new BoardFormatError(`${FORMAT}: ${message}`, limit ? 'LIMIT_EXCEEDED' : unsupported ? 'UNSUPPORTED_VARIANT' : 'INVALID_FORMAT', 'tvw');
};

class Bytes {
  readonly view: DataView;
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  u32(offset: number): number { return this.view.getUint32(offset, true); }
  i32(offset: number): number { return this.view.getInt32(offset, true); }
  text(offset: number, allowEmpty = false): TextField | undefined {
    const length = this.data[offset];
    if (length === undefined || !length && !allowEmpty || offset + 1 + length > this.data.length) return undefined;
    const bytes = this.data.subarray(offset + 1, offset + 1 + length);
    if (bytes.some(byte => byte < 32 || byte === 127)) return undefined;
    return { value: decoder.decode(bytes), end: offset + 1 + length };
  }
}

/** Established one-byte endings retained for compact table framing. Full registries declare a size and pack count. */
const CLOSING_TAGS: readonly number[] = [0x23, 0x17];
/** The fixed prefix the table has on most exports: the words 7 and 4 sit 56 and 44 bytes before the first count. */
const PREFIX = 69;
/** Every successfully read net name counts; failed attempts are cheap and bounded by the file size. */
interface NameBudget { names: number; exhausted: boolean }

/**
 * A net table is the count twice, that many Pascal names, a probe-registry origin,
 * kind 4, a Pascal registry name, a positive probe size and a bounded pack count.
 * Compact framing retains the established zero origin / ProbeDB / one-byte ending.
 * Duplicate counts and the complete registry framing identify the table.
 */
function tableAt(bytes: Bytes, q: number, budget: NameBudget, start: number): NetTable | undefined {
  const { data } = bytes;
  if (q + 9 >= data.length) return undefined;
  const count = bytes.u32(q);
  if (count > MAX_NETS || bytes.u32(q + 4) !== count) return undefined;
  let p = q + 8;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const field = bytes.text(p, true);
    if (!field) return undefined;
    if (++budget.names > MAX_NETS * 4) { budget.exhausted = true; return undefined; }
    names.push(field.value); p = field.end;
  }
  if (p + 21 > data.length) return undefined;
  if (Math.abs(bytes.i32(p)) > 2_000_000 || Math.abs(bytes.i32(p + 4)) > 2_000_000 || bytes.u32(p + 8) !== 4) return undefined;
  const probe = bytes.text(p + 12);
  if (!probe) return undefined;
  // ProbeDB is followed by a physical probe size and a pack count, not a
  // constant closing tag. Validate that full header when it is available.
  if (probe.end + 8 <= data.length) {
    const size = bytes.u32(probe.end), packs = bytes.u32(probe.end + 4);
    if (size > 0 && size <= 2_000_000 && packs > 0 && packs <= 4096) return { names, start, end: probe.end + 8 };
  }
  // Retain the established minimal table framing used by compact exports.
  if (bytes.u32(p) !== 0 || bytes.u32(p + 4) !== 0 || probe.value !== 'ProbeDB' || !CLOSING_TAGS.includes(data[probe.end])) return undefined;
  if (probe.end + 4 <= data.length && bytes.u32(probe.end) !== data[probe.end]) return undefined;
  return { names, start, end: p + 21 };
}

/**
 * Finds the table by its validated structure. The usual 69-byte prefix is checked first (the words 7 and 4 at fixed
 * distances from the count); an export whose prefix differs is found by the same validated body without that
 * assumption. Everything before the first count is then the layer region, so the prefix length does not matter.
 */
function netTable(bytes: Bytes): NetTable | undefined {
  const { data } = bytes;
  const budget: NameBudget = { names: 0, exhausted: false };
  for (let q = PREFIX; q + 9 < data.length; q++) {
    if (data[q - 56] !== 7 || data[q - 44] !== 4 || bytes.u32(q - 56) !== 7 || bytes.u32(q - 44) !== 4) continue;
    const table = tableAt(bytes, q, budget, q - PREFIX);
    if (table) return table;
    if (budget.exhausted) return undefined;
  }
  for (let q = 0; q + 9 < data.length; q++) {
    const table = tableAt(bytes, q, budget, q);
    if (table) return table;
    if (budget.exhausted) return undefined;
  }
  return undefined;
}

/** Used only on the bounded sniff window. There is no fixed magic at byte zero. */
export function hasTvwNetTable(head: Uint8Array): boolean { return Boolean(netTable(new Bytes(head))); }

/** AppleDouble (RFC 1740) companion files, written next to a file as "._name", start with the magic 0x00051607 and a version word. */
export function isAppleDouble(data: Uint8Array): boolean {
  if (data.length < 8 || data[0] !== 0 || data[1] !== 5 || data[2] !== 0x16 || data[3] !== 7) return false;
  return data[4] === 0 && (data[5] === 1 || data[5] === 2) && data[6] === 0 && data[7] === 0;
}

/** Layer numbers 2 (TOP) and 5 or 7 (BOTTOM) were established first; they stay valid when the header list cannot resolve them. */
const LEGACY_TOP = 2, LEGACY_BOTTOM = [5, 7];
/**
 * A pin list names its layer by the zero-based index into the full list of layer headers; the header's type decides the side.
 * A number that selects an aux, silk, mask or inner layer is never treated as TOP or BOTTOM. Only the first established
 * numbers (2, 5, 7) fall back to the single TOP or BOTTOM layer when the detected list does not settle them.
 */
function layerFor(kind: number, layers: TvwLayerResult): TvwLayer {
  const header = layers.headers[kind];
  if (header?.layer) return header.layer;
  const top = layers.layers.filter(layer => layer.side === 'top'), bottom = layers.layers.filter(layer => layer.side === 'bottom');
  const legacy = kind === LEGACY_TOP ? top : LEGACY_BOTTOM.includes(kind) ? bottom : undefined;
  if (!header && legacy?.length === 1) return legacy[0];
  if (header) fail(`a pin list refers to layer ${kind} ("${header.name.slice(0, 40)}", type ${header.type}), which is not a top or bottom layer; this export variant is not supported.`, false, true);
  return fail(`a pin list refers to layer ${kind}, but only ${layers.headers.length} layer ${layers.headers.length === 1 ? 'header was' : 'headers were'} found; this export variant is not supported.`, false, true);
}

export function parseTvw(input: ParseInput): Board | null {
  if (input.data.length > MAX_IMPORT_BYTES) fail('file exceeds the import limit.', true);
  if (isAppleDouble(input.data)) fail('this is an AppleDouble companion file (a "._" resource-fork stub written by macOS next to the real file), not a boardview.');
  if (input.data.length < 100) return null;
  const bytes = new Bytes(input.data), table = netTable(bytes);
  if (!table) return null;
  const layers = readTvwLayers(input.data.subarray(0, table.start), table.names.length);
  if (layers.skippedLayers) fail('physical layer tables are incomplete or unsupported.');
  if (!layers.layers.length) fail('no top or bottom layer header with a known prefix was found before the net table; this export uses a layer-header variant that is not supported.', false, true);
  // A pin list may name any top or bottom header of the full list, plus the first established numbers.
  const references = new Set<number>([LEGACY_TOP, ...LEGACY_BOTTOM].filter(index => !layers.headers[index]));
  for (const header of layers.headers) if (header.layer) references.add(header.index);
  const components = readTvwComponents(input.data, table.end, kind => references.has(kind)), parts = components.parts;
  const pins: RawPin[] = [];
  for (const part of parts) {
    // Each pin group's layer reference selects its own physical-pad namespace.
    // UID is eight times the pad ordinal. This explicit link preserves pin labels even when master order is reversed
    // or a symmetric bottom footprint swaps the labels under a mirror.
    if (!part.pins.length) continue;
    const sides = new Set<'top' | 'bottom'>();
    for (const group of part.pinGroups) {
      const layer = layerFor(group.kind, layers), side = layer.side;
      sides.add(side);
      for (const source of group.pins) {
        if (source.uid % 8 || source.uid / 8 >= layer.pads.length) fail('pin reference is not aligned or exceeds its declared physical pad table.');
        const pad = layer.pads[source.uid / 8];
        const round = pad.shapeType === 0 && pad.width === pad.height;
        pins.push({ x: pad.x, y: pad.y, part: part.raw.key, number: source.number || String(source.ordinal),
          ...(!source.number ? { numberGenerated: true } : {}), net: pad.net < 0 ? '' : table.names[pad.net], side,
          width: pad.width, height: pad.height, shape: round ? 'round' : 'rect', ...(round ? { radius: pad.width / 2 } : {}) });
      }
    }
    part.raw.side = sides.size === 1 ? [...sides][0] : 'both';
  }
  if (!pins.length) fail('the component table contains no pins.');
  return buildBoard(input, { format: FORMAT, parts: parts.map(part => part.raw), pins, unitsToMm: SCALE,
    warnings: [{ key: 'parse.warning.tvwSummary', params: { mapped: pins.length, unresolved: 0, omitted: 0 } },
      { key: 'parse.warning.tvwLimits' }] });
}
