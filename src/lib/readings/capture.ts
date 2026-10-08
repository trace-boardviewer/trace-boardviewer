/**
 * Golden-board capture: a keyboard-driven walk over a working board that turns typed (or meter) values into known-good readings.
 * Pure state: every action returns a new session, so the UI can keep it, undo it or store it.
 *
 * ORDER (`captureSteps`): each net is visited once, in four groups:
 *  1. main rails: power nets (net-class.ts) whose name does not extend another power net's name;
 *  2. sub-rails: power nets whose name extends one ("PP3V3_S5_SW" after "PP3V3_S5", "+5V_USB" after "+5V");
 *     each group with the most pins first, then by name; rails are captured as net readings;
 *  3. test points: a pin of each test-point part (part-kind.ts) on a net not visited yet, by reference in natural order;
 *  4. connector pins: each pin of each connector on a net not visited yet, by reference and pin number in natural order.
 * Ground and no-connect nets are never steps (readings are taken against ground). A scope (a list of net names, for example one rail
 * tree from the rail walk) keeps only the steps on those nets.
 *
 * ACTIONS: record (parse the text for the kind and advance), skip (advance, leave a gap), back (return to the previous step to
 * measure it again), go to a step, comment (a note on a step). `captureReadings` turns the recorded steps into readings with source
 * `known-good`, the session's conditions, the time of each entry and the typed text in `raw`. The pack built from them is checked by
 * `auditPack` before it is shared.
 */
import { classifyBoardNets } from '../net-class';
import { classifyComponent } from '../part-kind';
import type { Board, BoardComponent } from '../types';
import { READINGS_LIMITS, canonicalName, validateReading } from './schema';
import type { Reading, ReadingConditions, ReadingKind, ReadingTarget } from './schema';
import { parseReadingValue } from './value';
import type { ParsedValue } from './value';

export type CaptureGroup = 'main-rail' | 'sub-rail' | 'test-point' | 'connector-pin';
export interface CaptureStep { target: ReadingTarget; net: string; group: CaptureGroup }
export interface CaptureEntry {
  status: 'recorded' | 'skipped';
  /** The parsed value (recorded entries only). */
  value?: Extract<ParsedValue, { ok: true }>;
  raw?: string;
  note?: string;
  takenAt?: string;
}
export interface CaptureSession {
  readonly kind: ReadingKind;
  readonly conditions: ReadingConditions;
  readonly steps: readonly CaptureStep[];
  /** The step to measure now; equals steps.length when the walk is done. */
  readonly index: number;
  readonly entries: ReadonlyArray<CaptureEntry | undefined>;
}
export interface CaptureOptions {
  kind: ReadingKind;
  conditions: ReadingConditions;
  /** Only steps on these nets (names as the board writes them). */
  scope?: readonly string[];
  groundPatterns?: readonly string[];
}

/** Natural order: digit runs compare by value ("R2" before "R10"), everything else by UTF-16 code unit. */
export function naturalCompare(a: string, b: string): number {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i), cb = b.charCodeAt(j);
    const da = ca >= 48 && ca <= 57, db = cb >= 48 && cb <= 57;
    if (da && db) {
      let ei = i, ej = j;
      while (ei < a.length && a.charCodeAt(ei) >= 48 && a.charCodeAt(ei) <= 57) ei++;
      while (ej < b.length && b.charCodeAt(ej) >= 48 && b.charCodeAt(ej) <= 57) ej++;
      const na = a.slice(i, ei).replace(/^0+(?=\d)/, ''), nb = b.slice(j, ej).replace(/^0+(?=\d)/, '');
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
      i = ei; j = ej; continue;
    }
    if (ca !== cb) return ca - cb;
    i++; j++;
  }
  return (a.length - i) - (b.length - j);
}

