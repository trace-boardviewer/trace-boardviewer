/**
 * OWON B35T+ (and B41T+, same protocol) Bluetooth LE notifications.
 *
 * Follows the community "owon-b35" Bluetooth protocol notes (realtime measurement packet). They are not a vendor document and
 * no meter has been tried, so the family stays experimental. One notification carries three little-endian 16-bit numbers,
 * six bytes in all:
 *
 *   word 0   0xF000 | function << 6 | scale << 3 | decimals
 *              function: 0 DC V, 1 AC V, 2 DC A, 3 AC A, 4 ohm, 5 capacitance, 6 frequency, 7 duty, 8 degC, 9 degF,
 *                        10 diode, 11 continuity, 12 transistor gain, 13 non-contact voltage
 *              scale:    1 nano, 2 micro, 3 milli, 4 (or 0) none, 5 kilo, 6 mega
 *              decimals: digits after the decimal point; a value above 3 is the over-range display
 *   word 1   flags: bit 0 hold, 1 relative (delta), 2 auto range, 3 low battery, 4 min, 5 max
 *   word 2   the digits, sign and magnitude: bit 15 is the minus sign, bits 0..14 the count
 *
 * The 0xF in the top nibble of word 0 is what lets a decoder find a frame again after garbage. GATT: service 0xFFF0, the
 * measurement notifies on 0xFFF4, commands (not used here) are written to 0xFFF3.
 *
 * A GATT notification keeps its boundaries, so a Bluetooth transport should decode each one with `decodeOwonB35Notification`,
 * which needs no resynchronisation. The stream decoder is for byte streams (a recorded log, a bridge that merges notifications);
 * the frame has no checksum, so it also requires the high byte of the flag word to be zero (the documented flags use bits 0 to 5)
 * to tell a frame start from a misaligned one; the notification decoder does not look at it.
 */
import { createStreamDecoder, type ScanResult } from './stream';
import { formatCount, scaleCount, signed } from './numeric';
import type { MeterDecoder, MeterFamilyInfo, MeterMode, MeterReading, MeterUnit } from './types';
import { DEG_C, DEG_F, makeFlags, OHM } from './types';

export const OWON_B35_FRAME_LENGTH = 6;
export const OWON_B35_BLE = { service: 0xfff0, notifyCharacteristic: 0xfff4, controlCharacteristic: 0xfff3 } as const;

export const OWON_B35_INFO: MeterFamilyInfo = {
  id: 'owon-b35',
  models: ['OWON B35T+', 'OWON B41T+'],
  status: 'experimental',
  link: 'ble',
  documents: ['owon-b35 project, Bluetooth protocol notes, realtime measurement packet (community)'],
  limits: [
    'Written from protocol descriptions and byte fixtures; not checked against a real meter.',
    'The over-range display is recognised by a decimal field above 3, as the protocol notes describe it, or by a count of 32767 (no 6000-count display can show it); not checked on hardware.',
    'The order of the MIN and MAX flag bits is taken from the notes and not checked; both mean a recorded extreme is shown.',
    'The stream decoder resynchronises on a zero high flag byte; decode BLE notifications one by one with decodeOwonB35Notification.',
    'Non-contact voltage has no numeric reading.',
  ],
};

interface FunctionSpec { mode: MeterMode; unit: MeterUnit; noNumber?: boolean; }

const FUNCTIONS: readonly FunctionSpec[] = [
  { mode: 'dcVolts', unit: 'V' },
  { mode: 'acVolts', unit: 'V' },
  { mode: 'dcAmps', unit: 'A' },
  { mode: 'acAmps', unit: 'A' },
  { mode: 'resistance', unit: OHM },
  { mode: 'capacitance', unit: 'F' },
  { mode: 'frequency', unit: 'Hz' },
  { mode: 'duty', unit: '%' },
  { mode: 'temperature', unit: DEG_C },
  { mode: 'temperature', unit: DEG_F },
  { mode: 'diode', unit: 'V' },
  { mode: 'continuity', unit: OHM },
  { mode: 'transistorGain', unit: '' },
  { mode: 'ncv', unit: 'V', noNumber: true },
];

