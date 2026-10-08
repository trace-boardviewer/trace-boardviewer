/**
 * The ONE index of a board. Built once per board object (`boardIndexOf`) and shared by everything that looks a part, pad or net up:
 * the controller (selection, cross-probe, search fallback), the canvas (per-side buckets, part kinds), the inspector, the component
 * list, the note dialog, the note keys and the breadcrumb. Before it, the same board was indexed three to five times on the UI thread.
 *
 * Two layers, both immutable to callers:
 *  - Core, built eagerly in O(n) without any collation: id maps, part kinds, per-side buckets (components, pads, pads by net name).
 *    Pads per part and pads per net name over both sides are filled on first use.
 *  - Cross-probe layer (exact reference / net-name maps, natural-order lists, pin groups, search records), built on first use and
 *    from the same id maps. A board that is only viewed never pays for it on the UI thread: search runs in the model worker
 *    (model-host.ts), and the layer is built there; on the UI thread it is built when a schematic or a PDF needs it.
 *
 * Identity rules are the cross-probe's (crossprobe.ts header): keys are NFKC + trim, case-sensitive; duplicates stay distinct and are
 * reported, never merged. Ids: the first component (or pad) with an id is the one the id maps return.
 * Pure TypeScript (no DOM): runs in the UI thread, in a worker and in node.
 */
import { classifyComponent } from './part-kind';
import type { PartKind } from './part-kind';
import { fold, naturalCollator, naturalCompare, normalizeKey, normalizeQuery } from './text-keys';
import type { Board, BoardComponent, BoardPin, ViewSide } from './types';

/** All pads of one component that share a pin number (thermal / split pads). */
export interface BoardPinGroup {
  number: string;
  pins: readonly BoardPin[];
  /** Distinct non-empty net names of the pads, natural order. More than one is a board inconsistency (reported as ambiguous). */
  nets: readonly string[];
}
export interface BoardNetEntry {
  /** Name exactly as the board writes it (what the UI selects by). */
  name: string;
  key: string;
  /** @internal lowercase NFKC search form of the name */
  folded: string;
  /** BoardNet.id; null for a net that only exists as `BoardPin.net` text. */
  id: string | null;
  /** Natural order: component, then pin number. */
  pins: readonly BoardPin[];
}
/** @internal search form of one component, aligned with `BoardIndex.components`. */
export interface BoardSearchRecord { key: string; folded: string; value: string; pkg: string; hay: string; nets: readonly string[] }
export interface BoardIndexStats { components: number; pins: number; nets: number; duplicateRefKeys: number; caseDistinctRefGroups: number; componentsWithoutRef: number; pinsWithoutNumber: number; duplicateComponentIds: number }

/** Pads that carry one net name on one side, and the parts they belong to (what the canvas highlights). */
export interface SideNetGroup { readonly pins: readonly BoardPin[]; readonly components: ReadonlySet<string> }
/** Everything of one physical side; parts and pads on 'both' sides are in both buckets. Board order. */
export interface SideBucket {
  readonly components: readonly BoardComponent[];
  readonly pins: readonly BoardPin[];
  /** Raw `BoardPin.net` text → pads on this side ('' groups the unconnected pads). */
  readonly netPins: ReadonlyMap<string, SideNetGroup>;
}

export interface BoardIndex {
  readonly kind: 'board';
  /** The board this index describes (identity: one index per board object). */
  readonly board: Board;

  // --- core (eager) ---
  readonly componentById: ReadonlyMap<string, BoardComponent>;
  readonly pinById: ReadonlyMap<string, BoardPin>;
  /** Part kind of every component id from the shared classifier (part-kind.ts), without schematic information. */
  readonly kinds: ReadonlyMap<string, PartKind>;
  readonly sides: Readonly<Record<ViewSide, SideBucket>>;
  /** Pads of a component in its `pinIds` order (ids without a pad are skipped); empty for an unknown id. */
  pinsOf(componentId: string): readonly BoardPin[];
  /** Every pad whose `net` text is exactly `name`, both sides, board order (the canvas and the inspector agree on it). */
  pinsOfNet(name: string): readonly BoardPin[];
  /** True when the board has a net of this name (after NFKC/trim; the same answer as `netByName`, without building it in the common case). */
  hasNet(name: string): boolean;
  /** Components of one side ('both' included), or of every side, in natural reference order (the component list). Memoized. */
  componentsInOrder(side?: ViewSide): readonly BoardComponent[];

