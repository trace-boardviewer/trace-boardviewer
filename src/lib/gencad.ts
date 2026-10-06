import type { Board, BoardComponent, BoardNet, BoardPin, BoardSide, Bounds, Point } from './types';
import { formatIssue, type ParseIssue, type ParseKey, type Params } from './i18n';

interface RecordLine { tokens: string[]; line: number }
interface Path { points: Point[]; kind: string }
interface Pad { kind: string; paths: Path[] }
/** What a pad definition contributes to every pin that uses it; `localBounds` is absent for a pad without geometry. */
interface PadExtent { localBounds?: Bounds; round: boolean; exactRectangle: boolean }
interface StackPad { name: string; layer: string; rotation: number; mirror: string }
interface PadStack { pads: StackPad[]; drill: number }
interface ShapePin { number: string; stack: string; position: Point; layer: string; rotation: number; mirror: string; line: number }
interface Shape { name: string; pins: ShapePin[]; paths: Path[]; insertion: string }
interface Placement {
  ref: string; shape: string; device: string; value: string; position: Point;
  side: BoardSide; rotation: number; mirror: string; flip: boolean; line: number; hasPlace: boolean;
}
interface Device { value: string; part: string; package: string }

const TAU = Math.PI * 2;
const MARKER_RADIUS = 0.18; // Display fallback only; never a measured pad dimension.
const GEOMETRY = new Set(['LINE', 'ARC', 'CIRCLE', 'RECTANGLE']);
/** Body points every placed pin adds to its component: the four corners of its pad extent. */
const PIN_BODY_POINTS = 4;
/** Output budget: shape instancing multiplies a small input, so the planned expansion is checked
 * before anything is allocated. Component and pin bounds match the generic format builder; `geometryPoints`
 * bounds the placed outlines, bodies and pad corners together, so the full component and pin budgets fit
 * it with ordinary shape bodies. `lines` is the physical-line cap of one file: the component budget needs up to
 * six records each (COMPONENT, PLACE, LAYER, ROTATION, SHAPE, DEVICE) and every pin of every signal one NODE
 * record, so it sits above components x 6 + pins with room for the sections of geometry, well inside the 64 MiB
 * byte limit. */
export const GENCAD_LIMITS = Object.freeze({ components: 250_000, pins: 1_000_000, geometryPoints: 8_000_000, lines: 8_000_000 });

/** A parse failure that keeps its message structured; the UI renders it in the active language. */
export class GenCadParseError extends Error {
  readonly issue: ParseIssue;
  constructor(issue: ParseIssue) {
    super(formatIssue('en', issue)); // Developer-facing fallback text only.
    this.name = 'GenCadParseError';
    this.issue = issue;
  }
}

function fail(key: ParseKey, line?: number, params?: Params): never {
  throw new GenCadParseError({ key, ...(params ? { params } : {}), ...(line ? { line } : {}) });
}

/** Quoted names may contain spaces, escaped quotes, or a literal #. */
function tokenize(text: string, line: number): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
    if (index >= text.length) break;
    if (text[index] !== '"') {
      const start = index;
      while (index < text.length && !/\s/.test(text[index])) index++;
      tokens.push(text.slice(start, index));
      continue;
    }
    index++;
    let token = '';
    let closed = false;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\' && (text[index] === '"' || text[index] === '\\')) {
        token += text[index++];
      } else if (char === '"') {
        if (text[index] === '"') { token += '"'; index++; }
        else { closed = true; break; }
      } else token += char;
    }
    if (!closed) fail('parse.error.unterminatedQuote', line);
    if (index < text.length && !/\s/.test(text[index])) fail('parse.error.badQuotedField', line);
    tokens.push(token);
  }
  return tokens;
}

