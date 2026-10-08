/*
 * Plausibility metrics of the diagnostic report (original TRACE module, MIT): a content-free test of the transform a reader applied.
 * The board is re-read under candidate interpretations (raw unit x1 / x25.4 / x0.0254, pad angle absolute / relative, bottom-side
 * Y mirrored or not) and each candidate gets the share of pins inside the outline, the number of overlapping pad pairs, the median
 * nearest-pin pitch snapped to standard pitches and, for the whole board, the pin-density ratio of top to bottom. A wrong reading
 * shows up as an outlier: the KiCad pad-angle bug was found by exactly such a count (501 overlapping pairs against 7).
 * Only rounded aggregates leave this module; no coordinate, size or name.
 *
 * Invariances used to keep the work bounded: a uniform scale changes neither the inside share, nor the overlaps (pads scale with
 * the coordinates), nor the density ratio, so those are computed once per pad-angle and mirror candidate and only the pitch is
 * scaled per unit candidate.
 */
import type { Board, BoardPin } from '../types';
import { count2, PITCHES, roundSig2, share, type Interpretation, type PadAngleMode, type Pitch, type PlausibilityFacts, type UnitsCandidate } from './report';

export interface Frame {
  /** Source unit to millimetres as the reader applied it (null: unknown, the candidates are relative to the board as read). */
  toMm: number | null;
  padAngle: PadAngleMode | 'unknown';
  /** True when the reader estimated the outline from the parts (no outline in the file): the inside share is then meaningless. */
  outlineEstimated: boolean;
}

/** Above this many sized pads the overlap count is skipped (reported as null with `limited`). */
export const MAX_OVERLAP_PADS = 250_000;
const MAX_PAIR_TESTS = 20_000_000;
const MAX_COMPONENT_PITCH_PINS = 4096;
/** The grid key of a pad too large for the grid (a power plane, a connector shell): it is compared with every pad. A cell hash can equal it only by collision, which is harmless. */
const HUGE_CELL = 0x7fffffff;
const UNIT_FACTORS: ReadonlyArray<readonly [UnitsCandidate, number]> = [['x1', 1], ['x25.4', 25.4], ['x0.0254', 0.0254]];
const STANDARD_PITCHES: ReadonlyArray<readonly [Pitch, number]> = [['0.4', 0.4], ['0.5', 0.5], ['0.65', 0.65], ['0.8', 0.8], ['1.0', 1], ['1.27', 1.27], ['2.54', 2.54]];

/** Snaps a pitch in millimetres to a standard pitch within 8 %, else below / between / above the standard range. */
export function snapPitch(mm: number | null): Pitch {
  if (mm === null || !Number.isFinite(mm) || mm <= 0) return 'none';
  for (const [label, value] of STANDARD_PITCHES) if (Math.abs(mm - value) <= value * 0.08) return label;
  if (mm < 0.4) return 'below';
  return mm > 2.54 ? 'above' : 'between';
}
if (PITCHES.length !== STANDARD_PITCHES.length + 4) throw new Error('pitch vocabulary mismatch'); // developer guard

/** Median over pins of the distance to the nearest other pin of the same component (stacked pins at distance 0 are ignored). */
function medianComponentPitch(board: Board): number | null {
  const byId = new Map(board.pins.map(pin => [pin.id, pin]));
  const distances: number[] = [];
  for (const component of board.components) {
    const pins = component.pinIds.slice(0, MAX_COMPONENT_PITCH_PINS).map(id => byId.get(id)).filter((pin): pin is BoardPin => !!pin);
    if (pins.length < 2) continue;
    for (let i = 0; i < pins.length; i++) {
      let best = Infinity;
      for (let j = 0; j < pins.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(pins[i].x - pins[j].x, pins[i].y - pins[j].y);
        if (d > 1e-9 && d < best) best = d;
      }
      if (Number.isFinite(best)) distances.push(best);
      if (distances.length >= 2_000_000) break;
    }
  }
  if (!distances.length) return null;
  distances.sort((a, b) => a - b);
  const middle = distances.length >> 1;
  return distances.length % 2 ? distances[middle] : (distances[middle - 1] + distances[middle]) / 2;
}

