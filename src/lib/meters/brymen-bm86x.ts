/**
 * Brymen BM867s / BM869s (BM86x) through the BU-86X IR-USB cable: the LCD-segment frame.
 *
 * Follows "Protocol for 500000-count professional dual display DMM series" (Brymen's protocol sheet, Table 1 "LCD map"):
 *
 *   request    report ID 0x00, then 0x00 0x86 0x66 (USB HID 1.1)
 *   response   27 bytes: three reports of 9 bytes, each starting with the report ID 0x00 (bytes 1, 10 and 19 of the sheet);
 *              byte 23 is the model ID 0x86. Hosts that strip the report IDs (WebHID gives eight data bytes per report) see
 *              the same frame as 24 bytes; both forms are decoded, and bytes are numbered here as the sheet numbers them.
 *
 * Every display position is a 7-segment cell in bits 7..1 in the order b g c d a f e, with the decimal point (or an
 * annunciator) in bit 0 of the next byte. Main display, six digits: bytes 5, 6, 7, 8, 9 and 11, decimal points 1p..4p in bit 0
 * of bytes 6..9. Secondary display, four digits: bytes 13..16, decimal points 7p..9p in bit 0 of bytes 14..16. Annunciators
 * used here (byte.bit):
 *
 *   3.7 AVG 3.6 MIN 3.5 MAX 3.4 DC 3.3 HOLD 3.0 AUTO     4.7 main minus 4.0 main AC    5.0 relative (delta triangle)
 *   11.0 V  17.7 A  17.6 n  17.5 F  17.4 S   18.7 duty %  18.6 k  18.5 M  18.4 ohm  18.3 u  18.2 m  18.1 dB  18.0 Hz   (main)
 *   12.7 battery  12.4 secondary minus  12.5 secondary AC  12.3 4-20 mA %  12.2 A  12.1 m  12.0 u   (secondary)
 *   17.3 V  17.2 Hz  17.1 k  17.0 M   (secondary)        13.0 continuity beeper
 *
 * The sheet has no diode annunciator; the meter writes "diod" on the secondary display, which is how a diode test is told from
 * DC volts. The temperature unit is a C or F character in the sixth main digit. Both are known from community reports of the
 * meter, not from the sheet, and no meter of this family has been tried: the family is experimental.
 *
 * The sheet's own worked example is "AC 312.17V / 60.11Hz"; its bytes spell 312.71 on the main display and light no main V, so
 * the tests build their frames from the segment table and use the example only for what it shows unambiguously.
 */
import { formatCount, isOverloadText, parseDisplayNumber, scaleCount, signed } from './numeric';
import { createStreamDecoder, type ScanResult } from './stream';
import type { MeterDecoder, MeterFamilyInfo, MeterMode, MeterReading, MeterSecondary, MeterUnit } from './types';
import { DEG_C, DEG_F, makeFlags, OHM } from './types';

export const BM86X_FRAME_LENGTH = 27;
export const BM86X_BARE_FRAME_LENGTH = 24;
export const BM86X_MODEL_ID = 0x86;
/** HID report to send to poll: report ID 0, these three data bytes. */
export const BM86X_REQUEST_REPORT = { reportId: 0, data: Uint8Array.of(0x00, 0x86, 0x66) } as const;
/** The BU-86X cable as the community reports its USB IDs (the protocol sheet does not give them). */
export const BM86X_USB = { vendorId: 0x0820, productId: 0x0001 } as const;

export const BM86X_INFO: MeterFamilyInfo = {
  id: 'brymen-bm86x',
  models: ['Brymen BM867s', 'Brymen BM869s'],
  status: 'experimental',
  link: 'hid',
  documents: ['Protocol for 500000-count professional dual display DMM series (Brymen)'],
  limits: [
    'Written from protocol descriptions and byte fixtures; not checked against a real meter.',
    'A diode test is recognised by the word "diod" on the secondary display, which the sheet does not describe.',
    'Temperature is recognised by a C or F character in the sixth digit; the sheet has no unit annunciator for it.',
    'Several annunciators (C, R, T1, T2, bar graph) are not decoded.',
  ],
};

// Segment bits inside a digit byte.
const SEG_B = 0x80, SEG_G = 0x40, SEG_C = 0x20, SEG_D = 0x10, SEG_A = 0x08, SEG_F = 0x04, SEG_E = 0x02;