function sectionsFrom(text: string): Map<string, RecordLine[]> {
  if (!text.trim()) fail('parse.error.empty');
  if (text.length > 64 * 1024 * 1024) fail('parse.error.tooLarge');
  if (text.includes('\0')) fail('parse.error.binary');
  const sections = new Map<string, RecordLine[]>();
  let current = '';
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  if (lines.length > GENCAD_LIMITS.lines) fail('parse.error.tooManyRecords');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || /^(#|;|\/\/)/.test(line)) continue;
    if (line.startsWith('$')) {
      const marker = line.toUpperCase();
      if (!/^\$[A-Z0-9_]+$/.test(marker)) fail('parse.error.badSectionMarker', index + 1);
      if (marker.startsWith('$END')) {
        if (!current || marker !== `$END${current}`) fail('parse.error.mismatchedSectionEnd', index + 1);
        current = '';
      } else {
        if (current) fail('parse.error.missingSectionEnd', index + 1, { section: current });
        current = marker.slice(1);
        if (sections.has(current)) fail('parse.error.duplicateSection', index + 1, { section: current });
        sections.set(current, []);
      }
      continue;
    }
    if (!current) fail('parse.error.dataOutsideSection', index + 1);
    const tokens = tokenize(line, index + 1);
    tokens[0] = tokens[0].toUpperCase();
    sections.get(current)!.push({ tokens, line: index + 1 });
  }
  if (current) fail('parse.error.missingSectionEnd', undefined, { section: current });
  for (const name of ['HEADER', 'SHAPES', 'COMPONENTS']) {
    if (!sections.has(name)) fail('parse.error.missingSection', undefined, { section: name });
  }
  return sections;
}

function args(row: RecordLine, length: number): void {
  if (row.tokens.length < length) fail('parse.error.missingField', row.line, { record: row.tokens[0] });
}

function number(row: RecordLine, index: number): number {
  const token = row.tokens[index];
  if (!token || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
    fail('parse.error.badNumber', row.line, { record: row.tokens[0] });
  }
  const value = Number(token);
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) fail('parse.error.coordinateRange', row.line);
  return value;
}

function point(row: RecordLine, index: number, scale: number): Point {
  const result = { x: number(row, index) * scale, y: number(row, index + 1) * scale };
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || Math.abs(result.x) > 1e9 || Math.abs(result.y) > 1e9) {
    fail('parse.error.coordinateRangeMm', row.line);
  }
  return result;
}

function distance(row: RecordLine, index: number, scale: number): number {
  const result = number(row, index) * scale;
  if (!Number.isFinite(result) || Math.abs(result) > 1e9) fail('parse.error.sizeRangeMm', row.line);
  return result;
}

function mirrorFlag(row: RecordLine, index: number): string {
  const value = (row.tokens[index] ?? '0').toUpperCase();
  if (!['0', 'MIRRORX', 'MIRRORY', 'MIRRORXY'].includes(value)) fail('parse.error.unknownMirror', row.line, { value });
  return value;
}

function padLayer(row: RecordLine, index: number, allowInner: boolean): string {
  const value = row.tokens[index].toUpperCase();
  if (['TOP', 'BOTTOM', 'ALL', 'BOTH'].includes(value) || (allowInner && /^INNER\d+$/.test(value))) return value;
  if (/^INNER\d+$/.test(value)) fail('parse.error.innerLayerPin', row.line, { layer: value });
  fail(allowInner ? 'parse.error.unknownStackLayer' : 'parse.error.unknownPinLayer', row.line, { layer: value });
}

const outerLayer = (layer: string) => ['TOP', 'BOTTOM', 'ALL', 'BOTH'].includes(layer);
const oppositeSide = (side: BoardSide): BoardSide => side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : 'both';

function transform(position: Point, rotation: number, mirror = '0', offset: Point = { x: 0, y: 0 }): Point {
  // MIRRORX means reflection about the X axis (Y changes sign), before rotation.
  const x = position.x * (mirror === 'MIRRORY' || mirror === 'MIRRORXY' ? -1 : 1);
  const y = position.y * (mirror === 'MIRRORX' || mirror === 'MIRRORXY' ? -1 : 1);
  const angle = rotation * Math.PI / 180;
  return { x: offset.x + x * Math.cos(angle) - y * Math.sin(angle), y: offset.y + x * Math.sin(angle) + y * Math.cos(angle) };
}

