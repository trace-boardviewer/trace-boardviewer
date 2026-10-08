/** Shared original Layout / Pin / Nail mapping for Jet BV and the BV2 text export. */
import type { Board, BoardSide, Point } from '../types';
import { BoardFormatError, buildBoard, MAX_MM, note, vendorDisconnected, type ParseInput, type RawPart, type RawPin } from './common';
import type { JetValue } from './bv-jet';

const INCH = 25.4, MAX_PARTS = 250_000, MAX_PINS = 1_000_000, MAX_OUTLINE = 200_000;
export interface BvTables { layout: Record<string, JetValue>[]; pins: Record<string, JetValue>[]; nails: Record<string, JetValue>[]; hasGroup: boolean }
export function isBvMilAnnotation(value: JetValue): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?MIL$/i.test(value) && Number.isFinite(Number(value.slice(0, -3))) && Number(value.slice(0, -3)) > 0;
}
export function assembleBvTables(input: ParseInput, tables: BvTables, format: string): Board {
  const prefix = format.startsWith('BV2') ? 'BV2' : 'BV';
  const invalid = (message: string): never => { throw new BoardFormatError(`${prefix}: ${message}`, 'INVALID_FORMAT', format); };
  const limit = (): never => { throw new BoardFormatError(`${prefix}: board record count exceeds the import limit.`, 'LIMIT_EXCEEDED', format); };
  const numeric = (value: JetValue, field: string, integer = false): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || integer && !Number.isSafeInteger(value)) invalid(`invalid ${field}.`);
    return value as number;
  };
  const text = (value: JetValue, field: string, optional = false): string => {
    if (value === null && optional) return '';
    if (typeof value !== 'string' || !optional && !value.trim()) invalid(`invalid ${field}.`);
    return value as string;
  };
  const side = (value: JetValue): BoardSide => {
    if (value === '(T)') return 'top'; if (value === '(B)') return 'bottom';
    throw new BoardFormatError(`${prefix}: unsupported side marker; expected (T) or (B).`, 'UNSUPPORTED_VARIANT', format);
  };
  if (tables.layout.length > MAX_OUTLINE || tables.pins.length + tables.nails.length > MAX_PINS) limit();
  const parts: RawPart[] = [], pins: RawPin[] = [], groups = new Map<number, Point[]>(), refParts = new Map<string, RawPart>(), pinIds = new Set<string>(), nailIds = new Set<string>();
  let curved = 0, unconnected = 0, generated = 0, repeatedNails = 0, noProbe = 0;
  for (const row of tables.layout) {
    const x = numeric(row.X, 'outline X'), y = numeric(row.Y, 'outline Y'), radius = numeric(row.R, 'outline radius');
    if (Math.abs(radius) * INCH > MAX_MM) invalid('outline radius exceeds the supported coordinate range.');
    if (radius !== 0) curved++;
    const group = tables.hasGroup ? numeric(row.Group, 'outline group', true) : 0;
    const points = groups.get(group) ?? []; points.push({ x, y }); groups.set(group, points);
  }
  if (groups.size > 1) throw new BoardFormatError(`${prefix}: multiple Layout groups have no validated contour interpretation.`, 'UNSUPPORTED_VARIANT', format);
  for (const row of tables.pins) {
    const ref = text(row.Part, 'component reference'), pinSide = side(row.TB), ordinal = numeric(row.Pin, 'pin ordinal', true);
    if (ordinal < 0) invalid('negative pin ordinal.'); numeric(row.Layer, 'pin layer', true);
    const label = text(row.Name, 'pin name', true), numberGenerated = !label; if (numberGenerated) generated++;
    const identity = JSON.stringify([ref, pinSide, prefix === 'BV2' ? label || ordinal : ordinal]);
    if (pinIds.has(identity)) invalid(prefix === 'BV2' ? 'duplicate source pin name or unnamed ordinal.' : 'duplicate source pin ordinal.'); pinIds.add(identity);
    let part = refParts.get(ref);
    if (!part) {
      if (parts.length >= MAX_PARTS) limit();
      part = { key: `component:${parts.length}`, ref, side: pinSide }; refParts.set(ref, part); parts.push(part);
    } else if (part.side !== pinSide) part.side = 'both';
    const sourceNet = text(row.Net, 'pin net', true), net = vendorDisconnected(sourceNet) ? '' : sourceNet; if (sourceNet && !net) unconnected++;
    pins.push({ part: part.key, number: label || String(ordinal), name: label || String(ordinal), ...(numberGenerated ? { numberGenerated: true } : {}), side: pinSide,
      x: numeric(row.X, 'pin X'), y: numeric(row.Y, 'pin Y'), net });
  }
  if (parts.length + tables.nails.length > MAX_PARTS) limit();
  for (const row of tables.nails) {
    const id = text(row.Nail, 'test-point identifier'), probe = /^\$\d+$/.test(id) ? id.slice(1) : id, nailSide = side(row.TB);
    if (prefix === 'BV2' && row.Type === 'NO_PROBE') noProbe++;
    else if (!(prefix === 'BV2' && isBvMilAnnotation(row.Type))) numeric(row.Type, 'test-point type', true);
    text(row.Grid, 'test-point grid', true); text(row.NET, 'test-point net id', true); text(row.VirtualPinVia, 'test-point annotation', true);
    if (nailIds.has(id)) repeatedNails++; nailIds.add(id);
    const x = numeric(row.X, 'test-point X'), y = numeric(row.Y, 'test-point Y'), key = `testpoint:${parts.length}`;
    const sourceNet = text(row.NetName, 'test-point net name', true), net = vendorDisconnected(sourceNet) ? '' : sourceNet; if (sourceNet && !net) unconnected++;
    parts.push({ key, ref: `TP:${probe}`, side: nailSide, position: { x, y } }); pins.push({ part: key, number: probe, name: probe, x, y, side: nailSide, net });
  }
  const warnings = [];
  if (curved) warnings.push(note(`${curved} outline points carry a non-zero radius; their contours are shown with straight segments.`));
  if (unconnected) warnings.push(note(`${unconnected} exporter UNCONNECTED pin or test-point placeholders are shown without a net.`));
  if (generated) warnings.push(note(`${generated} pins have no source name; their source ordinals are shown with generated pin identity.`));
  if (repeatedNails) warnings.push(note(`${repeatedNails} test-point rows reuse a source identifier; all are kept as separate test points.`));
  if (noProbe) warnings.push(note(`${noProbe} source test-point rows are marked NO_PROBE; they are retained as electrical points, without a probe-availability model.`));
  const outlines = [...groups.values()]; if (outlines.some(points => points.length < 3)) invalid('an outline group has fewer than three points.');
  return buildBoard(input, { format, unitsToMm: INCH, parts, pins, outlines, warnings });
}
