/**
 * Meter link: common types.
 *
 * Everything under src/lib/meters is pure: bytes (or text) in, readings out, no I/O, no timers, no globals. Transports (WebHID,
 * Web Serial, Web Bluetooth, a sigrok-cli process, a polled file) feed the decoders; the decoders never talk to a device.
 *
 * A `MeterReading` is what the meter shows, not what the technician wants to store:
 *   - `value` is in SI base units (volt, ampere, ohm, farad, hertz, second, siemens, degree Celsius or Fahrenheit, percent),
 *     so a 220.00 mV range gives 0.22 and a 2.2 kohm range gives 2200. `null` when the display shows no number.
 *   - `flags.ol` is the over-range display ("OL"); the value is then `null`. `flags.invalid` is any other display without a
 *     number (blank, discharge error, a mode that has no numeric reading such as non-contact voltage).
 *   - `resolution` is the size of one count on the display (the last digit shown), in the same unit as `value`. The stability
 *     detector uses it for its "2 counts" tolerance.
 *   - `caveat` marks a reading whose mode or scale had to be assumed from the protocol; the application must not capture such a
 *     reading automatically.
 */

/** What the meter is measuring. */
export type MeterMode =
  | 'dcVolts' | 'acVolts' | 'acdcVolts'
  | 'dcAmps' | 'acAmps' | 'acdcAmps'
  | 'resistance' | 'continuity' | 'diode' | 'capacitance'
  | 'frequency' | 'duty' | 'temperature' | 'conductance' | 'transistorGain' | 'ncv'
  | 'other';

/** Units of `MeterReading.value`. The ohm sign is U+03A9; a unit-less reading (transistor gain) has ''. */
export type MeterUnit = 'V' | 'A' | 'Ω' | 'F' | 'Hz' | '%' | '°C' | '°F' | 'S' | 's' | 'dB' | '';

export const OHM: MeterUnit = 'Ω';
export const DEG_C: MeterUnit = '°C';
export const DEG_F: MeterUnit = '°F';

/** Every transport/decoder family, including the two that are not meters. */
export type MeterFamilyId = 'ut61e' | 'ut61eplus' | 'owon-b35' | 'fluke-28x' | 'brymen-bm86x' | 'file-bridge' | 'simulated';

export interface MeterFlags {
  /** The display shows over-range ("OL"). `value` is null. */
  ol: boolean;
  /** The display shows no number for another reason (blank, error, a mode without a numeric reading). `value` is null. */
  invalid: boolean;
  /** The meter's HOLD is on. Some families keep streaming live values in HOLD, others send the frozen one. */
  hold: boolean;
  /** Relative (delta) mode: the value is a difference to a stored reference, not an absolute reading. */
  rel: boolean;
  /** Automatic ranging. False when manual, or when the family does not report it. */
  auto: boolean;
  lowBattery: boolean;
  /** The shown value is a recorded minimum / maximum (or peak) rather than the live value. */
  min: boolean;
  max: boolean;
}

/** Why a reading must not be trusted blindly. */
export type MeterCaveat =
  /** The mode could not be told from the protocol (diode versus volts, continuity versus ohms, a file without mode words). */
  | 'mode-ambiguous'
  /** The scale (range prefix) was assumed because the protocol sources do not state it. */
  | 'scale-assumed';

/** The second display of a dual-display meter. */
export interface MeterSecondary {
  value: number | null;
  unit: MeterUnit;
  /** The text on the display. */
  display: string;
  ol?: boolean;
}

export interface MeterReading {
  family: MeterFamilyId;
  /** SI value, or null when the display shows no number. */
  value: number | null;
  unit: MeterUnit;
  mode: MeterMode;
  flags: MeterFlags;
  /** Milliseconds, from the clock the caller gives the decoder (epoch milliseconds in the application). */
  at: number;
  /** What the meter shows, when the protocol carries text ("-0.0850", "OL"). */
  display?: string;
  /** One count of the last digit, in `unit`. */
  resolution?: number;
  caveat?: MeterCaveat;
  secondary?: MeterSecondary;
}

