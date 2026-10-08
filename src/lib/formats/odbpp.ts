/*
 * Original TRACE adapter (MIT): ODB++ product model reader. Facts come from the ODB++ Design Format Specification 8.1 (Siemens;
 * read for facts, nothing reproduced). No ODB++ implementation code was used.
 *
 * What is read: matrix/matrix (steps, layer types and order), misc/info (default units), the chosen step's stephdr (nested steps),
 * profile (board outline and cutouts), eda/data (nets with toeprint subnets, packages with pins and outlines), the component layers
 * comp_+_top / comp_+_bot (CMP, PRP, TOP and BOM records) and, only when eda/data has no nets, netlists/cadnet/netlist matched to
 * pins by position. Copper features, drills, symbols, fonts and attributes of graphic layers are not read.
 *
 * Coordinates: ODB++ is Y-up and seen from the top, like the TRACE board model; every file carries its own UNITS (MM or INCH; a file
 * without one falls back to misc/info, then to INCH as the specification says). Pins are placed at their TOP record positions, which
 * are board coordinates. Package geometry (pad shapes, bodies) is placed with the component's rotation (clockwise in ODB++) and mirror
 * (rotate, then mirror X); when that does not reproduce the TOP positions, the placement that does is used and the import says so.
 * A component's rotation is the file's angle turned into TRACE's counter-clockwise convention on both sides (the side carries the mirror).
 *
 * Pin sides: the eda/data FID records of a toeprint's subnet name the board features it consists of; with the matrix row order they say
 * which copper it touches (an edge-connector pad of a top part on the bottom copper is a bottom pin). Without them a through-hole pin is
 * on both sides and any other on its part's side. A toeprint without a net whose features lie only on mask or paste layers (a paste
 * aperture) is not a pin; a hole (PIN mount type H) stays one. Models written by KiCad get the KiCad reader's rule for single-pad
 * "unconnected-(…)" placeholder nets, so both readings of one design agree.
 */
import type { Board, BoardSide, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, note, TextDecodeError, type ParseInput, type RawPart, type RawPin } from './common';
import { odbTail, readContainer, resolveLimits, sniffContainer, treeFromFiles, type OdbppContainer, type OdbppLimits, type OdbppTree } from './odbpp-archive';
import { pathEvidence } from './odbpp-sniff';
import {
  FID, MM_PER_UNIT, parseCadNetlist, parseComponents, parseEdaData, parseKeyValues, parseMatrix, parseSurfaces,
  type ComponentRecord, type Components, type EdaData, type LayerKind, type EdaPackage, type EdaPin, type Matrix, type MatrixLayer, type OdbUnits, type Outline, type Polygon,
} from './odbpp-records';

export { DEFAULT_ODBPP_LIMITS, type OdbppContainer, type OdbppLimits } from './odbpp-archive';
export const ODBPP_FORMAT = 'ODB++';

export interface OdbppSniff { id: 'odbpp'; confidence: number; container: OdbppContainer; detail: string; nested?: string }
export interface OdbppStepInfo {
  name: string;
  /** Listed in matrix/matrix (false: found only as a directory). */
  inMatrix: boolean;
  components: number;
  toeprints: number;
  hasEda: boolean;
  hasProfile: boolean;
  hasNetlist: boolean;
  /** Steps nested by STEP-REPEAT records (panels and arrays); their instances are not expanded. */
  childSteps: string[];
  /** Why the step's files could not be read (the step is then never chosen by default, and reading it throws). */
  error?: string;
}
export interface OdbppComponentInfo {
  ref: string;
  side: 'top' | 'bottom';
  layer: string;
  /** CMP part_name field. */
  partName: string;
  /** Best part number: a PART_NUMBER-like property, else the chosen BOM MPN, VPL_MPN, CPN or IPN, else the part name. */
  partNumber: string;
  value: string;
  packageName: string;
  mountType?: string;
  properties: Record<string, string>;
  attributes: Record<string, string>;
  bom: Array<[string, string]>;
}
export interface OdbppModel {
  board: Board;
  step: string;
  steps: OdbppStepInfo[];
  container: OdbppContainer;
  /** Product-model directory inside the archive ("" when the archive root is the product model). */
  root: string;
  layers: MatrixLayer[];
  /** Units each read file declared (or fell back to), by path relative to the product model. */
  units: Record<string, OdbUnits>;
  source?: string;
  version?: string;
  /** Parallel to board.components. */
  components: OdbppComponentInfo[];
}
export interface OdbppSource {
  container: OdbppContainer;
  root: string;
  steps: OdbppStepInfo[];
  /** The step parseOdbpp reads when none is named (null when no step holds components). */
  defaultStep: string | null;
  read(step?: string): OdbppModel;
  board(step?: string): Board;
}
export interface OdbppReadOptions { step?: string; limits?: Partial<OdbppLimits> }
export interface OdbppFileSet { name: string; files: Readonly<Record<string, Uint8Array>> | ReadonlyMap<string, Uint8Array> }

const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_VARIANT' = 'INVALID_FORMAT'): never => { throw new BoardFormatError(`ODB++: ${message}`, code, ODBPP_FORMAT); };
const tag = (error: unknown): never => {
  if (error instanceof BoardFormatError && !error.format) { const tagged = new BoardFormatError(error.message, error.code, ODBPP_FORMAT); tagged.cause = error; throw tagged; }
  throw error;
};
const list = (names: string[], max = 6) => names.slice(0, max).join(', ') + (names.length > max ? ', …' : '');

/** Archive bytes → bounded sniff verdict with a confidence in [0, 1]; null when nothing points to an ODB++ product model. */
export function sniffOdbpp(data: Uint8Array, limits?: Partial<OdbppLimits>): OdbppSniff | null {
  if (!(data instanceof Uint8Array)) return null;
  const resolved = resolveLimits(limits);
  const found = sniffContainer(data, resolved);
  if (!found) return null;
  const evidence = pathEvidence(found.paths, resolved);
  if (!evidence.confidence) return null;
  return { id: 'odbpp', confidence: evidence.confidence, container: found.container, detail: `${found.paths.length} entries inspected${evidence.matrix ? ', matrix/matrix present' : ''}${evidence.unsafe ? ', ODB++ paths only behind unsafe (absolute or parent-directory) names' : ''}`, ...(found.nested ? { nested: found.nested } : {}) };
}