/** Even-odd point-in-polygon with a band index over the edges, so a large outline does not cost pins x edges. */
function insideTester(outline: Board['outline']): ((x: number, y: number) => boolean) | null {
  if (outline.length < 3) return null;
  let minY = Infinity, maxY = -Infinity;
  for (const p of outline) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const bands = Math.max(1, Math.min(4096, outline.length)), height = maxY - minY || 1;
  const index: number[][] = Array.from({ length: bands }, () => []);
  const band = (y: number) => Math.max(0, Math.min(bands - 1, Math.floor((y - minY) / height * bands)));
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    for (let k = band(Math.min(a.y, b.y)); k <= band(Math.max(a.y, b.y)); k++) index[k].push(i);
  }
  return (x, y) => {
    if (y < minY || y > maxY) return false;
    let inside = false;
    for (const i of index[band(y)]) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
}

interface Pad { x: number; y: number; round: boolean; r: number; hw: number; hh: number; cos: number; sin: number; top: boolean; bottom: boolean; minX: number; minY: number; maxX: number; maxY: number }
/** The pad of a pin as a circle or a rotated rectangle, or null when the file gives the pad no size. */
function padOf(pin: BoardPin, rotation: number, mirrorY: number | null): Pad | null {
  const width = pin.width ?? pin.radius * 2, height = pin.height ?? pin.radius * 2;
  if (!(width > 0) || !(height > 0)) return null;
  const y = mirrorY === null || pin.side !== 'bottom' ? pin.y : mirrorY - pin.y;
  const degrees = mirrorY !== null && pin.side === 'bottom' ? -rotation : rotation;
  const round = pin.shape === 'round' && (pin.width === undefined || pin.width === pin.height);
  const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const hw = width / 2, hh = height / 2;
  const ex = round ? hw : Math.abs(hw * cos) + Math.abs(hh * sin), ey = round ? hw : Math.abs(hw * sin) + Math.abs(hh * cos);
  return { x: pin.x, y, round, r: hw, hw, hh, cos, sin, top: pin.side !== 'bottom', bottom: pin.side !== 'top', minX: pin.x - ex, minY: y - ey, maxX: pin.x + ex, maxY: y + ey };
}
/** Separating-axis test with a small tolerance, so pads that only touch do not count as overlapping. */
function overlaps(a: Pad, b: Pad, epsilon: number): boolean {
  if (a.round && b.round) return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - epsilon;
  if (a.round || b.round) {
    const [circle, rect] = a.round ? [a, b] : [b, a];
    const dx = circle.x - rect.x, dy = circle.y - rect.y;
    const lx = Math.max(-rect.hw, Math.min(rect.hw, dx * rect.cos + dy * rect.sin)), ly = Math.max(-rect.hh, Math.min(rect.hh, -dx * rect.sin + dy * rect.cos));
    const px = rect.x + lx * rect.cos - ly * rect.sin, py = rect.y + lx * rect.sin + ly * rect.cos;
    return Math.hypot(circle.x - px, circle.y - py) < circle.r - epsilon;
  }
  const axes = [[a.cos, a.sin], [-a.sin, a.cos], [b.cos, b.sin], [-b.sin, b.cos]];
  for (const [ux, uy] of axes) {
    const project = (p: Pad) => Math.abs(p.hw * (p.cos * ux + p.sin * uy)) + Math.abs(p.hh * (-p.sin * ux + p.cos * uy));
    const distance = Math.abs((a.x - b.x) * ux + (a.y - b.y) * uy);
    if (distance >= project(a) + project(b) - epsilon) return false;
  }
  return true;
}
/** Pairs of pads on a common side that overlap; null when the board is above the bounds of this test. */
function overlappingPairs(pads: Pad[]): number | null {
  if (pads.length > MAX_OVERLAP_PADS) return null;
  if (pads.length < 2) return 0;
  const sizes = pads.map(pad => Math.max(pad.maxX - pad.minX, pad.maxY - pad.minY)).sort((a, b) => a - b);
  const cell = Math.max(sizes[sizes.length >> 1] * 2, 1e-9), epsilon = sizes[sizes.length >> 1] * 1e-6;
  // Grid cells are keyed by a hash of two integers (a collision only adds a candidate; every candidate is tested against its box).
  const grid = new Map<number, number[]>();
  const cells = (pad: Pad, visit: (key: number) => void) => {
    const x0 = Math.floor(pad.minX / cell), x1 = Math.floor(pad.maxX / cell), y0 = Math.floor(pad.minY / cell), y1 = Math.floor(pad.maxY / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { visit(HUGE_CELL); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) visit(Math.imul(x, 73856093) ^ Math.imul(y, 19349663));
  };
  pads.forEach((pad, index) => cells(pad, key => { const list = grid.get(key); if (list) list.push(index); else grid.set(key, [index]); }));
  const huge = grid.get(HUGE_CELL) ?? [];
  const stamp = new Int32Array(pads.length).fill(-1);
  let pairs = 0, tests = 0;
  for (let i = 0; i < pads.length; i++) {
    const a = pads[i];
    const consider = (j: number) => {
      if (j <= i || stamp[j] === i) return;
      stamp[j] = i;
      const b = pads[j];
      if (!(a.top && b.top || a.bottom && b.bottom)) return;
      if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY) return;
      tests++;
      if (overlaps(a, b, epsilon)) pairs++;
    };
    cells(a, key => { for (const j of grid.get(key) ?? []) consider(j); });
    for (const j of huge) consider(j);
    if (tests > MAX_PAIR_TESTS) return null;
  }
  return pairs;
}

