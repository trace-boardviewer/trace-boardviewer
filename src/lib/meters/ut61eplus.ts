/**
 * UNI-T UT61E+ (also UT61B+/D+) frames, as sent by the meter's built-in USB-UART bridge (CP2110, see cp2110.ts).
 *
 * Follows the community protocol notes of the "ut61ep" project (frame, mode and range tables). There is no vendor document for
 * this protocol and no meter has been tried, so the whole family stays experimental:
 *
 *   request   AB CD 03 5E 01 D9        (magic, length 3, command 0x5E, checksum)
 *   reply     AB CD 10 <14 bytes> <checksum hi> <checksum lo>      19 bytes in all
 *   checksum  sum of every byte in front of it (magic and length included), 16 bit, big endian
 *
 * The 14-byte payload:
 *   0       mode      0 AC V, 1 AC mV, 2 DC V, 3 DC mV, 4 Hz, 5 duty %, 6 ohm, 7 continuity, 8 diode, 9 capacitance, 10 degC,
 *                     11 degF, 12 DC uA, 13 AC uA, 14 DC mA, 15 AC mA, 16 DC A, 17 AC A, 18 hFE, 20 NCV, 21 AC V LoZ,
 *                     24 AC V LPF, 25 DC V (with an AC channel, see flags 3)
 *   1       range     ASCII digit, 0x30 + range number
 *   2..8    display   seven ASCII characters, blank padded, decimal point included ("-0.0850", " OL.   ")
 *   9..10   bar graph (not used)
 *   11      flags 1   bit 0 rel, bit 1 hold, bit 2 min, bit 3 max
 *   12      flags 2   bit 1 low battery, bit 2 manual range
 *   13      flags 3   bit 0 negative, bit 1 peak min, bit 2 peak max, bit 3 AC channel of mode 25
 * Only the low nibble of a flag byte carries data.
 *
 * The display text carries its own decimal point, so volts, amperes, millivolts, microamperes and milliamperes need no range
 * table. The ohm and capacitance displays change prefix with the range: ohm shows ohm, kohm, kohm, kohm, Mohm, Mohm, Mohm for
 * ranges 0..6, capacitance shows nF, nF, uF, uF, uF, mF, mF, mF for ranges 0..7. The frequency prefix is not in the sources:
 * the table of the ES51922 (same 22000-count family) is used and every frequency reading carries `caveat: 'scale-assumed'`.
 */
import { createStreamDecoder, type ScanResult } from './stream';
import { formatCount, isOverloadText, parseDisplayNumber, scaleCount, signed } from './numeric';
import type { MeterDecoder, MeterFamilyInfo, MeterMode, MeterReading, MeterUnit } from './types';
import { DEG_C, DEG_F, makeFlags, OHM } from './types';

export const UT61EPLUS_FRAME_LENGTH = 19;
export const UT61EPLUS_PAYLOAD_LENGTH = 14;
const MAGIC_0 = 0xab;
const MAGIC_1 = 0xcd;
const REPLY_LENGTH_BYTE = 0x10;

export const UT61EPLUS_INFO: MeterFamilyInfo = {
  id: 'ut61eplus',
  models: ['UNI-T UT61E+', 'UNI-T UT61B+/D+ (same frames)'],
  status: 'experimental',
  link: 'hid',
  documents: ['ut61ep project, UT61E+ protocol notes (community)', 'CP2110/4 Interface Specification (AN434)'],
  limits: [
    'Written from protocol descriptions and byte fixtures; not checked against a real meter.',
    'The frequency prefix is assumed from the ES51922 range plan (reported as scale-assumed).',
    'The bar graph bytes and the high-voltage/caution flag are not decoded.',
    'Non-contact voltage has no numeric reading.',
  ],
};

export function ut61Checksum(bytes: ArrayLike<number>, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += bytes[i];
  return sum & 0xffff;
}

