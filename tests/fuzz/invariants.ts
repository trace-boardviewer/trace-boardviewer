/**
 * What every successful parse must satisfy, whatever the input: the model contract of src/lib/types.ts and src/lib/schematic/model.ts
 * restated as checks. A check returns the first violation as a short sentence, or null.
 */
import { MAX_MESSAGE_CHARS } from '../../src/lib/bounded-text';
import { SCHEMATIC_LIMITS } from '../../src/lib/schematic/model';
import type { SchConnectivity, Schematic } from '../../src/lib/schematic/model';
import type { Board } from '../../src/lib/types';

/** The importer limits of src/lib/formats/common.ts (`buildBoard`) and the GenCAD expansion budget. */
export const BOARD_LIMITS = Object.freeze({ components: 250_000, pins: 1_000_000, coordinateMm: 1e10, warnings: 10_000, warningText: MAX_MESSAGE_CHARS });

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPoint = (value: unknown): boolean => typeof value === 'object' && value !== null && finite((value as { x: unknown }).x) && finite((value as { y: unknown }).y);
const SIDES = new Set(['top', 'bottom', 'both']);
const SHAPES = new Set(['round', 'rect', 'square']);

function unique(ids: Iterable<string>, label: string): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') return `${label}: empty or non-text id`;
    if (seen.has(id)) return `${label}: duplicate id ${id.slice(0, 40)}`;
    seen.add(id);
  }
  return null;
}

/** Units of output a board holds: the figure the bounded-output check works on. */
export const boardUnits = (board: Board): number => board.components.length + board.pins.length + board.nets.length + board.outline.length + board.warnings.length;

export function checkBoard(board: Board): string | null {
  if (typeof board !== 'object' || board === null) return 'the result is not an object';
  if (typeof board.name !== 'string' || typeof board.format !== 'string' || board.format === '') return 'name or format is not text';
  if (board.units !== 'mm') return `units is ${String(board.units)}`;
  if (!Array.isArray(board.components) || !Array.isArray(board.pins) || !Array.isArray(board.nets) || !Array.isArray(board.outline) || !Array.isArray(board.warnings)) return 'a list of the board is missing';
  if (board.components.length > BOARD_LIMITS.components) return `${board.components.length} components exceed the importer limit`;
  if (board.pins.length > BOARD_LIMITS.pins) return `${board.pins.length} pins exceed the importer limit`;
  if (board.warnings.length > BOARD_LIMITS.warnings) return `${board.warnings.length} warnings`;
  let problem = unique(board.components.map(c => c.id), 'components') ?? unique(board.pins.map(p => p.id), 'pins') ?? unique(board.nets.map(n => n.id), 'nets');
  if (problem) return problem;
  const components = new Map(board.components.map(component => [component.id, component]));
  const pins = new Map(board.pins.map(pin => [pin.id, pin]));
  const inBounds = (b: { minX: number; minY: number; maxX: number; maxY: number }) => finite(b.minX) && finite(b.minY) && finite(b.maxX) && finite(b.maxY) && b.minX <= b.maxX && b.minY <= b.maxY && Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)) <= BOARD_LIMITS.coordinateMm;
  if (!inBounds(board.bounds)) return 'board bounds are not finite, ordered and within range';
  for (const point of board.outline) if (!isPoint(point)) return 'an outline point is not finite';
  const owned = new Set<string>();
  for (const component of board.components) {
    if (typeof component.ref !== 'string' || typeof component.value !== 'string' || typeof component.package !== 'string') return `component ${component.id}: ref, value or package is not text`;
    if (!SIDES.has(component.side)) return `component ${component.id}: side ${String(component.side)}`;
    if (!isPoint(component.position) || !finite(component.rotation)) return `component ${component.id}: position or rotation is not finite`;
    if (!inBounds(component.bounds)) return `component ${component.id}: bounds are not finite and ordered`;
    if (!Array.isArray(component.outline) || component.outline.some(point => !isPoint(point))) return `component ${component.id}: outline is not a list of finite points`;
    for (const id of component.pinIds) {
      const pin = pins.get(id);
      if (!pin) return `component ${component.id}: pin ${id} does not exist`;
      if (pin.componentId !== component.id) return `component ${component.id}: pin ${id} belongs to ${pin.componentId}`;
      if (owned.has(id)) return `pin ${id} is listed by two components`;
      owned.add(id);
    }
  }
  for (const pin of board.pins) {
    if (!components.has(pin.componentId)) return `pin ${pin.id}: component ${pin.componentId} does not exist`;
    if (!owned.has(pin.id)) return `pin ${pin.id}: not listed by its component`;
    if (typeof pin.number !== 'string' || pin.number === '' || typeof pin.name !== 'string' || typeof pin.net !== 'string') return `pin ${pin.id}: number, name or net is not text (or the number is empty)`;
    if (!SIDES.has(pin.side) || !SHAPES.has(pin.shape)) return `pin ${pin.id}: side or shape is invalid`;
    if (!isPoint(pin) || Math.abs(pin.x) > BOARD_LIMITS.coordinateMm || Math.abs(pin.y) > BOARD_LIMITS.coordinateMm) return `pin ${pin.id}: position is not finite or out of range`;
    if (!finite(pin.radius) || pin.radius < 0) return `pin ${pin.id}: radius ${String(pin.radius)}`;
    for (const key of ['width', 'height'] as const) if (pin[key] !== undefined && (!finite(pin[key]) || (pin[key] as number) < 0)) return `pin ${pin.id}: ${key} ${String(pin[key])}`;
    if (pin.rotation !== undefined && !finite(pin.rotation)) return `pin ${pin.id}: rotation is not finite`;
  }
  const names = new Set<string>(), netOf = new Map<string, string>();
  for (const net of board.nets) {
    if (typeof net.name !== 'string' || net.name === '') return `net ${net.id}: empty name`;
    if (names.has(net.name)) return `net name ${net.name.slice(0, 40)} appears twice`;
    names.add(net.name);
    // A net may have no pin: GenCAD keeps a declared signal that no node reaches, and every consumer copes with it.
    for (const id of net.pinIds) {
      const pin = pins.get(id);
      if (!pin) return `net ${net.name.slice(0, 40)}: pin ${id} does not exist`;
      if (pin.net !== net.name) return `net ${net.name.slice(0, 40)}: pin ${id} says net ${pin.net.slice(0, 40)}`;
      if (netOf.has(id)) return `pin ${id} is in two nets`;
      netOf.set(id, net.name);
    }
  }
  for (const pin of board.pins) if (pin.net !== '' && !netOf.has(pin.id)) return `pin ${pin.id} names net ${pin.net.slice(0, 40)} but is in no net`;
  for (const warning of board.warnings) {
    if (typeof warning !== 'object' || warning === null || typeof warning.key !== 'string' || !warning.key.startsWith('parse.')) return `a warning has no parse.* key`;
    if (warning.params !== undefined) {
      if (typeof warning.params !== 'object' || warning.params === null) return `warning ${warning.key}: params is not an object`;
      for (const value of Object.values(warning.params)) {
        if (typeof value === 'string' ? value.length > BOARD_LIMITS.warningText : typeof value === 'number' ? !finite(value) : typeof value !== 'boolean') return `warning ${warning.key}: a parameter is not a short text, a finite number or a boolean`;
      }
    }
  }
  return null;
}

