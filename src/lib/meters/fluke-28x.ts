/**
 * Fluke 287 / 289 (and 187 / 189) through the IR serial cable: the ASCII query and response subset.
 *
 * Follows the "Fluke 289/287 Remote Interface Specification" (communication protocol, ID, QM, QDDA and the CMD_ACK table):
 *
 *   link        115200 baud, 8 data bits, no parity, 1 stop bit; commands and responses end in CR
 *   command     ID<CR>, QM<CR>, QDDA<CR>   (upper or lower case)
 *   response    CMD_ACK<CR> then, for a query, one line of data<CR>; CMD_ACK is one digit: 0 ok, 1 syntax error,
 *               2 execution error, 5 no data. The 189 puts "<COMMAND>," in front of the digit.
 *   ID          FLUKE 289,V1.00,95081087                         model, software version, serial number
 *   QM          value,unit,state,attribute                       the value of the primary display, in base units
 *                 unit: NONE VDC VAC ADC AAC VAC_PLUS_DC AAC_PLUS_DC V A OHM SIE Hz S F CEL FAR PCT dBm dBV dB CREST_FACTOR
 *                 state: INVALID NORMAL BLANK DISCHARGE OL OL_MINUS OPEN_TC; overload and invalid carry 9.99999999E+37
 *   QDDA        primaryFunction,secondaryFunction,autoRange,baseUnit,rangeNumber,unitMultiplier,lightningBolt,minMaxStartTime,
 *               numberOfModes,{modes},numberOfReadings,{readingID,value,baseUnit,unitMultiplier,decimalPlaces,
 *               displayDigits,state,attribute,timestamp}
 *
 * The decoder recognises a line by its shape, so it needs to know nothing about which command was sent: acknowledgements and
 * the identity line give no reading, a QM line and a QDDA line give one. QM carries no function, so a DC voltage line may
 * be a diode test and is marked `caveat: 'mode-ambiguous'` (a diode test with a good junction is told by its attribute);
 * QDDA names the function and has no such limit, so poll QDDA.
 */
import { createStreamDecoder, type ScanResult } from './stream';
import type { MeterDecoder, MeterFamilyInfo, MeterMode, MeterReading, MeterSecondary, MeterUnit } from './types';
import { DEG_C, DEG_F, makeFlags, OHM } from './types';

export const FLUKE_28X_SERIAL = { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 } as const;

const ascii = (text: string): Uint8Array => Uint8Array.from(text, ch => ch.charCodeAt(0));
export const FLUKE_28X_COMMANDS = { id: ascii('ID\r'), qm: ascii('QM\r'), qdda: ascii('QDDA\r') } as const;

export const FLUKE_28X_INFO: MeterFamilyInfo = {
  id: 'fluke-28x',
  models: ['Fluke 287', 'Fluke 289', 'Fluke 187/189 (QM and ID)'],
  status: 'experimental',
  link: 'serial',
  documents: ['Fluke 289/287 Remote Interface Specification'],
  limits: [
    'Written from protocol descriptions and byte fixtures; not checked against a real meter.',
    'QM does not name the function: a DC voltage line may be a diode test (reported as mode-ambiguous). Poll QDDA.',
    'Only ID, QM and QDDA lines are decoded; recordings and screen captures are not.',
  ],
};

export interface FlukeIdentity { model: string; version: string; serial: string; line: string; }

const UNITS: Readonly<Record<string, { mode: MeterMode; unit: MeterUnit }>> = {
  VDC: { mode: 'dcVolts', unit: 'V' },
  VAC: { mode: 'acVolts', unit: 'V' },
  VAC_PLUS_DC: { mode: 'acdcVolts', unit: 'V' },
  ADC: { mode: 'dcAmps', unit: 'A' },
  AAC: { mode: 'acAmps', unit: 'A' },
  AAC_PLUS_DC: { mode: 'acdcAmps', unit: 'A' },
  V: { mode: 'other', unit: 'V' },
  A: { mode: 'other', unit: 'A' },
  OHM: { mode: 'resistance', unit: OHM },
  SIE: { mode: 'conductance', unit: 'S' },
  HZ: { mode: 'frequency', unit: 'Hz' },
  S: { mode: 'other', unit: 's' },
  F: { mode: 'capacitance', unit: 'F' },
  CEL: { mode: 'temperature', unit: DEG_C },
  FAR: { mode: 'temperature', unit: DEG_F },
  PCT: { mode: 'duty', unit: '%' },
  DBM: { mode: 'other', unit: 'dB' },
  DBV: { mode: 'other', unit: 'dB' },
  DB: { mode: 'other', unit: 'dB' },
  CREST_FACTOR: { mode: 'other', unit: '' },
  NONE: { mode: 'other', unit: '' },
};