const BOUNDARY = /[_\-./]/;
/** Power nets whose name extends another power net's name at a boundary character. */
function subRails(names: readonly string[]): Set<string> {
  const upper = names.map(name => name.toUpperCase());
  const sorted = [...upper].sort();
  const subs = new Set<string>();
  // After sorting, a name's extensions follow it directly (shared prefix); a scan with a stack of open prefixes is linear in practice.
  const stack: string[] = [];
  for (const name of sorted) {
    while (stack.length && !name.startsWith(stack[stack.length - 1])) stack.pop();
    const parent = stack.find(prefix => name.length > prefix.length && name.startsWith(prefix) && BOUNDARY.test(name[prefix.length]));
    if (parent) subs.add(name);
    stack.push(name);
  }
  return new Set(names.filter((_, index) => subs.has(upper[index])));
}

/** The steps of a capture walk over `board` (see the order above). */
export function captureSteps(board: Pick<Board, 'nets' | 'pins' | 'components'>, options: Pick<CaptureOptions, 'scope' | 'groundPatterns'> = {}): CaptureStep[] {
  const classes = classifyBoardNets(board, { groundPatterns: options.groundPatterns });
  const scope = options.scope ? new Set(options.scope) : null;
  const inScope = (net: string): boolean => scope === null || scope.has(net);
  const visited = new Set<string>();
  const steps: CaptureStep[] = [];
  const power = board.nets.filter(net => classes.classOf(net.name).kind === 'power' && net.name !== '');
  const subs = subRails(power.map(net => net.name));
  const byPins = (a: { name: string; pinIds: string[] }, b: { name: string; pinIds: string[] }) => (b.pinIds.length - a.pinIds.length) || naturalCompare(a.name, b.name);
  for (const group of ['main-rail', 'sub-rail'] as const) {
    for (const net of power.filter(item => subs.has(item.name) === (group === 'sub-rail')).sort(byPins)) {
      const name = canonicalName(net.name, READINGS_LIMITS.net);
      if (name === null || visited.has(net.name) || !inScope(net.name)) continue;
      visited.add(net.name);
      steps.push({ target: { net: name }, net: net.name, group });
    }
  }
  const pins = new Map(board.pins.map(pin => [pin.id, pin]));
  const countedNet = (net: string): boolean => { const kind = classes.classOf(net).kind; return kind === 'power' || kind === 'signal'; };
  const partSteps = (parts: BoardComponent[], group: CaptureGroup, onePerPart: boolean) => {
    for (const component of parts.sort((a, b) => naturalCompare(a.ref, b.ref))) {
      const ref = component.refGenerated ? null : canonicalName(component.ref, READINGS_LIMITS.name);
      if (ref === null) continue;
      const own = component.pinIds.map(id => pins.get(id)).filter(pin => pin !== undefined && !pin.numberGenerated)
        .sort((a, b) => naturalCompare(a!.number, b!.number));
      for (const pin of own) {
        const number = canonicalName(pin!.number, READINGS_LIMITS.name);
        if (number === null || !countedNet(pin!.net) || visited.has(pin!.net) || !inScope(pin!.net)) continue;
        visited.add(pin!.net);
        const net = canonicalName(pin!.net, READINGS_LIMITS.net);
        steps.push({ target: net === null ? { ref, pin: number } : { ref, pin: number, net }, net: pin!.net, group });
        if (onePerPart) break;
      }
    }
  };
  const kinds = new Map(board.components.map(component => [component, classifyComponent(component).kind]));
  partSteps(board.components.filter(component => kinds.get(component) === 'testpoint'), 'test-point', true);
  partSteps(board.components.filter(component => kinds.get(component) === 'connector'), 'connector-pin', false);
  return steps;
}

export function createCaptureSession(board: Pick<Board, 'nets' | 'pins' | 'components'>, options: CaptureOptions): CaptureSession {
  const steps = captureSteps(board, options);
  return { kind: options.kind, conditions: options.conditions, steps, index: 0, entries: new Array(steps.length).fill(undefined) };
}

