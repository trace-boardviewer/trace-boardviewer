/**
 * Drop locator: from readings taken at points of a shorted rail while a limited current is injected (millivolts to ground), or from
 * resistances to ground measured at those points, estimate which part of the rail holds the short.
 *
 * Model. Current flows from the injection point through the copper to the short and returns through ground, so along the rail the
 * reading falls toward the short. TRACE has no copper data: pad positions stand in for the copper, which every result states
 * (`proxy-geometry`). For each candidate location s (a pin of a candidate part on the net) the readings y_i at points p_i are fitted
 * by least squares to
 *     y_i = a + b · f_s(p_i),   b >= 0,
 * with one of two field shapes:
 *  - `linear` (a trace): f_s(p) = |p - s|, the drop grows with the length of copper between p and the short;
 *  - `plane` (a pour): f_s(p) = G(p, s) - G(p, q), the potential of a sheet with the current going in at q and out at s, where
 *    G(p, x) = ln(|p - x| + 0.5 mm) summed over x and its eight mirror images in the edges of the box the net's pads span (grown by
 *    1 mm), the usual first-order stand-in for the edges of the copper. q is the injection point when the caller gives it
 *    (`injection`), else the place of the highest reading (`injection-assumed`; the confidence is then at most medium).
 * `model: 'auto'` (default) keeps the better of the two for each candidate. A fit that would need b < 0 (readings falling away from
 * s) is replaced by the flat fit y = mean. Readings that rise toward the short (a drop measured from the injection point, or the
 * ground side) are read with `polarity: 'highest-at-short'`.
 *
 * Each candidate part is scored by its best pin. With σ² the noise variance (given, or the best fit's residual variance, at least
 * `modelError` (3 %) of the reading range: the stand-in geometry is never exact), part k gets the weight
 * prior_k · exp(-(SSE_k - SSE_min) / 2σ²), normalised to probabilities.
 *
 * Confidence. `nearProbability` is the probability that the short lies within 3 mm of the best location (neighbouring parts count
 * together); `stability` the share of readings that can each be left out without moving the best location further than that
 * (computed from the fit sums, O(1) per reading and candidate). High: near >= 0.6 and every reading can be left out; medium:
 * near >= 0.3 and half of them can; else low. Never high with fewer than five readings, without the injection point, or when two
 * or more readings share the lowest value (`plateau`: dead ends beyond the short; their level and the slope before them place the
 * short only as well as straight lines match the copper); `too-few-readings` below three.
 *
 * Measured on synthetic boards (drop-locator.test.ts): on a copper plane (a 40 x 40 mm grid of unit resistors with insulating
 * edges, 40 capacitors, current in at a corner) with the injection point known, ten random readings put the best location within
 * 3 mm of the short in 18 of 20 cases, 11 answers were high and none of them wrong, and following the next probes from three
 * readings found the shorted part in all 20 (about four readings more); on the ground side 9 of 10 were within 3 mm. A straight
 * trace is located to the right part. Traces with bends are the weak case: straight lines then misstate the copper length (in a
 * branched L-shaped trace, eight readings put 10 of 36 cases within 3 mm, and following the probes reached 20 of 36), so medium
 * and low answers are directions to measure in, not results.
 *
 * Next probe: among reachable pins of the net that were not measured, the one where the top hypotheses predict the most different
 * readings (largest probability-weighted variance of the predicted value) separates them best.
 *
 * Candidates are the parts with a pin on the net, except test points, mechanical parts and parts that are not fitted (optionally
 * weighted by `prior`, for example the short-suspect scores); at most 16 pins per part are tried. Cost: O(candidate pins x readings
 * x 9), readings capped at 500; next-probe search O(probe pins x 50 x 9), probe pins capped at 4,000.
 *
 * Ground side: the same gradient exists on the ground net, where the short's current enters it. Readings on a ground net need the
 * shorted rail (`rail`): the candidates are then the parts with pins on both nets, scored by their pins on the ground net, and the
 * default polarity is `highest-at-short` (the meter's reference lead on the supply's ground clamp, so the reading falls toward it;
 * `injection` is then the clamp point).
 */