/** The plausibility facts of a parsed board under the reader's frame. */
export function plausibility(board: Board, frame: Frame, tick: () => void = () => {}): PlausibilityFacts {
  const componentRotation = new Map(board.components.map(component => [component.id, component.rotation]));
  const asReadPadAngle = frame.padAngle;
  const angleCandidates: Array<Interpretation['padAngle']> = asReadPadAngle === 'absolute' || asReadPadAngle === 'relative' ? ['absolute', 'relative'] : ['as-read'];
  const rotationFor = (pin: BoardPin, candidate: Interpretation['padAngle']): number => {
    const own = pin.rotation ?? 0, parent = componentRotation.get(pin.componentId) ?? 0;
    if (candidate === 'as-read' || candidate === asReadPadAngle) return own;
    return candidate === 'relative' ? own + parent : own - parent; // read as absolute, try relative (and the reverse)
  };
  const mirrorY = board.bounds.minY + board.bounds.maxY;
  const sized = board.pins.filter(pin => (pin.width ?? pin.radius * 2) > 0 && (pin.height ?? pin.radius * 2) > 0).length;
  const limited = sized > MAX_OVERLAP_PADS;

  const tester = frame.outlineEstimated ? null : insideTester(board.outline);
  const inside = new Map<Interpretation['bottom'], number | null>();
  for (const bottom of ['as-read', 'mirrored'] as const) {
    if (!tester || !board.pins.length) { inside.set(bottom, null); continue; }
    let count = 0;
    for (const pin of board.pins) if (tester(pin.x, bottom === 'mirrored' && pin.side === 'bottom' ? mirrorY - pin.y : pin.y)) count++;
    inside.set(bottom, share(count, board.pins.length));
  }
  const overlapCounts = new Map<string, number | null>();
  for (const angle of angleCandidates) for (const bottom of ['as-read', 'mirrored'] as const) {
    if (limited) { overlapCounts.set(`${angle}|${bottom}`, null); continue; }
    tick();
    const pads: Pad[] = [];
    for (const pin of board.pins) { const pad = padOf(pin, rotationFor(pin, angle), bottom === 'mirrored' ? mirrorY : null); if (pad) pads.push(pad); }
    const pairs = overlappingPairs(pads);
    overlapCounts.set(`${angle}|${bottom}`, pairs === null ? null : count2(pairs));
  }
  tick();
  const pitchMm = medianComponentPitch(board);
  const raw = pitchMm === null ? null : pitchMm / (frame.toMm ?? 1);
  const asReadUnits: PlausibilityFacts['asReadUnits'] = frame.toMm === null ? 'unknown'
    : UNIT_FACTORS.find(([, factor]) => Math.abs(factor - frame.toMm!) <= frame.toMm! * 1e-9)?.[0] ?? 'other';

  const interpretations: Interpretation[] = [];
  for (const [units, factor] of UNIT_FACTORS) for (const angle of angleCandidates) for (const bottom of ['as-read', 'mirrored'] as const) {
    const asReadUnit = asReadUnits === 'unknown' ? units === 'x1' : asReadUnits === units;
    interpretations.push({
      units, padAngle: angle, bottom,
      asRead: asReadUnit && (angle === 'as-read' || angle === asReadPadAngle) && bottom === 'as-read',
      pinsInsideOutline: inside.get(bottom) ?? null,
      overlappingPadPairs: overlapCounts.get(`${angle}|${bottom}`) ?? null,
      medianPitch: snapPitch(raw === null ? null : raw * factor),
    });
  }
  const top = board.pins.filter(pin => pin.side !== 'bottom').length, bottomPins = board.pins.filter(pin => pin.side !== 'top').length;
  return {
    asReadUnits, asReadPadAngle, pinDensityTopBottom: bottomPins ? Math.min(1_000_000, roundSig2(top / bottomPins)) : null,
    limited, interpretations,
  };
}