const OVERLOAD_STATES = new Set(['OL', 'OL_MINUS']);
const INVALID_STATES = new Set(['INVALID', 'BLANK', 'DISCHARGE', 'OPEN_TC', 'INACTIVE']);

/** The function the QDDA response names, as the mode of the primary display. */
const PRIMARY_FUNCTIONS: Readonly<Record<string, MeterMode>> = (() => {
  const table: Record<string, MeterMode> = {
    LIMBO: 'other', TEMPERATURE: 'temperature', OHMS: 'resistance', OHMS_LOW: 'resistance', CONDUCTANCE: 'conductance',
    CONTINUITY: 'continuity', CAPACITANCE: 'capacitance', DIODE_TEST: 'diode', V_AC_LOZ: 'acVolts',
  };
  for (const [prefix, quantity] of [['V', 'Volts'], ['MV', 'Volts'], ['A', 'Amps'], ['MA', 'Amps'], ['UA', 'Amps']] as const) {
    table[`${prefix}_AC`] = quantity === 'Volts' ? 'acVolts' : 'acAmps';
    table[`${prefix}_DC`] = quantity === 'Volts' ? 'dcVolts' : 'dcAmps';
    table[`${prefix}_AC_OVER_DC`] = quantity === 'Volts' ? 'acVolts' : 'acAmps';
    table[`${prefix}_DC_OVER_AC`] = quantity === 'Volts' ? 'dcVolts' : 'dcAmps';
    table[`${prefix}_AC_PLUS_DC`] = quantity === 'Volts' ? 'acdcVolts' : 'acdcAmps';
  }
  return table;
})();

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function applyState(reading: MeterReading, state: string, value: number): void {
  if (OVERLOAD_STATES.has(state)) { reading.flags.ol = true; reading.display = state === 'OL_MINUS' ? '-OL' : 'OL'; return; }
  if (INVALID_STATES.has(state)) { reading.flags.invalid = true; return; }
  if (state !== 'NORMAL') { reading.flags.invalid = true; return; }
  reading.value = value;
}

/** A QM line: value,unit,state,attribute. Null when the line is not one. */
export function parseFlukeQm(line: string, at: number): MeterReading | null {
  const fields = line.split(',').map(field => field.trim());
  if (fields.length !== 4 || !NUMBER.test(fields[0])) return null;
  const unit = UNITS[fields[1].toUpperCase()];
  if (!unit) return null;
  const state = fields[2].toUpperCase();
  const attribute = fields[3].toUpperCase();
  const reading: MeterReading = { family: 'fluke-28x', value: null, unit: unit.unit, mode: unit.mode, flags: makeFlags(), at };
  applyState(reading, state, Number(fields[0]));
  if (unit.mode === 'dcVolts') {
    if (attribute === 'GOOD_DIODE') reading.mode = 'diode';
    else reading.caveat = 'mode-ambiguous';
  } else if (unit.mode === 'resistance' && (attribute === 'OPEN_CIRCUIT' || attribute === 'SHORT_CIRCUIT')) {
    reading.mode = 'continuity';
  }
  return reading;
}

/** A QDDA line. Null when the field count does not add up or the first field is not a function. */
export function parseFlukeQdda(line: string, at: number): MeterReading | null {
  const f = line.split(',').map(field => field.trim());
  if (f.length < 10) return null;
  const mode = PRIMARY_FUNCTIONS[f[0].toUpperCase()];
  if (mode === undefined) return null;
  const modeCount = Number(f[8]);
  if (!Number.isInteger(modeCount) || modeCount < 0 || modeCount > 8 || f.length < 10 + modeCount) return null;
  const modes = f.slice(9, 9 + modeCount).map(name => name.toUpperCase());
  const readingCount = Number(f[9 + modeCount]);
  if (!Number.isInteger(readingCount) || readingCount < 0 || readingCount > 16) return null;
  const start = 10 + modeCount;
  if (f.length !== start + readingCount * 9) return null;

  interface Row { id: string; value: number; unit: string; multiplier: number; decimals: number; state: string; attribute: string; }
  const rows: Row[] = [];
  for (let i = 0; i < readingCount; i++) {
    const r = f.slice(start + i * 9, start + i * 9 + 9);
    if (!NUMBER.test(r[1])) return null;
    rows.push({ id: r[0].toUpperCase(), value: Number(r[1]), unit: r[2].toUpperCase(), multiplier: Number(r[3]), decimals: Number(r[4]), state: r[6].toUpperCase(), attribute: r[7].toUpperCase() });
  }
  const primary = rows.find(row => row.id === 'PRIMARY') ?? rows.find(row => row.id === 'LIVE');
  if (!primary) return null;
  const unit = UNITS[primary.unit];
  if (!unit) return null;

  const flags = makeFlags({
    auto: f[2].toUpperCase() === 'AUTO',
    hold: modes.includes('HOLD') || modes.includes('AUTO_HOLD'),
    rel: modes.includes('REL') || modes.includes('REL_PERCENT'),
  });
  const reading: MeterReading = { family: 'fluke-28x', value: null, unit: unit.unit, mode, flags, at };
  if (mode === 'other') flags.invalid = true;
  else applyState(reading, primary.state, primary.value);
  if (Number.isFinite(primary.multiplier) && Number.isFinite(primary.decimals)) reading.resolution = 10 ** (primary.multiplier - primary.decimals);

  const second = rows.find(row => row.id === 'SECONDARY');
  const secondUnit = second ? UNITS[second.unit] : undefined;
  if (second && secondUnit && second.state === 'NORMAL') {
    const secondary: MeterSecondary = { value: second.value, unit: secondUnit.unit, display: String(second.value) };
    reading.secondary = secondary;
  }
  return reading;
}