/** Opens an archive; null when the bytes are not an ODB++ archive (so a dispatcher can try other readers). */
export function openOdbpp(input: ParseInput, limits?: Partial<OdbppLimits>): OdbppSource | null {
  try {
    if (!(input?.data instanceof Uint8Array)) return null;
    const resolved = resolveLimits(limits);
    if (!sniffOdbpp(input.data, resolved)) return null;
    const tree = readContainer(input.data, resolved);
    if (!tree) return null;
    return source(tree, input.name);
  } catch (error) { return tag(error); }
}
/** An extracted product-model directory (or its parent) as relative path → bytes. */
export function openOdbppFiles(set: OdbppFileSet, limits?: Partial<OdbppLimits>): OdbppSource {
  try { return source(treeFromFiles(set.files, resolveLimits(limits)), set.name); } catch (error) { return tag(error); }
}
/** Same input and output as every TRACE board adapter: null for bytes that are not ODB++, BoardFormatError for a damaged model. */
export function parseOdbpp(input: ParseInput, options: OdbppReadOptions = {}): Board | null {
  return openOdbpp(input, options.limits)?.board(options.step) ?? null;
}
export function parseOdbppFiles(set: OdbppFileSet, options: OdbppReadOptions = {}): Board { return openOdbppFiles(set, options.limits).board(options.step); }
export function readOdbpp(input: ParseInput, options: OdbppReadOptions = {}): OdbppModel | null { return openOdbpp(input, options.limits)?.read(options.step) ?? null; }
export function listOdbppSteps(input: ParseInput, limits?: Partial<OdbppLimits>): OdbppStepInfo[] | null { return openOdbpp(input, limits)?.steps ?? null; }

// --- product model ---

const archiveName = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(?:tar\.gz|tar\.z|tgz|tar|zip)$/i, '') || base;
};
function text(data: Uint8Array, file: string): string {
  try { return decodeText(data); }
  catch (error) { if (error instanceof TextDecodeError) return fail(`${file} is not a text file.`); throw error; }
}
interface Job {
  container: OdbppContainer; root: string; name: string; tree: OdbppTree;
  get(tail: string): Uint8Array | undefined;
  matrix: Matrix | null; infoUnits?: OdbUnits; source?: string; version?: string; rootCount: number;
  /** Kept file paths of the chosen product model, relative to it. */
  tails: string[];
  layerByName: Map<string, MatrixLayer>;
  /** First and last matrix row of a copper layer (null without copper layers). */
  copperRows: { min: number; max: number } | null;
  /** Disclosures about the product model as a whole (unreadable matrix or misc/info). */
  notes: string[];
}
/** The reason of a BoardFormatError without the "ODB++ <file>:" prefix the record parsers add, for a note. */
const reason = (error: BoardFormatError) => error.message.replace(/^ODB\+\+(?: archive)?:?\s*/, '').slice(0, 200);
/** Runs `read`; a BoardFormatError other than an exceeded limit becomes `fallback` (the caller discloses it). */
function tolerant<T>(read: () => T, fallback: (error: BoardFormatError) => T): T {
  try { return read(); }
  catch (error) { if (error instanceof BoardFormatError && error.code !== 'LIMIT_EXCEEDED') return fallback(error); throw error; }
}
function job(tree: OdbppTree, name: string): Job {
  const roots = new Map<string, { files: Map<string, Uint8Array>; matrix: boolean }>();
  for (const [path, data] of tree.files) {
    const split = odbTail(path);
    if (!split) continue;
    let root = roots.get(split.root);
    if (!root) roots.set(split.root, root = { files: new Map(), matrix: false });
    root.files.set(split.tail, data);
    if (split.tail === 'matrix/matrix') root.matrix = true;
  }
  if (!roots.size) fail(`the archive has an ODB++ layout, but none of the files a board needs (matrix/matrix, components, eda/data) could be read${tree.links ? ` (${tree.links} links were skipped)` : ''}${tree.unsafePaths ? ` (${tree.unsafePaths} unsafe paths were ignored)` : ''}.`);
  const ranked = [...roots].sort(([a, x], [b, y]) => Number(y.matrix) - Number(x.matrix) || y.files.size - x.files.size || (a < b ? -1 : a > b ? 1 : 0));
  const [root, chosen] = ranked[0];
  const get = (tail: string) => chosen.files.get(tail);
  const notes: string[] = [];
  const matrixData = get('matrix/matrix');
  // A damaged matrix or misc/info does not hide the board: steps and layers are then found by directory, units by each file.
  const matrix = matrixData ? tolerant(() => parseMatrix(text(matrixData, 'matrix/matrix')), error => { notes.push(`matrix/matrix could not be read (${reason(error)}).`); return null; }) : null;
  if (matrix?.illegalNames.count) notes.push(`${matrix.illegalNames.count} STEP/LAYER block(s) in matrix/matrix have names that are not legal ODB++ entity names and were skipped: ${list(matrix.illegalNames.examples.map(name => `"${name}"`))}.`);
  const infoData = get('misc/info');
  let infoUnits: OdbUnits | undefined, source: string | undefined, version: string | undefined;
  const info = infoData ? tolerant(() => parseKeyValues(text(infoData, 'misc/info'), 'misc/info').values, error => { notes.push(`misc/info could not be read (${reason(error)}).`); return null; }) : null;
  if (info) {
    const units = info.get('UNITS')?.toUpperCase();
    if (units === 'MM' || units === 'INCH') infoUnits = units;
    source = (info.get('ODB_SOURCE') || info.get('SAVE_APP'))?.slice(0, 120) || undefined;
    const major = info.get('ODB_VERSION_MAJOR'), minor = info.get('ODB_VERSION_MINOR');
    if (major && /^\d{1,3}$/.test(major)) version = `${major}${minor && /^\d{1,3}$/.test(minor) ? `.${minor}` : ''}`;
  }
  const layerByName = new Map<string, MatrixLayer>();
  let minCopper = Infinity, maxCopper = -Infinity;
  for (const layer of matrix?.layers ?? []) {
    if (!layerByName.has(layer.name)) layerByName.set(layer.name, layer);
    if (COPPER.has(layer.type)) { minCopper = Math.min(minCopper, layer.row); maxCopper = Math.max(maxCopper, layer.row); }
  }
  const copperRows = minCopper <= maxCopper ? { min: minCopper, max: maxCopper } : null;
  return { container: tree.container, root, name: archiveName(name), tree, get, matrix, infoUnits, source, version, rootCount: roots.size, notes, tails: [...chosen.files.keys()], layerByName, copperRows };
}

const COPPER = new Set(['SIGNAL', 'POWER_GROUND', 'MIXED']);
interface ComponentLayer { name: string; side: 'top' | 'bottom'; parsed: Components; file: string }
/** Per toeprint of a component layer (offsets by component): the eda/data net index (-1: none) and the FID mask of its subnet. */
interface SubnetTable { offsets: Int32Array; nets: Int32Array; masks: Int32Array }
interface StepData { info: OdbppStepInfo; layers: ComponentLayer[]; skippedLayers: string[]; failure?: BoardFormatError }
interface StepFiles { inMatrix: boolean; componentLayers: string[] }

