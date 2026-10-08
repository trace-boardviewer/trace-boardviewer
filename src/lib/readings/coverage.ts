/**
 * Coverage: which nets of the open board have a reading (for one kind and condition set), as counts, percentages and lists.
 *
 * A net is covered when a net reading names it, or a pin reading names a pin on it (the pin is looked up on the open board by its
 * reference and pin number, the keys of note-keys.ts; pads the file gives no number cannot hold readings and are left out). Ground
 * and no-connect nets (net-class.ts) are not counted: readings are taken against ground. `rails` are the power nets, `signals` all
 * other counted nets, `nets` both. A pin is covered when it has its own reading or its net is covered; pins on ground or no-connect
 * nets are not counted. Part readings (a reference without a pin) do not cover a net.
 */
import { classifyBoardNets } from '../net-class';
import type { Board } from '../types';
import { READINGS_LIMITS, canonicalName, readingKeyText } from './schema';
import type { PowerState, Reading, ReadingKind, ReadingSource } from './schema';

export interface CoverageOptions {
  kind?: ReadingKind;
  power?: PowerState;
  /** State label (compared ignoring case and blanks at the ends); absent: any state. */
  state?: string;
  /** Which sources count; default all. */
  sources?: readonly ReadingSource[];
  groundPatterns?: readonly string[];
}
export interface CoverageGroup { total: number; covered: number; /** 0 to 100, one decimal; 0 when there is nothing to cover. */ percent: number }
export interface RailCoverage { net: string; pinCount: number; expectedVolts: number | null; covered: boolean }
export interface CoverageReport {
  nets: CoverageGroup;
  rails: CoverageGroup;
  signals: CoverageGroup;
  pins: CoverageGroup;
  /** Every power net, most pins first. */
  railList: RailCoverage[];
  /** Nets without a reading: rails first, then signals, most pins first within each. */
  uncovered: string[];
}

const group = (total: number, covered: number): CoverageGroup => ({ total, covered, percent: total === 0 ? 0 : Math.round((covered / total) * 1000) / 10 });

/** Reading targets (text keys) that count under the options. */
function countedTargets(readings: Iterable<Reading>, options: CoverageOptions): { nets: Set<string>; pins: Set<string> } {
  const sources = options.sources ? new Set(options.sources) : null;
  const state = options.state?.trim().toLowerCase();
  const nets = new Set<string>(), pins = new Set<string>();
  for (const reading of readings) {
    if (options.kind !== undefined && reading.kind !== options.kind) continue;
    if (options.power !== undefined && reading.conditions.power !== options.power) continue;
    if (state !== undefined && (reading.conditions.state ?? '').trim().toLowerCase() !== state) continue;
    if (sources && !sources.has(reading.source)) continue;
    const target = reading.target;
    if (target.ref === undefined) { if (target.net !== undefined) nets.add(target.net); }
    else if (target.pin !== undefined) pins.add(readingKeyText(target));
  }
  return { nets, pins };
}

export function readingsCoverage(board: Pick<Board, 'nets' | 'pins' | 'components'>, readings: Iterable<Reading>, options: CoverageOptions = {}): CoverageReport {
  const classes = classifyBoardNets(board, { groundPatterns: options.groundPatterns });
  const { nets: netReadings, pins: pinReadings } = countedTargets(readings, options);
  const refs = new Map<string, string>();
  for (const component of board.components) {
    if (component.refGenerated) continue;
    const ref = canonicalName(component.ref, READINGS_LIMITS.name);
    if (ref !== null) refs.set(component.id, ref);
  }
  const counted = (name: string): boolean => { const kind = classes.classOf(name).kind; return kind === 'power' || kind === 'signal'; };
  // Nets covered through a pin reading, and the pins that are counted.
  const coveredNets = new Set<string>();
  const pinEntries: Array<{ key: string; net: string }> = [];
  const seen = new Set<string>();
  for (const pin of board.pins) {
    if (pin.numberGenerated || !counted(pin.net)) continue;
    const ref = refs.get(pin.componentId);
    const number = canonicalName(pin.number, READINGS_LIMITS.name);
    if (ref === undefined || number === null) continue;
    const key = readingKeyText({ ref, pin: number });
    // A pin drawn as several pads (thermal, split) is one pin.
    if (!seen.has(key)) { seen.add(key); pinEntries.push({ key, net: pin.net }); }
    if (pinReadings.has(key)) coveredNets.add(pin.net);
  }
  for (const net of board.nets) {
    const name = canonicalName(net.name, READINGS_LIMITS.net);
    if (name !== null && netReadings.has(name)) coveredNets.add(net.name);
  }
  const railList: RailCoverage[] = [];
  const uncoveredRails: Array<[string, number]> = [], uncoveredSignals: Array<[string, number]> = [];
  let rails = 0, railsCovered = 0, signals = 0, signalsCovered = 0;
  for (const net of board.nets) {
    const kind = classes.classOf(net.name);
    if (kind.kind !== 'power' && kind.kind !== 'signal') continue;
    const covered = coveredNets.has(net.name);
    if (kind.kind === 'power') {
      rails++; if (covered) railsCovered++; else uncoveredRails.push([net.name, net.pinIds.length]);
      railList.push({ net: net.name, pinCount: net.pinIds.length, expectedVolts: kind.expectedVoltage?.volts ?? null, covered });
    } else {
      signals++; if (covered) signalsCovered++; else uncoveredSignals.push([net.name, net.pinIds.length]);
    }
  }
  const byPins = (a: [string, number], b: [string, number]) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  railList.sort((a, b) => byPins([a.net, a.pinCount], [b.net, b.pinCount]));
  let pinsCovered = 0;
  for (const entry of pinEntries) if (pinReadings.has(entry.key) || coveredNets.has(entry.net)) pinsCovered++;
  return {
    nets: group(rails + signals, railsCovered + signalsCovered),
    rails: group(rails, railsCovered),
    signals: group(signals, signalsCovered),
    pins: group(pinEntries.length, pinsCovered),
    railList,
    uncovered: [...uncoveredRails.sort(byPins), ...uncoveredSignals.sort(byPins)].map(([name]) => name),
  };
}
