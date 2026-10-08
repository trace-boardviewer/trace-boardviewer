/**
 * Measured versus known-good: pairing, tolerance, flags and the out-of-tolerance list. Pure TypeScript.
 *
 * PAIRING. A measured reading is compared with a reference (source `known-good` or `imported`) that has
 *  - the same kind;
 *  - the same target: the same pin (or part); or, for a pin reading, a net reference on the net that pin is on (the net recorded with
 *    the reading, or what `netOf` says for the open board);
 *  - the same conditions: power; state label (both absent, or equal ignoring case); the point of the other lead (absent = ground, and a
 *    net named like ground counts as ground); meter mode for voltage (absent = dc). Polarity must be equal when both readings record
 *    it; when one of them does not, they are still paired and the result is flagged `polarity-assumed`.
 * Among several references the choice is fixed: known-good before imported, a pin reference before a net reference, the later
 * `takenAt`, then the smaller id. Among several measured readings of one target and condition set only the latest counts (`latestMeasured`).
 *
 * TOLERANCE. Allowed deviation = max(abs, rel x |reference|). The reference's own `tolerance` replaces the defaults entirely; without
 * one, the default of the kind applies (`DEFAULT_TOLERANCES`, overridable per kind): diode max(20 mV, 5 %), voltage max(50 mV, 5 %),
 * resistance max(0.5 ohm, 10 %). The absolute part keeps a reference of zero (a grounded net, a dead rail) comparable. The edge is
 * inclusive, with a relative slack of 1e-9 so that 1.05 V against 1 V at 5 % passes despite binary rounding.
 *
 * FLAGS. OL against OL passes; OL against a number fails (`unexpected-open`) and a number against OL fails (`unexpected-value`), both
 * with an infinite score. A failing diode value under 0.05 V or resistance under 1 ohm whose reference is at least twice that is a
 * `short-suspect`. Continuity passes when `connected` is equal. Different kinds are `incomparable` (each kind has one unit).
 * The score is |deviation| / allowed (0 to 1 passes); the out-of-tolerance list is sorted by score, worst first.
 */
import { createGroundMatcher } from '../net-class';
import type { NameMatcher } from '../net-class';
import { readingKeyText } from './schema';
import type { NumericKind, Reading, ReadingPoint, ReadingTolerance } from './schema';

export interface ToleranceRule { abs: number; rel: number }
export const DEFAULT_TOLERANCES: Readonly<Record<NumericKind, ToleranceRule>> = Object.freeze({
  diode: Object.freeze({ abs: 0.02, rel: 0.05 }),
  voltage: Object.freeze({ abs: 0.05, rel: 0.05 }),
  resistance: Object.freeze({ abs: 0.5, rel: 0.1 }),
});
/** A failing value below this, with a reference at least twice as high, suggests a short. */
export const SHORT_SUSPECT: Readonly<Partial<Record<NumericKind, number>>> = Object.freeze({ diode: 0.05, resistance: 1 });
const EDGE_SLACK = 1e-9;

export type ComparisonFlag = 'short-suspect' | 'unexpected-open' | 'unexpected-value' | 'polarity-assumed';
export interface Comparison {
  status: 'pass' | 'fail' | 'incomparable';
  flags: ComparisonFlag[];
  /** measured - reference in the SI unit; null for OL, continuity and incomparable pairs. */
  deviation: number | null;
  /** Allowed |deviation|; null where no number is compared. */
  allowed: number | null;
  /** |deviation| / allowed; Infinity for an OL or continuity mismatch; 0 for a pass without numbers. */
  score: number;
}

export interface CompareOptions {
  /** Default tolerance per kind (merged over DEFAULT_TOLERANCES). */
  tolerances?: Partial<Record<NumericKind, ToleranceRule>>;
  /** Ground name patterns (net-class.ts); a reference point on a net named like ground is ground. */
  groundPatterns?: readonly string[];
  /** Net of a pin on the open board, for pairing a pin reading with a net reference. */
  netOf?: (ref: string, pin: string) => string | undefined;
}

const isReference = (reading: Reading): boolean => reading.source === 'known-good' || reading.source === 'imported';

function allowedDeviation(reference: Reading, kind: NumericKind, tolerances: Partial<Record<NumericKind, ToleranceRule>> | undefined): number {
  const own: ReadingTolerance | undefined = reference.tolerance;
  const magnitude = Math.abs(reference.value ?? 0);
  if (own) return Math.max(own.abs ?? 0, (own.rel ?? 0) * magnitude);
  const rule = tolerances?.[kind] ?? DEFAULT_TOLERANCES[kind];
  return Math.max(rule.abs, rule.rel * magnitude);
}

