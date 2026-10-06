import { distance } from '../lib/geometry';
import type { Point2 } from '../lib/geometry';
import { clipSegmentToBounds } from '../lib/render-geometry';

/** The measurement line is dashed 5 px on, 4 px off. */
export const MEASURE_DASH: readonly number[] = [5, 4];
const DASH_PERIOD = MEASURE_DASH.reduce((sum, part) => sum + part, 0);
/** The stroked part reaches this far beyond the viewport on every side, so caps and the 1.5 px width never show an edge. */
export const MEASURE_CLIP_MARGIN_PX = 16;

export interface DashedSegment {
  from: Point2;
  to: Point2;
  /** `lineDashOffset` to stroke `from -> to` so that every dash lands exactly where it would on the unclipped line. */
  dashOffset: number;
}

const positiveModulo = (value: number, period: number) => ((value % period) + period) % period;

/**
 * P03: the part of the dashed screen-space segment a -> b that can be seen. A measurement at high zoom has endpoints hundreds of thousands
 * of pixels away; stroking all of it makes the rasteriser walk every dash (447,213 px diagonal at DPR 2.5: 5.1 ms vs 1.1 ms clipped).
 * The segment is clipped to the canvas plus `margin`, and the dash pattern phase is carried over: starting the stroke `t0 * length` px into
 * the line, the pattern must start `prior + t0 * length` (modulo the pattern period) px into itself.
 * Returns null when no part of the line is within the clip rectangle. A line that already lies inside it is returned unchanged.
 */
export function clipDashedSegment(a: Point2, b: Point2, width: number, height: number, margin = MEASURE_CLIP_MARGIN_PX, priorOffset = 0): DashedSegment | null {
  const bounds = { minX: -margin, minY: -margin, maxX: width + margin, maxY: height + margin };
  const inside = (p: Point2) => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY;
  if (inside(a) && inside(b)) return { from: a, to: b, dashOffset: priorOffset };
  if (!Number.isFinite(a.x + a.y + b.x + b.y)) return null;
  const clipped = clipSegmentToBounds(a, b, bounds);
  if (!clipped) return null;
  return { from: clipped.from, to: clipped.to, dashOffset: positiveModulo(priorOffset + distance(a, clipped.from), DASH_PERIOD) };
}

/** The subset of `CanvasRenderingContext2D` the measurement line needs (a recording stub in tests). */
export interface DashedLineContext {
  lineDashOffset: number;
  setLineDash(segments: number[]): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** Strokes the dashed measurement line a -> b (screen CSS pixels) with only its visible part; the caller sets colour and width. */
export function strokeMeasurementLine(ctx: DashedLineContext, a: Point2, b: Point2, width: number, height: number): void {
  const prior = ctx.lineDashOffset;
  ctx.setLineDash([...MEASURE_DASH]);
  const segment = clipDashedSegment(a, b, width, height, MEASURE_CLIP_MARGIN_PX, prior);
  if (segment) {
    ctx.lineDashOffset = segment.dashOffset;
    ctx.beginPath(); ctx.moveTo(segment.from.x, segment.from.y); ctx.lineTo(segment.to.x, segment.to.y); ctx.stroke();
    ctx.lineDashOffset = prior;
  }
  ctx.setLineDash([]);
}