  // --- cross-probe layer (built on first access) ---
  /** Natural order (ref, then id). Includes components with an empty reference. */
  readonly components: readonly BoardComponent[];
  /** normalized ref → components carrying exactly that ref (several = duplicate refs). R1 and r1 are different keys. */
  readonly byRef: ReadonlyMap<string, readonly BoardComponent[]>;
  /** lowercase form → distinct exact ref keys sharing it (more than one = case-distinct refs such as R1/r1). */
  readonly refsByFold: ReadonlyMap<string, readonly string[]>;
  /** componentId → (normalized pin number → pads), insertion order = natural pin order. Each part's groups are built on first lookup. */
  readonly pinGroups: ReadonlyMap<string, ReadonlyMap<string, BoardPinGroup>>;
  /** Natural order by name. */
  readonly nets: readonly BoardNetEntry[];
  readonly netByName: ReadonlyMap<string, readonly BoardNetEntry[]>;
  readonly netsByFold: ReadonlyMap<string, readonly string[]>;
  readonly stats: BoardIndexStats;
  /** @internal aligned with `components` */
  readonly search: readonly BoardSearchRecord[];
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
const onSide = (item: { side: string }, side: ViewSide) => item.side === side || item.side === 'both';
const EMPTY_PINS: readonly BoardPin[] = Object.freeze([]);

const distinctNets = (pins: readonly BoardPin[]): string[] => {
  if (pins.length === 1) { const net = normalizeKey(pins[0].net); return net ? [net] : []; }
  const nets = new Set<string>();
  for (const pin of pins) { const net = normalizeKey(pin.net); if (net) nets.add(net); }
  return [...nets].sort(naturalCompare);
};

/**
 * The pin groups of every component, each built on its first lookup (a viewer that never cross-probes builds none). Iterating
 * builds them all, in board order (the first component of an id wins, as in the id map).
 */
class LazyPinGroups implements ReadonlyMap<string, ReadonlyMap<string, BoardPinGroup>> {
  private readonly built = new Map<string, ReadonlyMap<string, BoardPinGroup>>();
  private withoutNumber = 0;
  private complete = false;
  constructor(private readonly components: ReadonlyMap<string, BoardComponent>, private readonly pins: ReadonlyMap<string, BoardPin>) {}
  get size(): number { return this.components.size; }
  has(id: string): boolean { return this.components.has(id); }
  get(id: string): ReadonlyMap<string, BoardPinGroup> | undefined {
    const found = this.built.get(id);
    if (found) return found;
    const component = this.components.get(id);
    if (!component) return undefined;
    const byNumber = new Map<string, BoardPin[]>();
    for (const pinId of component.pinIds) {
      const pin = this.pins.get(pinId);
      if (!pin) continue;
      const number = normalizeKey(pin.number);
      if (!number) { this.withoutNumber++; continue; }
      push(byNumber, number, pin);
    }
    const groups = new Map<string, BoardPinGroup>();
    const numbers = [...byNumber.keys()];
    if (numbers.length > 1) numbers.sort(naturalCompare);
    for (const number of numbers) { const pins = byNumber.get(number)!; groups.set(number, { number, pins, nets: distinctNets(pins) }); }
    this.built.set(id, groups);
    return groups;
  }
  /** Pads without a usable number over the whole board (builds every group once). */
  pinsWithoutNumber(): number { this.all(); return this.withoutNumber; }
  private all(): Map<string, ReadonlyMap<string, BoardPinGroup>> {
    if (!this.complete) {
      const ordered = new Map<string, ReadonlyMap<string, BoardPinGroup>>();
      for (const id of this.components.keys()) ordered.set(id, this.get(id)!);
      this.built.clear();
      for (const [id, groups] of ordered) this.built.set(id, groups);
      this.complete = true;
    }
    return this.built;
  }
  forEach(callback: (value: ReadonlyMap<string, BoardPinGroup>, key: string, map: ReadonlyMap<string, ReadonlyMap<string, BoardPinGroup>>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.all()) callback.call(thisArg, value, key, this);
  }
  entries() { return this.all().entries(); }
  keys() { return this.all().keys(); }
  values() { return this.all().values(); }
  [Symbol.iterator]() { return this.all()[Symbol.iterator](); }
}

/**
 * Builds a fresh index (tests, the model worker). The application shares one per board through `boardIndexOf`.
 * Cost on the calling thread: the core only; the cross-probe layer is built when one of its fields is first read.
 */
export function buildBoardIndex(board: Board): BoardIndex {
  // --- core ---
  const componentById = new Map<string, BoardComponent>();
  let duplicateComponentIds = 0;
  for (const component of board.components) { if (componentById.has(component.id)) duplicateComponentIds++; else componentById.set(component.id, component); }
  const pinById = new Map<string, BoardPin>();
  for (const pin of board.pins) if (!pinById.has(pin.id)) pinById.set(pin.id, pin);
  const kinds = new Map<string, PartKind>();
  for (const component of componentById.values()) kinds.set(component.id, classifyComponent(component).kind);

  const bucket = () => ({ components: [] as BoardComponent[], pins: [] as BoardPin[], netPins: new Map<string, { pins: BoardPin[]; components: Set<string> }>() });
  const top = bucket(), bottom = bucket();
  for (const component of board.components) {
    if (onSide(component, 'top')) top.components.push(component);
    if (onSide(component, 'bottom')) bottom.components.push(component);
  }
  const place = (side: ReturnType<typeof bucket>, pin: BoardPin) => {
    side.pins.push(pin);
    let group = side.netPins.get(pin.net);
    if (!group) { group = { pins: [], components: new Set() }; side.netPins.set(pin.net, group); }
    group.pins.push(pin); group.components.add(pin.componentId);
  };
  for (const pin of board.pins) {
    if (onSide(pin, 'top')) place(top, pin);
    if (onSide(pin, 'bottom')) place(bottom, pin);
  }
  const freezeBucket = (side: ReturnType<typeof bucket>): SideBucket => Object.freeze({ components: Object.freeze(side.components), pins: Object.freeze(side.pins), netPins: side.netPins });
  const sides = Object.freeze({ top: freezeBucket(top), bottom: freezeBucket(bottom) });

  // Pads per net name over both sides, built on the first net lookup (selecting a net, the inspector's net section).
  let netPinsAll: Map<string, BoardPin[]> | null = null;
  const netPins = (): Map<string, BoardPin[]> => {
    if (!netPinsAll) { netPinsAll = new Map(); for (const pin of board.pins) push(netPinsAll, pin.net, pin); }
    return netPinsAll;
  };

  const pinsByComponent = new Map<string, readonly BoardPin[]>();
  const pinsOf = (componentId: string): readonly BoardPin[] => {
    let pins = pinsByComponent.get(componentId);
    if (!pins) {
      const component = componentById.get(componentId);
      if (!component) return EMPTY_PINS;
      const list: BoardPin[] = [];
      for (const id of component.pinIds) { const pin = pinById.get(id); if (pin) list.push(pin); }
      pinsByComponent.set(componentId, pins = Object.freeze(list));
    }
    return pins;
  };

  const ordered = new Map<string, readonly BoardComponent[]>();
  const componentsInOrder = (side?: ViewSide): readonly BoardComponent[] => {
    const key = side ?? 'all';
    let list = ordered.get(key);
    if (!list) {
      if (side === undefined) {
        // The component list's order: natural reference order, then id (code units).
        const collator = naturalCollator();
        list = Object.freeze(board.components.slice().sort((a, b) => collator.compare(a.ref, b.ref) || (a.id < b.id ? -1 : 1)));
      } else list = Object.freeze(componentsInOrder().filter(component => onSide(component, side)));
      ordered.set(key, list);
    }
    return list;
  };

  // --- cross-probe layer (lazy) ---
  interface Refs { components: readonly BoardComponent[]; rank: Map<string, number>; byRef: Map<string, BoardComponent[]>; refsByFold: Map<string, string[]>; componentsWithoutRef: number; duplicateRefKeys: number; caseDistinctRefGroups: number }
  let refsPart: Refs | null = null;
  const refs = (): Refs => {
    if (refsPart) return refsPart;
    const components = Object.freeze(board.components.slice().sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.id, b.id)));
    const rank = new Map<string, number>();
    components.forEach((component, i) => { if (!rank.has(component.id)) rank.set(component.id, i); });
    const byRef = new Map<string, BoardComponent[]>(), refsByFold = new Map<string, string[]>();
    let componentsWithoutRef = 0;
    for (const component of components) {
      const key = normalizeKey(component.ref);
      if (!key) { componentsWithoutRef++; continue; }
      const list = byRef.get(key);
      if (list) list.push(component);
      else { byRef.set(key, [component]); push(refsByFold, fold(key), key); }
    }
    let duplicateRefKeys = 0, caseDistinctRefGroups = 0;
    for (const list of byRef.values()) if (list.length > 1) duplicateRefKeys++;
    for (const keys of refsByFold.values()) if (keys.length > 1) caseDistinctRefGroups++;
    return (refsPart = { components, rank, byRef, refsByFold, componentsWithoutRef, duplicateRefKeys, caseDistinctRefGroups });
  };

  interface Nets { nets: readonly BoardNetEntry[]; netByName: Map<string, BoardNetEntry[]>; netsByFold: Map<string, string[]> }
  let netsPart: Nets | null = null;
  const nets = (): Nets => {
    if (netsPart) return netsPart;
    interface Builder { name: string; id: string | null; pins: BoardPin[]; seen: Set<string> }
    const builders: Builder[] = [], builderByKey = new Map<string, Builder[]>();
    const addBuilder = (name: string, id: string | null): Builder => {
      const builder: Builder = { name, id, pins: [], seen: new Set() };
      builders.push(builder); push(builderByKey, normalizeKey(name), builder);
      return builder;
    };
    const attach = (builder: Builder, pin: BoardPin) => { if (!builder.seen.has(pin.id)) { builder.seen.add(pin.id); builder.pins.push(pin); } };
    for (const net of board.nets) {
      if (!normalizeKey(net.name)) continue;
      const builder = addBuilder(net.name, net.id);
      for (const id of net.pinIds) { const pin = pinById.get(id); if (pin) attach(builder, pin); }
    }
    // A pin's own `net` text is authoritative for the pin even when board.nets omits it; with duplicate net names the owner is undecidable.
    for (const pin of pinById.values()) {
      const key = normalizeKey(pin.net);
      if (!key) continue;
      const list = builderByKey.get(key);
      if (!list) attach(addBuilder(pin.net, null), pin);
      else if (list.length === 1) attach(list[0], pin);
    }
    const { rank } = refs();
    const pinOrder = (a: BoardPin, b: BoardPin) => (rank.get(a.componentId) ?? 0) - (rank.get(b.componentId) ?? 0) || naturalCompare(a.number, b.number) || naturalCompare(a.id, b.id);
    const entries: BoardNetEntry[] = builders
      .map(b => ({ name: b.name, key: normalizeKey(b.name), folded: fold(normalizeQuery(b.name)), id: b.id, pins: b.pins.sort(pinOrder) }))
      .sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.id ?? '', b.id ?? ''));
    const netByName = new Map<string, BoardNetEntry[]>(), netsByFold = new Map<string, string[]>();
    for (const net of entries) {
      const list = netByName.get(net.key);
      if (list) list.push(net); else { netByName.set(net.key, [net]); push(netsByFold, fold(net.key), net.key); }
    }
    return (netsPart = { nets: Object.freeze(entries), netByName, netsByFold });
  };

  const pinGroups = new LazyPinGroups(componentById, pinById);

  let searchPart: readonly BoardSearchRecord[] | null = null;
  const search = (): readonly BoardSearchRecord[] => {
    if (searchPart) return searchPart;
    // One folded string per distinct net name: every part that touches a net shares it instead of holding its own copy.
    const foldedNet = new Map<string, string>();
    const folded = (net: string): string => { let value = foldedNet.get(net); if (value === undefined) foldedNet.set(net, value = fold(normalizeQuery(net))); return value; };
    return (searchPart = Object.freeze(refs().components.map(component => {
      const names = new Set<string>();
      for (const id of component.pinIds) { const net = pinById.get(id)?.net; if (net) names.add(folded(net)); }
      const value = fold(normalizeQuery(component.value)), pkg = fold(normalizeQuery(component.package));
      return { key: normalizeKey(component.ref), folded: fold(normalizeQuery(component.ref)), value, pkg, hay: fold(normalizeQuery(`${component.ref} ${component.value} ${component.package}`)), nets: [...names] };
    })));
  };

  let statsPart: BoardIndexStats | null = null;
  const stats = (): BoardIndexStats => {
    if (statsPart) return statsPart;
    const r = refs();
    return (statsPart = Object.freeze({
      components: board.components.length, pins: board.pins.length, nets: nets().nets.length, duplicateRefKeys: r.duplicateRefKeys, caseDistinctRefGroups: r.caseDistinctRefGroups,
      componentsWithoutRef: r.componentsWithoutRef, pinsWithoutNumber: pinGroups.pinsWithoutNumber(), duplicateComponentIds,
    }));
  };

  return Object.freeze({
    kind: 'board' as const, board, componentById, pinById, kinds, sides, pinsOf, componentsInOrder, pinGroups,
    pinsOfNet: (name: string): readonly BoardPin[] => netPins().get(name) ?? EMPTY_PINS,
    hasNet: (name: string): boolean => {
      const key = normalizeKey(name);
      if (!key) return false;
      // A pad (the one its id names) that carries the exact text always makes a net of its key; anything else asks the full map.
      if (netPins().get(name)?.some(pin => pinById.get(pin.id) === pin)) return true;
      return nets().netByName.has(key);
    },
    get components() { return refs().components; },
    get byRef() { return refs().byRef as ReadonlyMap<string, readonly BoardComponent[]>; },
    get refsByFold() { return refs().refsByFold as ReadonlyMap<string, readonly string[]>; },
    get nets() { return nets().nets; },
    get netByName() { return nets().netByName as ReadonlyMap<string, readonly BoardNetEntry[]>; },
    get netsByFold() { return nets().netsByFold as ReadonlyMap<string, readonly string[]>; },
    get stats() { return stats(); },
    get search() { return search(); },
  });
}

const shared = new WeakMap<Board, BoardIndex>();
/** The shared index of a board object, built on first request and kept as long as the board itself. */
export function boardIndexOf(board: Board): BoardIndex {
  let index = shared.get(board);
  if (!index) { index = buildBoardIndex(board); shared.set(board, index); }
  return index;
}