/** FLUKE 289,V1.00,95081087 */
export function parseFlukeIdentity(line: string): FlukeIdentity | null {
  if (!/^FLUKE\b/i.test(line)) return null;
  const parts = line.split(',').map(part => part.trim());
  return { model: parts[0] ?? '', version: parts[1] ?? '', serial: parts[2] ?? '', line };
}

export interface Fluke28xDecoder extends MeterDecoder {
  /** The last identity line seen. */
  readonly identity: FlukeIdentity | null;
  /** The last acknowledgement digit seen (0 ok, 1 syntax error, 2 execution error, 5 no data). */
  readonly lastAck: number | null;
  /** Acknowledgements other than 0. */
  readonly ackErrors: number;
}

const MAX_LINE = 1024;
const ACK = /^(?:[A-Za-z]{2,5},)?(\d)$/;

export function createFluke28xDecoder(options: { now?: () => number } = {}): Fluke28xDecoder {
  let identity: FlukeIdentity | null = null;
  let lastAck: number | null = null;
  let ackErrors = 0;
  // After a line that was cut by a stray byte or ran too long, the rest of it up to its CR is dropped: the tail of a damaged
  // QM line ("0,VDC,NORMAL,NONE") would otherwise read as a valid line with the wrong value.
  let skipToEol = false;
  const base = createStreamDecoder({
    family: 'fluke-28x',
    now: options.now,
    maxBuffer: 2 * MAX_LINE,
    scan(front: Uint8Array, at: number): ScanResult {
      if (skipToEol) {
        const cr = front.indexOf(0x0d);
        if (cr < 0) return { kind: 'garbage', length: front.length };
        skipToEol = false;
        return { kind: 'garbage', length: cr + 1 };
      }
      // Only printable ASCII and line ends belong to a response; anything else cannot start a line.
      const first = front[0];
      if (first !== 0x0a && first !== 0x0d && (first < 0x20 || first > 0x7e)) return { kind: 'garbage', length: 1 };
      let end = -1;
      let text = '';
      for (let i = 0; i < front.length; i++) {
        const byte = front[i];
        if (byte === 0x0d) { end = i; break; }
        if (byte === 0x0a) continue;
        if (byte < 0x20 || byte > 0x7e) { skipToEol = true; return { kind: 'garbage', length: i + 1, bad: true }; }
        text += String.fromCharCode(byte);
        if (text.length > MAX_LINE) { skipToEol = true; return { kind: 'garbage', length: i + 1, bad: true }; }
      }
      if (end < 0) return { kind: 'need-more' };
      const length = end + 1;
      text = text.trim();
      if (text === '') return { kind: 'garbage', length };

      const ack = ACK.exec(text);
      if (ack) {
        lastAck = Number(ack[1]);
        if (lastAck !== 0) ackErrors++;
        return { kind: 'frame', length, readings: [] };
      }
      const ident = parseFlukeIdentity(text);
      if (ident) { identity = ident; return { kind: 'frame', length, readings: [] }; }
      const reading = parseFlukeQm(text, at) ?? parseFlukeQdda(text, at);
      if (reading) return { kind: 'frame', length, readings: [reading] };
      return { kind: 'garbage', length, bad: true };
    },
  });
  return {
    family: base.family,
    stats: base.stats,
    push: base.push,
    reset: () => { skipToEol = false; base.reset(); },
    get identity() { return identity; },
    get lastAck() { return lastAck; },
    get ackErrors() { return ackErrors; },
  };
}