export function makeFlags(over: Partial<MeterFlags> = {}): MeterFlags {
  return { ol: false, invalid: false, hold: false, rel: false, auto: false, lowBattery: false, min: false, max: false, ...over };
}

/** The modes of the readings schema (R2 section 2.6) plus the two the stability detector must tell apart. */
export type CaptureMode = 'diode' | 'voltage' | 'resistance' | 'current' | 'frequency' | 'capacitance' | 'continuity' | 'temperature' | 'other';

/** The coarse mode a capture is made in; continuity is its own mode here because a resistance capture must not accept it. */
export function captureModeOf(mode: MeterMode): CaptureMode {
  switch (mode) {
    case 'dcVolts': case 'acVolts': case 'acdcVolts': return 'voltage';
    case 'dcAmps': case 'acAmps': case 'acdcAmps': return 'current';
    case 'resistance': return 'resistance';
    case 'continuity': return 'continuity';
    case 'diode': return 'diode';
    case 'capacitance': return 'capacitance';
    case 'frequency': return 'frequency';
    case 'temperature': return 'temperature';
    default: return 'other';
  }
}

/** The `mode` field of a stored reading (R2 section 2.6): diode, voltage, resistance, current, frequency, capacitance or other. */
export type StoredReadingMode = 'diode' | 'voltage' | 'resistance' | 'current' | 'frequency' | 'capacitance' | 'other';

export function storedReadingModeOf(mode: MeterMode): StoredReadingMode {
  const capture = captureModeOf(mode);
  if (capture === 'continuity') return 'resistance';
  if (capture === 'temperature') return 'other';
  return capture;
}

/** True for the modes whose value is a DC quantity (or both). Used by the stability detector's coupling check. */
export function modeCoupling(mode: MeterMode): 'dc' | 'ac' | 'acdc' | null {
  switch (mode) {
    case 'dcVolts': case 'dcAmps': return 'dc';
    case 'acVolts': case 'acAmps': return 'ac';
    case 'acdcVolts': case 'acdcAmps': return 'acdc';
    default: return null;
  }
}

export interface MeterDecoderStats {
  /** Bytes (or characters) given to the decoder. */
  bytes: number;
  /** Frames (or lines) that passed the family's validation. */
  frames: number;
  readings: number;
  /** Frame-shaped data that failed validation (checksum, impossible code) and was dropped. */
  badFrames: number;
  /** Bytes dropped while looking for the next frame start. */
  skippedBytes: number;
  /** Runs of garbage the decoder had to skip to find a frame again. */
  resyncs: number;
}

/**
 * Bytes in, readings out. A decoder keeps a bounded buffer, so chunks may split a frame anywhere; garbage between frames is
 * skipped and counted, never thrown.
 */
export interface MeterDecoder {
  readonly family: MeterFamilyId;
  /** Feed the next chunk. `at` is the arrival time of the chunk (default: the decoder's clock). */
  push(chunk: ArrayLike<number>, at?: number): MeterReading[];
  /** Forget the buffered partial frame (after a reconnect) and keep the counters. */
  reset(): void;
  readonly stats: Readonly<MeterDecoderStats>;
}

/** The transport-facing shape the later UI work uses (R2 section 2.7). */
export interface MeterSource {
  readonly family: MeterFamilyId;
  connect(): Promise<void>;
  readonly samples: AsyncIterable<MeterReading>;
  close(): Promise<void> | void;
}

export interface MeterFamilyInfo {
  id: MeterFamilyId;
  /** Product names, for the support table. */
  models: readonly string[];
  /** Every family here is untested on hardware until the owner's checklist run says otherwise. */
  status: 'experimental' | 'simulated' | 'tool';
  link: 'serial' | 'hid' | 'ble' | 'file' | 'none';
  /** Titles of the public documents the decoder follows. */
  documents: readonly string[];
  /** What the decoder cannot tell, in plain words. */
  limits: readonly string[];
}