/** Compares one measured reading with one reference (pairing is the caller's job, see `findReference`). */
export function compareReading(measured: Reading, reference: Reading, options: CompareOptions = {}): Comparison {
  const flags: ComparisonFlag[] = [];
  if (measured.conditions.polarity !== reference.conditions.polarity) flags.push('polarity-assumed');
  if (measured.kind !== reference.kind) {
    return { status: 'incomparable', flags, deviation: null, allowed: null, score: 0 };
  }
  if (measured.kind === 'continuity') {
    const same = measured.connected === reference.connected;
    return { status: same ? 'pass' : 'fail', flags, deviation: null, allowed: null, score: same ? 0 : Infinity };
  }
  const kind = measured.kind;
  if (measured.ol || reference.ol) {
    if (measured.ol && reference.ol) return { status: 'pass', flags, deviation: null, allowed: null, score: 0 };
    if (measured.ol) flags.push('unexpected-open');
    else {
      flags.push('unexpected-value');
      const limit = SHORT_SUSPECT[kind];
      if (limit !== undefined && measured.value! < limit) flags.push('short-suspect');
    }
    return { status: 'fail', flags, deviation: null, allowed: null, score: Infinity };
  }
  const m = measured.value!, r = reference.value!;
  const deviation = m - r;
  const allowed = allowedDeviation(reference, kind, options.tolerances);
  const size = Math.abs(deviation);
  const pass = size <= allowed * (1 + EDGE_SLACK) + Number.MIN_VALUE;
  const score = allowed > 0 ? size / allowed : size === 0 ? 0 : Infinity;
  if (!pass) {
    const limit = SHORT_SUSPECT[kind];
    if (limit !== undefined && m < limit && r >= 2 * limit) flags.push('short-suspect');
  }
  return { status: pass ? 'pass' : 'fail', flags, deviation, allowed, score: pass ? Math.min(score, 1) : score };
}

// ---------------------------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------------------------

/** Key of the point the other lead sits on; "@ground" (which no escaped name can spell) for board ground. */
function pointKey(point: ReadingPoint | undefined, ground: NameMatcher): string {
  if (point === undefined || (point.net !== undefined && ground(point.net))) return '@ground';
  return readingKeyText(point);
}
const stateKey = (state: string | undefined): string => (state === undefined ? '' : state.trim().toLowerCase());

/** The condition part of a pairing key (polarity excluded: it is matched loosely). */
function conditionKey(reading: Reading, ground: NameMatcher): string {
  const c = reading.conditions;
  const mode = reading.kind === 'voltage' ? (c.meterMode ?? 'dc') : '';
  return `${reading.kind}\u0000${c.power}\u0000${stateKey(c.state)}\u0000${pointKey(c.reference, ground)}\u0000${mode}`;
}

const sourceRank = (reading: Reading): number => (reading.source === 'known-good' ? 0 : 1);
/** Order of preference among references (best first). */
function better(a: Reading, aNet: boolean, b: Reading, bNet: boolean): boolean {
  if (sourceRank(a) !== sourceRank(b)) return sourceRank(a) < sourceRank(b);
  if (aNet !== bNet) return !aNet;
  const ta = a.takenAt ?? '', tb = b.takenAt ?? '';
  if (ta !== tb) return Date.parse(ta || '1970-01-01T00:00Z') > Date.parse(tb || '1970-01-01T00:00Z');
  return a.id < b.id;
}

export interface ReferenceIndex {
  /** The preferred reference for a measured reading, or null. `candidates` counts every reference that would pair. */
  find(measured: Reading): { reference: Reading; viaNet: boolean; candidates: number } | null;
}

/** Index of the references among `readings` for pairing (build once, query per measured reading). */
export function indexReferences(readings: Iterable<Reading>, options: CompareOptions = {}): ReferenceIndex {
  const ground = createGroundMatcher(options.groundPatterns);
  const byKey = new Map<string, Reading[]>();
  for (const reading of readings) {
    if (!isReference(reading)) continue;
    const key = `${readingKeyText(reading.target)}\u0001${conditionKey(reading, ground)}`;
    const list = byKey.get(key);
    if (list) list.push(reading); else byKey.set(key, [reading]);
  }
  const polarityFits = (a: Reading, b: Reading): boolean => a.conditions.polarity === undefined || b.conditions.polarity === undefined || a.conditions.polarity === b.conditions.polarity;
  return {
    find(measured) {
      const condition = conditionKey(measured, ground);
      const direct = (byKey.get(`${readingKeyText(measured.target)}\u0001${condition}`) ?? []).filter(reference => polarityFits(measured, reference));
      let viaNet: Reading[] = [];
      if (measured.target.pin !== undefined && measured.target.ref !== undefined) {
        const net = options.netOf?.(measured.target.ref, measured.target.pin) ?? measured.target.net;
        if (net !== undefined) viaNet = (byKey.get(`${readingKeyText({ net })}\u0001${condition}`) ?? []).filter(reference => polarityFits(measured, reference));
      }
      let best: Reading | null = null, bestNet = false;
      for (const reference of direct) if (!best || better(reference, false, best, bestNet)) { best = reference; bestNet = false; }
      for (const reference of viaNet) if (!best || better(reference, true, best, bestNet)) { best = reference; bestNet = true; }
      return best ? { reference: best, viaNet: bestNet, candidates: direct.length + viaNet.length } : null;
    },
  };
}