/** A command frame: magic, length (command + checksum), command, checksum. `buildUt61Command(0x5e, [0x01])` is the poll request. */
export function buildUt61Command(command: number, arguments_: readonly number[] = []): Uint8Array {
  const out = new Uint8Array(3 + 1 + arguments_.length + 2);
  out[0] = MAGIC_0; out[1] = MAGIC_1;
  out[2] = 1 + arguments_.length + 2;
  out[3] = command;
  arguments_.forEach((value, i) => { out[4 + i] = value & 0xff; });
  const checksum = ut61Checksum(out, out.length - 2);
  out[out.length - 2] = checksum >> 8;
  out[out.length - 1] = checksum & 0xff;
  return out;
}

/** The poll request that makes the meter send one measurement frame: AB CD 03 5E 01 D9 (the 01 D9 is the checksum). */
export const UT61EPLUS_REQUEST: Uint8Array = buildUt61Command(0x5e);

interface ModeSpec {
  mode: MeterMode;
  unit: MeterUnit;
  /** Power of ten of the unit prefix of the displayed number (mV: -3). */
  prefix: number;
  /** The range changes the prefix: 'ohm' and 'cap' follow the tables above, 'freq' is assumed. */
  ranged?: 'ohm' | 'cap' | 'freq';
  noNumber?: boolean;
}

const MODES: Readonly<Record<number, ModeSpec>> = {
  0: { mode: 'acVolts', unit: 'V', prefix: 0 },
  1: { mode: 'acVolts', unit: 'V', prefix: -3 },
  2: { mode: 'dcVolts', unit: 'V', prefix: 0 },
  3: { mode: 'dcVolts', unit: 'V', prefix: -3 },
  4: { mode: 'frequency', unit: 'Hz', prefix: 0, ranged: 'freq' },
  5: { mode: 'duty', unit: '%', prefix: 0 },
  6: { mode: 'resistance', unit: OHM, prefix: 0, ranged: 'ohm' },
  7: { mode: 'continuity', unit: OHM, prefix: 0 },
  8: { mode: 'diode', unit: 'V', prefix: 0 },
  9: { mode: 'capacitance', unit: 'F', prefix: -9, ranged: 'cap' },
  10: { mode: 'temperature', unit: DEG_C, prefix: 0 },
  11: { mode: 'temperature', unit: DEG_F, prefix: 0 },
  12: { mode: 'dcAmps', unit: 'A', prefix: -6 },
  13: { mode: 'acAmps', unit: 'A', prefix: -6 },
  14: { mode: 'dcAmps', unit: 'A', prefix: -3 },
  15: { mode: 'acAmps', unit: 'A', prefix: -3 },
  16: { mode: 'dcAmps', unit: 'A', prefix: 0 },
  17: { mode: 'acAmps', unit: 'A', prefix: 0 },
  18: { mode: 'transistorGain', unit: '', prefix: 0 },
  20: { mode: 'ncv', unit: 'V', prefix: 0, noNumber: true },
  21: { mode: 'acVolts', unit: 'V', prefix: 0 },
  24: { mode: 'acVolts', unit: 'V', prefix: 0 },
  25: { mode: 'dcVolts', unit: 'V', prefix: 0 },
};

function rangePrefix(kind: 'ohm' | 'cap' | 'freq', range: number): number {
  switch (kind) {
    case 'ohm': return 3 * Math.floor((range + 2) / 3);
    case 'cap': return -9 + 3 * Math.floor((range + 1) / 3);
    case 'freq': return 3 * Math.floor((range + 1) / 3);
  }
}