const GLYPHS: ReadonlyMap<number, string> = new Map([
  [0x00, ' '],
  [SEG_A | SEG_B | SEG_C | SEG_D | SEG_E | SEG_F, '0'],
  [SEG_B | SEG_C, '1'],
  [SEG_A | SEG_B | SEG_D | SEG_E | SEG_G, '2'],
  [SEG_A | SEG_B | SEG_C | SEG_D | SEG_G, '3'],
  [SEG_B | SEG_C | SEG_F | SEG_G, '4'],
  [SEG_A | SEG_C | SEG_D | SEG_F | SEG_G, '5'],
  [SEG_A | SEG_C | SEG_D | SEG_E | SEG_F | SEG_G, '6'],
  [SEG_A | SEG_B | SEG_C, '7'],
  [SEG_A | SEG_B | SEG_C | SEG_D | SEG_E | SEG_F | SEG_G, '8'],
  [SEG_A | SEG_B | SEG_C | SEG_D | SEG_F | SEG_G, '9'],
  [SEG_A | SEG_B | SEG_C | SEG_F | SEG_G, '9'],
  [SEG_G, '-'],
  [SEG_D | SEG_E | SEG_F, 'L'],
  [SEG_A | SEG_D | SEG_E | SEG_F, 'C'],
  [SEG_A | SEG_E | SEG_F | SEG_G, 'F'],
  [SEG_A | SEG_D | SEG_E | SEG_F | SEG_G, 'E'],
  [SEG_A | SEG_B | SEG_E | SEG_F | SEG_G, 'P'],
  [SEG_B | SEG_C | SEG_E | SEG_F | SEG_G, 'H'],
  [SEG_C | SEG_D | SEG_E | SEG_G, 'o'],
  [SEG_B | SEG_C | SEG_D | SEG_E | SEG_G, 'd'],
  [SEG_C, 'i'],
  [SEG_E, 'i'],
  [SEG_C | SEG_E | SEG_G, 'n'],
  [SEG_E | SEG_G, 'r'],
  [SEG_C | SEG_D | SEG_E, 'u'],
  [SEG_A | SEG_B | SEG_C | SEG_E | SEG_F | SEG_G, 'A'],
]);

/** The character of a digit byte (bit 0 is not part of the digit); '?' for a segment pattern that is not a known glyph. */
export function glyphOf(byte: number): string {
  return GLYPHS.get(byte & 0xfe) ?? '?';
}

/** Segment byte (bit 0 clear) of a character, for building fixtures. */
export function segmentsOf(char: string): number {
  for (const [segments, glyph] of GLYPHS) if (glyph === char) return segments;
  throw new RangeError(`no segment pattern for ${JSON.stringify(char)}`);
}

/** Bring a 24-byte (report IDs stripped) or 27-byte frame to the 27-byte numbering of the sheet; null for any other length. */
export function normaliseBm86xFrame(frame: ArrayLike<number>): Uint8Array | null {
  const out = new Uint8Array(BM86X_FRAME_LENGTH);
  if (frame.length === BM86X_FRAME_LENGTH) {
    for (let i = 0; i < BM86X_FRAME_LENGTH; i++) out[i] = frame[i] & 0xff;
  } else if (frame.length === BM86X_BARE_FRAME_LENGTH) {
    for (let i = 0; i < 8; i++) out[1 + i] = frame[i] & 0xff;
    for (let i = 0; i < 8; i++) out[10 + i] = frame[8 + i] & 0xff;
    for (let i = 0; i < 8; i++) out[19 + i] = frame[16 + i] & 0xff;
  } else return null;
  return out;
}

const bit = (byte: number, n: number): boolean => ((byte >> n) & 1) === 1;

interface DisplayText { text: string; decimals: number; }

/** The text of a run of digits with the decimal point after digit k when `points[k]`. */
function readDisplay(digits: readonly number[], points: readonly boolean[], minus: boolean, skipLast = false): DisplayText {
  const count = skipLast ? digits.length - 1 : digits.length;
  let text = '';
  for (let i = 0; i < count; i++) {
    text += glyphOf(digits[i]);
    if (i < points.length && points[i]) text += '.';
  }
  text = text.trimStart();
  return { text: minus && text !== '' ? `-${text}` : text, decimals: 0 };
}

function secondUnit(t: Uint8Array): { unit: MeterUnit; prefix: number } | null {
  let unit: MeterUnit | null = null;
  if (bit(t[16], 3)) unit = 'V';
  else if (bit(t[16], 2)) unit = 'Hz';
  else if (bit(t[11], 2)) unit = 'A';
  else if (bit(t[11], 3)) unit = '%';
  if (unit === null) return null;
  const prefix = bit(t[16], 1) ? 3 : bit(t[16], 0) ? 6 : bit(t[11], 1) ? -3 : bit(t[11], 0) ? -6 : 0;
  return { unit, prefix };
}