function boundsOf(points: Point[]): Bounds {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

function rectangle(bounds: Bounds): Point[] {
  return [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }, { x: bounds.minX, y: bounds.minY }];
}

function expand(bounds: Bounds, amount: number): Bounds {
  return { minX: bounds.minX - amount, minY: bounds.minY - amount, maxX: bounds.maxX + amount, maxY: bounds.maxY + amount };
}

function geometry(row: RecordLine, scale: number): Path {
  const command = row.tokens[0];
  if (command === 'LINE') { args(row, 5); return { points: [point(row, 1, scale), point(row, 3, scale)], kind: command }; }
  if (command === 'RECTANGLE') {
    args(row, 5);
    const start = point(row, 1, scale);
    const width = distance(row, 3, scale); const height = distance(row, 4, scale);
    // GENCAD rectangles store a starting corner and size, not two corners.
    return { points: rectangle({ minX: Math.min(start.x, start.x + width), minY: Math.min(start.y, start.y + height), maxX: Math.max(start.x, start.x + width), maxY: Math.max(start.y, start.y + height) }), kind: command };
  }
  if (command === 'CIRCLE') {
    args(row, 4);
    const center = point(row, 1, scale); const radius = distance(row, 3, scale);
    if (radius < 0) fail('parse.error.negativeRadius', row.line);
    const points = Array.from({ length: 65 }, (_, index) => ({ x: center.x + radius * Math.cos(index * TAU / 64), y: center.y + radius * Math.sin(index * TAU / 64) }));
    return { points, kind: command };
  }
  args(row, 7);
  const start = point(row, 1, scale); const end = point(row, 3, scale); const center = point(row, 5, scale);
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const endRadius = Math.hypot(end.x - center.x, end.y - center.y);
  if (!radius || Math.abs(radius - endRadius) > Math.max(0.01, radius * 0.001)) fail('parse.error.invalidArc', row.line);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  // Arcs are counter-clockwise in the file's Y-up coordinate system.
  const sweep = ((endAngle - startAngle + TAU) % TAU) || TAU;
  const stops: number[] = [0, sweep];
  const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 32)));
  for (let index = 1; index < steps; index++) stops.push(sweep * index / steps);
  // Include cardinal extrema so fit-to-board dimensions remain exact.
  for (let angle = 0; angle < TAU; angle += Math.PI / 2) {
    const distance = (angle - startAngle + TAU) % TAU;
    if (distance > 0 && distance < sweep) stops.push(distance);
  }
  const points = stops.sort((a, b) => a - b).map(offset => ({ x: center.x + radius * Math.cos(startAngle + offset), y: center.y + radius * Math.sin(startAngle + offset) }));
  points[0] = start; points[points.length - 1] = end;
  return { points, kind: command };
}

function samePoint(a: Point, b: Point): boolean { return Math.hypot(a.x - b.x, a.y - b.y) < 1e-5; }

/** Join unordered segments; use the outer closed contour instead of bridging cutouts.
 * Paths that already close stand alone and dangling branches are pruned before chaining, so a
 * stray open edge can never consume the edges of a valid loop, whatever the record order. */