/** Matrix steps in column order, then steps found only as directories (sorted), each with the component layers present: one pass over the files. */
function stepIndex(j: Job): Map<string, StepFiles> {
  const index = new Map<string, StepFiles>();
  for (const step of j.matrix?.steps ?? []) if (!index.has(step.name)) index.set(step.name, { inMatrix: true, componentLayers: [] });
  const found = new Map<string, StepFiles>();
  for (const tail of j.tails) {
    const match = /^steps\/([^/]+)\/(.+)$/.exec(tail);
    if (!match) continue;
    let step = index.get(match[1]) ?? found.get(match[1]);
    if (!step) found.set(match[1], step = { inMatrix: false, componentLayers: [] });
    const layer = /^layers\/([^/]+)\/components$/.exec(match[2]);
    if (layer) step.componentLayers.push(layer[1]);
  }
  for (const name of [...found.keys()].sort()) index.set(name, found.get(name)!);
  return index;
}
/** Component layers of a step, top first: comp_+_top / comp_+_bot by name, other COMPONENT layers by their row against the copper rows. */
function componentLayers(j: Job, step: string, files: StepFiles, units: (file: string, declared?: OdbUnits) => OdbUnits): { layers: ComponentLayer[]; skipped: string[] } {
  const prefix = `steps/${step}/layers/`;
  const sideOf = (name: string): 'top' | 'bottom' | null => {
    if (name === 'comp_+_top') return 'top';
    if (name === 'comp_+_bot') return 'bottom';
    const layer = j.layerByName.get(name);
    if (!layer || layer.type !== 'COMPONENT' || !j.copperRows) return null;
    if (layer.row < j.copperRows.min) return 'top';
    if (layer.row > j.copperRows.max) return 'bottom';
    return null; // embedded components between copper layers
  };
  const layers: ComponentLayer[] = [], skipped: string[] = [];
  for (const name of [...new Set(files.componentLayers)].sort()) {
    const file = `${prefix}${name}/components`, data = j.get(file);
    if (!data) continue;
    const side = sideOf(name);
    if (!side) { skipped.push(name); continue; }
    const parsed = parseComponents(text(data, file), file);
    units(file, parsed.units);
    layers.push({ name, side, parsed, file });
  }
  layers.sort((a, b) => Number(a.side === 'bottom') - Number(b.side === 'bottom') || Number(b.name.startsWith('comp_+_')) - Number(a.name.startsWith('comp_+_')));
  return { layers, skipped };
}

function source(tree: OdbppTree, name: string): OdbppSource {
  const j = job(tree, name);
  const cache = new Map<string, StepData>();
  const declared: Record<string, OdbUnits> = {}, fallbacks = new Set<string>();
  const unitsOf = (file: string, units?: OdbUnits): OdbUnits => {
    if (units) return declared[file] = units;
    fallbacks.add(file);
    return declared[file] = j.infoUnits ?? 'INCH';
  };
  const index = stepIndex(j);
  const stepData = (stepName: string): StepData => {
    const cached = cache.get(stepName);
    if (cached) return cached;
    const base = `steps/${stepName}/`, files = index.get(stepName)!;
    let result: StepData;
    try {
      const { layers, skipped } = componentLayers(j, stepName, files, unitsOf);
      const header = j.get(`${base}stephdr`);
      const childSteps = header ? parseKeyValues(text(header, `${base}stephdr`), `${base}stephdr`).blocks.filter(block => block.name === 'STEP-REPEAT').map(block => (block.values.get('NAME') ?? '').toLowerCase()).filter(Boolean) : [];
      result = { layers, skippedLayers: skipped, info: {
        name: stepName, inMatrix: files.inMatrix,
        components: layers.reduce((sum, layer) => sum + layer.parsed.components.length, 0),
        toeprints: layers.reduce((sum, layer) => sum + layer.parsed.components.reduce((count, component) => count + component.toeprints.length, 0), 0),
        hasEda: !!j.get(`${base}eda/data`), hasProfile: !!j.get(`${base}profile`), hasNetlist: !!j.get(`${base}netlists/cadnet/netlist`), childSteps: [...new Set(childSteps)],
      } };
    } catch (error) {
      // A damaged file in one step (often a panel or a coupon) must not hide the others; reading this step reports it.
      if (!(error instanceof BoardFormatError) || error.code === 'LIMIT_EXCEEDED') throw error;
      result = { layers: [], skippedLayers: [], failure: error, info: {
        name: stepName, inMatrix: files.inMatrix, components: 0, toeprints: 0,
        hasEda: !!j.get(`${base}eda/data`), hasProfile: !!j.get(`${base}profile`), hasNetlist: !!j.get(`${base}netlists/cadnet/netlist`), childSteps: [], error: reason(error),
      } };
    }
    cache.set(stepName, result);
    return result;
  };
  const steps = [...index.keys()].map(step => stepData(step).info);
  const withParts = steps.filter(step => step.components > 0);
  const plain = withParts.filter(step => !step.childSteps.length);
  const pool = plain.length ? plain : withParts;
  const defaultStep = pool.length ? pool.reduce((best, step) => step.components > best.components ? step : best).name : null;
  const read = (requested?: string): OdbppModel => {
    try {
      let chosen: string;
      if (requested !== undefined) {
        const wanted = String(requested).toLowerCase();
        if (!index.has(wanted)) return fail(`step "${String(requested).slice(0, 64)}" does not exist; the product model has ${steps.length ? list(steps.map(step => step.name)) : 'no steps'}.`);
        chosen = wanted;
      } else if (defaultStep) chosen = defaultStep;
      else {
        const broken = steps.find(step => step.error);
        if (broken) throw cache.get(broken.name)!.failure;
        return fail(`no step holds components (comp_+_top / comp_+_bot)${steps.length ? `; steps: ${list(steps.map(step => step.name))}` : ''}.`);
      }
      const data = stepData(chosen);
      if (data.failure) throw data.failure;
      return model(j, chosen, steps, data, requested === undefined ? pool : [], unitsOf, declared, fallbacks);
    } catch (error) { return tag(error); }
  };
  return { container: j.container, root: j.root.replace(/\/$/, ''), steps, defaultStep, read, board: step => read(step).board };
}

// --- placement of package geometry ---

/** cos/sin of an angle in degrees, exact at multiples of 90. */
function trig(degrees: number): [number, number] {
  const turns = degrees / 90;
  if (Number.isInteger(turns)) { const q = ((turns % 4) + 4) % 4; return [[1, 0, -1, 0][q], [0, 1, 0, -1][q]]; }
  const angle = degrees * Math.PI / 180;
  return [Math.cos(angle), Math.sin(angle)];
}
const normalizeAngle = (degrees: number) => { const value = ((degrees % 360) + 360) % 360; return value === 360 || Object.is(value, -0) ? 0 : value; };
interface Placement {
  rotation: number; mirror: 'none' | 'x' | 'y'; apply(p: Point): Point;
  /** Board direction (counter-clockwise degrees) of a package direction: a mirror reverses the package angle. */
  orient(degrees: number): number;
}
/** p → R(rotation, counter-clockwise) · M · p + origin, all in mm. */
function placement(rotation: number, mirror: Placement['mirror'], origin: Point): Placement {
  const [cos, sin] = trig(rotation);
  return {
    rotation: normalizeAngle(rotation), mirror,
    orient: degrees => normalizeAngle(mirror === 'none' ? rotation + degrees : rotation - degrees),
    apply: p => {
      const x = mirror === 'x' ? -p.x : p.x, y = mirror === 'y' ? -p.y : p.y;
      return { x: origin.x + x * cos - y * sin, y: origin.y + x * sin + y * cos };
    },
  };
}
/**
 * The specification's placement (rotate clockwise by rot, then mirror X when the mirror flag is M) unless it misses the TOP positions;
 * then the first of the other rotation/mirror combinations that reproduces them (an exporter that writes bottom packages already flipped).
 */