export const schematicUnits = (schematic: Schematic): number => schematic.defs.reduce((sum, def) => sum + def.symbols.length + def.wires.length + def.labels.length + def.junctions.length + def.buses.length + def.sheetRefs.length, 0) + schematic.instances.length + schematic.diagnostics.length;

export function checkSchematic(schematic: Schematic): string | null {
  if (typeof schematic !== 'object' || schematic === null) return 'the result is not an object';
  if (!['kicad-sch', 'kicad-legacy-sch', 'eagle-sch', 'altium-sch'].includes(schematic.format)) return `format ${String(schematic.format)}`;
  if (!Array.isArray(schematic.defs) || !Array.isArray(schematic.instances) || !Array.isArray(schematic.diagnostics)) return 'a list of the schematic is missing';
  if (schematic.defs.length === 0 || schematic.defs.length > SCHEMATIC_LIMITS.maxSheetDefs) return `${schematic.defs.length} sheet definitions`;
  if (schematic.instances.length === 0 || schematic.instances.length > SCHEMATIC_LIMITS.maxInstances) return `${schematic.instances.length} sheet instances`;
  let pinTotal = 0;
  let problem = unique(schematic.defs.map(def => def.id), 'defs');
  if (problem) return problem;
  const defs = new Map(schematic.defs.map(def => [def.id, def]));
  if (!defs.has(schematic.rootDefId)) return 'the root definition does not exist';
  const coordinate = (value: unknown) => finite(value) && Math.abs(value) <= SCHEMATIC_LIMITS.maxCoordinateMm * 10;
  const point = (value: { x: number; y: number } | undefined) => value !== undefined && coordinate(value.x) && coordinate(value.y);
  for (const def of schematic.defs) {
    if (def.symbols.length > SCHEMATIC_LIMITS.maxSymbolsPerDef || def.wires.length > SCHEMATIC_LIMITS.maxWiresPerDef) return `sheet ${def.id.slice(0, 40)}: too many symbols or wires`;
    problem = unique(def.symbols.map(s => s.id), `sheet ${def.id.slice(0, 40)} symbols`) ?? unique(def.wires.map(w => w.id), 'wires') ?? unique(def.labels.map(l => l.id), 'labels') ?? unique(def.junctions.map(j => j.id), 'junctions')
      ?? unique(def.buses.map(b => b.id), 'buses') ?? unique(def.busEntries.map(b => b.id), 'bus entries') ?? unique(def.noConnects.map(n => n.id), 'no-connects') ?? unique(def.sheetRefs.map(r => r.id), 'sheet references')
      ?? unique(def.symbols.flatMap(symbol => symbol.pins.map(pin => pin.id)), 'pins');
    if (problem) return problem;
    for (const symbol of def.symbols) {
      pinTotal += symbol.pins.length;
      if (!point(symbol.at) || !finite(symbol.rotation)) return `symbol ${symbol.id.slice(0, 40)}: position or rotation is not finite`;
      for (const pin of symbol.pins) {
        if (typeof pin.number !== 'string' || pin.number === '') return `symbol ${symbol.id.slice(0, 40)}: a pin has no number`;
        if (!point(pin.at) || !point(pin.body)) return `symbol ${symbol.id.slice(0, 40)}: pin ${pin.number.slice(0, 20)} has a position that is not finite`;
      }
    }
    for (const wire of def.wires) if (!point(wire.a) || !point(wire.b)) return `wire ${wire.id.slice(0, 40)}: end points are not finite`;
    for (const label of def.labels) if (!point(label.at) || typeof label.text !== 'string') return `label ${label.id.slice(0, 40)}: position or text is invalid`;
    for (const reference of def.sheetRefs) if (reference.defId !== null && !defs.has(reference.defId)) return `sheet reference ${reference.id.slice(0, 40)} points at a missing definition`;
    const b = def.bounds;
    if (!finite(b.minX) || !finite(b.minY) || !finite(b.maxX) || !finite(b.maxY)) return `sheet ${def.id.slice(0, 40)}: bounds are not finite`;
  }
  if (pinTotal > SCHEMATIC_LIMITS.maxPinsTotal) return `${pinTotal} pins exceed the importer limit`;
  const paths = new Set<string>();
  for (const instance of schematic.instances) {
    if (paths.has(instance.path)) return `instance path ${instance.path.slice(0, 40)} appears twice`;
    paths.add(instance.path);
    if (!defs.has(instance.defId)) return `instance ${instance.path.slice(0, 40)} points at a missing definition`;
  }
  for (const instance of schematic.instances) {
    for (const child of instance.childPaths) if (!paths.has(child)) return `instance ${instance.path.slice(0, 40)} lists a missing child`;
    if (instance.parentPath !== null && !paths.has(instance.parentPath)) return `instance ${instance.path.slice(0, 40)} has a missing parent`;
  }
  for (const diagnostic of schematic.diagnostics) {
    if (!['info', 'warning', 'error'].includes(diagnostic.severity) || typeof diagnostic.code !== 'string' || diagnostic.code === '' || typeof diagnostic.message !== 'string') return 'a diagnostic is malformed';
    if (diagnostic.message.length > BOARD_LIMITS.warningText) return `a diagnostic message has ${diagnostic.message.length} characters`;
  }
  return null;
}

export function checkConnectivity(connectivity: SchConnectivity, schematic: Schematic): string | null {
  if (!Array.isArray(connectivity.nets)) return 'the net list is missing';
  const problem = unique(connectivity.nets.map(net => net.id), 'nets');
  if (problem) return problem;
  const ids = new Set(connectivity.nets.map(net => net.id));
  const defs = new Set(schematic.defs.map(def => def.id));
  for (const net of connectivity.nets) {
    if (typeof net.name !== 'string' || !Array.isArray(net.aliases) || !Array.isArray(net.members)) return `net ${net.id.slice(0, 40)} is malformed`;
    for (const member of net.members) if (!defs.has(member.defId)) return `net ${net.id.slice(0, 40)} has a member on a missing sheet`;
  }
  for (const [key, id] of Object.entries(connectivity.pinNet)) if (!ids.has(id)) return `pin ${key.slice(0, 40)} is in a net that does not exist`;
  for (const [key, id] of Object.entries(connectivity.wireNet)) if (!ids.has(id)) return `wire ${key.slice(0, 40)} is in a net that does not exist`;
  return null;
}
