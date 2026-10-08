/*
 * Original TRACE code (MIT). Shared helpers of the EasyEDA Standard and EasyEDA Pro readers. Format references are the vendor documents only:
 * EasyEDA Standard "EasyEDA File Format" (docs.easyeda.com/en/DocumentFormat/), EasyEDA Pro file format V2.2 (github.com/easyeda/easyeda-file-format-v2)
 * and V3 (prodocs.easyeda.com/en/format/). No implementation source code was read or copied.
 */
import type { ParseIssue, Point } from '../types';
import { BoardFormatError, number as decimal, type FormatErrorCode } from './common';

export const EASYEDA_STD_FORMAT = 'EasyEDA Standard PCB';
export const EASYEDA_PRO_FORMAT = 'EasyEDA Pro PCB';
/** EasyEDA Standard stores every length in units of 10 mil (the documented "10X mil" base unit). */
export const STD_UNIT_MM = 0.254;
/**
 * EasyEDA Pro (format versions 1.x as written by editor 2.2.x) stores lengths in mil (0.0254 mm). The vendor text says "0.01 inch" for these
 * documents, but every real file read while writing this reader contradicts that (a 0603 footprint has 0.8 mm pads as 31.5 units, a 0.3 mm via hole
 * is 11.81, a 100 mm board outline is 3937 units wide), so the unit is mil.
 */
export const PRO_UNIT_MM = 0.0254;
/** Source numbers beyond this are not board geometry (1e8 units is 2.5 km in mil); the limit also keeps every product below finite range. */
export const MAX_SOURCE_UNITS = 1e8;
/** End points of board-edge items that differ by less than this are one corner (the same tolerance the KiCad reader uses). */
export const OUTLINE_CLOSURE_MM = 0.01;
export const MAX_PARTS = 250_000;
export const MAX_PINS = 1_000_000;
/** Sampled points of every arc and circle of one document together. */
export const MAX_ARC_POINTS = 2_000_000;
export const MAX_RECORD_FIELDS = 4096;

export type EasyedaKind = 'pcb' | 'footprint' | 'schematic' | 'project' | 'unsupported';
/** What a cheap, bounded look at the first bytes says. `confidence` is 0..1: >= 0.9 is a structural signature, 0.5 a plausible guess, below that a hint only. */
export interface EasyedaSniff {
  id: 'easyeda-std' | 'easyeda-pro';
  variant: string;
  kind: EasyedaKind;
  confidence: number;
  reason: string;
}

export const fail = (format: string, message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never => { throw new BoardFormatError(`${message}`, code, format); };
export const note = (message: string): ParseIssue => ({ key: 'parse.warning.formatNote', params: { message } });
/** "1 track" / "2 tracks" (an irregular plural is given). */
export const quantity = (count: number, singular: string, plural = `${singular}s`): string => `${count} ${count === 1 ? singular : plural}`;
export const normalizeAngle = (degrees: number): number => { const value = ((degrees % 360) + 360) % 360; return value === 0 ? 0 : value; };

/** A finite number of source units from a JSON value (number or plain decimal text), within the supported magnitude. */
export function numeric(value: unknown, label: string, format: string): number {
  let result: number;
  if (typeof value === 'number') result = value;
  else if (typeof value === 'string') {
    try { result = decimal(value, label); } catch (error) { throw error instanceof BoardFormatError ? new BoardFormatError(`${format}: ${error.message}`, error.code, format) : error; }
  } else return fail(format, `${format}: ${label} is missing or not a number.`);
  if (!Number.isFinite(result)) return fail(format, `${format}: ${label} is not a finite number.`);
  if (Math.abs(result) > MAX_SOURCE_UNITS) return fail(format, `${format}: ${label} ${result} exceeds the supported magnitude of ${MAX_SOURCE_UNITS} source units.`);
  return result;
}
/** Like numeric(), but empty or absent text is `fallback` (Standard stores "no value" as an empty field). */
export function numericOr(value: unknown, fallback: number, label: string, format: string): number {
  return value === undefined || value === null || typeof value === 'string' && !value.trim() ? fallback : numeric(value, label, format);
}

/** Splits at most `max` fields (the rest of the text is left unread), so a long trailing field such as a text path is never copied. */
export function splitFields(text: string, separator: string, max: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (;;) {
    const at = text.indexOf(separator, start);
    if (at < 0) { fields.push(text.slice(start)); return fields; }
    fields.push(text.slice(start, at));
    if (fields.length >= max) return fields;
    start = at + separator.length;
  }
}
/** Numbers separated by spaces and/or commas ("311 175 351,175"). Linear; refuses more than `limit` numbers. */
export function numberList(text: string, label: string, format: string, limit = 2_000_000): number[] {
  const result: number[] = [];
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 44 || c === 9 || c === 10 || c === 13) { i++; continue; }
    const start = i++;
    while (i < n) { const d = text.charCodeAt(i); if (d === 32 || d === 44 || d === 9 || d === 10 || d === 13) break; i++; }
    if (result.length >= limit) return fail(format, `${format}: ${label} lists more than ${limit} numbers.`, 'LIMIT_EXCEEDED');
    result.push(numeric(text.slice(start, i), label, format));
  }
  return result;
}
export function pointsOf(values: number[], label: string, format: string): Point[] {
  if (values.length % 2) return fail(format, `${format}: ${label} has an odd number of coordinates.`);
  const points: Point[] = [];
  for (let i = 0; i < values.length; i += 2) points.push({ x: values[i], y: values[i + 1] });
  return points;
}

