/**
 * Probe points: where on a net a meter probe can actually be put, best first, each with its reasons.
 *
 * Every pin of the net is scored (one best pin per part by default) from what the board file says; the constants are a heuristic,
 * listed here so that a rank can always be explained:
 *   test point                                        +50
 *   connector pin                                     +20
 *   through-hole pad (reachable from both sides)      +15
 *   pad area                                          +8 per mm², at most +20; a pad under 0.15 mm² -5; no size in the file 0
 *   pin of a small part (passive, diode; <= 3 pins)   +5
 *   pin of an IC or other many-pin part               -10 (fine pitch)
 *   ball-grid pin (package BGA/CSP/LGA, or ball names such as A1 or AB12 on a part of 16+ pins)   -60, not reachable
 *   pad under its own part's body (inner pad of a 4+ pin part, e.g. a QFN exposed pad)            -40, not reachable
 *   pad under another part of more than 50 pins on the same side (a BGA, a module)                -40, not reachable
 *   only on the side not in view                      -10
 *   distance from the view centre                     -1 per 10 mm, at most -10
 * Through-hole pads are never "under" a part: the other side reaches them. Reachable pads rank before unreachable ones, then by score.
 *
 * Cost: O(pins of the net x large parts on the board); the large-part list is built once per graph.
 */
import { naturalCompare } from './crossprobe';
import type { NetGraph } from './net-graph';
import { padArea, wordsOfText } from './net-graph';
import type { Bounds, Point, ViewSide } from './types';
import type { PartKind } from './part-kind';

export interface ProbePointOptions {
  /** Side in view: pins only on the other side get a penalty. */
  side?: ViewSide;
  /** View centre in board millimetres: nearer pins rank higher. */
  viewCenter?: Point;
  /** How many points to return; default 3. */
  limit?: number;
  /** A part with more pins than this covers what lies under it; default 50. */
  largePartPins?: number;
  /** Return only the best pin of each part; default true. */
  onePerPart?: boolean;
}

export type ProbeReasonCode = 'testpoint' | 'connector' | 'through-hole' | 'pad-area' | 'tiny-pad' | 'pad-size-unknown' | 'small-part' | 'ic-pin'
  | 'ball-grid' | 'under-body' | 'under-part' | 'other-side' | 'distance';
export interface ProbeReason {
  readonly code: ProbeReasonCode;
  /** Score change. */
  readonly delta: number;
  /** English explanation (diagnostics; the interface translates `code` with `params`). */
  readonly detail: string;
  readonly params?: Readonly<Record<string, string | number>>;
}
export interface PinAccess {
  readonly score: number;
  /** False when the pad is under a part body or a ball-grid package. */
  readonly accessible: boolean;
  readonly reasons: readonly ProbeReason[];
}
export interface ProbePoint extends PinAccess {
  readonly pinId: string;
  readonly componentId: string;
  readonly ref: string;
  readonly pin: string;
  readonly side: string;
  readonly x: number;
  readonly y: number;
}
export interface ProbePointResult {
  readonly net: string;
  readonly status: 'ok' | 'unknown-net' | 'no-connect';
  /** Candidates scored (pins, or parts with `onePerPart`). */
  readonly total: number;
  readonly points: readonly ProbePoint[];
}

export const DEFAULT_LARGE_PART_PINS = 50;
/** Up to this many points are picked by insertion into a short sorted list; more are sorted. */
const MAX_SELECTED = 64;
const SMALL_PARTS: ReadonlySet<PartKind> = new Set(['resistor', 'capacitor', 'inductor', 'ferrite', 'fuse', 'diode', 'led', 'jumper', 'transistor', 'crystal']);
const GRID_PACKAGE = /^(?:[A-Z]{0,4}BGA|[A-Z]{0,3}CSP|[A-Z]{0,3}LGA)\d*$/;
const BALL_NAME = /^[A-HJ-NPR-Z]{1,2}\d{1,2}$/;

