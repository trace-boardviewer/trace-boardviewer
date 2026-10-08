/** Original TVW component-table framing, checked against local record bytes. */
import { BoardFormatError, MAX_IMPORT_BYTES, type RawPart } from './common';

const COORD_LIMIT = 2_000_000, MAX_PARTS = 250_000, MAX_PINS = 1_000_000;
const MAX_PIN_INSPECTIONS = 4_000_000, HEADER_WINDOW = 256 * 1024;
const decoder = new TextDecoder('windows-1252');
export interface TvwComponentPin { number: string; ordinal: number; uid: number }
export interface TvwComponentPinGroup { kind: number; pins: TvwComponentPin[] }
export interface TvwComponentPart {
  raw: RawPart;
  pins: TvwComponentPin[];
  end: number;
  masterIndex: number;
  classification: number;
  pinKind: number;
  /** A component can contain separate top and bottom pin groups. */
  pinGroups: TvwComponentPinGroup[];
  /** A one-pin test point, including an unnamed record with an unknown classification. */
  testPoint: boolean;
}
export interface TvwComponentTable { start: number; end: number; count: number; parts: TvwComponentPart[] }
interface TextField { value: string; end: number }
/** Pin-list layer references: the first established numbers (TOP 2, BOTTOM 5 and 7) until the caller names the layer headers. */
const LEGACY_LAYER_REFERENCES = [2, 5, 7];
interface InspectionBudget {
  pins: number;
  /** Whether a pin-list layer reference selects a layer the caller can resolve; others are rejected, never guessed. */
  accept: (reference: number) => boolean;
  /** References of the readings of the current record that were refused only for that reason (a hint for the error). */
  refused: Set<number>;
}
const fail = (message: string, limit = false): never => {
  throw new BoardFormatError(`TVW boardview: ${message}`, limit ? 'LIMIT_EXCEEDED' : 'UNSUPPORTED_VARIANT', 'tvw');
};

class Bytes {
  readonly view: DataView;
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  u32(offset: number): number { return this.view.getUint32(offset, true); }
  i32(offset: number): number { return this.view.getInt32(offset, true); }
  text(offset: number, empty = false): TextField | undefined {
    const length = this.data[offset];
    if (length === undefined || !length && !empty || offset + 1 + length > this.data.length) return undefined;
    const bytes = this.data.subarray(offset + 1, offset + 1 + length);
    if (bytes.some(byte => byte < 32 || byte === 127)) return undefined;
    return { value: decoder.decode(bytes), end: offset + 1 + length };
  }
}