function outerContour(paths: Path[]): { outline: Point[]; extras: number } {
  const segments = paths.filter(path => path.points.length > 1 && !path.points.every(p => samePoint(p, path.points[0]))).map(path => [...path.points]);
  const contours: Point[][] = [];
  const open: Point[][] = [];
  for (const segment of segments) (samePoint(segment[0], segment[segment.length - 1]) ? contours : open).push(segment);
  const remaining = new Set(open.map((_, index) => index));
  const ends = open.map(segment => [segment[0], segment[segment.length - 1]] as const);
  const endpoints = new Map<string, number[]>();
  const bucket = (p: Point) => [Math.round(p.x * 1e5), Math.round(p.y * 1e5)];
  for (const [index, pair] of ends.entries()) {
    for (const p of pair) {
      const key = bucket(p).join(','); const matches = endpoints.get(key) ?? [];
      matches.push(index); endpoints.set(key, matches);
    }
  }
  /** Other remaining open paths with an endpoint at p. */
  const touching = (p: Point, self: number): number[] => {
    const [x, y] = bucket(p); const result: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const index of endpoints.get(`${x + dx},${y + dy}`) ?? []) {
        if (index !== self && remaining.has(index) && !result.includes(index) && ends[index].some(end => samePoint(p, end))) result.push(index);
      }
    }
    return result;
  };
  // An open path with a free end cannot belong to any loop; removing it may free its neighbour's end.
  const dangling = (index: number) => ends[index].some(p => touching(p, index).length === 0);
  let pruned = 0;
  const queue = [...remaining].filter(dangling);
  while (queue.length) {
    const index = queue.pop()!;
    if (!remaining.has(index)) continue;
    remaining.delete(index); pruned++;
    for (const p of ends[index]) for (const other of touching(p, index)) if (dangling(other)) queue.push(other);
  }
  const findAdjacent = (p: Point): number | undefined => touching(p, -1)[0];
  while (remaining.size) {
    const first = remaining.values().next().value as number;
    const contour = open[first]; remaining.delete(first);
    while (!samePoint(contour[0], contour[contour.length - 1])) {
      const last = contour[contour.length - 1];
      const appendIndex = findAdjacent(last);
      const index = appendIndex ?? findAdjacent(contour[0]);
      if (index === undefined) break;
      const candidate = open[index]; remaining.delete(index);
      if (appendIndex !== undefined) {
        if (!samePoint(last, candidate[0])) candidate.reverse();
        contour.push(...candidate.slice(1));
      } else {
        if (!samePoint(contour[0], candidate[candidate.length - 1])) candidate.reverse();
        contour.unshift(...candidate.slice(0, -1));
      }
    }
    contours.push(contour);
  }
  const closed = contours.filter(points => points.length >= 4 && samePoint(points[0], points[points.length - 1]));
  const area = (points: Point[]) => Math.abs(points.slice(1).reduce((sum, p, index) => sum + points[index].x * p.y - p.x * points[index].y, 0));
  closed.sort((a, b) => area(b) - area(a));
  // Pruned branches are separate contours the view does not show, so they count as extras too.
  return { outline: closed[0] ?? [], extras: Math.max(0, contours.length - 1) + pruned };
}

function units(header: RecordLine[]): number {
  const versions = header.filter(row => row.tokens[0] === 'GENCAD');
  if (versions.length !== 1 || versions[0].tokens[1] !== '1.4') fail('parse.error.requiresGencad14');
  const rows = header.filter(row => row.tokens[0] === 'UNITS');
  if (rows.length !== 1) fail('parse.error.unitsMissing');
  const row = rows[0]; args(row, 2);
  switch (row.tokens[1].toUpperCase()) {
    case 'MM': return 1;
    case 'INCH': return 25.4;
    case 'THOU': case 'MIL': case 'MILS': return 0.0254;
    case 'USER': {
      args(row, 3);
      const perInch = number(row, 2);
      if (perInch <= 0 || perInch < 1e-6) fail('parse.error.userUnitDivisor', row.line);
      return 25.4 / perInch;
    }
    default: return fail('parse.error.unsupportedUnit', row.line, { unit: row.tokens[1] });
  }
}

/** Import GENCAD 1.4 into millimetres, absolute board coordinates, with Y upwards.
 * Geometry syntax checked against KiCad's official exporter documentation:
 * https://docs.kicad.org/doxygen/export__gencad__writer_8cpp_source.html
 * LAYER BOTTOM does not implicitly mirror coordinates; only explicit SHAPE flags do.
 * Outer-layer mounting-side compatibility follows the supplied repair-board exporter.
 */
