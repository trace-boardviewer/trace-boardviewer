/**
 * Cyrustek ES51922 serial frames (UNI-T UT61E).
 *
 * Follows the "ES51922 22,000 Counts Auto DMM" datasheet, section "Serial Data Output". Link: 19200 baud, 7 data bits, odd
 * parity, 1 stop bit; the chip sends one block per conversion, 14 packets of 7 bits:
 *
 *   0       range      0b0110rrr   (0x30 + range number)
 *   1..5    digit 4..0 0b011dddd   (0x30..0x39; digit 4 is the most significant)
 *   6       function   0b011ffff
 *   7       status     0b011 judge sign batt ol
 *   8       option 1   0b011 max min rel rmr
 *   9       option 2   0b011 ul pmax pmin 0
 *   10      option 3   0b011 dc ac auto vahz
 *   11      option 4   0b0110 vbar hold lpf
 *   12, 13  CR, LF
 *
 * A transport that hands over 8-bit bytes of a 7O1 link may leave the parity bit in bit 7, so bit 7 is masked off unless the
 * caller says otherwise. `flags.hold` only says that the LCD is frozen; the digits are whatever the frame carries.
 *
 * Not decoded on purpose: temperature and ADP (no UT61E has them; the frame gives a reading with `flags.invalid`). Two cases
 * rest on an assumption and carry `caveat: 'scale-assumed'`: duty cycle (no range table is read for it, one decimal is used for
 * any range code) and the manual-range current function (read as a 22 A and a 220 A range).
 */
import { formatCount, scaleCount, signed } from './numeric';
import { createStreamDecoder, type ScanResult } from './stream';
import type { MeterDecoder, MeterFamilyInfo, MeterMode, MeterReading, MeterUnit } from './types';
import { DEG_C, makeFlags, OHM } from './types';

export const ES51922_FRAME_LENGTH = 14;
export const ES51922_SERIAL = { baudRate: 19200, dataBits: 7, parity: 'odd', stopBits: 1 } as const;

export const ES51922_INFO: MeterFamilyInfo = {
  id: 'ut61e',
  models: ['UNI-T UT61E (Cyrustek ES51922)'],
  status: 'experimental',
  link: 'serial',
  documents: ['ES51922 22,000 Counts Auto DMM datasheet, Serial Data Output'],
  limits: [
    'Written from protocol descriptions and byte fixtures; not checked against a real meter.',
    'Other UT61 models use different chips and frames and are not decoded here.',
    'Duty cycle and the manual-range current function assume their scale (reported as scale-assumed).',
    'Temperature and ADP frames give an invalid reading; the UT61E has neither.',
  ],
};

/** One range: the unit, the power of ten of one count (prefix power minus displayed decimals) and the decimals the LCD shows. */
interface Range { unit: MeterUnit; exp: number; dec: number; }
const range = (unit: MeterUnit, prefix: number, decimals: number): Range => ({ unit, exp: prefix - decimals, dec: decimals });

const V = (p: number, d: number): Range => range('V', p, d);
const A = (p: number, d: number): Range => range('A', p, d);
const R = (p: number, d: number): Range => range(OHM, p, d);
const HZ = (p: number, d: number): Range => range('Hz', p, d);
const FA = (p: number, d: number): Range => range('F', p, d);

// Range number to range, per function (the datasheet's range table): 2.2000 V, 22.000 V, 220.00 V, 1000.0 V, 220.00 mV; and so on.
const VOLT_RANGES = [V(0, 4), V(0, 3), V(0, 2), V(0, 1), V(-3, 2)];
const MICRO_A_RANGES = [A(-6, 2), A(-6, 1)];
const MILLI_A_RANGES = [A(-3, 3), A(-3, 2)];
/** The manual-range current function: 22 A and 220 A. The datasheet's table for it is read as these two, so the reading carries `scale-assumed`. */
const MANUAL_A_RANGES = [A(0, 3), A(0, 2)];
const OHM_RANGES = [R(0, 2), R(3, 4), R(3, 3), R(3, 2), R(6, 4), R(6, 3), R(6, 2)];
const FREQ_RANGES = [HZ(0, 3), HZ(0, 2), HZ(3, 4), HZ(3, 3), HZ(3, 2), HZ(6, 4), HZ(6, 3), HZ(6, 2)];
const CAP_RANGES = [FA(-9, 3), FA(-9, 2), FA(-6, 4), FA(-6, 3), FA(-6, 2), FA(-3, 4), FA(-3, 3), FA(-3, 2)];