/** Counts the sampled points of one document so a file of many arcs cannot exceed a fixed budget. */
export class PointBudget {
  private used = 0;
  constructor(private readonly format: string) {}
  take(count: number): void {
    this.used += count;
    if (this.used > MAX_ARC_POINTS) fail(this.format, `${this.format}: the outline arcs and circles would need more than ${MAX_ARC_POINTS} sampled points.`, 'LIMIT_EXCEEDED');
  }
}

const MAX_ARC_RADIUS = 1e7;
const sampleCount = (sweep: number): number => Math.max(2, Math.min(4096, Math.ceil(Math.abs(sweep) / (Math.PI / 32))));
/**
 * Points of the arc from `start` to `end` that sweeps `degrees` (positive: counter-clockwise on a Y-up plane, negative: clockwise). The first and last
 * points are exactly `start` and `end`, so edges that share an end point keep sharing it. A (near) straight or full-turn sweep is the chord.
 */
export function arcBySweep(start: Point, end: Point, degrees: number, budget: PointBudget): Point[] {
  const dx = end.x - start.x, dy = end.y - start.y, chord = Math.hypot(dx, dy);
  const half = degrees * Math.PI / 360, sine = Math.sin(half);
  if (!(chord > 0) || Math.abs(sine) < 1e-9) return [start, end];
  const radius = chord / (2 * Math.abs(sine));
  if (!(radius <= MAX_ARC_RADIUS)) return [start, end];
  // The centre lies on the left of start->end for a counter-clockwise sweep below 180 degrees, on the right above it, and mirrored for a clockwise one.
  const offset = chord / 2 / Math.tan(half), center = { x: (start.x + end.x) / 2 - dy / chord * offset, y: (start.y + end.y) / 2 + dx / chord * offset };
  const from = Math.atan2(start.y - center.y, start.x - center.x), sweep = degrees * Math.PI / 180, steps = sampleCount(sweep);
  budget.take(steps + 1);
  const points: Point[] = [start];
  for (let step = 1; step < steps; step++) points.push({ x: center.x + radius * Math.cos(from + sweep * step / steps), y: center.y + radius * Math.sin(from + sweep * step / steps) });
  points.push(end);
  return points;
}
/**
 * SVG elliptical-arc command restricted to circles (EasyEDA writes "A r,r 0 large sweep x,y"): endpoint-to-centre conversion of the SVG implementation
 * notes (F.6.5). Works in the caller's coordinates; `sweep` is the SVG sweep-flag (the positive-angle direction of those coordinates).
 */
export function arcBySvg(start: Point, end: Point, radius: number, large: boolean, sweep: boolean, budget: PointBudget): Point[] {
  if (!(radius > 0) || (start.x === end.x && start.y === end.y)) return [start, end];
  const hx = (start.x - end.x) / 2, hy = (start.y - end.y) / 2, distance2 = hx * hx + hy * hy;
  if (!(distance2 > 0)) return [start, end];
  let r = radius;
  if (r * r < distance2) r = Math.sqrt(distance2);
  const coefficient = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, (r * r - distance2) / distance2));
  const cx = coefficient * hy + (start.x + end.x) / 2, cy = -coefficient * hx + (start.y + end.y) / 2;
  const from = Math.atan2(start.y - cy, start.x - cx), to = Math.atan2(end.y - cy, end.x - cx);
  let delta = to - from;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = sampleCount(delta);
  budget.take(steps + 1);
  const points: Point[] = [start];
  for (let step = 1; step < steps; step++) points.push({ x: cx + r * Math.cos(from + delta * step / steps), y: cy + r * Math.sin(from + delta * step / steps) });
  points.push(end);
  return points;
}
export function circlePoints(center: Point, radius: number, budget: PointBudget): Point[] {
  const steps = 64;
  budget.take(steps + 1);
  const points: Point[] = [];
  for (let step = 0; step < steps; step++) points.push({ x: center.x + radius * Math.cos(2 * Math.PI * step / steps), y: center.y + radius * Math.sin(2 * Math.PI * step / steps) });
  points.push(points[0]);
  return points;
}
export function rotateAbout(point: Point, origin: Point, degreesCcw: number): Point {
  const a = degreesCcw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = point.x - origin.x, dy = point.y - origin.y;
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
}
export const edgesOf = (path: Point[]): Array<[Point, Point]> => path.slice(1).map((point, i): [Point, Point] => [path[i], point]);

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export function grow(box: Box, x: number, y: number): void {
  if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y; if (y > box.maxY) box.maxY = y;
}
export const boxIsEmpty = (box: Box): boolean => !(box.minX <= box.maxX && box.minY <= box.maxY);
export const boxCorners = (box: Box): Point[] => [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];

/** Text of the first `length` bytes, as UTF-8 where valid (BOM stripped), for signature sniffing only. */
export function headText(data: Uint8Array, length: number): string {
  const end = Math.min(data.length, length);
  let text = new TextDecoder('utf-8').decode(data.subarray(0, end));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}