/** Power of ten of the unit prefix, by scale code. Code 7 is not defined. */
const SCALE_EXP: ReadonlyArray<number | undefined> = [0, -9, -6, -3, 0, 3, 6, undefined];

/** Decode one six-byte notification; null when a field is outside the tables. */
export function decodeOwonB35Frame(frame: ArrayLike<number>, at: number): MeterReading | null {
  const word0 = frame[0] | (frame[1] << 8);
  const word1 = frame[2] | (frame[3] << 8);
  const word2 = frame[4] | (frame[5] << 8);
  if ((word0 & 0xf000) !== 0xf000) return null;
  const spec = FUNCTIONS[(word0 >> 6) & 0x0f];
  const prefix = SCALE_EXP[(word0 >> 3) & 0x07];
  if (!spec || prefix === undefined) return null;
  const decimals = word0 & 0x07;

  const flags = makeFlags({
    hold: (word1 & 0x01) !== 0,
    rel: (word1 & 0x02) !== 0,
    auto: (word1 & 0x04) !== 0,
    lowBattery: (word1 & 0x08) !== 0,
    min: (word1 & 0x10) !== 0,
    max: (word1 & 0x20) !== 0,
  });
  const reading: MeterReading = { family: 'owon-b35', value: null, unit: spec.unit, mode: spec.mode, flags, at };
  if (spec.noNumber) { flags.invalid = true; return reading; }
  if (decimals > 3) { flags.ol = true; reading.display = 'OL'; return reading; }

  const count = word2 & 0x7fff;
  if (count === 0x7fff) { flags.ol = true; reading.display = 'OL'; return reading; }
  const negative = (word2 & 0x8000) !== 0;
  const exp = prefix - decimals;
  reading.value = signed(scaleCount(count, exp), negative);
  reading.resolution = 10 ** exp;
  reading.display = formatCount(count, decimals, negative);
  return reading;
}

/** One whole notification (exactly six bytes): the reading, or null when the length or a field is wrong. */
export function decodeOwonB35Notification(notification: ArrayLike<number>, at: number): MeterReading | null {
  return notification.length === OWON_B35_FRAME_LENGTH ? decodeOwonB35Frame(notification, at) : null;
}

export interface OwonB35Options { now?: () => number; }

export function createOwonB35Decoder(options: OwonB35Options = {}): MeterDecoder {
  return createStreamDecoder({
    family: 'owon-b35',
    now: options.now,
    maxBuffer: 64,
    scan(front: Uint8Array, at: number): ScanResult {
      if (front.length < 2) return { kind: 'need-more' };
      // The top nibble of word 0 is always 0xF and bits 10 and 11 are zero: the byte is 0xF0 to 0xF3.
      if (front[1] < 0xf0 || front[1] > 0xf3) return { kind: 'garbage', length: 1 };
      // The documented flags use bits 0 to 5; a non-zero high byte means this is not a frame start (a lost byte, a frame cut in two).
      if (front.length >= 4 && front[3] !== 0) return { kind: 'garbage', length: 1 };
      if (front.length < OWON_B35_FRAME_LENGTH) return { kind: 'need-more' };
      const reading = decodeOwonB35Frame(front, at);
      if (!reading) return { kind: 'garbage', length: 1, bad: true };
      return { kind: 'frame', length: OWON_B35_FRAME_LENGTH, readings: [reading] };
    },
  });
}

/** Build a notification (test fixtures, the simulator). */
export function encodeOwonB35Frame(spec: { func: number; scale: number; decimals: number; count: number; negative?: boolean; flags?: number }): Uint8Array {
  const word0 = 0xf000 | ((spec.func & 0x0f) << 6) | ((spec.scale & 7) << 3) | (spec.decimals & 7);
  const word2 = (spec.count & 0x7fff) | (spec.negative ? 0x8000 : 0);
  const word1 = (spec.flags ?? 0) & 0x3f;
  return Uint8Array.of(word0 & 0xff, word0 >> 8, word1 & 0xff, word1 >> 8, word2 & 0xff, word2 >> 8);
}