function numberFrom(text: string, prefix: number): { value: number; resolution: number; display: string } | null {
  const parsed = parseDisplayNumber(text);
  if (!parsed) return null;
  const exp = prefix - parsed.decimals;
  return { value: signed(scaleCount(parsed.count, exp), parsed.negative), resolution: 10 ** exp, display: formatCount(parsed.count, parsed.decimals, parsed.negative) };
}

/** Decode a frame (24 or 27 bytes). Null when the report IDs or the model ID are wrong. */
export function decodeBm86xFrame(frame: ArrayLike<number>, at: number): MeterReading | null {
  const t = normaliseBm86xFrame(frame);
  if (!t || t[0] !== 0 || t[9] !== 0 || t[18] !== 0 || t[22] !== BM86X_MODEL_ID) return null;
  // The sheet's byte n is t[n - 1].
  const b3 = t[2], b4 = t[3], b5 = t[4], b12 = t[11], b13 = t[12], b17 = t[16], b18 = t[17], b11 = t[10];

  const mainDigits = [t[4], t[5], t[6], t[7], t[8], t[10]];
  const mainPoints = [bit(t[5], 0), bit(t[6], 0), bit(t[7], 0), bit(t[8], 0)];
  const secondDigits = [t[12], t[13], t[14], t[15]];
  const secondPoints = [bit(t[13], 0), bit(t[14], 0), bit(t[15], 0)];

  const flags = makeFlags({
    auto: bit(b3, 0), hold: bit(b3, 3), rel: bit(b5, 0), max: bit(b3, 5), min: bit(b3, 6), lowBattery: bit(b12, 7),
  });

  // The secondary display.
  const secondText = readDisplay(secondDigits, secondPoints, bit(b12, 4));
  const secondaryUnit = secondUnit(t);
  const diodeWord = secondText.text.replace(/[ .]/g, '').toLowerCase() === 'diod';

  // The main display: the unit annunciators, then the number.
  let unit: MeterUnit | null = null;
  if (bit(b18, 1)) unit = 'dB';
  else if (bit(b18, 7)) unit = '%';
  else if (bit(b18, 4)) unit = OHM;
  else if (bit(b17, 5)) unit = 'F';
  else if (bit(b17, 4)) unit = 'S';
  else if (bit(b18, 0)) unit = 'Hz';
  else if (bit(b17, 7)) unit = 'A';
  else if (bit(b11, 0)) unit = 'V';
  const prefix = bit(b17, 6) ? -9 : bit(b18, 3) ? -6 : bit(b18, 2) ? -3 : bit(b18, 6) ? 3 : bit(b18, 5) ? 6 : 0;

  const lastGlyph = glyphOf(mainDigits[5]);
  const temperature = unit === null && (lastGlyph === 'C' || lastGlyph === 'F');
  const main = readDisplay(mainDigits, mainPoints, bit(b4, 3 + 4), temperature);

  const dc = bit(b3, 4);
  const ac = bit(b4, 0);
  let mode: MeterMode = 'other';
  let caveat: MeterReading['caveat'];
  switch (unit) {
    case 'V':
      if (diodeWord) mode = 'diode';
      else if (ac && dc) mode = 'acdcVolts';
      else if (ac) mode = 'acVolts';
      else { mode = 'dcVolts'; if (!dc) caveat = 'mode-ambiguous'; }
      break;
    case 'A':
      if (ac && dc) mode = 'acdcAmps';
      else if (ac) mode = 'acAmps';
      else { mode = 'dcAmps'; if (!dc) caveat = 'mode-ambiguous'; }
      break;
    case OHM: mode = bit(b13, 0) ? 'continuity' : 'resistance'; break;
    case 'F': mode = 'capacitance'; break;
    case 'S': mode = 'conductance'; break;
    case 'Hz': mode = 'frequency'; break;
    case '%': mode = 'duty'; break;
    default: mode = temperature ? 'temperature' : 'other';
  }
  const resolvedUnit: MeterUnit = temperature ? (lastGlyph === 'C' ? DEG_C : DEG_F) : (unit ?? '');
  const reading: MeterReading = { family: 'brymen-bm86x', value: null, unit: resolvedUnit, mode, flags, at };
  if (caveat) reading.caveat = caveat;

  const compact = main.text.replace(/[ .]/g, '').toUpperCase();
  reading.display = main.text;
  if (compact.includes('L') && (compact.includes('0') || compact.includes('O')) && isOverloadText(main.text.replace('-', ''))) {
    flags.ol = true;
  } else {
    const parsed = numberFrom(main.text, temperature ? 0 : prefix);
    if (parsed) {
      reading.value = parsed.value;
      reading.resolution = parsed.resolution;
      reading.display = parsed.display;
    } else flags.invalid = true;
  }

  if (secondText.text !== '' && !diodeWord) {
    const secondary: MeterSecondary = { value: null, unit: secondaryUnit?.unit ?? '', display: secondText.text };
    const compactSecond = secondText.text.replace(/[ .]/g, '').toUpperCase();
    if (compactSecond.includes('L') && isOverloadText(secondText.text.replace('-', ''))) secondary.ol = true;
    else {
      const parsed = numberFrom(secondText.text, secondaryUnit?.prefix ?? 0);
      if (parsed && secondaryUnit) { secondary.value = parsed.value; secondary.display = parsed.display; }
    }
    reading.secondary = secondary;
  }
  return reading;
}