function fitPlacement(component: ComponentRecord, pkg: EdaPackage | undefined, toMm: { component: number; eda: number }): { placement: Placement; verdict: 'spec' | 'alternate' | 'unverified' | 'unchecked' } {
  const origin = { x: component.x * toMm.component, y: component.y * toMm.component }, r = component.rot;
  const spec = component.mirror ? placement(r, 'x', origin) : placement(-r, 'none', origin);
  const pairs: Array<[Point, Point]> = [];
  if (pkg) for (const toeprint of component.toeprints) {
    const pin = pkg.pins[toeprint.pin];
    if (pin) pairs.push([{ x: pin.x * toMm.eda, y: pin.y * toMm.eda }, { x: toeprint.x * toMm.component, y: toeprint.y * toMm.component }]);
  }
  if (!pairs.length) return { placement: spec, verdict: 'unchecked' };
  const extent = pairs.reduce((max, [p]) => Math.max(max, Math.abs(p.x), Math.abs(p.y)), 0);
  const tolerance = 0.03 + 0.002 * extent;
  const error = (candidate: Placement) => pairs.reduce((max, [p, q]) => { const at = candidate.apply(p); return Math.max(max, Math.hypot(at.x - q.x, at.y - q.y)); }, 0);
  if (error(spec) <= tolerance) return { placement: spec, verdict: 'spec' };
  const candidates = ([[-r, 'none'], [r, 'none'], [-r, 'x'], [r, 'x'], [-r, 'y'], [r, 'y']] as const).map(([angle, mirror]) => placement(angle, mirror, origin));
  let best: Placement | undefined, bestError = Infinity;
  for (const candidate of candidates) { const value = error(candidate); if (value < bestError) { best = candidate; bestError = value; } }
  return best && bestError <= tolerance ? { placement: best, verdict: 'alternate' } : { placement: spec, verdict: 'unverified' };
}