interface LargePart { part: number; side: string; bounds: Bounds; pins: number }
const largeCache = new WeakMap<NetGraph, Map<number, LargePart[]>>();

function largeParts(graph: NetGraph, minPins: number): LargePart[] {
  let byLimit = largeCache.get(graph);
  if (!byLimit) { byLimit = new Map(); largeCache.set(graph, byLimit); }
  let list = byLimit.get(minPins);
  if (!list) {
    list = [];
    for (let part = 0; part < graph.partCount; part++) {
      const pins = graph.partPins(part).length;
      const component = graph.component(part);
      if (pins > minPins && component.bounds && component.side !== 'both') list.push({ part, side: component.side, bounds: component.bounds, pins });
    }
    byLimit.set(minPins, list);
  }
  return list;
}

const gridCache = new WeakMap<NetGraph, Map<number, boolean>>();
/** A ball-grid package: by package word, or by ball names on most of the part's pins. */
function isBallGrid(graph: NetGraph, part: number): boolean {
  let cache = gridCache.get(graph);
  if (!cache) { cache = new Map(); gridCache.set(graph, cache); }
  let answer = cache.get(part);
  if (answer === undefined) {
    const component = graph.component(part);
    answer = wordsOfText(component.package).some(word => GRID_PACKAGE.test(word));
    const pins = graph.partPins(part);
    if (!answer && pins.length >= 16) {
      let balls = 0;
      for (const pin of pins) if (BALL_NAME.test(String(graph.pin(pin).number).trim().toUpperCase())) balls++;
      answer = balls >= pins.length * 0.8;
    }
    cache.set(part, answer);
  }
  return answer;
}

const inside = (bounds: Bounds, x: number, y: number): boolean => x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** How reachable one pin is, with the reasons. */
export function pinAccess(graph: NetGraph, pinIndex: number, options: ProbePointOptions = {}): PinAccess {
  const pin = graph.pin(pinIndex);
  const part = graph.pinPart[pinIndex];
  const reasons: ProbeReason[] = [];
  let accessible = true;
  const add = (code: ProbeReasonCode, delta: number, detail: string, params?: Record<string, string | number>) => { reasons.push(params ? { code, delta, detail, params } : { code, delta, detail }); };
  const component = part >= 0 ? graph.component(part) : null;
  const kind: PartKind = part >= 0 ? graph.kindOf(part).kind : 'part';
  const partPins = part >= 0 ? graph.partPins(part).length : 1;
  if (kind === 'testpoint') add('testpoint', 50, 'test point');
  else if (kind === 'connector') add('connector', 20, 'connector pin');
  if (pin.side === 'both') add('through-hole', 15, 'through-hole pad, reachable from both sides');
  const area = padArea(pin);
  if (area === null) add('pad-size-unknown', 0, 'the file gives no pad size');
  else if (area < 0.15) add('tiny-pad', -5, `pad of ${area.toFixed(2)} mm²`, { area: Math.round(area * 100) / 100 });
  else add('pad-area', Math.round(Math.min(20, area * 8) * 10) / 10, `pad of ${area.toFixed(2)} mm²`, { area: Math.round(area * 100) / 100 });
  if (SMALL_PARTS.has(kind) && partPins <= 3) add('small-part', 5, `end of a small part (${kind})`, { kind });
  else if (kind !== 'testpoint' && kind !== 'connector' && partPins > 3) add('ic-pin', -10, `pin of a part with ${partPins} pins`, { pins: partPins });
  if (part >= 0 && kind !== 'connector' && kind !== 'testpoint' && partPins >= 4) {
    if (isBallGrid(graph, part)) { add('ball-grid', -60, 'ball under a ball-grid package'); accessible = false; }
    else if (component && component.bounds && pin.side !== 'both') {
      const b = component.bounds, w = b.maxX - b.minX, h = b.maxY - b.minY;
      const insetX = w * 0.15, insetY = h * 0.15;
      if (w > 0 && h > 0 && pin.x > b.minX + insetX && pin.x < b.maxX - insetX && pin.y > b.minY + insetY && pin.y < b.maxY - insetY) {
        add('under-body', -40, `inner pad under the body of ${component.ref}`, { ref: component.ref }); accessible = false;
      }
    }
  }
  if (pin.side !== 'both') {
    const limit = typeof options.largePartPins === 'number' && Number.isFinite(options.largePartPins) ? Math.max(1, Math.floor(options.largePartPins)) : DEFAULT_LARGE_PART_PINS;
    for (const large of largeParts(graph, limit)) {
      if (large.part === part || large.side !== pin.side || !inside(large.bounds, pin.x, pin.y)) continue;
      const over = graph.component(large.part);
      add('under-part', -40, `under ${over.ref} (${large.pins} pins)`, { ref: over.ref, pins: large.pins }); accessible = false;
      break;
    }
  }
  if (options.side && pin.side !== 'both' && pin.side !== options.side) add('other-side', -10, `on the ${pin.side} side`, { side: pin.side });
  const center = options.viewCenter;
  if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
    const distance = Math.hypot(pin.x - center.x, pin.y - center.y);
    const delta = -Math.min(10, distance / 10);
    if (delta <= -0.5) add('distance', round1(delta), `${distance.toFixed(0)} mm from the view centre`, { mm: Math.round(distance) });
  }
  let score = 0;
  for (const reason of reasons) score += reason.delta;
  return { score: round1(score), accessible, reasons };
}