const bit = (byte: number, n: number): boolean => ((byte >> n) & 1) === 1;

/**
 * Decode one frame of 14 bytes (bit 7 already masked). Null when the frame is well-formed but names a function or range the
 * datasheet does not define.
 */
export function decodeEs51922Frame(frame: ArrayLike<number>, at: number): MeterReading | null {
  const rangeNumber = frame[0] & 0x0f;
  const func = frame[6] & 0x0f;
  const status = frame[7] & 0x0f;
  const opt1 = frame[8] & 0x0f;
  const opt2 = frame[9] & 0x0f;
  const opt3 = frame[10] & 0x0f;
  const opt4 = frame[11] & 0x0f;

  const judge = bit(status, 3);
  const negative = bit(status, 2);
  const overload = bit(status, 0);
  const dc = bit(opt3, 3);
  const ac = bit(opt3, 2);

  const flags = makeFlags({
    ol: overload,
    hold: bit(opt4, 1),
    rel: bit(opt1, 1),
    auto: bit(opt3, 1),
    lowBattery: bit(status, 1),
    // MAX / MIN of the min-max function and the peak variants all mean "the LCD shows a recorded extreme".
    max: bit(opt1, 3) || bit(opt2, 2),
    min: bit(opt1, 2) || bit(opt2, 1),
  });

  let spec: Range | undefined;
  let mode: MeterMode = 'other';
  let coupled = false;
  let scaleAssumed = false;
  switch (func) {
    case 0x0b: spec = VOLT_RANGES[rangeNumber]; mode = 'dcVolts'; coupled = true; break;
    case 0x0d: spec = MICRO_A_RANGES[rangeNumber]; mode = 'dcAmps'; coupled = true; break;
    case 0x0f: spec = MILLI_A_RANGES[rangeNumber]; mode = 'dcAmps'; coupled = true; break;
    case 0x00: spec = rangeNumber === 0 ? A(0, 3) : undefined; mode = 'dcAmps'; coupled = true; break;
    case 0x09: spec = MANUAL_A_RANGES[rangeNumber]; mode = 'dcAmps'; coupled = true; scaleAssumed = true; break;
    case 0x03: spec = OHM_RANGES[rangeNumber]; mode = 'resistance'; break;
    case 0x05: spec = rangeNumber === 0 ? R(0, 2) : undefined; mode = 'continuity'; break;
    case 0x01: spec = rangeNumber === 0 ? V(0, 4) : undefined; mode = 'diode'; break;
    case 0x02:
      if (judge) { spec = FREQ_RANGES[rangeNumber]; mode = 'frequency'; } else { spec = range('%', 0, 1); mode = 'duty'; scaleAssumed = true; }
      break;
    case 0x06: spec = CAP_RANGES[rangeNumber]; mode = 'capacitance'; break;
    case 0x04: return { family: 'ut61e', value: null, unit: DEG_C, mode: 'temperature', flags: { ...flags, invalid: true }, at };
    case 0x0e: return { family: 'ut61e', value: null, unit: '', mode: 'other', flags: { ...flags, invalid: true }, at };
    default: return null;
  }
  if (!spec) return null;

  if (coupled) {
    if (ac && dc) mode = mode === 'dcVolts' ? 'acdcVolts' : 'acdcAmps';
    else if (ac) mode = mode === 'dcVolts' ? 'acVolts' : 'acAmps';
  }

  const base: MeterReading = { family: 'ut61e', value: null, unit: spec.unit, mode, flags, at, resolution: 10 ** spec.exp };
  if (coupled && !ac && !dc) base.caveat = 'mode-ambiguous';
  else if (scaleAssumed) base.caveat = 'scale-assumed';
  if (overload) {
    base.display = 'OL';
    return base;
  }
  let count = 0;
  for (let i = 1; i <= 5; i++) {
    const digit = frame[i] & 0x0f;
    if (digit > 9) return null;
    count = count * 10 + digit;
  }
  const value = scaleCount(count, spec.exp);
  base.value = signed(value, negative);
  base.display = formatCount(count, spec.dec, negative);
  return base;
}