import { naturalCompare } from './crossprobe';
import type { NetGraph } from './net-graph';
import { pinAccess } from './probe-points';

export interface DropReading {
  /** Pin where the reading was taken; it must be on the net. */
  readonly pinId?: string;
  /** Or a board position in millimetres (used when no pin is given). */
  readonly x?: number;
  readonly y?: number;
  /** The reading (mV, V or Ω; one unit for all readings). */
  readonly value: number;
}

export type DropModel = 'linear' | 'plane';

export interface DropLocatorOptions {
  /** 'lowest-at-short' (to-ground voltage or resistance; the default on a rail) or 'highest-at-short' (the default on a ground net). */
  polarity?: 'lowest-at-short' | 'highest-at-short';
  model?: 'auto' | DropModel;
  /** Where the current goes in (a pin, or a board position in mm); on a ground net, where it leaves (the supply's ground clamp). */
  injection?: { readonly pinId?: string; readonly x?: number; readonly y?: number };
  /** Standard deviation of a reading, in the readings' unit; estimated when absent. */
  noise?: number;
  /** Smallest noise assumed, as a fraction of the reading range (the stand-in geometry's own error); default 0.03. */
  modelError?: number;
  /** Relative prior weight per component id (absent parts weigh 1; 0 removes a part). */
  prior?: ReadonlyMap<string, number>;
  /** Candidates returned; default 5. */
  limit?: number;
  /** Next probe points suggested; default 3. */
  suggest?: number;
  /** Readings on a ground net: the shorted rail; only parts on both nets are candidates. Ignored for other nets. */
  rail?: string;
}

export interface DropCandidate {
  readonly componentId: string;
  readonly ref: string;
  /** The best-fitting pin of the part. */
  readonly pinId: string;
  readonly x: number;
  readonly y: number;
  readonly probability: number;
  /** Root mean square residual of the fit, in the readings' unit. */
  readonly rms: number;
  /** Rise of the reading per mm (linear) or per unit of the plane field, after polarity. */
  readonly slope: number;
  /** Fitted reading at the short location (linear model; for the plane model the field's offset). */
  readonly atShort: number;
  readonly model: DropModel;
}
export type DropReasonCode =
  | 'lowest-reading' | 'fit' | 'runner-up' | 'beyond-readings' | 'few-readings' | 'proxy-geometry' | 'flat-readings' | 'injection-assumed' | 'plateau';
export interface DropReason { readonly code: DropReasonCode; readonly detail: string; readonly params?: Readonly<Record<string, string | number>> }
export interface NextProbe {
  readonly pinId: string;
  readonly componentId: string;
  readonly ref: string;
  readonly pin: string;
  readonly x: number;
  readonly y: number;
  /** Probability-weighted standard deviation of the readings the top hypotheses predict here. */
  readonly spread: number;
}
export type RejectedReason = 'unknown-pin' | 'not-on-net' | 'not-finite' | 'over-limit';
export interface DropLocatorResult {
  readonly net: string;
  readonly status: 'ok' | 'unknown-net' | 'ground' | 'no-connect' | 'too-few-readings' | 'flat-readings' | 'no-candidates';
  readonly readingsUsed: number;
  readonly rejected: ReadonlyArray<{ readonly index: number; readonly reason: RejectedReason }>;
  readonly best: DropCandidate | null;
  readonly candidates: readonly DropCandidate[];
  readonly confidence: 'high' | 'medium' | 'low' | 'none';
  /** Probability that the short lies within CONFIDENCE_RADIUS_MM of the best location. */
  readonly nearProbability: number;
  /** Share of the readings that can each be left out without moving the best location more than CONFIDENCE_RADIUS_MM (0 below five readings). */
  readonly stability: number;
  /** Probability-weighted centre of the candidate locations and the RMS distance around it (mm). */
  readonly estimate: { readonly x: number; readonly y: number; readonly spreadMm: number } | null;
  /** The best location or the probability-weighted centre lies outside the box spanned by the readings (grown by 10 %): measure further that way. */
  readonly outside: boolean;
  /** The injection point the plane model used, and whether it was given or assumed (the highest reading). */
  readonly injection: { readonly x: number; readonly y: number; readonly basis: 'given' | 'highest-reading' } | null;
  readonly reasoning: readonly DropReason[];
  readonly nextProbes: readonly NextProbe[];
}