export function rankProbePoints(graph: NetGraph, netName: string, options: ProbePointOptions = {}): ProbePointResult {
  const net = graph.netIndex(netName);
  if (net < 0) return { net: netName, status: 'unknown-net', total: 0, points: [] };
  if (graph.isNoConnect(net)) return { net: netName, status: 'no-connect', total: 0, points: [] };
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 3;
  const onePerPart = options.onePerPart !== false;
  const best = new Map<number, ProbePoint & { index: number }>();
  const all: Array<ProbePoint & { index: number }> = [];
  for (const pin of graph.netPins(net)) {
    const record = graph.pin(pin);
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) continue;
    const access = pinAccess(graph, pin, options);
    const part = graph.pinPart[pin];
    const component = part >= 0 ? graph.component(part) : null;
    const point = { ...access, pinId: record.id, componentId: component?.id ?? '', ref: component?.ref ?? '', pin: record.number, side: record.side, x: record.x, y: record.y, index: pin };
    if (onePerPart && part >= 0) {
      const current = best.get(part);
      if (!current || Number(point.accessible) > Number(current.accessible) || (point.accessible === current.accessible && point.score > current.score)) best.set(part, point);
    } else all.push(point);
  }
  const candidates = [...best.values(), ...all];
  const order = (a: ProbePoint & { index: number }, b: ProbePoint & { index: number }): number =>
    Number(b.accessible) - Number(a.accessible) || b.score - a.score || naturalCompare(a.ref, b.ref) || naturalCompare(a.pin, b.pin) || a.index - b.index;
  let ranked: Array<ProbePoint & { index: number }>;
  if (limit > MAX_SELECTED) ranked = candidates.sort(order).slice(0, limit);
  else {
    // The best few of many: keep a short sorted list, so the cost is the scoring and one cheap comparison per candidate, not a sort.
    ranked = [];
    for (const candidate of limit === 0 ? [] : candidates) {
      if (ranked.length >= limit && order(candidate, ranked[ranked.length - 1]) >= 0) continue;
      let at = ranked.length;
      while (at > 0 && order(candidate, ranked[at - 1]) < 0) at--;
      ranked.splice(at, 0, candidate);
      if (ranked.length > limit) ranked.pop();
    }
  }
  return { net: netName, status: 'ok', total: candidates.length, points: ranked.map(({ index: _index, ...point }) => point) };
}