/** The latest measured reading per target and condition set (by `takenAt`, then by position: later wins). */
export function latestMeasured(readings: Iterable<Reading>, options: Pick<CompareOptions, 'groundPatterns'> = {}): Reading[] {
  const ground = createGroundMatcher(options.groundPatterns);
  const latest = new Map<string, Reading>();
  for (const reading of readings) {
    if (reading.source !== 'measured') continue;
    const key = `${readingKeyText(reading.target)}\u0001${conditionKey(reading, ground)}\u0001${reading.conditions.polarity ?? ''}`;
    const current = latest.get(key);
    const at = reading.takenAt === undefined ? NaN : Date.parse(reading.takenAt);
    const before = current?.takenAt === undefined ? NaN : Date.parse(current.takenAt);
    if (!current || Number.isNaN(at) || Number.isNaN(before) || at >= before) latest.set(key, reading);
  }
  return [...latest.values()];
}

export interface ComparedReading { measured: Reading; reference: Reading | null; viaNet: boolean; result: Comparison | null }
export interface ComparisonReport {
  /** One entry per current measured reading. */
  rows: ComparedReading[];
  /** Failing rows, worst score first (then by target key). */
  outOfTolerance: ComparedReading[];
  /** Measured readings without a reference to compare with. */
  missingReference: Reading[];
  /**
   * Readings that suggest a short (`isShortSuspect`) and are not cleared by a reference: failing rows flagged `short-suspect` and
   * suspect readings without a reference, lowest value first.
   */
  shortSuspects: Reading[];
  counts: { pass: number; fail: number; incomparable: number; missing: number };
}

/**
 * A measured value that suggests a short on its own (R2 2.6): under 0.05 V in diode mode or under 1 ohm, taken against ground, on a
 * target that is not itself a ground net. OL and continuity never are.
 */
export function isShortSuspect(reading: Reading, ground: NameMatcher = createGroundMatcher()): boolean {
  if (reading.kind !== 'diode' && reading.kind !== 'resistance') return false;
  const limit = SHORT_SUSPECT[reading.kind];
  if (limit === undefined || reading.value === undefined || !(reading.value < limit)) return false;
  const reference = reading.conditions.reference;
  if (reference !== undefined && !(reference.net !== undefined && ground(reference.net))) return false;
  const net = reading.target.net; // the net itself, or the net the pin was on
  return net === undefined || !ground(net);
}

/** Compares the current measured readings of a family with its references. */
export function compareAll(readings: readonly Reading[], options: CompareOptions = {}): ComparisonReport {
  const index = indexReferences(readings, options);
  const ground = createGroundMatcher(options.groundPatterns);
  const report: ComparisonReport = { rows: [], outOfTolerance: [], missingReference: [], shortSuspects: [], counts: { pass: 0, fail: 0, incomparable: 0, missing: 0 } };
  for (const measured of latestMeasured(readings, options)) {
    const found = index.find(measured);
    if (!found) {
      report.rows.push({ measured, reference: null, viaNet: false, result: null });
      report.missingReference.push(measured);
      report.counts.missing++;
      if (isShortSuspect(measured, ground)) report.shortSuspects.push(measured);
      continue;
    }
    const result = compareReading(measured, found.reference, options);
    const row = { measured, reference: found.reference, viaNet: found.viaNet, result };
    report.rows.push(row);
    report.counts[result.status]++;
    if (result.status === 'fail') report.outOfTolerance.push(row);
    if (result.flags.includes('short-suspect')) report.shortSuspects.push(measured);
  }
  report.shortSuspects.sort((a, b) => ((a.value ?? 0) - (b.value ?? 0)) || (readingKeyText(a.target) < readingKeyText(b.target) ? -1 : 1));
  report.outOfTolerance.sort((a, b) => (b.result!.score - a.result!.score) || (readingKeyText(a.measured.target) < readingKeyText(b.measured.target) ? -1 : 1));
  return report;
}

export type NetVerdict = 'fail' | 'incomparable' | 'pass';
export interface NetSummary { status: NetVerdict; worstScore: number; rows: number }

/** Worst verdict per net: a net fails when any reading on it (net reading, or pin reading on one of its pins) fails. */
export function summarizeByNet(rows: readonly ComparedReading[], netOf?: (ref: string, pin: string) => string | undefined): Map<string, NetSummary> {
  const rank: Record<NetVerdict, number> = { fail: 2, incomparable: 1, pass: 0 };
  const nets = new Map<string, NetSummary>();
  for (const row of rows) {
    if (!row.result) continue;
    const target = row.measured.target;
    const net = target.ref !== undefined && target.pin !== undefined ? netOf?.(target.ref, target.pin) ?? target.net : target.ref === undefined ? target.net : undefined;
    if (net === undefined) continue;
    const current = nets.get(net) ?? { status: 'pass' as NetVerdict, worstScore: 0, rows: 0 };
    current.rows++;
    if (rank[row.result.status] > rank[current.status]) current.status = row.result.status;
    if (row.result.status === 'fail' && row.result.score > current.worstScore) current.worstScore = row.result.score;
    nets.set(net, current);
  }
  return nets;
}