/** Decode one 19-byte frame (magic, length and checksum already verified). */
export function decodeUt61EplusPayload(payload: ArrayLike<number>, at: number): MeterReading | null {
  const spec = MODES[payload[0]];
  if (!spec) return null;
  const rangeByte = payload[1];
  const range = rangeByte >= 0x30 ? rangeByte - 0x30 : rangeByte;
  let text = '';
  for (let i = 2; i <= 8; i++) text += String.fromCharCode(payload[i] & 0x7f);
  const f1 = payload[11] & 0x0f;
  const f2 = payload[12] & 0x0f;
  const f3 = payload[13] & 0x0f;

  // Mode 25 alternates between the DC and the AC channel of the DC+AC display; flags 3 bit 3 says which one this frame is.
  const mode = payload[0] === 25 && (f3 & 8) !== 0 ? 'acVolts' : spec.mode;

  const flags = makeFlags({
    rel: (f1 & 1) !== 0,
    hold: (f1 & 2) !== 0,
    min: (f1 & 4) !== 0 || (f3 & 2) !== 0,
    max: (f1 & 8) !== 0 || (f3 & 4) !== 0,
    lowBattery: (f2 & 2) !== 0,
    auto: (f2 & 4) === 0,
  });
  const reading: MeterReading = { family: 'ut61eplus', value: null, unit: spec.unit, mode, flags, at };
  if (spec.ranged === 'freq') reading.caveat = 'scale-assumed';
  if (spec.noNumber) { flags.invalid = true; return reading; }

  reading.display = text.trim();
  if (isOverloadText(text)) { flags.ol = true; reading.display = 'OL'; return reading; }
  const number = parseDisplayNumber(text);
  if (!number) { flags.invalid = true; return reading; }
  const prefix = spec.ranged ? rangePrefix(spec.ranged, range) : spec.prefix;
  const exp = prefix - number.decimals;
  const negative = number.negative || (f3 & 1) !== 0;
  reading.value = signed(scaleCount(number.count, exp), negative);
  reading.resolution = 10 ** exp;
  reading.display = formatCount(number.count, number.decimals, negative);
  return reading;
}

export interface Ut61EplusOptions { now?: () => number; }

export function createUt61EplusDecoder(options: Ut61EplusOptions = {}): MeterDecoder {
  return createStreamDecoder({
    family: 'ut61eplus',
    now: options.now,
    maxBuffer: 256,
    scan(front: Uint8Array, at: number): ScanResult {
      if (front[0] !== MAGIC_0) return { kind: 'garbage', length: 1 };
      if (front.length < 2) return { kind: 'need-more' };
      if (front[1] !== MAGIC_1) return { kind: 'garbage', length: 1 };
      if (front.length < 3) return { kind: 'need-more' };
      if (front[2] !== REPLY_LENGTH_BYTE) return { kind: 'garbage', length: 2 };
      if (front.length < UT61EPLUS_FRAME_LENGTH) return { kind: 'need-more' };
      const expected = (front[17] << 8) | front[18];
      if (ut61Checksum(front, 17) !== expected) return { kind: 'garbage', length: 2, bad: true };
      const reading = decodeUt61EplusPayload(front.subarray(3, 3 + UT61EPLUS_PAYLOAD_LENGTH), at);
      if (!reading) return { kind: 'garbage', length: UT61EPLUS_FRAME_LENGTH, bad: true };
      return { kind: 'frame', length: UT61EPLUS_FRAME_LENGTH, readings: [reading] };
    },
  });
}

/** Build a complete reply frame (test fixtures, the simulator). */
export function encodeUt61EplusFrame(spec: { mode: number; range: number; display: string; f1?: number; f2?: number; f3?: number }): Uint8Array {
  const out = new Uint8Array(UT61EPLUS_FRAME_LENGTH);
  out[0] = MAGIC_0; out[1] = MAGIC_1; out[2] = REPLY_LENGTH_BYTE;
  out[3] = spec.mode;
  out[4] = 0x30 + spec.range;
  const text = spec.display.padStart(7, ' ').slice(-7);
  for (let i = 0; i < 7; i++) out[5 + i] = text.charCodeAt(i);
  out[12] = 0x30; out[13] = 0x30; // bar graph
  out[14] = 0x30 | ((spec.f1 ?? 0) & 0x0f);
  out[15] = 0x30 | ((spec.f2 ?? 0) & 0x0f);
  out[16] = 0x30 | ((spec.f3 ?? 0) & 0x0f);
  const checksum = ut61Checksum(out, 17);
  out[17] = checksum >> 8;
  out[18] = checksum & 0xff;
  return out;
}