/** `angle`: counter-clockwise direction of the width in package axes (rotated rectangles). */
interface Pad { shape: RawPin['shape']; radius: number; width?: number; height?: number; angle?: number; approximated: boolean }
function boundsOf(points: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}
function area(points: Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index++) { const a = points[index], b = points[(index + 1) % points.length]; sum += a.x * b.y - b.x * a.y; }
  return Math.abs(sum / 2);
}
/** The ring without repeated vertices and without vertices on a straight line between their neighbours (relative tolerance). */
function ringCorners(ring: Point[]): Point[] {
  const unique = ring.filter((p, index) => { const q = ring[(index + ring.length - 1) % ring.length]; return p.x !== q.x || p.y !== q.y; });
  if (unique.length < 3) return unique;
  return unique.filter((p, index) => {
    const a = unique[(index + unique.length - 1) % unique.length], b = unique[(index + 1) % unique.length];
    const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y;
    return Math.abs(ux * vy - uy * vx) > 1e-6 * Math.hypot(ux, uy) * Math.hypot(vx, vy);
  });
}
/** A four-corner ring with right angles and equal opposite sides, within file resolution (2°, 2 %): its side lengths and the direction of its first side. */
function rectangle(ring: Point[]): { width: number; height: number; angle: number } | null {
  const c = ringCorners(ring);
  if (c.length !== 4) return null;
  const sides = c.map((p, index) => { const q = c[(index + 1) % 4]; return { x: q.x - p.x, y: q.y - p.y }; });
  const lengths = sides.map(side => Math.hypot(side.x, side.y));
  if (!lengths.every(length => length > 0)) return null;
  for (let index = 0; index < 4; index++) {
    const u = sides[index], v = sides[(index + 1) % 4];
    if (Math.abs(u.x * v.x + u.y * v.y) > Math.sin(Math.PI / 90) * lengths[index] * lengths[(index + 1) % 4]) return null;
  }
  if (Math.abs(lengths[0] - lengths[2]) > 0.02 * Math.max(lengths[0], lengths[2]) || Math.abs(lengths[1] - lengths[3]) > 0.02 * Math.max(lengths[1], lengths[3])) return null;
  const angle = Math.atan2(sides[0].y, sides[0].x) * 180 / Math.PI;
  return { width: (lengths[0] + lengths[2]) / 2, height: (lengths[1] + lengths[3]) / 2, angle: Math.round(normalizeAngle(angle) * 1e6) / 1e6 % 180 };
}
/** Convex hull (Andrew's monotone chain), counter-clockwise, without collinear points. */
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let index = sorted.length - 1; index >= 0; index--) { const p = sorted[index]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const MAX_HULL = 256;
/**
 * Smallest-area rectangle around the points (one side lies on a hull edge): side lengths and the direction of the first side.
 * Null when the hull has more than MAX_HULL corners (the search is quadratic in them) or no area.
 */
function orientedBox(points: Point[]): { width: number; height: number; angle: number; area: number } | null {
  const h = hull(points);
  if (h.length < 3 || h.length > MAX_HULL) return null;
  let best: { width: number; height: number; angle: number; area: number } | null = null;
  for (let index = 0; index < h.length; index++) {
    const a = h[index], b = h[(index + 1) % h.length], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(length > 0)) continue;
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of h) { const u = p.x * ux + p.y * uy, v = -p.x * uy + p.y * ux; minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-12) best = { width: maxU - minU, height: maxV - minV, angle: Math.atan2(uy, ux) * 180 / Math.PI, area };
  }
  if (!best || !(best.area > 0)) return null;
  // The same box seen from its other side: report the direction in [0°, 90°) so axis-aligned boxes get angle 0.
  let { width, height, angle } = best;
  angle = Math.round(normalizeAngle(angle) * 1e6) / 1e6 % 180;
  if (angle >= 90) { angle -= 90; [width, height] = [height, width]; }
  return { width, height, angle, area: best.area };
}
/** Pad size from the first pin outline, in package axes (mm); other contours become their smallest enclosing rectangle (approximated). */
function padOf(pin: EdaPin, scale: number): Pad | null {
  const outline = pin.outlines[0];
  if (!outline) return null;
  if (outline.kind === 'circle') return { shape: 'round', radius: outline.r * scale, approximated: false };
  if (outline.kind === 'square') return { shape: 'square', radius: outline.half * scale, width: 2 * outline.half * scale, height: 2 * outline.half * scale, approximated: false };
  if (outline.kind === 'rect') {
    const width = outline.w * scale, height = outline.h * scale;
    return { shape: width === height ? 'square' : 'rect', radius: Math.min(width, height) / 2, width, height, approximated: false };
  }
  const islands = outline.polygons.filter(polygon => !polygon.hole);
  if (!islands.length) return null;
  if (islands.length === 1 && islands[0].circle) return { shape: 'round', radius: islands[0].circle.r * scale, approximated: false };
  const points = islands.flatMap(polygon => polygon.points), box = boundsOf(points);
  const width = (box.maxX - box.minX) * scale, height = (box.maxY - box.minY) * scale;
  if (islands.length === 1) {
    const ring = islands[0].points;
    // Every edge horizontal or vertical and the area equal to the bounding box: a rectangle, extra collinear vertices included.
    const boxArea = (box.maxX - box.minX) * (box.maxY - box.minY);
    const axisRectangle = ring.length >= 4 && boxArea > 0 && ring.every((p, index) => { const q = ring[(index + 1) % ring.length]; return p.x === q.x || p.y === q.y; }) && Math.abs(area(ring) - boxArea) <= 1e-9 * boxArea;
    if (axisRectangle) return { shape: width === height ? 'square' : 'rect', radius: Math.min(width, height) / 2, width, height, approximated: false };
    // A polygonized circle: at least eight vertices at the same distance from the box centre, in a square box, with no side longer than
    // the chord of a 50° arc. The vertices lie on the circle, so their mean distance is the radius (half the box is a little smaller when
    // no vertex sits on an axis). The chord limit keeps out rounded squares, whose vertices all lie on the corner arcs too.
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2, distances = ring.map(p => Math.hypot(p.x - cx, p.y - cy));
    const r = distances.reduce((sum, distance) => sum + distance, 0) / distances.length, chord = 2 * r * Math.sin(25 * Math.PI / 180);
    const round = ring.length >= 8 && r > 0 && Math.abs(width - height) <= 0.02 * width && distances.every(distance => Math.abs(distance - r) <= 0.03 * r)
      && ring.every((p, index) => { const q = ring[(index + 1) % ring.length]; return Math.hypot(q.x - p.x, q.y - p.y) <= chord; });
    if (round) return { shape: 'round', radius: r * scale, approximated: false };
    const rotated = rectangle(ring);
    if (rotated) {
      const w = rotated.width * scale, h = rotated.height * scale;
      return { shape: Math.abs(w - h) <= 1e-9 * Math.max(w, h) ? 'square' : 'rect', radius: Math.min(w, h) / 2, width: w, height: h, angle: rotated.angle, approximated: false };
    }
  }
  // Rounded, chamfered, oval and custom shapes: the smallest enclosing rectangle when it is clearly smaller than the axis-aligned box (a pad
  // turned inside its package), else the axis-aligned box.
  const box2 = orientedBox(points);
  if (box2 && box2.angle !== 0 && box2.area < 0.95 * (box.maxX - box.minX) * (box.maxY - box.minY)) {
    const w = box2.width * scale, h = box2.height * scale;
    return { shape: Math.abs(w - h) <= 1e-9 * Math.max(w, h) ? 'square' : 'rect', radius: Math.min(w, h) / 2, width: w, height: h, angle: box2.angle, approximated: true };
  }
  return { shape: width === height ? 'square' : 'rect', radius: Math.min(width, height) / 2, width, height, approximated: true };
}
function memo<K, V>(cache: Map<K, V>, key: K, make: () => V): V {
  if (cache.has(key)) return cache.get(key)!;
  const value = make();
  cache.set(key, value);
  return value;
}
const CIRCLE_POINTS = 24;
function circlePoints(x: number, y: number, r: number): Point[] {
  return Array.from({ length: CIRCLE_POINTS }, (_, index) => { const angle = 2 * Math.PI * index / CIRCLE_POINTS; return { x: x + r * Math.cos(angle), y: y + r * Math.sin(angle) }; });
}
/** Body polygon in package units: the first package outline (largest island of a contour), else the PKG bounding box. */
function bodyOf(pkg: EdaPackage): Point[] | null {
  const outline: Outline | undefined = pkg.outlines[0];
  const rect = (minX: number, minY: number, maxX: number, maxY: number) => [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  if (outline?.kind === 'rect') return rect(outline.x, outline.y, outline.x + outline.w, outline.y + outline.h);
  if (outline?.kind === 'square') return rect(outline.x - outline.half, outline.y - outline.half, outline.x + outline.half, outline.y + outline.half);
  if (outline?.kind === 'circle') return circlePoints(outline.x, outline.y, outline.r);
  if (outline?.kind === 'contour') {
    const islands = outline.polygons.filter(polygon => !polygon.hole && polygon.points.length >= 3);
    if (islands.length) return islands.reduce((best, polygon) => area(polygon.points) > area(best.points) ? polygon : best).points;
  }
  return pkg.bbox && pkg.bbox.maxX > pkg.bbox.minX && pkg.bbox.maxY > pkg.bbox.minY ? rect(pkg.bbox.minX, pkg.bbox.minY, pkg.bbox.maxX, pkg.bbox.maxY) : null;
}
const MAX_BODY_POINTS = 512, MAX_PLACED_OUTLINE_POINTS = 8_000_000;

// --- properties ---

/** Property names that hold the component value, strongest first (a writer such as KiCad lists every field alphabetically, so the first match in file order is not the best one). */
const VALUE_PROPERTIES = ['value', 'comp_value', 'part_value', 'val'];
const PART_NUMBER_PROPERTY = /^(?:part_?number|part_?no|partnumber|pn|mpn|manufacturer_?part_?number|mfr_?part_?number)$/i;
const MOUNT_TYPES = ['Other', 'SMT', 'THMT', 'PressFit'];
function attributes(raw: string, parsed: Components): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const item of raw.split(',')) {
    const assignment = item.trim();
    if (!assignment) continue;
    const equals = assignment.indexOf('='), index = Number(equals < 0 ? assignment : assignment.slice(0, equals));
    const name = Number.isSafeInteger(index) ? parsed.attributeNames.get(index) ?? `@${index}` : assignment.slice(0, 40);
    let value = equals < 0 ? 'true' : assignment.slice(equals + 1);
    if (name === '.comp_mount_type' && /^\d$/.test(value)) value = MOUNT_TYPES[Number(value)] ?? value;
    else if (/^\.desc\d*$|^\.comp_value$|^\.part_desc\d*$/i.test(name) && /^\d+$/.test(value)) value = parsed.attributeTexts.get(Number(value)) ?? value;
    Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function componentValue(properties: ReadonlyArray<[string, string]>): string {
  for (const wanted of VALUE_PROPERTIES) {
    const found = properties.find(([name]) => name.toLowerCase() === wanted);
    if (found) return found[1];
  }
  return '';
}
const MPN_STATUS = /^(-1|0|1) ([01YN]) (.+)$/i;
/**
 * BOM DATA part number. An MPN line is either "MPN <qualify> <chosen> <mpn>" (chosen 1 or Y) or a bare "MPN <mpn>" whose group later
 * says "CHS 1" (the alternate-parts layout); the chosen MPN wins, else the first one, else VPL_MPN, CPN, IPN, else the CMP part name.
 */
function partNumber(component: ComponentRecord): string {
  const property = component.properties.find(([name, value]) => PART_NUMBER_PROPERTY.test(name) && value.trim());
  if (property) return property[1].trim();
  const first: Record<string, string> = Object.create(null);
  let firstMpn = '', chosen = '', lastMpn = '';
  for (const [record, raw] of component.bom) {
    const value = raw.trim().replace(/[ \t]+/g, ' ');
    if (!value) continue;
    if (record === 'MPN') {
      const status = MPN_STATUS.exec(value);
      lastMpn = status ? status[3] : value;
      firstMpn ||= lastMpn;
      if (status && /^[1Y]$/i.test(status[2])) chosen ||= lastMpn;
    } else if (record === 'CHS') { if (value === '1' && lastMpn) chosen ||= lastMpn; }
    else first[record] ??= value;
  }
  return chosen || firstMpn || first.VPL_MPN || first.CPN || first.IPN || (component.partName && component.partName !== '???' ? component.partName : '');
}

/** Name → value of the first property of each name (a plain object without a prototype chain, so any name is safe as a key). */
function firstProperties(properties: Array<[string, string]>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, value] of properties) if (!Object.hasOwn(result, name)) result[name] = value;
  return result;
}
/** KiCad writes one single-pad placeholder net per unconnected pad ("unconnected-(R1-Pad2)", a second pad of that number gets "_1"); the KiCad reader treats them as no-connects. */
const KICAD_PLACEHOLDER_NET = /^unconnected-\(.+\)(?:_\d+)?$/;