export const MAX_READINGS = 500;
export const DEFAULT_MODEL_ERROR = 0.03;
export const CONFIDENCE_RADIUS_MM = 3;
const HIGH_CONFIDENCE = 0.6, MEDIUM_CONFIDENCE = 0.3;
const LOG_OFFSET_MM = 0.5;
const BOX_MARGIN_MM = 1;
const HYPOTHESES = 50;
const MAX_PROBES = 4000;
const MAX_PINS_PER_PART = 16;
/** Readings within this share of the range above the lowest one count as equal to it. */
const PLATEAU_SHARE = 0.02;

const PROXY: DropReason = { code: 'proxy-geometry', detail: 'pad positions stand in for the copper; the board file has no copper data' };

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** ln-distance from p to x and to its eight mirror images in the box edges. */
function sheet(px: number, py: number, x: number, y: number, box: Box): number {
  const ixs = [x, 2 * box.minX - x, 2 * box.maxX - x], iys = [y, 2 * box.minY - y, 2 * box.maxY - y];
  let sum = 0;
  for (const ix of ixs) for (const iy of iys) sum += Math.log(Math.hypot(px - ix, py - iy) + LOG_OFFSET_MM);
  return sum;
}

interface Fit { sse: number; a: number; b: number; model: DropModel }

/** Leave-one-out bookkeeping: for each reading i, the smallest SSE of any candidate fitted without reading i, and that candidate's pin. */
interface LeaveOneOut { readonly sse: Float64Array; readonly pin: Int32Array }

/**
 * Least squares y = a + b·f with b >= 0 (flat when the data fall away from the candidate). With `loo`, also the fit without each
 * reading in turn, from the sums in O(1) per reading, kept when it beats the best so far for that reading.
 */
function fitField(f: Float64Array, values: Float64Array, model: DropModel, loo: LeaveOneOut | null, pin: number): Fit {
  const n = values.length;
  let sf = 0, sff = 0, sv = 0, sfv = 0, svv = 0;
  for (let i = 0; i < n; i++) { sf += f[i]; sff += f[i] * f[i]; sv += values[i]; sfv += f[i] * values[i]; svv += values[i] * values[i]; }
  const denominator = n * sff - sf * sf;
  let b = denominator > 1e-12 * Math.max(1, n * sff) ? (n * sfv - sf * sv) / denominator : 0;
  if (!(b > 0)) b = 0;
  const a = (sv - b * sf) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) { const r = values[i] - a - b * f[i]; sse += r * r; }
  if (loo) {
    const m = n - 1;
    for (let i = 0; i < n; i++) {
      const lf = sf - f[i], lv = sv - values[i];
      const cff = sff - f[i] * f[i] - (lf * lf) / m, cfv = sfv - f[i] * values[i] - (lf * lv) / m, cvv = svv - values[i] * values[i] - (lv * lv) / m;
      const left = Math.max(0, cff > 1e-12 * Math.max(1, sff) && cfv > 0 ? cvv - (cfv * cfv) / cff : cvv);
      if (left < loo.sse[i]) { loo.sse[i] = left; loo.pin[i] = pin; }
    }
  }
  return { sse, a, b, model };
}