function plausiblePrefix(front: Uint8Array, count: number): boolean {
  for (let i = 0; i < count; i++) {
    const byte = front[i];
    if (i < 12) {
      if (byte < 0x30 || byte > 0x3f) return false;
      if (i === 0 && byte > 0x37) return false;
    } else if (i === 12) {
      if (byte !== 0x0d) return false;
    } else if (byte !== 0x0a) return false;
  }
  return true;
}

export interface Es51922Options {
  now?: () => number;
  /** Clear bit 7 of every byte (the parity bit of a 7O1 link). Default true. */
  stripParity?: boolean;
}

export function createEs51922Decoder(options: Es51922Options = {}): MeterDecoder {
  const strip = options.stripParity ?? true;
  const view = new Uint8Array(ES51922_FRAME_LENGTH);
  return createStreamDecoder({
    family: 'ut61e',
    now: options.now,
    maxBuffer: 128,
    scan(front: Uint8Array, at: number): ScanResult {
      const count = Math.min(front.length, ES51922_FRAME_LENGTH);
      for (let i = 0; i < count; i++) view[i] = strip ? front[i] & 0x7f : front[i];
      if (!plausiblePrefix(view, count)) return { kind: 'garbage', length: 1 };
      if (count < ES51922_FRAME_LENGTH) return { kind: 'need-more' };
      const reading = decodeEs51922Frame(view, at);
      // CR LF at the exact place and twelve plausible bytes in front of it: the boundary can be trusted, drop the whole frame.
      if (!reading) return { kind: 'garbage', length: ES51922_FRAME_LENGTH, bad: true };
      return { kind: 'frame', length: ES51922_FRAME_LENGTH, readings: [reading] };
    },
  });
}

/**
 * Build a frame from fields (test fixtures, the simulator). `count` is the five-digit number on the LCD, `range` the range
 * number, `func` the low nibble of the function packet. Every packet gets the 0b011 prefix the datasheet defines.
 */
export interface Es51922FrameSpec {
  range: number;
  count: number;
  func: number;
  negative?: boolean;
  overload?: boolean;
  judge?: boolean;
  battery?: boolean;
  max?: boolean; min?: boolean; rel?: boolean; rmr?: boolean;
  ul?: boolean; pmax?: boolean; pmin?: boolean;
  dc?: boolean; ac?: boolean; auto?: boolean; vahz?: boolean;
  vbar?: boolean; hold?: boolean; lpf?: boolean;
}

export function encodeEs51922Frame(spec: Es51922FrameSpec): Uint8Array {
  const nibble = (...bits: Array<boolean | undefined>): number => bits.reduce<number>((acc, on) => (acc << 1) | (on ? 1 : 0), 0);
  const out = new Uint8Array(ES51922_FRAME_LENGTH);
  out[0] = 0x30 | (spec.range & 7);
  const digits = String(Math.max(0, Math.min(99999, Math.trunc(spec.count)))).padStart(5, '0');
  for (let i = 0; i < 5; i++) out[1 + i] = 0x30 | (digits.charCodeAt(i) - 0x30);
  out[6] = 0x30 | (spec.func & 0x0f);
  out[7] = 0x30 | nibble(spec.judge, spec.negative, spec.battery, spec.overload);
  out[8] = 0x30 | nibble(spec.max, spec.min, spec.rel, spec.rmr);
  out[9] = 0x30 | nibble(spec.ul, spec.pmax, spec.pmin, false);
  out[10] = 0x30 | nibble(spec.dc, spec.ac, spec.auto, spec.vahz);
  out[11] = 0x30 | nibble(false, spec.vbar, spec.hold, spec.lpf);
  out[12] = 0x0d;
  out[13] = 0x0a;
  return out;
}
