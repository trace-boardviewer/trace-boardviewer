import type { Bounds2, Point2 } from '../geometry';
import { pointInPolygon } from '../geometry';
import type { BoardFeature, FeatureQuery } from './hotspots';
import { transform } from './matrix3';
import type { Registration } from './registration';

/**
 * The damage and rework map (F14): areas the technician paints on an aligned photo (corrosion, a burn, a missing part) as polygons, and what lies
 * under them. The areas are intersected exactly with the footprints of parts and pads on the board, in board millimetres, so the answer does not
 * depend on the resolution of the photo. (A painted mask in pixels goes through `findHotRegions` + `analyzeHotRegions` instead: see hotspots.ts.)
 */

export const polygonArea = (polygon: readonly Point2[]): number => {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) { const a = polygon[i], b = polygon[(i + 1) % polygon.length]; sum += a.x * b.y - b.x * a.y; }
  return Math.abs(sum) / 2;
};

/** The part of a polygon inside an axis-aligned rectangle (Sutherland-Hodgman). Empty when they do not meet. Any simple polygon is accepted; the area of the result is exact. */
export function clipPolygonToRect(polygon: readonly Point2[], rect: Bounds2): Point2[] {
  let output = polygon.slice();
  const edges: { inside: (p: Point2) => boolean; cut: (a: Point2, b: Point2) => Point2 }[] = [
    { inside: p => p.x >= rect.minX, cut: (a, b) => ({ x: rect.minX, y: a.y + (b.y - a.y) * (rect.minX - a.x) / (b.x - a.x) }) },
    { inside: p => p.x <= rect.maxX, cut: (a, b) => ({ x: rect.maxX, y: a.y + (b.y - a.y) * (rect.maxX - a.x) / (b.x - a.x) }) },
    { inside: p => p.y >= rect.minY, cut: (a, b) => ({ x: a.x + (b.x - a.x) * (rect.minY - a.y) / (b.y - a.y), y: rect.minY }) },
    { inside: p => p.y <= rect.maxY, cut: (a, b) => ({ x: a.x + (b.x - a.x) * (rect.maxY - a.y) / (b.y - a.y), y: rect.maxY }) },
  ];
  for (const edge of edges) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i], previous = input[(i + input.length - 1) % input.length];
      const currentIn = edge.inside(current), previousIn = edge.inside(previous);
      if (currentIn) { if (!previousIn) output.push(edge.cut(previous, current)); output.push(current); }
      else if (previousIn) output.push(edge.cut(previous, current));
    }
    if (!output.length) break;
  }
  return output;
}

/** A photo polygon (px) as a board polygon (mm); null when a vertex has no board position or fewer than 3 vertices are given. */
export function imagePolygonToBoard(registration: Pick<Registration, 'imageToBoard'>, polygon: readonly Point2[]): Point2[] | null {
  if (polygon.length < 3) return null;
  const mapped = polygon.map(p => transform(registration.imageToBoard, p));
  return mapped.every(p => p !== null) ? (mapped as Point2[]) : null;
}

export interface DamageHit {
  readonly feature: BoardFeature;
  /** Area of the feature that lies under the painted area, mm squared. */
  readonly areaMm2: number;
  /** That area as a fraction of the feature's own footprint (1: entirely under the paint). */
  readonly fraction: number;
}

export interface DamageNet {
  readonly net: string;
  /** Affected pins on the net. */
  readonly pins: number;
  /** References of the parts those pins belong to, sorted. */
  readonly refs: readonly string[];
}

export interface DamageReport {
  readonly areaMm2: number;
  readonly parts: readonly DamageHit[];
  readonly pins: readonly DamageHit[];
  /** The nets of the affected pins, most pins first. */
  readonly nets: readonly DamageNet[];
}

export interface DamageOptions {
  /** Features that are only on the other side are ignored. */
  side?: 'top' | 'bottom';
  /** Hits that cover less of the feature than this fraction are dropped (default 0.05). */
  minFraction?: number;
}

/** Parts, pins and nets under a painted area given in board millimetres. */
export function featuresUnderPolygon(polygon: readonly Point2[], query: FeatureQuery, options: DamageOptions = {}): DamageReport {
  const minFraction = options.minFraction ?? 0.05;
  const area = polygonArea(polygon);
  const parts: DamageHit[] = [], pins: DamageHit[] = [];
  if (polygon.length >= 3 && polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polygon) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    for (const feature of query({ minX, minY, maxX, maxY })) {
      if (options.side && feature.side && feature.side !== 'both' && feature.side !== options.side) continue;
      const b = feature.bounds, featureArea = (b.maxX - b.minX) * (b.maxY - b.minY);
      let covered: number, fraction: number;
      if (featureArea > 1e-12) {
        covered = polygonArea(clipPolygonToRect(polygon, b));
        fraction = Math.min(1, covered / featureArea);
      } else {
        // A feature without extent is either under the paint or not.
        const inside = pointInPolygon({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, polygon);
        covered = 0; fraction = inside ? 1 : 0;
      }
      if (fraction <= 0 || fraction < minFraction) continue;
      (feature.kind === 'pin' ? pins : parts).push({ feature, areaMm2: covered, fraction });
    }
  }
  // Differences below a nanometre of area or a billionth of the feature are rounding, not an order.
  const order = (a: DamageHit, b: DamageHit) => {
    const byFraction = b.fraction - a.fraction, byArea = b.areaMm2 - a.areaMm2;
    return Math.abs(byFraction) > 1e-9 ? byFraction : Math.abs(byArea) > 1e-9 ? byArea : a.feature.id < b.feature.id ? -1 : a.feature.id > b.feature.id ? 1 : 0;
  };
  parts.sort(order); pins.sort(order);
  const byNet = new Map<string, { pins: number; refs: Set<string> }>();
  for (const hit of pins) {
    if (!hit.feature.net) continue;
    const entry = byNet.get(hit.feature.net) ?? { pins: 0, refs: new Set<string>() };
    entry.pins++; entry.refs.add(hit.feature.ref);
    byNet.set(hit.feature.net, entry);
  }
  const nets = [...byNet].map(([net, entry]) => ({ net, pins: entry.pins, refs: [...entry.refs].sort() })).sort((a, b) => b.pins - a.pins || (a.net < b.net ? -1 : 1));
  return { areaMm2: area, parts, pins, nets };
}