export function locateShort(graph: NetGraph, netName: string, readings: readonly DropReading[], options: DropLocatorOptions = {}): DropLocatorResult {
  const net = graph.netIndex(netName);
  const rejected: Array<{ index: number; reason: RejectedReason }> = [];
  const result = (status: DropLocatorResult['status'], extra: Partial<DropLocatorResult> = {}): DropLocatorResult => ({
    net: netName, status, readingsUsed: 0, rejected, best: null, candidates: [], confidence: 'none', nearProbability: 0, stability: 0, estimate: null, outside: false,
    injection: null, reasoning: [PROXY], nextProbes: [], ...extra,
  });
  if (net < 0) return result('unknown-net');
  if (graph.isNoConnect(net)) return result('no-connect');
  let railParts: ReadonlySet<number> | null = null;
  if (graph.isGround(net)) {
    const rail = typeof options.rail === 'string' ? graph.netIndex(options.rail) : -1;
    if (rail < 0 || graph.isGround(rail) || graph.isNoConnect(rail)) return result('ground');
    railParts = new Set(graph.netParts(rail));
  }

  // Readings.
  const polarity = options.polarity ?? (railParts ? 'highest-at-short' : 'lowest-at-short');
  const sign = polarity === 'highest-at-short' ? -1 : 1;
  const xs: number[] = [], ys: number[] = [], vs: number[] = [], readPins: number[] = [];
  readings.forEach((reading, index) => {
    if (xs.length >= MAX_READINGS) { rejected.push({ index, reason: 'over-limit' }); return; }
    if (!reading || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) { rejected.push({ index, reason: 'not-finite' }); return; }
    let x: number, y: number, pinIndex = -1;
    if (typeof reading.pinId === 'string') {
      pinIndex = graph.pinIndex(reading.pinId);
      if (pinIndex < 0) { rejected.push({ index, reason: 'unknown-pin' }); return; }
      if (graph.pinNet[pinIndex] !== net) { rejected.push({ index, reason: 'not-on-net' }); return; }
      x = graph.pin(pinIndex).x; y = graph.pin(pinIndex).y;
    } else { x = Number(reading.x); y = Number(reading.y); }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { rejected.push({ index, reason: 'not-finite' }); return; }
    xs.push(x); ys.push(y); vs.push(sign * reading.value); readPins.push(pinIndex);
  });
  const n = vs.length;
  if (n < 3) return result('too-few-readings', { readingsUsed: n });
  const px = Float64Array.from(xs), py = Float64Array.from(ys), values = Float64Array.from(vs);
  let low = 0, high = 0;
  for (let i = 1; i < n; i++) { if (values[i] < values[low]) low = i; if (values[i] > values[high]) high = i; }
  const range = values[high] - values[low];
  const scale = Math.max(Math.abs(values[high]), Math.abs(values[low]), 1e-300);
  const givenNoise = typeof options.noise === 'number' && Number.isFinite(options.noise) && options.noise > 0 ? options.noise : null;
  if (range <= (givenNoise ?? 0) || range <= 1e-9 * scale) {
    return result('flat-readings', { readingsUsed: n, reasoning: [{ code: 'flat-readings', detail: 'all readings are equal within the noise: no gradient to follow' }, PROXY] });
  }

  // Geometry: the box of the net's pads and readings (the stand-in for the copper's edges) and the injection point.
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number) => {
    if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x; if (y < box.minY) box.minY = y; if (y > box.maxY) box.maxY = y;
  };
  for (const pin of graph.netPins(net)) { const record = graph.pin(pin); if (Number.isFinite(record.x) && Number.isFinite(record.y)) grow(record.x, record.y); }
  for (let i = 0; i < n; i++) grow(px[i], py[i]);
  box.minX -= BOX_MARGIN_MM; box.minY -= BOX_MARGIN_MM; box.maxX += BOX_MARGIN_MM; box.maxY += BOX_MARGIN_MM;
  let injection: NonNullable<DropLocatorResult['injection']> | null = null;
  const spec = options.injection;
  if (spec && typeof spec === 'object') {
    if (typeof spec.pinId === 'string') {
      const pin = graph.pinIndex(spec.pinId);
      if (pin >= 0 && Number.isFinite(graph.pin(pin).x) && Number.isFinite(graph.pin(pin).y)) injection = { x: graph.pin(pin).x, y: graph.pin(pin).y, basis: 'given' };
    } else if (Number.isFinite(spec.x) && Number.isFinite(spec.y)) injection = { x: Number(spec.x), y: Number(spec.y), basis: 'given' };
  }
  const source: NonNullable<DropLocatorResult['injection']> = injection ?? { x: px[high], y: py[high], basis: 'highest-reading' };
  const sourceTerm = new Float64Array(n);
  for (let i = 0; i < n; i++) sourceTerm[i] = sheet(px[i], py[i], source.x, source.y, box);
  // Trace: the length of copper from the short to where p's branch leaves the source-to-short path, (|p-s| + |q-s| - |p-q|) / 2
  // with straight lines for the copper; dead ends beyond the short read 0, like the short itself.
  const fieldAt = (model: DropModel, x: number, y: number, sx: number, sy: number, sourceHere: number): number =>
    (model === 'linear'
      ? (Math.hypot(x - sx, y - sy) + Math.hypot(source.x - sx, source.y - sy) - Math.hypot(x - source.x, y - source.y)) / 2
      : sheet(x, y, sx, sy, box) - sourceHere);

  // Candidates: parts on the net (and on the rail, for ground-side readings), each tried at up to 16 of its pins on the net.
  const priorOf = (part: number): number => {
    const weight = options.prior?.get(graph.component(part).id);
    return weight === undefined ? 1 : Number.isFinite(weight) && weight > 0 ? weight : 0;
  };
  const models: DropModel[] = options.model === 'linear' ? ['linear'] : options.model === 'plane' ? ['plane'] : ['linear', 'plane'];
  const f = new Float64Array(n);
  interface PartFit { part: number; pin: number; fit: Fit; prior: number }
  const pinsOf = new Map<number, number[]>();
  for (const pin of graph.netPins(net)) {
    const part = graph.pinPart[pin];
    if (part < 0 || (railParts && !railParts.has(part))) continue;
    const record = graph.pin(pin);
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) continue;
    const list = pinsOf.get(part);
    if (list) list.push(pin); else pinsOf.set(part, [pin]);
  }
  const fits: PartFit[] = [];
  const loo: LeaveOneOut | null = n >= 5 ? { sse: new Float64Array(n).fill(Infinity), pin: new Int32Array(n).fill(-1) } : null;
  for (const [part, pins] of pinsOf) {
    const kind = graph.kindOf(part).kind;
    if (kind === 'testpoint' || kind === 'mechanical' || graph.notFittedBy(part) !== null) continue;
    const prior = priorOf(part);
    if (prior <= 0) continue;
    const stride = Math.max(1, Math.ceil(pins.length / MAX_PINS_PER_PART));
    let best: PartFit | null = null;
    for (let k = 0; k < pins.length; k += stride) {
      const record = graph.pin(pins[k]);
      for (const model of models) {
        for (let i = 0; i < n; i++) f[i] = fieldAt(model, px[i], py[i], record.x, record.y, sourceTerm[i]);
        const fit = fitField(f, values, model, loo, pins[k]);
        if (!best || fit.sse < best.fit.sse) best = { part, pin: pins[k], fit, prior };
      }
    }
    if (best) fits.push(best);
  }
  if (fits.length === 0) return result('no-candidates', { readingsUsed: n, injection: source });
  let minSse = Infinity;
  for (const item of fits) if (item.fit.sse < minSse) minSse = item.fit.sse;
  const modelError = typeof options.modelError === 'number' && Number.isFinite(options.modelError) && options.modelError >= 0 ? options.modelError : DEFAULT_MODEL_ERROR;
  const floor = Math.max(range * 1e-3, range * modelError) ** 2;
  const variance = givenNoise !== null ? givenNoise * givenNoise : Math.max(minSse / Math.max(1, n - 3), floor);
  let total = 0;
  const weights = fits.map(item => { const w = item.prior * Math.exp(-(item.fit.sse - minSse) / (2 * variance)); total += w; return w; });
  const probability = (index: number) => (total > 0 ? weights[index] / total : 0);
  const order = fits.map((_, index) => index).sort((a, b) => weights[b] - weights[a] || fits[a].fit.sse - fits[b].fit.sse
    || naturalCompare(graph.component(fits[a].part).ref, graph.component(fits[b].part).ref) || fits[a].part - fits[b].part);
  const candidateOf = (index: number): DropCandidate => {
    const item = fits[index], component = graph.component(item.part), pin = graph.pin(item.pin);
    return {
      componentId: component.id, ref: component.ref, pinId: pin.id, x: pin.x, y: pin.y, probability: probability(index),
      rms: Math.sqrt(item.fit.sse / n), slope: item.fit.b * sign, atShort: item.fit.a * sign, model: item.fit.model,
    };
  };
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 5;
  const candidates = order.slice(0, limit).map(candidateOf);
  const best = candidates[0];

  // Estimate (probability-weighted centre and spread), the mass near the best location, and whether it lies beyond the readings.
  let cx = 0, cy = 0, near = 0;
  for (let k = 0; k < fits.length; k++) {
    const p = probability(k), pin = graph.pin(fits[k].pin);
    cx += p * pin.x; cy += p * pin.y;
    if (Math.hypot(pin.x - best.x, pin.y - best.y) <= CONFIDENCE_RADIUS_MM) near += p;
  }
  let spread = 0;
  for (let k = 0; k < fits.length; k++) { const pin = graph.pin(fits[k].pin); spread += probability(k) * ((pin.x - cx) ** 2 + (pin.y - cy) ** 2); }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, px[i]); maxX = Math.max(maxX, px[i]); minY = Math.min(minY, py[i]); maxY = Math.max(maxY, py[i]); }
  const growX = Math.max((maxX - minX) * 0.1, 0.5), growY = Math.max((maxY - minY) * 0.1, 0.5);
  const beyond = (x: number, y: number) => x < minX - growX || x > maxX + growX || y < minY - growY || y > maxY + growY;
  const outside = beyond(best.x, best.y) || beyond(cx, cy);

  // Stability: with each reading left out in turn, does the best location stay within the radius? One reading that alone decides
  // the answer (the only one beyond a bend, the only one on a branch) makes it fragile however well the rest fits.
  let stable = 0;
  if (loo) for (let i = 0; i < n; i++) {
    const pin = loo.pin[i];
    if (pin >= 0 && Math.hypot(graph.pin(pin).x - best.x, graph.pin(pin).y - best.y) <= CONFIDENCE_RADIUS_MM) stable++;
  }
  const stability = loo ? stable / n : 0;
  let confidence: DropLocatorResult['confidence'] = near >= HIGH_CONFIDENCE && stability >= 1 ? 'high' : near >= MEDIUM_CONFIDENCE && stability >= 0.5 ? 'medium' : 'low';
  // A plateau: several readings at the lowest value (within the noise) sit on dead ends beyond the short or at it; where along the
  // copper before them the short is, the readings cannot tell.
  const tolerance = Math.max(givenNoise ?? 0, range * PLATEAU_SHARE);
  let atLowest = 0;
  for (let i = 0; i < n; i++) if (values[i] <= values[low] + tolerance) atLowest++;
  const plateau = atLowest >= 2;
  if ((n < 5 || source.basis !== 'given' || plateau) && confidence === 'high') confidence = 'medium';

  const reasoning: DropReason[] = [];
  const lowName = readPins[low] >= 0 ? describePin(graph, readPins[low]) : `(${px[low].toFixed(1)}, ${py[low].toFixed(1)})`;
  reasoning.push({ code: 'lowest-reading', detail: `${polarity === 'highest-at-short' ? 'highest' : 'lowest'} reading ${values[low] * sign} at ${lowName}`, params: { value: values[low] * sign, at: lowName } });
  reasoning.push({
    code: 'fit', detail: `a ${best.model === 'linear' ? 'trace' : 'plane'} field around ${best.ref} fits the ${n} readings with an RMS error of ${+best.rms.toPrecision(3)}; ${Math.round(near * 100)} % within ${CONFIDENCE_RADIUS_MM} mm of it`,
    params: { ref: best.ref, readings: n, rms: +best.rms.toPrecision(3), model: best.model, percent: Math.round(near * 100) },
  });
  if (candidates[1] && candidates[1].probability >= 0.1) {
    reasoning.push({ code: 'runner-up', detail: `${candidates[1].ref} fits nearly as well (${Math.round(candidates[1].probability * 100)} %)`, params: { ref: candidates[1].ref, percent: Math.round(candidates[1].probability * 100) } });
  }
  if (outside) {
    const where = beyond(best.x, best.y) ? best : { x: cx, y: cy };
    reasoning.push({ code: 'beyond-readings', detail: `the likely location lies outside the measured area, around (${where.x.toFixed(1)}, ${where.y.toFixed(1)}): measure further that way`, params: { x: +where.x.toFixed(1), y: +where.y.toFixed(1) } });
  }
  if (n < 5) reasoning.push({ code: 'few-readings', detail: `${n} readings: more readings around ${best.ref} will firm this up`, params: { readings: n } });
  if (plateau) reasoning.push({ code: 'plateau', detail: `${atLowest} readings share the lowest value: the short lies before them along the copper, and where exactly depends on copper the pad positions only approximate`, params: { readings: atLowest } });
  if (source.basis !== 'given') reasoning.push({ code: 'injection-assumed', detail: 'injection point not given: taken at the highest reading, so the confidence stays at most medium' });
  reasoning.push(PROXY);

  // Next probes: where the top hypotheses disagree most.
  const suggest = typeof options.suggest === 'number' && Number.isFinite(options.suggest) ? Math.max(0, Math.floor(options.suggest)) : 3;
  const nextProbes: NextProbe[] = [];
  if (suggest > 0) {
    const top = order.slice(0, HYPOTHESES).filter(index => probability(index) > 1e-6);
    const mass = top.reduce((sum, index) => sum + weights[index], 0);
    const measured = new Set(readPins.filter(pin => pin >= 0));
    const netPins = graph.netPins(net);
    const stride = Math.max(1, Math.ceil(netPins.length / MAX_PROBES));
    const scored: Array<NextProbe & { index: number; part: number }> = [];
    for (let k = 0; k < netPins.length; k += stride) {
      const pin = netPins[k];
      if (measured.has(pin)) continue;
      const record = graph.pin(pin);
      if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) continue;
      let close = false;
      for (let i = 0; i < n && !close; i++) if (Math.hypot(px[i] - record.x, py[i] - record.y) < 0.5) close = true;
      if (close || !pinAccess(graph, pin).accessible) continue;
      const sourceHere = sheet(record.x, record.y, source.x, source.y, box);
      let mean = 0;
      const predictions = top.map(index => {
        const item = fits[index], at = graph.pin(item.pin);
        const value = item.fit.a + item.fit.b * fieldAt(item.fit.model, record.x, record.y, at.x, at.y, sourceHere);
        mean += (weights[index] / mass) * value;
        return value;
      });
      let varianceHere = 0;
      top.forEach((index, t) => { varianceHere += (weights[index] / mass) * (predictions[t] - mean) ** 2; });
      const part = graph.pinPart[pin];
      const component = part >= 0 ? graph.component(part) : null;
      scored.push({ pinId: record.id, componentId: component?.id ?? '', ref: component?.ref ?? '', pin: record.number, x: record.x, y: record.y, spread: Math.sqrt(varianceHere), index: pin, part });
    }
    scored.sort((a, b) => b.spread - a.spread || naturalCompare(a.ref, b.ref) || naturalCompare(a.pin, b.pin) || a.index - b.index);
    const seenParts = new Set<number>();
    for (const { index: _index, part, ...probe } of scored) {
      if (nextProbes.length >= suggest) break;
      if (part >= 0) { if (seenParts.has(part)) continue; seenParts.add(part); }
      nextProbes.push(probe);
    }
  }
  return {
    net: netName, status: 'ok', readingsUsed: n, rejected, best, candidates, confidence, nearProbability: near, stability,
    estimate: { x: cx, y: cy, spreadMm: Math.sqrt(spread) }, outside, injection: source, reasoning, nextProbes,
  };
}

function describePin(graph: NetGraph, pin: number): string {
  const part = graph.pinPart[pin];
  return part >= 0 ? `${graph.component(part).ref}.${graph.pin(pin).number}` : graph.pin(pin).id;
}