function componentPrefix(bytes: Bytes, offset: number): { ref: TextField; a: number; coords: number[]; rotation: number; classification: number } | undefined {
  const length = bytes.data[offset], first = bytes.data[offset + 1];
  if (!length || length > 64 || !(first === 43 || first === 64 || first >= 48 && first <= 57 || first >= 65 && first <= 90 || first >= 97 && first <= 122)) return undefined;
  const ref = bytes.text(offset);
  if (!ref || !/^[A-Za-z0-9@+][A-Za-z0-9_.()+#:@ /-]*$/.test(ref.value)) return undefined;
  const a = ref.end;
  if (a + 50 > bytes.data.length) return undefined;
  const coords = [0, 4, 8, 12, 16, 20].map(delta => bytes.i32(a + delta));
  const [minY, minX, maxY, maxX] = coords;
  // Placement origins may lie outside an asymmetric connector/body bounding box.
  if (coords.some(value => Math.abs(value) > COORD_LIMIT) || minX > maxX || minY > maxY) return undefined;
  const rotation = bytes.i32(a + 24), classification = bytes.u32(a + 32);
  if (Math.abs(rotation) > 360 || classification > 30 && classification !== 0xffffffff) return undefined;
  return { ref, a, coords, rotation, classification };
}

function componentAt(bytes: Bytes, offset: number, budget: InspectionBudget): TvwComponentPart | undefined {
  const prefix = componentPrefix(bytes, offset);
  if (!prefix) return undefined;
  const { ref, a, coords, rotation, classification } = prefix;
  const [minY, minX, maxY, maxX, y, x] = coords;
  const candidates: TvwComponentPart[] = [];
  for (const fixed of [44, 48]) {
    const flag = bytes.data[a + fixed];
    if (flag !== 0 && flag !== 1) continue;
    const tails: { value: string; package: string; tail: number }[] = [];
    if (flag === 0) {
      // A metadata-free test point has four empty Pascal fields (one zero word),
      // no serial field and no additional metadata word.
      if (classification === 18 || classification === 0xffffffff) tails.push({ value: '', package: '', tail: a + fixed + 1 });
    } else {
      const value = bytes.text(a + fixed + 1, true);
      if (!value) continue;
      const extra1 = bytes.text(value.end, true), extra2 = extra1 && bytes.text(extra1.end, true);
      const packageOffsets = new Set([value.end + 2, ...(extra2 ? [extra2.end] : [])]);
      for (const packageOffset of packageOffsets) {
        const packageName = bytes.text(packageOffset, classification === 18);
        if (!packageName || !/^[\x20-\x7e]*$/.test(packageName.value)) continue;
        const serial = bytes.text(packageName.end, true);
        if (serial) tails.push({ value: value.value, package: packageName.value, tail: serial.end });
      }
    }
    for (const tail of tails) {
      const reserved = fixed === 44 ? 4 : 0;
      if (tail.tail + 12 + reserved > bytes.data.length || bytes.u32(tail.tail) !== 0) continue;
      const count = bytes.u32(tail.tail + 4), kind = bytes.u32(tail.tail + 8);
      if (count > 16_384 || reserved && bytes.u32(tail.tail + 12) !== 0) continue;
      if (!budget.accept(kind)) { budget.refused.add(kind); continue; }
      // An unnamed package is meaningful only for a one-pin test-point record.
      if (!tail.package && (!(classification === 18 || classification === 0xffffffff) || count !== 1)) continue;
      const testPoint = count === 1 && (classification === 18 || !tail.package);
      const pins: TvwComponentPin[] = [], ordinals = new Set<number>();
      const pinGroups: TvwComponentPinGroup[] = [];
      let p = tail.tail + 12 + reserved, groupCount = count, groupKind = kind, complete = true;
      for (let group = 0; group < 2; group++) {
        if (groupCount > 16_384) { complete = false; break; }
        if (!budget.accept(groupKind)) { budget.refused.add(groupKind); complete = false; break; }
        const groupPins: TvwComponentPin[] = [];
        for (let i = 0; i < groupCount; i++) {
          if (++budget.pins > MAX_PIN_INSPECTIONS) fail('component validation exceeds the inspection limit.', true);
          if (p + 13 > bytes.data.length || bytes.u32(p + 4) !== 0) break;
          const ordinal = bytes.u32(p + 8), name = bytes.text(p + 12, testPoint);
          const needsWord = i + 1 < groupCount || !reserved || group === 0;
          if (!name || ordinal < 1 || ordinal > 65_536 || ordinals.has(ordinal) || name.value.length > 32
            || name.end + (needsWord ? 4 : 0) > bytes.data.length) break;
          const pin = { number: name.value, ordinal, uid: bytes.u32(p) };
          ordinals.add(ordinal); pins.push(pin); groupPins.push(pin);
          // Compact records put the zero word before the next pin. After the
          // last name comes the second group's count. After that group the
          // next component starts directly, without an additional terminator.
          if (i + 1 < groupCount || !reserved) {
            if (bytes.u32(name.end) !== 0) { complete = false; break; }
            p = name.end + 4;
          } else p = name.end;
        }
        if (!complete || groupPins.length !== groupCount) { complete = false; break; }
        pinGroups.push({ kind: groupKind, pins: groupPins });
        if (!reserved || !groupCount || group === 1) break;
        groupCount = bytes.u32(p); p += 4;
        if (!groupCount) break;
        if (p + 8 > bytes.data.length || bytes.u32(p + 4) !== 0) { complete = false; break; }
        groupKind = bytes.u32(p); p += 8;
      }
      if (!complete) continue;
      const candidate: TvwComponentPart = {
        raw: { key: `part-${offset}`, ref: ref.value, value: tail.value, package: tail.package, side: 'both',
          position: { x, y }, rotation: -rotation, bounds: { minX, minY, maxX, maxY } },
        pins, pinGroups, end: p, masterIndex: bytes.u32(a + 28), classification, pinKind: kind, testPoint,
      };
      const identical = candidates.some(prior => prior.end === candidate.end && prior.raw.value === candidate.raw.value
        && prior.raw.package === candidate.raw.package && prior.pins.length === candidate.pins.length
        && prior.pinGroups.length === candidate.pinGroups.length && prior.pinGroups.every((group, i) =>
          group.kind === candidate.pinGroups[i].kind && group.pins.length === candidate.pinGroups[i].pins.length)
        && prior.pins.every((pin, i) => pin.uid === candidate.pins[i].uid && pin.ordinal === candidate.pins[i].ordinal && pin.number === candidate.pins[i].number));
      if (!identical) candidates.push(candidate);
      if (candidates.length > 1) fail(`ambiguous component metadata for ${ref.value}.`);
    }
  }
  return candidates[0];
}

/**
 * `afterProbe` is the end of the complete ProbeDB terminator. The bounded search
 * finds the count/kind-12 table header; every declared component then follows
 * sequentially. A damaged or unsupported entry never causes a resynchronizing scan.
 */
export function readTvwComponents(data: Uint8Array, afterProbe: number, acceptLayerReference: (reference: number) => boolean = reference => LEGACY_LAYER_REFERENCES.includes(reference)): TvwComponentTable {
  if (data.length > MAX_IMPORT_BYTES) fail('file exceeds the import limit.', true);
  if (!Number.isInteger(afterProbe) || afterProbe < 0 || afterProbe > data.length) fail('invalid component-table start.');
  const bytes = new Bytes(data), budget: InspectionBudget = { pins: 0, accept: acceptLayerReference, refused: new Set() };
  const stop = Math.min(data.length - 8, afterProbe + HEADER_WINDOW);
  for (let start = afterProbe; start <= stop; start++) {
    if (bytes.u32(start + 4) !== 12 || !componentPrefix(bytes, start + 8)) continue;
    const count = bytes.u32(start);
    if (!count || count > MAX_PARTS) fail('component count exceeds the import limit.', true);
    const parts: TvwComponentPart[] = [];
    let end = start + 8, pinCount = 0;
    for (let index = 0; index < count; index++) {
      budget.refused.clear();
      const part = componentAt(bytes, end, budget);
      if (!part) {
        const hint = budget.refused.size === 1 ? ` One reading of it names layer ${[...budget.refused][0]}, which is not a top or bottom layer of this file.` : '';
        return fail(`component ${index + 1} of ${count} at byte ${end} has an unsupported or incomplete record.${hint}`);
      }
      parts.push(part); end = part.end; pinCount += part.pins.length;
      if (pinCount > MAX_PINS) fail('pin count exceeds the import limit.', true);
    }
    return { start, end, count, parts };
  }
  return fail('no complete component-table header was found.');
}