const withEntry = (session: CaptureSession, at: number, entry: CaptureEntry | undefined, index: number): CaptureSession => {
  const entries = session.entries.slice();
  entries[at] = entry;
  return { ...session, entries, index };
};

export type CaptureResult = { session: CaptureSession; error?: Extract<ParsedValue, { ok: false }>['reason'] | 'done' };

/** Parses `text` for the session's kind, stores it at the current step and moves to the next one. A note already on the step stays. */
export function captureRecord(session: CaptureSession, text: string, now: string): CaptureResult {
  if (session.index >= session.steps.length) return { session, error: 'done' };
  const parsed = parseReadingValue(text, session.kind);
  if (!parsed.ok) return { session, error: parsed.reason };
  const raw = text.trim().slice(0, READINGS_LIMITS.raw);
  const note = session.entries[session.index]?.note;
  const entry: CaptureEntry = { status: 'recorded', value: parsed, raw, takenAt: now };
  if (note !== undefined) entry.note = note;
  return { session: withEntry(session, session.index, entry, session.index + 1) };
}

/** Leaves the current step without a value and moves on (a recorded value there is dropped). */
export function captureSkip(session: CaptureSession): CaptureSession {
  if (session.index >= session.steps.length) return session;
  const note = session.entries[session.index]?.note;
  return withEntry(session, session.index, note === undefined ? { status: 'skipped' } : { status: 'skipped', note }, session.index + 1);
}

/** Back to the previous step (to measure it again; its entry stays until it is recorded or skipped anew). */
export function captureBack(session: CaptureSession): CaptureSession {
  return session.index === 0 ? session : { ...session, index: session.index - 1 };
}

export function captureGoTo(session: CaptureSession, index: number): CaptureSession {
  if (!Number.isInteger(index) || index < 0 || index > session.steps.length) return session;
  return { ...session, index };
}

/** A note on a step (default: the last step that was recorded or skipped, else the current one); empty text removes it. */
export function captureComment(session: CaptureSession, text: string, step?: number): CaptureSession {
  const at = step ?? (session.index > 0 ? session.index - 1 : 0);
  if (!Number.isInteger(at) || at < 0 || at >= session.steps.length) return session;
  const note = text.trim().slice(0, READINGS_LIMITS.note);
  const current = session.entries[at];
  const entry: CaptureEntry = current ? { ...current } : { status: 'skipped' };
  if (note === '') delete entry.note; else entry.note = note;
  // A note on a step not measured yet is kept on an entry that only becomes a reading once a value is recorded.
  return withEntry(session, at, current === undefined && note === '' ? undefined : entry, session.index);
}

export function captureProgress(session: CaptureSession): { total: number; recorded: number; skipped: number; remaining: number } {
  let recorded = 0, skipped = 0;
  for (const entry of session.entries) { if (entry?.status === 'recorded') recorded++; else if (entry?.status === 'skipped') skipped++; }
  return { total: session.steps.length, recorded, skipped, remaining: session.steps.length - recorded - skipped };
}

/** Known-good readings of the recorded steps, in step order. */
export function captureReadings(session: CaptureSession, newId: () => string): Reading[] {
  const readings: Reading[] = [];
  session.steps.forEach((step, index) => {
    const entry = session.entries[index];
    if (!entry || entry.status !== 'recorded' || !entry.value) return;
    const reading: Record<string, unknown> = { id: newId(), kind: session.kind, target: step.target };
    const value = entry.value;
    if ('connected' in value) reading.connected = value.connected;
    else if ('ol' in value) reading.ol = true;
    else { reading.value = value.value; reading.unit = value.unit; }
    if (entry.raw) reading.raw = entry.raw;
    reading.conditions = session.conditions;
    reading.source = 'known-good';
    if (entry.takenAt !== undefined) reading.takenAt = entry.takenAt;
    if (entry.note !== undefined) reading.note = entry.note;
    readings.push(validateReading(reading));
  });
  return readings;
}