function consistent27(front: Uint8Array, n: number): boolean {
  return (n < 1 || front[0] === 0) && (n < 10 || front[9] === 0) && (n < 19 || front[18] === 0) && (n < 23 || front[22] === BM86X_MODEL_ID);
}

export interface Bm86xOptions { now?: () => number; }

export function createBm86xDecoder(options: Bm86xOptions = {}): MeterDecoder {
  return createStreamDecoder({
    family: 'brymen-bm86x',
    now: options.now,
    maxBuffer: 256,
    scan(front: Uint8Array, at: number): ScanResult {
      const n = front.length;
      if (n >= BM86X_FRAME_LENGTH && consistent27(front, n)) {
        const reading = decodeBm86xFrame(front.subarray(0, BM86X_FRAME_LENGTH), at);
        if (reading) return { kind: 'frame', length: BM86X_FRAME_LENGTH, readings: [reading] };
      }
      // The report IDs stripped by the host: the model ID is the only fixed byte of the 24-byte form.
      if (n >= BM86X_BARE_FRAME_LENGTH && front[19] === BM86X_MODEL_ID) {
        const reading = decodeBm86xFrame(front.subarray(0, BM86X_BARE_FRAME_LENGTH), at);
        if (reading) return { kind: 'frame', length: BM86X_BARE_FRAME_LENGTH, readings: [reading] };
      }
      // Not enough bytes to tell: either form may still be arriving.
      if (n < BM86X_FRAME_LENGTH && consistent27(front, n)) return { kind: 'need-more' };
      if (n < BM86X_BARE_FRAME_LENGTH && (n <= 19 || front[19] === BM86X_MODEL_ID)) return { kind: 'need-more' };
      return { kind: 'garbage', length: 1 };
    },
  });
}

/** What a fixture needs to say about a frame; everything else is dark. Strings use the characters of GLYPHS. */
export interface Bm86xFrameSpec {
  /** Main display text without the decimal point's position ("31271"), up to six characters, right aligned. */
  main?: string;
  /** Decimal point after main digit 1..4 (0: none). */
  mainPoint?: 0 | 1 | 2 | 3 | 4;
  mainMinus?: boolean;
  second?: string;
  secondPoint?: 0 | 7 | 8 | 9;
  secondMinus?: boolean;
  /** Annunciators as 'byte.bit' of the sheet, for example '3.4' (DC) or '18.4' (ohm). */
  lit?: readonly string[];
}

/** Build a frame in the 27-byte numbering (report IDs and model ID included); `bare` strips the report IDs. */
export function encodeBm86xFrame(spec: Bm86xFrameSpec, bare = false): Uint8Array {
  const t = new Uint8Array(BM86X_FRAME_LENGTH);
  t[22] = BM86X_MODEL_ID;
  const mainText = (spec.main ?? '').padStart(6, ' ');
  const mainBytes = [4, 5, 6, 7, 8, 10];
  for (let i = 0; i < 6; i++) t[mainBytes[i]] = segmentsOf(mainText[i]);
  if (spec.mainPoint) t[4 + spec.mainPoint] |= 1;
  if (spec.mainMinus) t[3] |= 0x80;
  const secondText = (spec.second ?? '').padStart(4, ' ');
  const secondBytes = [12, 13, 14, 15];
  for (let i = 0; i < 4; i++) t[secondBytes[i]] = segmentsOf(secondText[i]);
  if (spec.secondPoint) t[13 + (spec.secondPoint - 7)] |= 1;
  if (spec.secondMinus) t[11] |= 0x10;
  for (const name of spec.lit ?? []) {
    const [byte, b] = name.split('.').map(Number);
    t[byte - 1] |= 1 << b;
  }
  if (!bare) return t;
  const out = new Uint8Array(BM86X_BARE_FRAME_LENGTH);
  for (let i = 0; i < 8; i++) { out[i] = t[1 + i]; out[8 + i] = t[10 + i]; out[16 + i] = t[19 + i]; }
  return out;
}