export function parseGenCad(text: string, fileName: string): Board {
  const sections = sectionsFrom(text);
  const header = sections.get('HEADER')!;
  const scale = units(header);
  // ORIGIN records the source origin; placements and outlines already share the exported frame.
  for (const row of header.filter(row => row.tokens[0] === 'ORIGIN')) { args(row, 3); point(row, 1, scale); }
  const warnings: ParseIssue[] = [];
  const pads = new Map<string, Pad>(); const stacks = new Map<string, PadStack>();
  const shapes = new Map<string, Shape>(); const devices = new Map<string, Device>();
  const placements: Placement[] = [];
  let pad: Pad | undefined; let stack: PadStack | undefined; let shape: Shape | undefined;
  let placement: Placement | undefined; let device: Device | undefined;
  for (const row of sections.get('PADS') ?? []) {
    const t = row.tokens;
    if (t[0] === 'PAD') {
      args(row, 4); number(row, 3); if (pads.has(t[1])) fail('parse.error.duplicatePad', row.line, { name: t[1] });
      pad = { kind: t[2].toUpperCase(), paths: [] }; pads.set(t[1], pad);
    } else if (GEOMETRY.has(t[0])) { if (!pad) fail('parse.error.padGeometryWithoutPad', row.line); pad.paths.push(geometry(row, scale)); }
  }
  for (const row of sections.get('PADSTACKS') ?? []) {
    const t = row.tokens;
    if (t[0] === 'PADSTACK') {
      args(row, 3); if (stacks.has(t[1])) fail('parse.error.duplicatePadstack', row.line, { name: t[1] });
      stack = { drill: Math.max(0, distance(row, 2, scale)), pads: [] }; stacks.set(t[1], stack);
    } else if (t[0] === 'PAD') {
      args(row, 3); if (!stack) fail('parse.error.padRecordWithoutStack', row.line);
      stack.pads.push({ name: t[1], layer: padLayer(row, 2, true), rotation: t[3] === undefined ? 0 : number(row, 3), mirror: mirrorFlag(row, 4) });
    }
  }
  for (const row of sections.get('SHAPES')!) {
    const t = row.tokens;
    if (t[0] === 'SHAPE') {
      args(row, 2); if (shapes.has(t[1])) fail('parse.error.duplicateShape', row.line, { name: t[1] });
      shape = { name: t[1], pins: [], paths: [], insertion: '' }; shapes.set(t[1], shape);
    } else if (t[0] === 'PIN') {
      args(row, 6); if (!shape) fail('parse.error.pinWithoutShape', row.line);
      shape.pins.push({ number: t[1], stack: t[2], position: point(row, 3, scale), layer: padLayer(row, 5, false), rotation: t[6] === undefined ? 0 : number(row, 6), mirror: mirrorFlag(row, 7), line: row.line });
    } else if (t[0] === 'INSERT') { args(row, 2); if (shape) shape.insertion = t[1].toUpperCase(); }
    else if (GEOMETRY.has(t[0])) { if (!shape) fail('parse.error.shapeGeometryWithoutShape', row.line); shape.paths.push(geometry(row, scale)); }
  }
  const refs = new Set<string>();
  for (const row of sections.get('COMPONENTS')!) {
    const t = row.tokens;
    if (t[0] === 'COMPONENT') {
      args(row, 2); if (!t[1] || refs.has(t[1])) fail('parse.error.missingOrDuplicateComponent', row.line, { ref: t[1] ?? '' });
      refs.add(t[1]); placement = { ref: t[1], shape: '', device: '', value: '', position: { x: 0, y: 0 }, side: 'top', rotation: 0, mirror: '0', flip: false, line: row.line, hasPlace: false }; placements.push(placement);
    } else {
      if (!placement && ['PLACE', 'SHAPE', 'LAYER', 'DEVICE', 'ROTATION', 'VALUE'].includes(t[0])) fail('parse.error.componentDataWithoutComponent', row.line);
      if (!placement) continue;
      if (t[0] === 'PLACE') { args(row, 3); placement.position = point(row, 1, scale); placement.hasPlace = true; }
      else if (t[0] === 'ROTATION') { args(row, 2); placement.rotation = ((number(row, 1) % 360) + 360) % 360; }
      else if (t[0] === 'LAYER') {
        args(row, 2); const layer = t[1].toUpperCase();
        if (!['TOP', 'BOTTOM', 'ALL', 'BOTH'].includes(layer)) fail('parse.error.unknownComponentSide', row.line, { value: t[1] });
        placement.side = layer === 'TOP' ? 'top' : layer === 'BOTTOM' ? 'bottom' : 'both';
      } else if (t[0] === 'SHAPE') {
        args(row, 2); placement.shape = t[1]; placement.mirror = mirrorFlag(row, 2);
        const flip = (t[3] ?? '0').toUpperCase(); if (!['0', 'FLIP'].includes(flip)) fail('parse.error.unknownFlip', row.line, { value: flip });
        placement.flip = flip === 'FLIP';
      } else if (t[0] === 'DEVICE') { args(row, 2); placement.device = t[1]; }
      else if (t[0] === 'VALUE') placement.value = t.slice(1).join(' ');
    }
  }
  for (const row of sections.get('DEVICES') ?? []) {
    const t = row.tokens;
    if (t[0] === 'DEVICE') { args(row, 2); if (devices.has(t[1])) fail('parse.error.duplicateDevice', row.line, { name: t[1] }); device = { value: '', part: '', package: '' }; devices.set(t[1], device); }
    else if (device) {
      if (t[0] === 'VALUE') device.value = t.slice(1).join(' ');
      else if (t[0] === 'PART') device.part = t.slice(1).join(' ');
      else if (t[0] === 'PACKAGE') device.package = t.slice(1).join(' ');
    }
  }
  if (!placements.length) fail('parse.error.noComponents');
  // Preflight the instanced output before expanding any shape: every placement materializes its outline and its body
  // points (the shape paths, twice) plus the four pad-extent corners of each pin. Pad definitions are resolved once per
  // definition below, never per pin, so a pin adds nothing else to the plan.
  let plannedPins = 0, plannedPoints = 0;
  for (const item of placements) {
    const definition = shapes.get(item.shape);
    if (!definition) continue; // Reported per placement below.
    plannedPins += definition.pins.length;
    plannedPoints += 2 * definition.paths.reduce((sum, path) => sum + path.points.length, 0) + definition.pins.length * PIN_BODY_POINTS;
  }
  if (placements.length > GENCAD_LIMITS.components || plannedPins > GENCAD_LIMITS.pins || plannedPoints > GENCAD_LIMITS.geometryPoints) fail('parse.error.tooManyRecords');
  const pins: BoardPin[] = []; const components: BoardComponent[] = [];
  const nodePins = new Map<string, BoardPin[]>();
  let fallbackPads = 0; let fallbackComponents = 0; let approximatedPads = 0;
  // The extent and kind of a pad definition do not depend on the pin that uses it: resolved once per definition.
  const padExtents = new Map<Pad | undefined, PadExtent>();
  const padExtentOf = (padDefinition: Pad | undefined): PadExtent => {
    let extent = padExtents.get(padDefinition);
    if (!extent) {
      const localPoints = padDefinition?.paths.flatMap(path => path.points) ?? [];
      extent = {
        ...(localPoints.length ? { localBounds: boundsOf(localPoints) } : {}),
        round: padDefinition?.kind === 'ROUND' && padDefinition.paths.length === 1 && padDefinition.paths[0].kind === 'CIRCLE',
        exactRectangle: ['RECTANGULAR', 'SQUARE'].includes(padDefinition?.kind ?? '') && padDefinition?.paths.length === 1 && padDefinition.paths[0].kind === 'RECTANGLE',
      };
      padExtents.set(padDefinition, extent);
    }
    return extent;
  };
  for (const item of placements) {
    if (!item.hasPlace) fail('parse.error.missingPlace', item.line, { ref: item.ref });
    const definition = shapes.get(item.shape);
    if (!definition) {
      if (item.shape) fail('parse.error.shapeNotFound', item.line, { ref: item.ref, shape: item.shape });
      fail('parse.error.shapeNotSpecified', item.line, { ref: item.ref });
    }
    const placed = (p: Point) => transform(p, item.rotation, item.mirror, item.position);
    const componentPins: BoardPin[] = [];
    const contour = outerContour(definition.paths);
    let outline = contour.outline.map(placed);
    const bodyPoints = definition.paths.flatMap(path => path.points.map(placed));
    for (const [index, terminal] of definition.pins.entries()) {
      const padstack = stacks.get(terminal.stack);
      // FLIP changes padstack layer selection, independently from coordinate mirroring.
      // A BOTTOM PIN reverses its stack orientation relative to a TOP PIN.
      const reversedPin = terminal.layer === 'BOTTOM';
      const targetLayer = ((item.side === 'bottom') !== item.flip) !== reversedPin ? 'BOTTOM' : 'TOP';
      const outerPads = padstack?.pads.filter(p => outerLayer(p.layer));
      if (padstack?.pads.length && !outerPads?.length) {
        fail('parse.error.innerOnlyPadstack', terminal.line, { ref: item.ref, pin: terminal.number, stack: terminal.stack });
      }
      const stackPad = outerPads?.find(p => p.layer === targetLayer)
        ?? outerPads?.find(p => p.layer === 'ALL' || p.layer === 'BOTH')
        ?? outerPads?.[0];
      const { localBounds, round, exactRectangle } = padExtentOf(pads.get(stackPad?.name ?? terminal.stack));
      const validSize = localBounds && localBounds.maxX - localBounds.minX > 0 && localBounds.maxY - localBounds.minY > 0;
      if (!validSize) fallbackPads++;
      const padCenter = localBounds ? { x: (localBounds.minX + localBounds.maxX) / 2, y: (localBounds.minY + localBounds.maxY) / 2 } : { x: 0, y: 0 };
      const padPlaced = (p: Point) => {
        const inStack = transform(p, stackPad?.rotation ?? 0, stackPad?.mirror ?? '0');
        const inShape = transform(inStack, terminal.rotation, terminal.mirror, terminal.position);
        return placed(inShape);
      };
      const center = padPlaced(padCenter);
      const axisStart = padPlaced({ x: 0, y: 0 }); const axisEnd = padPlaced({ x: 1, y: 0 });
      const padAngle = Math.atan2(axisEnd.y - axisStart.y, axisEnd.x - axisStart.x);
      if (validSize && !round && !exactRectangle) approximatedPads++;
      const padBounds = localBounds
        ? round ? expand(boundsOf([center]), (localBounds.maxX - localBounds.minX) / 2) : boundsOf(rectangle(localBounds).map(padPlaced))
        : boundsOf([center]);
      // Exact rectangles keep their source dimensions. Mirroring can reverse the local
      // Y axis, but a centred rectangle is unchanged by that reflection.
      const width = exactRectangle && localBounds ? localBounds.maxX - localBounds.minX : padBounds.maxX - padBounds.minX;
      const height = exactRectangle && localBounds ? localBounds.maxY - localBounds.minY : padBounds.maxY - padBounds.minY;
      const rotation = exactRectangle ? ((padAngle * 180 / Math.PI % 360) + 360) % 360 : 0;
      let kind: BoardPin['shape'] = round || !validSize ? 'round' : 'rect';
      if (kind === 'rect' && Math.abs(width - height) < 1e-6) kind = 'square';
      const through = terminal.layer === 'ALL' || terminal.layer === 'BOTH'
        || outerPads?.some(p => p.layer === 'ALL' || p.layer === 'BOTH')
        || (outerPads?.some(p => p.layer === 'TOP') && outerPads.some(p => p.layer === 'BOTTOM'));
      // The supplied repair-board exporter uses a lone TOP stack on the component's
      // mounting side, including BOTTOM components without FLIP. Keep that convention
      // explicit; BOTTOM stack/PIN orientation selects the opposite mounting side.
      const opposite = (stackPad?.layer === 'BOTTOM') !== reversedPin;
      const side = through ? 'both' : opposite ? oppositeSide(item.side) : item.side;
      const pin: BoardPin = {
        id: `${encodeURIComponent(item.ref)}:${encodeURIComponent(terminal.number)}:${index}`,
        componentId: item.ref, number: terminal.number, name: terminal.number, net: '',
        ...center, side,
        radius: validSize ? round ? (localBounds.maxX - localBounds.minX) / 2 : Math.min(width, height) / 2 : 0,
        shape: kind, width, height, rotation,
      };
      pins.push(pin); componentPins.push(pin);
      bodyPoints.push(...rectangle(validSize ? padBounds : expand(padBounds, MARKER_RADIUS)));
      const key = JSON.stringify([item.ref, terminal.number]);
      const related = nodePins.get(key) ?? []; related.push(pin); nodePins.set(key, related);
    }
    if (!bodyPoints.length) bodyPoints.push(item.position);
    let bounds = boundsOf(bodyPoints);
    if (!outline.length) { fallbackComponents++; bounds = expand(bounds, 0.2); outline = rectangle(bounds); }
    const properties = devices.get(item.device);
    components.push({
      id: item.ref, ref: item.ref, value: item.value || properties?.value || properties?.part || '',
      package: properties?.package || definition.name, side: item.side, rotation: item.rotation,
      position: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
      bounds, outline, pinIds: componentPins.map(pin => pin.id),
    });
  }
  if (!pins.length) fail('parse.error.noPins');
  const netMap = new Map<string, BoardNet>(); const netPinSets = new Map<string, Set<string>>();
  let activeNet: BoardNet | undefined; let danglingNodes = 0; const danglingExamples: string[] = [];
  for (const row of sections.get('SIGNALS') ?? []) {
    const t = row.tokens;
    if (t[0] === 'SIGNAL') {
      args(row, 2); if (!t[1]) fail('parse.error.emptyNetName', row.line);
      activeNet = netMap.get(t[1]);
      if (!activeNet) { activeNet = { id: t[1], name: t[1], pinIds: [] }; netMap.set(t[1], activeNet); netPinSets.set(t[1], new Set()); }
    } else if (t[0] === 'NODE') {
      args(row, 3); if (!activeNet) fail('parse.error.nodeWithoutSignal', row.line);
      const related = nodePins.get(JSON.stringify([t[1], t[2]]));
      if (!related) { danglingNodes++; if (danglingExamples.length < 3) danglingExamples.push(`${t[1]}.${t[2]}`); continue; }
      for (const pin of related) {
        if (pin.net && pin.net !== activeNet.name) fail('parse.error.pinMultipleNets', row.line, { ref: t[1], pin: t[2] });
        pin.net = activeNet.name;
        const ids = netPinSets.get(activeNet.name)!;
        if (!ids.has(pin.id)) { ids.add(pin.id); activeNet.pinIds.push(pin.id); }
      }
    }
  }
  if (fallbackPads) warnings.push({ key: 'parse.warning.fallbackPads', params: { count: fallbackPads } });
  if (fallbackComponents) warnings.push({ key: 'parse.warning.fallbackComponents', params: { count: fallbackComponents } });
  if (approximatedPads) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximatedPads } });
  if (danglingNodes) warnings.push({ key: 'parse.warning.danglingNodes', params: { count: danglingNodes, examples: danglingExamples.join(', ') } });
  if (!netMap.size) warnings.push({ key: 'parse.warning.noNets' });
  const boardPaths = (sections.get('BOARD') ?? []).filter(row => GEOMETRY.has(row.tokens[0])).map(row => geometry(row, scale));
  const boardContour = outerContour(boardPaths);
  let outline = boardContour.outline;
  const allPoints = components.flatMap(component => rectangle(component.bounds));
  if (!outline.length) {
    outline = rectangle(expand(boundsOf([...allPoints, ...boardPaths.flatMap(path => path.points)]), 2));
    warnings.push({ key: 'parse.warning.missingBoardOutline' });
  } else if (boardContour.extras) warnings.push({ key: 'parse.warning.boardCutouts' });
  const bounds = boundsOf([...outline, ...allPoints]);
  const name = fileName.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '';
  return { name, format: 'GENCAD 1.4', units: 'mm', components, pins, nets: [...netMap.values()], outline, bounds, warnings };
}