// --- assembly ---

function model(j: Job, step: string, steps: OdbppStepInfo[], data: StepData, candidates: OdbppStepInfo[], unitsOf: (file: string, units?: OdbUnits) => OdbUnits, declared: Record<string, OdbUnits>, fallbacks: ReadonlySet<string>): OdbppModel {
  const base = `steps/${step}/`, notes: string[] = [];
  if (!data.info.components) fail(`step "${step}" has no components (comp_+_top / comp_+_bot are missing or empty).`);
  const edaBytes = j.get(`${base}eda/data`);
  // LYR names → copper position from the matrix rows (top copper is the first copper row): FID records then say which copper a toeprint touches.
  const layerKind = (name: string): LayerKind | undefined => {
    const layer = j.layerByName.get(name);
    if (!layer || !j.copperRows) return undefined;
    if (!COPPER.has(layer.type)) return 'other';
    if (j.copperRows.min === j.copperRows.max) return 'copper';
    return layer.row === j.copperRows.min ? 'top' : layer.row === j.copperRows.max ? 'bottom' : 'inner';
  };
  const eda: EdaData | null = edaBytes ? parseEdaData(text(edaBytes, `${base}eda/data`), `${base}eda/data`, layerKind) : null;
  const edaScale = eda ? MM_PER_UNIT[unitsOf(`${base}eda/data`, eda.units)] : 1;

  // Toeprint nets from SNT TOP records, indexed per side by component and toeprint order.
  const canonical: Record<'top' | 'bottom', ComponentLayer | undefined> = {
    top: data.layers.find(layer => layer.name === 'comp_+_top') ?? data.layers.find(layer => layer.side === 'top'),
    bottom: data.layers.find(layer => layer.name === 'comp_+_bot') ?? data.layers.find(layer => layer.side === 'bottom'),
  };
  const subnetNets = new Map<ComponentLayer, SubnetTable>();
  for (const layer of [canonical.top, canonical.bottom]) {
    if (!layer || subnetNets.has(layer)) continue;
    const offsets = new Int32Array(layer.parsed.components.length + 1);
    layer.parsed.components.forEach((component, index) => { offsets[index + 1] = offsets[index] + component.toeprints.length; });
    const count = offsets[offsets.length - 1];
    subnetNets.set(layer, { offsets, nets: new Int32Array(count).fill(-1), masks: new Int32Array(count) });
  }
  let badSubnets = 0, subnetConflicts = 0;
  if (eda) for (let index = 0; index < eda.toeprintNets.length; index += 5) {
    const net: number = eda.toeprintNets[index], comp: number = eda.toeprintNets[index + 2], toeprint: number = eda.toeprintNets[index + 3];
    const layer: ComponentLayer | undefined = eda.toeprintNets[index + 1] ? canonical.bottom : canonical.top;
    const table: SubnetTable | undefined = layer ? subnetNets.get(layer) : undefined;
    if (!layer || !table || comp >= layer.parsed.components.length || toeprint >= layer.parsed.components[comp].toeprints.length) { badSubnets++; continue; }
    const at = table.offsets[comp] + toeprint;
    if (table.nets[at] !== -1 && table.nets[at] !== net) subnetConflicts++;
    table.nets[at] = net; table.masks[at] |= eda.toeprintNets[index + 4];
  }
  const netName = (index: number): string => {
    const name = eda?.netNames[index];
    return name === undefined || name.toUpperCase() === '$NONE$' ? '' : name;
  };

  const parts: RawPart[] = [], pins: RawPin[] = [], infos: OdbppComponentInfo[] = [];
  let missingPackages = 0, missingPins = 0, alternate = 0, unverified = 0, approximated = 0, netDisagreements = 0, badNetNumbers = 0, outlinePoints = 0, droppedOutlines = 0;
  let noCopper = 0, copperSides = 0;
  // Packages are shared by many components (and pins by many toeprints): their shapes are worked out once.
  const bodies = new Map<EdaPackage, Point[] | null>(), pads = new Map<EdaPin, Pad | null>();
  for (const layer of data.layers) {
    const componentScale = MM_PER_UNIT[declared[layer.file]];
    const table = subnetNets.get(layer);
    layer.parsed.components.forEach((component, index) => {
      const key = `${layer.name}:${index}`;
      const pkg = eda && component.pkgRef >= 0 ? eda.packages[component.pkgRef] : undefined;
      if (eda && eda.packages.length && !pkg) missingPackages++;
      const fit = fitPlacement(component, pkg, { component: componentScale, eda: edaScale });
      if (fit.verdict === 'alternate') alternate++; else if (fit.verdict === 'unverified') unverified++;
      let outline: Point[] | undefined;
      const body = pkg && memo(bodies, pkg, () => bodyOf(pkg));
      if (body) {
        const ring = body.length > MAX_BODY_POINTS ? (() => { const b = boundsOf(body); return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]; })() : body;
        if (outlinePoints + ring.length <= MAX_PLACED_OUTLINE_POINTS) { outline = ring.map(p => fit.placement.apply({ x: p.x * edaScale, y: p.y * edaScale })); outlinePoints += ring.length; }
        else droppedOutlines++;
      }
      const value = componentValue(component.properties);
      const packageName = pkg?.name ?? component.partName;
      // The file's rotation (clockwise) as TRACE's counter-clockwise angle on both sides; the mirror flag says the part is seen from below.
      parts.push({ key, ...(component.name ? { ref: component.name } : { refGenerated: true }), value, package: packageName, side: layer.side, position: { x: component.x * componentScale, y: component.y * componentScale }, rotation: normalizeAngle(-component.rot), ...(outline ? { outline } : {}) });
      const attrs = attributes(component.attributes, layer.parsed);
      infos.push({
        ref: component.name || key, side: layer.side, layer: layer.name, partName: component.partName, partNumber: partNumber(component), value, packageName,
        ...(attrs['.comp_mount_type'] ? { mountType: attrs['.comp_mount_type'] } : {}),
        properties: firstProperties(component.properties), attributes: attrs, bom: component.bom,
      });
      component.toeprints.forEach((toeprint, ordinal) => {
        const pin = pkg?.pins[toeprint.pin];
        if (pkg && !pin) missingPins++;
        let net = '';
        if (eda) {
          const fromSubnet = table ? table.nets[table.offsets[index] + ordinal] : -1;
          if (fromSubnet >= 0) {
            if (toeprint.net >= 0 && toeprint.net !== fromSubnet) netDisagreements++;
            net = netName(fromSubnet);
          } else if (toeprint.net >= 0) {
            if (toeprint.net >= eda.netNames.length) badNetNumbers++; else net = netName(toeprint.net);
          }
        }
        // Side: the copper layers the toeprint's features lie on (eda/data FID records), else through-hole pins both sides, others the part's side.
        const mask = table ? table.masks[table.offsets[index] + ordinal] : 0;
        const fallback: BoardSide = pin?.type === 'T' ? 'both' : layer.side;
        let side: BoardSide = fallback;
        if (mask && !(mask & FID.UNKNOWN) && !(mask & FID.COPPER)) {
          const copper = mask & (FID.TOP | FID.BOTTOM | FID.INNER);
          // Features on mask or paste layers only, no net and not a hole (PIN mount type H): a paste or mask aperture, not a pin.
          if (!copper) { if (!net && pin?.mtype !== 'H') { noCopper++; return; } }
          else side = copper === FID.TOP ? 'top' : copper === FID.BOTTOM ? 'bottom' : 'both';
          if (copper && side !== fallback) copperSides++;
        }
        const number = toeprint.name || pin?.name || '';
        const pad = pin ? memo(pads, pin, () => padOf(pin, edaScale)) : null;
        if (pad?.approximated) approximated++;
        pins.push({
          part: key, number, ...(number ? {} : { numberGenerated: true }), name: number, net, side,
          x: toeprint.x * componentScale, y: toeprint.y * componentScale,
          ...(pad ? { shape: pad.shape, radius: pad.radius, ...(pad.width === undefined ? {} : { width: pad.width, height: pad.height }), ...(pad.shape === 'round' ? {} : { rotation: fit.placement.orient(pad.angle ?? 0) }) } : {}),
        });
      });
    });
  }

  // cadnet fallback: eda/data without nets (or absent) → net points matched to pins by position and side.
  let netSource = eda && eda.netNames.some(name => name && name.toUpperCase() !== '$NONE$') ? 'eda/data' : 'none';
  const netlistBytes = j.get(`${base}netlists/cadnet/netlist`);
  if (netSource === 'none' && netlistBytes) {
    const netlist = parseCadNetlist(text(netlistBytes, `${base}netlists/cadnet/netlist`), `${base}netlists/cadnet/netlist`);
    const scale = MM_PER_UNIT[unitsOf(`${base}netlists/cadnet/netlist`, netlist.units)];
    const matched = matchNetlist(pins, netlist.points, netlist.nets, netlist.names, scale);
    if (matched.assigned) {
      netSource = 'netlists/cadnet/netlist';
      notes.push(`Nets come from netlists/cadnet/netlist, matched to ${matched.assigned} pins by position${matched.mirroredY ? ' with the Y axis negated (the netlist and the component layers disagree on the Y sign)' : ''}; ${matched.unmatched} net points matched no pin${matched.crowded ? `; ${matched.crowded} pins stacked more than 64 to a 0.05 mm cell were not matched` : ''}.`);
    }
  }

  // KiCad-written models: the same placeholder rule as the KiCad reader, so both readings of one design agree.
  let placeholders = 0;
  if (/\bkicad\b/i.test(`${j.source ?? ''} ${eda?.source ?? ''}`)) {
    const members = new Map<string, number>();
    for (const pin of pins) if (pin.net) members.set(pin.net, (members.get(pin.net) ?? 0) + 1);
    for (const pin of pins) if (pin.net && members.get(pin.net) === 1 && KICAD_PLACEHOLDER_NET.test(pin.net)) { pin.net = ''; placeholders++; }
  }

  // Profile.
  const profileBytes = j.get(`${base}profile`);
  let outlines: Point[][] = [];
  if (profileBytes) {
    const profile = parseSurfaces(text(profileBytes, `${base}profile`), `${base}profile`);
    const scale = MM_PER_UNIT[unitsOf(`${base}profile`, profile.units)];
    const polygons: Polygon[] = profile.polygons.filter(polygon => polygon.points.length >= 3);
    polygons.sort((a, b) => Number(a.hole) - Number(b.hole) || area(b.points) - area(a.points));
    outlines = polygons.map(polygon => polygon.points.map(p => ({ x: p.x * scale, y: p.y * scale })));
    if (!polygons.length) notes.push('The step profile holds no closed surface; the outline is estimated from the components.');
  } else notes.push('The step has no profile file; the outline is estimated from the components.');

  // English diagnostics, shown through the formatNote catalog entry (parse.warning.formatNote = "{message}") like the other adapters.
  notes.unshift(`ODB++ step "${step}"${j.version ? `, ODB++ ${j.version}` : ''}${j.source ? `, written by ${j.source}` : ''}: components, pins, packages, nets and the profile are read; copper features, drills and other layers are not drawn.`);
  if (candidates.length > 1) notes.push(`The product model has ${candidates.length} steps with components (${list(candidates.map(candidate => candidate.name))}); "${step}" (the most components) was read. Another step can be chosen.`);
  if (data.info.childSteps.length) notes.push(`Step "${step}" nests other steps (${list(data.info.childSteps)}); only its own components are shown, the nested instances are not expanded.`);
  if (j.rootCount > 1) notes.push(`The archive holds ${j.rootCount} product models; "${j.root.replace(/\/$/, '') || '(archive root)'}" was read.`);
  if (j.tree.nested) notes.push(`The product model was read from ${j.tree.nested.split('/').pop()?.slice(0, 80)} inside the archive.`);
  notes.push(...j.notes);
  if (!j.matrix) notes.push(`matrix/matrix is ${j.get('matrix/matrix') ? 'unreadable' : 'missing'}; steps and component layers were taken from directory names.`);
  const brokenSteps = steps.filter(other => other.error && other.name !== step);
  if (brokenSteps.length) notes.push(`${brokenSteps.length} other step(s) could not be read: ${list(brokenSteps.map(other => `${other.name} (${other.error})`), 3)}.`);
  if (j.tree.endMissing) notes.push('The tar archive ends without its end-of-archive block; it may be truncated (every entry it holds is complete).');
  if (data.skippedLayers.length) notes.push(`Component layers that are not on an outer side were skipped (embedded or unknown): ${list(data.skippedLayers)}.`);
  const stepFallbacks = [...fallbacks].filter(file => file.startsWith(base));
  if (stepFallbacks.length) notes.push(`${stepFallbacks.length} file(s) have no UNITS directive and were read in ${j.infoUnits ? `${j.infoUnits} (misc/info)` : 'INCH (the specification default)'}: ${list(stepFallbacks)}.`);
  if (!eda) notes.push('eda/data is missing: package names come from the CMP part names and pads have no size.');
  else if (netSource === 'none') notes.push('eda/data has no nets and no usable cadnet netlist was found; pins have no nets.');
  if (noCopper) notes.push(`${noCopper} toeprint(s) without a net whose features lie only on mask or paste layers (paste or mask apertures that are not holes) are not pins and were left out.`);
  if (copperSides) notes.push(`${copperSides} pin(s) were placed on the side of the copper they touch (eda/data feature records), not on their part's side.`);
  if (placeholders) notes.push(`${placeholders} KiCad "unconnected-(…)" single-pad placeholder nets were treated as no-connects.`);
  if (badSubnets) notes.push(`${badSubnets} SNT TOP record(s) point to a component or toeprint that does not exist and were ignored.`);
  if (subnetConflicts) notes.push(`${subnetConflicts} toeprint(s) are claimed by two nets in eda/data; the later net record was used.`);
  if (netDisagreements) notes.push(`${netDisagreements} TOP record net number(s) disagree with the eda/data subnet records; the subnet records were used.`);
  if (badNetNumbers) notes.push(`${badNetNumbers} TOP record(s) name a net number that eda/data does not have; those pins have no net.`);
  if (missingPackages) notes.push(`${missingPackages} component(s) reference a package that eda/data does not define; they have no package geometry.`);
  if (missingPins) notes.push(`${missingPins} toeprint(s) reference a package pin that does not exist; those pads have no size.`);
  if (alternate) notes.push(`${alternate} component(s): the file's rotation and mirror flag did not reproduce the pin positions with the specification's placement (rotate clockwise, then mirror X); the package geometry was placed with the rotation/mirror combination that does (pin positions themselves come from the TOP records).`);
  if (unverified) notes.push(`${unverified} component(s): no rotation/mirror combination reproduces the pin positions from the package; bodies and pad orientations of these parts may be off.`);
  if (approximated) notes.push(`${approximated} pad(s) whose contour is neither a circle nor a rectangle (rounded, oval, chamfered or custom shapes) are drawn as their smallest enclosing rectangle.`);
  if (droppedOutlines) notes.push(`${droppedOutlines} component bodies were not drawn: the placed outline point budget (${MAX_PLACED_OUTLINE_POINTS}) was reached.`);
  if (j.tree.unsafePaths) notes.push(`${j.tree.unsafePaths} archive entries with absolute, drive-letter or parent-directory (..) paths were ignored.`);
  if (j.tree.links) notes.push(`${j.tree.links} link entries in the archive were skipped (links are never followed).`);
  if (j.tree.duplicates) notes.push(`${j.tree.duplicates} duplicate archive entries were found; the last copy of each was used.`);
  const ignoredRecords = data.layers.reduce((sum, layer) => sum + layer.parsed.ignored, 0) + (eda?.ignored ?? 0);
  if (ignoredRecords) notes.push(`${ignoredRecords} unrecognized records in the component layers and eda/data were ignored.`);

  const board = buildBoard({ name: j.name, data: new Uint8Array(0) }, { format: ODBPP_FORMAT, unitsToMm: 1, parts, pins, outlines, warnings: notes.map(note) });
  board.name = j.name;
  const units: Record<string, OdbUnits> = {};
  for (const [file, value] of Object.entries(declared)) if (file.startsWith(base)) units[file] = value;
  return { board, step, steps, container: j.container, root: j.root.replace(/\/$/, ''), layers: j.matrix?.layers ?? [], units, ...(j.source ? { source: j.source } : {}), ...(j.version ? { version: j.version } : {}), components: infos };
}

/** Assigns cadnet net names to pins at the same position (within 0.02 mm) and a compatible side; tries the Y sign that matches more points. */
function matchNetlist(pins: RawPin[], points: Float64Array, nets: Int32Array, names: Map<number, string>, scale: number): { assigned: number; unmatched: number; mirroredY: boolean; crowded: number } {
  // A cell keeps at most CROWD pins, so hostile input that stacks every pin on one spot costs at most 9 × CROWD distance checks per point.
  const TOLERANCE = 0.02, CELL = 0.05, CROWD = 64;
  const grid = new Map<string, number[]>();
  let crowded = 0;
  pins.forEach((pin, index) => {
    const key = `${Math.floor(pin.x / CELL)},${Math.floor(pin.y / CELL)}`;
    const bucket = grid.get(key);
    if (!bucket) grid.set(key, [index]); else if (bucket.length < CROWD) bucket.push(index); else crowded++;
  });
  const find = (x: number, y: number, side: number): number => {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    let best = -1, bestDistance = TOLERANCE;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const index of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
      const pin = pins[index], pinSide = pin.side ?? 'both';
      if (side === 0 && pinSide === 'bottom' || side === 1 && pinSide === 'top') continue;
      const distance = Math.hypot(pin.x - x, pin.y - y);
      if (distance <= bestDistance) { best = index; bestDistance = distance; }
    }
    return best;
  };
  const usable = (index: number) => { const name = names.get(nets[index]); return nets[index] >= 0 && !!name && name.toUpperCase() !== '$NONE$'; };
  const count = (sign: number) => { let hits = 0; for (let index = 0; index < nets.length; index++) if (usable(index) && find(points[3 * index] * scale, sign * points[3 * index + 1] * scale, points[3 * index + 2]) >= 0) hits++; return hits; };
  const direct = count(1), negated = direct === nets.length ? 0 : count(-1);
  const sign = negated > direct ? -1 : 1;
  let assigned = 0, unmatched = 0;
  for (let index = 0; index < nets.length; index++) {
    if (!usable(index)) continue;
    const hit = find(points[3 * index] * scale, sign * points[3 * index + 1] * scale, points[3 * index + 2]);
    if (hit < 0) { unmatched++; continue; }
    if (!pins[hit].net) { pins[hit].net = names.get(nets[index])!; assigned++; }
  }
  return { assigned, unmatched, mirroredY: sign < 0, crowded };
}
