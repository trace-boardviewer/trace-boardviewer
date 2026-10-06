/**
 * Cross-probe: the ONLY link between the separate Board, Schematic and Document models. Pure, deterministic,
 * serializable results, no DOM / Electron / pdf.js runtime (type-only imports), so it runs in a worker or in node.
 *
 * Identity rules:
 *  - Keys are NFKC + trim (`normalizeKey`), compared CASE-SENSITIVELY. R1 and r1 are two different references.
 *    Case-insensitive equals are only ever returned as separate, flagged `caseInsensitive` alternates (B18).
 *  - Board pin = (component ref, pin number). Schematic pin = (annotated ref of the sheet instance, SchPin.number).
 *  - Partial names never link (R1 is not R10). Duplicates are reported as ambiguous with the reason, never picked.
 *  - Net names are never equated except by exact string equality (against the net's name or one of its merged
 *    alias names) or by an explicit, user-confirmed `WorkspaceAliases.nets` entry. Reference aliases come only from
 *    `WorkspaceAliases.refs`. Automatic schematic names ("Net-(R1-Pad2)") carry no identity: relation `unknown`.
 *  - Every ordering is natural (numeric) through ONE cached Intl.Collator (P02) with a code-unit tie-break.
 *  - Every list a function returns is bounded; the totals are always exact and `truncated` says when rows were cut.
 */
import type { Board, BoardComponent, BoardPin, BoardSide } from './types';
import type { WorkspaceAliases } from './documents';
import type { Hit, RefCandidate } from './pdf/search';
import type { RefCandidateResult } from './pdf/session-contract';
import { pinKey, symbolKey, symbolRef } from './schematic/model';
import type { SchNet, SchNetMember, SchSheetInstance, SchSymbol, SchematicDesign } from './schematic/model';

// ---------------------------------------------------------------------------------------------------------------
// Normalization and ordering
// ---------------------------------------------------------------------------------------------------------------

const SEP = '\u0000';
let collator: Intl.Collator | undefined;

/** Natural order ("R2" < "R10") through one cached collator; 'en' is DATA_LOCALE (board data is ordered alike in every UI language). */
export function naturalCompare(a: string, b: string): number {
  collator ??= new Intl.Collator('en', { numeric: true });
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The identity key of a reference, pin number or net name: NFKC and trim, case preserved. */
export const normalizeKey = (value: string): string => value.normalize('NFKC').trim();
const fold = (value: string): string => value.toLowerCase();
/** Query/haystack form for search: NFKC, invisible zero-width characters dropped (IME / paste debris), whitespace runs collapsed to one space, trimmed. */
export const normalizeQuery = (value: string): string => value.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/gu, '').replace(/\s+/gu, ' ').trim();

const capped = <T>(list: readonly T[], limit: number): T[] => list.length > limit ? list.slice(0, limit) : list.slice();
const MAX_LIST = 16;
const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
const clampLimit = (value: number | undefined, fallback: number): number => value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(50_000, Math.floor(value)));

export interface Listing<T> { rows: T[]; total: number; truncated: boolean }

// ---------------------------------------------------------------------------------------------------------------
// Aliases (user-confirmed, from WorkspaceManifest.aliases)
// ---------------------------------------------------------------------------------------------------------------

export interface CompiledAliases {
  /** normalized schematic ref → normalized board ref */
  readonly refs: ReadonlyMap<string, string>;
  /** normalized board ref → normalized schematic refs aliased to it (natural order) */
  readonly refsReverse: ReadonlyMap<string, readonly string[]>;
  /** normalized schematic net name → normalized board net name */
  readonly nets: ReadonlyMap<string, string>;
  readonly netsReverse: ReadonlyMap<string, readonly string[]>;
}
export type AliasInput = WorkspaceAliases | CompiledAliases | null | undefined;

/** Normalizes and reverses explicit aliases once; empty keys/values are dropped. Nothing is ever inferred. */
export function compileAliases(aliases?: WorkspaceAliases | null): CompiledAliases {
  const build = (record: Record<string, string> | undefined) => {
    const forward = new Map<string, string>(), reverse = new Map<string, string[]>();
    for (const [from, to] of Object.entries(record ?? {})) {
      const a = normalizeKey(from), b = normalizeKey(String(to));
      if (!a || !b) continue;
      forward.set(a, b);
      push(reverse, b, a);
    }
    for (const list of reverse.values()) list.sort(naturalCompare);
    return { forward, reverse };
  };
  const refs = build(aliases?.refs), nets = build(aliases?.nets);
  return { refs: refs.forward, refsReverse: refs.reverse, nets: nets.forward, netsReverse: nets.reverse };
}
const toAliases = (input: AliasInput): CompiledAliases => input && (input as CompiledAliases).refs instanceof Map ? input as CompiledAliases : compileAliases(input as WorkspaceAliases | null | undefined);

// ---------------------------------------------------------------------------------------------------------------
// Board index
// ---------------------------------------------------------------------------------------------------------------

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
interface BoardSearchRecord { key: string; folded: string; value: string; pkg: string; hay: string; nets: readonly string[] }
export interface BoardIndexStats { components: number; pins: number; nets: number; duplicateRefKeys: number; caseDistinctRefGroups: number; componentsWithoutRef: number; pinsWithoutNumber: number; duplicateComponentIds: number }
export interface BoardIndex {
  readonly kind: 'board';
  /** Natural order (ref, then id). Includes components with an empty reference. */
  readonly components: readonly BoardComponent[];
  readonly componentById: ReadonlyMap<string, BoardComponent>;
  readonly pinById: ReadonlyMap<string, BoardPin>;
  /** normalized ref → components carrying exactly that ref (several = duplicate refs). R1 and r1 are different keys. */
  readonly byRef: ReadonlyMap<string, readonly BoardComponent[]>;
  /** lowercase form → distinct exact ref keys sharing it (more than one = case-distinct refs such as R1/r1). */
  readonly refsByFold: ReadonlyMap<string, readonly string[]>;
  /** componentId → (normalized pin number → pads), insertion order = natural pin order. */
  readonly pinGroups: ReadonlyMap<string, ReadonlyMap<string, BoardPinGroup>>;
  /** Natural order by name. */
  readonly nets: readonly BoardNetEntry[];
  readonly netByName: ReadonlyMap<string, readonly BoardNetEntry[]>;
  readonly netsByFold: ReadonlyMap<string, readonly string[]>;
  readonly stats: BoardIndexStats;
  /** @internal aligned with `components` */
  readonly search: readonly BoardSearchRecord[];
}

const distinctNets = (pins: readonly BoardPin[]): string[] => {
  if (pins.length === 1) { const net = normalizeKey(pins[0].net); return net ? [net] : []; }
  const nets = new Set<string>();
  for (const pin of pins) { const net = normalizeKey(pin.net); if (net) nets.add(net); }
  return [...nets].sort(naturalCompare);
};

/**
 * ref → components (duplicates and case-distinct refs stay distinct, B18), (component, pin number) → pads and
 * net name → pins. One pass over the board; every sort goes through the cached collator (P02).
 */
export function buildBoardIndex(board: Board): BoardIndex {
  const componentById = new Map<string, BoardComponent>();
  let duplicateComponentIds = 0;
  for (const component of board.components) { if (componentById.has(component.id)) duplicateComponentIds++; else componentById.set(component.id, component); }
  const pinById = new Map<string, BoardPin>();
  for (const pin of board.pins) if (!pinById.has(pin.id)) pinById.set(pin.id, pin);
  const components = board.components.slice().sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.id, b.id));
  const rank = new Map<string, number>();
  components.forEach((component, i) => { if (!rank.has(component.id)) rank.set(component.id, i); });

  const byRef = new Map<string, BoardComponent[]>(), foldKeys = new Map<string, string[]>();
  let componentsWithoutRef = 0;
  for (const component of components) {
    const key = normalizeKey(component.ref);
    if (!key) { componentsWithoutRef++; continue; }
    const list = byRef.get(key);
    if (list) list.push(component);
    else { byRef.set(key, [component]); push(foldKeys, fold(key), key); }
  }
  let duplicateRefKeys = 0, caseDistinctRefGroups = 0;
  for (const list of byRef.values()) if (list.length > 1) duplicateRefKeys++;
  for (const keys of foldKeys.values()) if (keys.length > 1) caseDistinctRefGroups++;

  const pinGroups = new Map<string, Map<string, BoardPinGroup>>();
  let pinsWithoutNumber = 0;
  for (const component of board.components) {
    if (pinGroups.has(component.id)) continue;
    const byNumber = new Map<string, BoardPin[]>();
    for (const id of component.pinIds) {
      const pin = pinById.get(id);
      if (!pin) continue;
      const number = normalizeKey(pin.number);
      if (!number) { pinsWithoutNumber++; continue; }
      push(byNumber, number, pin);
    }
    const groups = new Map<string, BoardPinGroup>();
    const numbers = [...byNumber.keys()];
    if (numbers.length > 1) numbers.sort(naturalCompare);
    for (const number of numbers) { const pins = byNumber.get(number)!; groups.set(number, { number, pins, nets: distinctNets(pins) }); }
    pinGroups.set(component.id, groups);
  }

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
  const pinOrder = (a: BoardPin, b: BoardPin) => (rank.get(a.componentId) ?? 0) - (rank.get(b.componentId) ?? 0) || naturalCompare(a.number, b.number) || naturalCompare(a.id, b.id);
  const nets: BoardNetEntry[] = builders
    .map(b => ({ name: b.name, key: normalizeKey(b.name), folded: fold(normalizeQuery(b.name)), id: b.id, pins: b.pins.sort(pinOrder) }))
    .sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.id ?? '', b.id ?? ''));
  const netByName = new Map<string, BoardNetEntry[]>(), netFold = new Map<string, string[]>();
  for (const net of nets) {
    const list = netByName.get(net.key);
    if (list) list.push(net); else { netByName.set(net.key, [net]); push(netFold, fold(net.key), net.key); }
  }

  const search: BoardSearchRecord[] = components.map(component => {
    const names = new Set<string>();
    for (const id of component.pinIds) { const net = pinById.get(id)?.net; if (net) names.add(fold(normalizeQuery(net))); }
    const value = fold(normalizeQuery(component.value)), pkg = fold(normalizeQuery(component.package));
    return { key: normalizeKey(component.ref), folded: fold(normalizeQuery(component.ref)), value, pkg, hay: fold(normalizeQuery(`${component.ref} ${component.value} ${component.package}`)), nets: [...names] };
  });
  return {
    kind: 'board', components, componentById, pinById, byRef, refsByFold: foldKeys, pinGroups, nets, netByName, netsByFold: netFold, search,
    stats: { components: board.components.length, pins: board.pins.length, nets: nets.length, duplicateRefKeys, caseDistinctRefGroups, componentsWithoutRef, pinsWithoutNumber, duplicateComponentIds },
  };
}

/** Components that carry exactly this reference (case-sensitive after NFKC/trim). */
export const boardComponentsByRef = (index: BoardIndex, ref: string): readonly BoardComponent[] => index.byRef.get(normalizeKey(ref)) ?? [];
/** Pads of `componentId` numbered `number` (several pads may share a number). */
export const boardPinsByNumber = (index: BoardIndex, componentId: string, number: string): readonly BoardPin[] => index.pinGroups.get(componentId)?.get(normalizeKey(number))?.pins ?? [];
/** Pins of the board net(s) named exactly `name`. Several entries mean the board declares the name twice. */
export const boardNetsByName = (index: BoardIndex, name: string): readonly BoardNetEntry[] => index.netByName.get(normalizeKey(name)) ?? [];

// ---------------------------------------------------------------------------------------------------------------
// Schematic index
// ---------------------------------------------------------------------------------------------------------------

export interface SchematicSource { documentId: string; design: SchematicDesign }
export interface SchSheetInfo { documentId: string; instancePath: string; defId: string; name: string; page: string; /** Names from the root down, " / " joined. */ label: string }
export interface SchPinPlacement { instancePath: string; defId: string; symbolId: string; pinId: string; unit: number; /** model pinKey(instancePath, symbolId, pinId) */ pinKey: string }
export interface SchUnitPlacement { instancePath: string; defId: string; symbolId: string; unit: number }
export interface SchNetEntry {
  /** `${documentId}\0${SchNet.id}`: unique across documents. */
  key: string;
  documentId: string;
  id: string;
  name: string;
  nameKey: string;
  /** @internal lowercase NFKC search forms of the name and of every alias */
  folded: string;
  aliasFolded: readonly string[];
  auto: boolean;
  scope: 'global' | 'local' | 'hierarchical';
  scopePath?: string;
  aliases: readonly string[];
  /** Every name the net answers to when it is matched with a board net: its aliases plus, for a KiCad source, the names KiCad writes into a board (`kicadNetlistNames`). */
  aliasKeys: readonly string[];
  members: readonly SchNetMember[];
}
/** One electrical pin of a part: the physical pins sharing its number (the common pins of a multi-unit part repeat in every unit). */
export interface SchPartPin {
  number: string;
  name: string;
  placements: readonly SchPinPlacement[];
  /** The single net all connected copies agree on; null when unconnected or in conflict. */
  net: SchNetEntry | null;
  netKeys: readonly string[];
  members: readonly SchNetMember[];
  /** Every copy carries an explicit no-connect marker (and none is connected). */
  noConnect: boolean;
  state: 'connected' | 'unconnected' | 'conflict';
}
export interface SchPart {
  /** `${documentId}\0${instancePath}\0${symbolId}` of the first unit: stable and unique. */
  key: string;
  documentId: string;
  ref: string;
  refKey: string;
  libId: string;
  value: string;
  footprint: string;
  unitCount: number;
  dnp: boolean;
  /** Ref still ends with "?" (not annotated): several parts normally share it, so it is always ambiguous. */
  unannotated: boolean;
  /** Two symbols claim the same unit of this reference: they were NOT merged into one multi-unit part. */
  duplicateAnnotation: boolean;
  /** Unit symbols ordered by unit, instance path, symbol id. */
  units: readonly SchUnitPlacement[];
  instancePaths: readonly string[];
  sheets: readonly SchSheetInfo[];
  pins: ReadonlyMap<string, SchPartPin>;
}
export interface SchematicIndex {
  readonly kind: 'schematic';
  readonly documents: readonly { documentId: string; name: string; format: string }[];
  /** Non-virtual parts, natural order. #PWR/#FLG style symbols are not parts. */
  readonly parts: readonly SchPart[];
  readonly partsByRef: ReadonlyMap<string, readonly SchPart[]>;
  readonly refsByFold: ReadonlyMap<string, readonly string[]>;
  /** `${documentId}\0${symbolKey(instancePath, symbolId)}` → part */
  readonly partBySymbol: ReadonlyMap<string, SchPart>;
  readonly virtualSymbols: ReadonlySet<string>;
  readonly sheets: ReadonlyMap<string, SchSheetInfo>;
  /** Natural order by name, every net of every document (power symbols' nets included). */
  readonly nets: readonly SchNetEntry[];
  readonly netByKey: ReadonlyMap<string, SchNetEntry>;
  /** by primary name only */
  readonly netsByName: ReadonlyMap<string, readonly SchNetEntry[]>;
  /** by primary name or any merged alias name */
  readonly netsByAnyName: ReadonlyMap<string, readonly SchNetEntry[]>;
  readonly netsByFold: ReadonlyMap<string, readonly string[]>;
  readonly stats: { documents: number; parts: number; virtualSymbols: number; nets: number; symbolsWithoutRef: number; duplicateAnnotations: number };
  /** @internal aligned with `parts` */
  readonly search: readonly { key: string; folded: string; value: string; footprint: string; hay: string }[];
}

/**
 * The names under which KiCad writes this net into a board or netlist, besides the text of its labels (W-open-cross-01):
 *  - a net named by a LOCAL or HIERARCHICAL label is qualified by its sheet path: "/NAME" on the root sheet, "/sheet/sub/NAME" below it (the
 *    names of the sheet symbols, root excluded); global labels, power symbols and automatic names stay bare. The schematic model keeps the bare
 *    label text, so the qualified form is derived here, from the sheet instance the name was taken from; without it every local-label net of a
 *    real KiCad board "differs" from the schematic;
 *  - a "/" in a net name is written "{slash}" (the label VPP/MCLR becomes "VPP{slash}MCLR"), since "/" separates the sheet path.
 * Each is one more exact name the net answers to; nothing is matched by similarity.
 */
export function kicadNetlistNames(net: SchNet, instances: ReadonlyMap<string, SchSheetInstance>): string[] {
  const escape = (name: string) => name.replace(/\{slash\}/g, '/').replace(/\//g, '{slash}');
  const names = new Set<string>(net.aliases.map(escape));
  if (!net.auto && net.scope !== 'global' && net.scopePath !== undefined) {
    const sheets: string[] = [];
    for (let instance = instances.get(net.scopePath); instance && instance.parentPath !== null; instance = instances.get(instance.parentPath)) sheets.unshift(instance.name);
    names.add(`/${sheets.map(name => `${name}/`).join('')}${escape(net.name)}`);
  }
  return [...names];
}

/**
 * The automatic name KiCad 8/9 gives a net that no label names (W-open-cross-02): "Net-(<ref>-<pin>)" of ONE member pin. Evidence: all 142 such nets
 * of five real KiCad 8/9 boards reproduce exactly with this rule (the older "Net-(R1-Pad2)" form, which the schematic model keeps as the net's name, is
 * what KiCad 5 wrote):
 *  - a pin is NAMED when its name is not empty, not "~" and not just its own number; its shown form is the name with "/" written "{slash}", or
 *    "<name>-Pad<number>" when another pin of the same symbol carries the same name; an unnamed pin shows "Pad<number>";
 *  - the reference carries the unit letter ("J15B") when the symbol has several units;
 *  - the member is chosen among the named pins when there are any, and the smallest resulting text wins (plain string order).
 * It is offered as one more exact name of an automatic net, so it can only add matches: a net that has it wrong stays "unknown", never "differs".
 */
export function kicadAutoNetName(net: SchNet, symbols: ReadonlyMap<string, SchSymbol>): string | null {
  if (!net.auto) return null;
  let best: { named: boolean; text: string } | null = null;
  for (const member of net.members) {
    const symbol = symbols.get(member.defId + SEP + member.symbolId);
    if (!symbol) return null;
    const named = !!member.pinName && member.pinName !== '~' && member.pinName !== member.pinNumber;
    let shown = named ? member.pinName.replace(/\//g, '{slash}') : `Pad${member.pinNumber}`;
    if (named && symbol.pins.filter(pin => pin.name === member.pinName).length > 1) shown += `-Pad${member.pinNumber}`;
    const ref = symbol.unitCount > 1 && member.unit >= 1 && member.unit <= 26 ? member.ref + String.fromCharCode(64 + member.unit) : member.ref;
    const text = `Net-(${ref}-${shown})`;
    if (!best || (named && !best.named) || (named === best.named && text < best.text)) best = { named, text };
  }
  return best?.text ?? null;
}

interface RawSymbol { documentId: string; instance: SchSheetInstance; defId: string; symbol: SchSymbol; ref: string; refKey: string; unit: number }

const symbolUnit = (symbol: SchSymbol, path: string): number => symbol.instances[path]?.unit ?? symbol.instances['']?.unit ?? symbol.unit;
const unitOrder = (a: RawSymbol, b: RawSymbol) => a.unit - b.unit || naturalCompare(a.instance.path, b.instance.path) || naturalCompare(a.symbol.id, b.symbol.id);
/** Several unit symbols form ONE part only when they are the same library part and no unit number repeats. */
const mergeable = (raws: readonly RawSymbol[]): boolean => raws.length < 2 || (new Set(raws.map(r => r.unit)).size === raws.length && raws.every(r => r.symbol.libId === raws[0].symbol.libId));

/**
 * Annotated ref per sheet instance → parts. Multi-unit symbols (several SchSymbols sharing one reference) form one
 * part (also across sheets when no unit repeats); a repeated sub-sheet keeps its placements distinct by instance
 * path; two symbols claiming the same unit are never merged. Virtual symbols are excluded from parts but their nets
 * stay in the net indexes. Only instantiated sheet definitions are indexed (one pass per `Schematic.instances` entry);
 * a symbol without any reference is skipped and counted in `stats.symbolsWithoutRef`. `documentId` defaults to
 * `schematic:<i>`; a repeated id is made unique with `~<n>`.
 */
export function buildSchematicIndex(designs: readonly (SchematicDesign | SchematicSource)[]): SchematicIndex {
  const documents: { documentId: string; name: string; format: string }[] = [];
  const sheets = new Map<string, SchSheetInfo>(), netByKey = new Map<string, SchNetEntry>();
  const nets: SchNetEntry[] = [], parts: SchPart[] = [], virtualSymbols = new Set<string>(), partBySymbol = new Map<string, SchPart>();
  const usedIds = new Set<string>();
  let symbolsWithoutRef = 0, duplicateAnnotations = 0;

  designs.forEach((entry, i) => {
    const source: SchematicSource = 'design' in entry ? entry : { documentId: `schematic:${i}`, design: entry };
    let documentId = source.documentId;
    for (let n = 2; usedIds.has(documentId); n++) documentId = `${source.documentId}~${n}`;
    usedIds.add(documentId);
    const { schematic, connectivity } = source.design;
    documents.push({ documentId, name: schematic.name, format: schematic.format });

    const memberByPin = new Map<string, SchNetMember>();
    const instanceByPath = new Map(schematic.instances.map(instance => [instance.path, instance] as const));
    const kicadSource = schematic.format !== 'eagle-sch';
    const symbolByKey = new Map<string, SchSymbol>();
    if (schematic.format === 'kicad-sch') for (const def of schematic.defs) for (const symbol of def.symbols) symbolByKey.set(def.id + SEP + symbol.id, symbol);
    for (const net of connectivity.nets) {
      const netlistNames = kicadSource ? kicadNetlistNames(net, instanceByPath) : [];
      if (schematic.format === 'kicad-sch') { const auto = kicadAutoNetName(net, symbolByKey); if (auto !== null) netlistNames.push(auto); }
      const entryNet: SchNetEntry = {
        key: documentId + SEP + net.id, documentId, id: net.id, name: net.name, nameKey: normalizeKey(net.name), folded: fold(normalizeQuery(net.name)), aliasFolded: net.aliases.map(alias => fold(normalizeQuery(alias))), auto: net.auto, scope: net.scope, scopePath: net.scopePath,
        aliases: net.aliases, aliasKeys: [...new Set([...net.aliases, ...netlistNames].map(normalizeKey))], members: net.members,
      };
      nets.push(entryNet); netByKey.set(entryNet.key, entryNet);
      for (const member of net.members) memberByPin.set(pinKey(member.instancePath, member.symbolId, member.pinId), member);
    }
    const noConnect = new Set(connectivity.noConnectPins);
    const defs = new Map(schematic.defs.map(def => [def.id, def]));
    const labels = new Map<string, string>();
    for (const instance of schematic.instances) {
      const name = instance.name || instance.page || instance.path || schematic.name;
      const parent = instance.parentPath === null ? undefined : labels.get(instance.parentPath);
      const label = parent ? `${parent} / ${name}` : name;
      labels.set(instance.path, label);
      sheets.set(documentId + SEP + instance.path, { documentId, instancePath: instance.path, defId: instance.defId, name, page: instance.page, label });
    }

    const groups = new Map<string, RawSymbol[]>();
    for (const instance of schematic.instances) {
      const def = defs.get(instance.defId);
      if (!def) continue;
      for (const symbol of def.symbols) {
        const qualified = documentId + SEP + symbolKey(instance.path, symbol.id);
        if (symbol.virtual) { virtualSymbols.add(qualified); continue; }
        const ref = symbolRef(symbol, instance.path), refKey = normalizeKey(ref);
        if (!refKey) { symbolsWithoutRef++; continue; }
        push(groups, refKey, { documentId, instance, defId: def.id, symbol, ref, refKey, unit: symbolUnit(symbol, instance.path) });
      }
    }

    const makePart = (raws: RawSymbol[], duplicate: boolean): void => {
      raws.sort(unitOrder);
      const first = raws[0];
      const units: SchUnitPlacement[] = raws.map(r => ({ instancePath: r.instance.path, defId: r.defId, symbolId: r.symbol.id, unit: r.unit }));
      const instancePaths = [...new Set(units.map(u => u.instancePath))];
      const pins = new Map<string, SchPartPin>();
      const partial = new Map<string, { name: string; placements: SchPinPlacement[]; netKeys: string[]; members: SchNetMember[]; allNoConnect: boolean }>();
      for (const raw of raws) {
        for (const pin of raw.symbol.pins) {
          const number = normalizeKey(pin.number);
          if (!number) continue;
          const key = pinKey(raw.instance.path, raw.symbol.id, pin.id);
          const netId = connectivity.pinNet[key];
          let record = partial.get(number);
          if (!record) { record = { name: '', placements: [], netKeys: [], members: [], allNoConnect: true }; partial.set(number, record); }
          if (!record.name && pin.name) record.name = pin.name;
          record.placements.push({ instancePath: raw.instance.path, defId: raw.defId, symbolId: raw.symbol.id, pinId: pin.id, unit: raw.unit, pinKey: key });
          if (netId !== undefined) { const netKey = documentId + SEP + netId; if (!record.netKeys.includes(netKey)) record.netKeys.push(netKey); }
          const member = memberByPin.get(key);
          if (member) record.members.push(member);
          if (!noConnect.has(key)) record.allNoConnect = false;
        }
      }
      const pinNumbers = [...partial.keys()];
      if (pinNumbers.length > 1) pinNumbers.sort(naturalCompare);
      for (const number of pinNumbers) {
        const record = partial.get(number)!;
        const netKeys = record.netKeys.length > 1 ? record.netKeys.sort() : record.netKeys;
        const state = netKeys.length > 1 ? 'conflict' : netKeys.length === 1 ? 'connected' : 'unconnected';
        pins.set(number, { number, name: record.name, placements: record.placements, net: state === 'connected' ? netByKey.get(netKeys[0]) ?? null : null, netKeys, members: record.members, noConnect: state === 'unconnected' && record.allNoConnect, state });
      }
      const part: SchPart = {
        key: documentId + SEP + first.instance.path + SEP + first.symbol.id, documentId, ref: first.ref, refKey: first.refKey, libId: first.symbol.libId, value: first.symbol.value, footprint: first.symbol.footprint,
        unitCount: Math.max(first.symbol.unitCount, raws.length), dnp: raws.every(r => r.symbol.dnp), unannotated: first.refKey.endsWith('?'), duplicateAnnotation: duplicate,
        units, instancePaths, sheets: instancePaths.map(path => sheets.get(documentId + SEP + path)!), pins,
      };
      parts.push(part);
      for (const raw of raws) partBySymbol.set(documentId + SEP + symbolKey(raw.instance.path, raw.symbol.id), part);
      if (duplicate) duplicateAnnotations++;
    };
    for (const raws of groups.values()) {
      if (mergeable(raws)) { makePart(raws, false); continue; }
      const byInstance = new Map<string, RawSymbol[]>();
      for (const raw of raws) push(byInstance, raw.instance.path, raw);
      for (const list of byInstance.values()) {
        if (mergeable(list)) makePart(list, false);
        else for (const raw of list) makePart([raw], true);
      }
    }
  });

  parts.sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.key, b.key));
  const partsByRef = new Map<string, SchPart[]>(), foldKeys = new Map<string, string[]>();
  for (const part of parts) {
    if (partsByRef.has(part.refKey)) partsByRef.get(part.refKey)!.push(part);
    else { partsByRef.set(part.refKey, [part]); push(foldKeys, fold(part.refKey), part.refKey); }
  }
  nets.sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.key, b.key));
  const netsByName = new Map<string, SchNetEntry[]>(), netsByAnyName = new Map<string, SchNetEntry[]>(), netFold = new Map<string, string[]>();
  for (const net of nets) {
    const list = netsByName.get(net.nameKey);
    if (list) list.push(net); else { netsByName.set(net.nameKey, [net]); push(netFold, fold(net.nameKey), net.nameKey); }
    for (const name of new Set([net.nameKey, ...net.aliasKeys])) if (name) push(netsByAnyName, name, net);
  }
  const search = parts.map(part => ({ key: part.refKey, folded: fold(normalizeQuery(part.ref)), value: fold(normalizeQuery(part.value)), footprint: fold(normalizeQuery(part.footprint)), hay: fold(normalizeQuery(`${part.ref} ${part.value} ${part.footprint}`)) }));
  return {
    kind: 'schematic', documents, parts, partsByRef, refsByFold: foldKeys, partBySymbol, virtualSymbols, sheets, nets, netByKey, netsByName, netsByAnyName, netsByFold: netFold, search,
    stats: { documents: documents.length, parts: parts.length, virtualSymbols: virtualSymbols.size, nets: nets.length, symbolsWithoutRef, duplicateAnnotations },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Link report: board <-> schematic
// ---------------------------------------------------------------------------------------------------------------

export type RefLinkStatus = 'unique' | 'ambiguous' | 'board-only' | 'schematic-only' | 'alias';
export type RefReason =
  | 'several-schematic-placements' | 'several-board-parts' | 'unannotated-schematic-reference' | 'duplicate-annotation' | 'alias-target-missing'
  | 'alias-overrides-exact-match' | 'schematic-dnp' | 'no-schematic-part' | 'no-board-component';
export type PinStatus = 'match' | 'net-differs' | 'pin-missing-on-board' | 'pin-missing-on-schematic' | 'ambiguous' | 'net-unknown';
export type PinReason =
  | 'both-unconnected' | 'matches-net-alias-name' | 'schematic-no-connect' | 'schematic-pin-unconnected' | 'board-pin-unconnected' | 'net-name-differs'
  | 'schematic-net-auto-named' | 'board-pin-nets-conflict' | 'schematic-pin-nets-conflict' | 'several-schematic-pins';
export type NetRelation = 'same-name' | 'differs' | 'alias-confirmed' | 'unknown';

export interface PartSummary { partKey: string; documentId: string; ref: string; via: 'exact' | 'alias'; instancePath: string; sheetLabel: string; page: string; instancePaths: string[]; units: number[] }
export interface PinCounts { match: number; netDiffers: number; missingOnBoard: number; missingOnSchematic: number; ambiguous: number; unknown: number }
export interface RefLinkRow {
  status: RefLinkStatus;
  /** Board reference this row is about (the alias target for aliased groups); '' never occurs. */
  ref: string;
  boardComponentIds: string[];
  boardComponentsTotal: number;
  schematicRefs: string[];
  schematicParts: PartSummary[];
  schematicPartsTotal: number;
  reasons: RefReason[];
  /** Same letters in another case on the OTHER side: flagged candidates for an explicit user decision, never linked. */
  caseInsensitive: { boardRefs: string[]; schematicRefs: string[] };
  /** Present for unique / alias rows: the per-pin tally. */
  pins?: PinCounts;
}
export interface PinLinkRow {
  status: PinStatus;
  reason?: PinReason;
  ref: string;
  boardComponentId: string;
  schematicRef: string;
  pinNumber: string;
  boardPinIds: string[];
  /** '' = no net on the board. */
  boardNet: string;
  schematic: { partKey: string; documentId: string; netKey: string | null; netId: string | null; netName: string | null; netAuto: boolean } | null;
  netRelation: NetRelation;
}
export interface NetLinkRow {
  boardNet: string;
  boardNetId: string | null;
  relation: NetRelation;
  /** Pins of this board net that were compared (their reference links uniquely). */
  comparedPins: number;
  pinsSameName: number;
  pinsAliasConfirmed: number;
  pinsDiffer: number;
  pinsUnknown: number;
  schematicNets: Array<{ documentId: string; netId: string; name: string; auto: boolean; pins: number }>;
  schematicNetsTotal: number;
}
export interface SchematicOnlyNetRow { name: string; documentId: string; netIds: string[]; netsTotal: number }
export interface AliasIssue { kind: 'ref' | 'net'; from: string; to: string; problem: 'source-missing' | 'target-missing' }
export interface LinkSummary {
  refs: { unique: number; ambiguous: number; boardOnly: number; schematicOnly: number; alias: number; unkeyedBoardComponents: number };
  /** Pins are compared only for unique/alias references; pins of ambiguous references are not compared. */
  pins: { compared: number; match: number; netDiffers: number; pinMissingOnBoard: number; pinMissingOnSchematic: number; ambiguous: number; netUnknown: number };
  nets: { compared: number; sameName: number; aliasConfirmed: number; differs: number; unknown: number; schematicOnly: number };
  disagreements: { refs: number; pins: number; nets: number; total: number };
}
export interface LinkReport {
  version: 1;
  refs: Listing<RefLinkRow>;
  /** Only disagreements and unverifiable pins unless `includeMatches`. */
  pins: Listing<PinLinkRow>;
  nets: Listing<NetLinkRow>;
  schematicOnlyNets: Listing<SchematicOnlyNetRow>;
  aliasIssues: Listing<AliasIssue>;
  summary: LinkSummary;
}
export interface LinkOptions { maxRefRows?: number; maxPinRows?: number; maxNetRows?: number; maxSchematicOnlyNets?: number; maxAliasIssues?: number; includeMatches?: boolean }
export const DEFAULT_LINK_LIMITS = Object.freeze({ maxRefRows: 500, maxPinRows: 1000, maxNetRows: 500, maxSchematicOnlyNets: 200, maxAliasIssues: 100 });

const REF_ORDER: Record<RefLinkStatus, number> = { ambiguous: 0, 'schematic-only': 1, 'board-only': 2, alias: 3, unique: 4 };
const PIN_ORDER: Record<PinStatus, number> = { ambiguous: 0, 'net-differs': 1, 'pin-missing-on-board': 2, 'pin-missing-on-schematic': 3, 'net-unknown': 4, match: 5 };
const NET_ORDER: Record<NetRelation, number> = { differs: 0, unknown: 1, 'alias-confirmed': 2, 'same-name': 3 };

function summarizePart(part: SchPart, via: 'exact' | 'alias'): PartSummary {
  const sheet = part.sheets[0];
  return { partKey: part.key, documentId: part.documentId, ref: part.ref, via, instancePath: part.units[0].instancePath, sheetLabel: sheet?.label ?? '', page: sheet?.page ?? '', instancePaths: capped(part.instancePaths, MAX_LIST), units: part.units.map(u => u.unit) };
}

interface PinVerdict { readonly status: PinStatus; readonly reason?: PinReason; readonly relation: NetRelation }
const verdict = (status: PinStatus, relation: NetRelation, reason?: PinReason): PinVerdict => Object.freeze({ status, relation, reason });
const V = {
  bothUnconnected: verdict('match', 'unknown', 'both-unconnected'), same: verdict('match', 'same-name'), sameViaAlias: verdict('match', 'same-name', 'matches-net-alias-name'), confirmed: verdict('match', 'alias-confirmed'),
  noConnect: verdict('net-differs', 'differs', 'schematic-no-connect'), unconnected: verdict('net-differs', 'differs', 'schematic-pin-unconnected'), boardUnconnected: verdict('net-differs', 'differs', 'board-pin-unconnected'),
  differs: verdict('net-differs', 'differs', 'net-name-differs'), auto: verdict('net-unknown', 'unknown', 'schematic-net-auto-named'),
  missingOnSchematic: verdict('pin-missing-on-schematic', 'unknown'), missingOnBoard: verdict('pin-missing-on-board', 'unknown'),
  boardConflict: verdict('ambiguous', 'unknown', 'board-pin-nets-conflict'), severalPins: verdict('ambiguous', 'unknown', 'several-schematic-pins'), schematicConflict: verdict('ambiguous', 'unknown', 'schematic-pin-nets-conflict'),
};

/** Board net (normalized, '' = none) against the schematic pin's net. Exact names and explicit aliases only. */
function relateNets(boardNet: string, pin: SchPartPin | undefined, aliases: CompiledAliases): PinVerdict {
  const net = pin?.net ?? null;
  if (!boardNet && !net) return V.bothUnconnected;
  if (!net) return pin?.noConnect ? V.noConnect : V.unconnected;
  if (!boardNet) return V.boardUnconnected;
  if (boardNet === net.nameKey) return V.same;
  if (net.aliasKeys.includes(boardNet)) return V.sameViaAlias;
  if (aliases.nets.size && (aliases.nets.get(net.nameKey) === boardNet || net.aliasKeys.some(name => aliases.nets.get(name) === boardNet))) return V.confirmed;
  return net.auto ? V.auto : V.differs;
}

/** Merge of two naturally sorted, duplicate-free key lists. */
function mergeNumbers(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const order = a[i] === b[j] ? 0 : naturalCompare(a[i], b[j]);
    if (order === 0) { out.push(a[i]); i++; j++; } else if (order < 0) out.push(a[i++]); else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
const EMPTY_PIN_GROUPS: ReadonlyMap<string, BoardPinGroup> = new Map();

/**
 * Compares a board and one or more schematic documents. Reference status (`unique` | `ambiguous` | `board-only` |
 * `schematic-only` | `alias`), per pin (`match` | `net-differs` | `pin-missing-on-board` | `pin-missing-on-schematic` |
 * `ambiguous`, plus `net-unknown` when a name cannot be compared) and per board net (`same-name` | `differs` |
 * `alias-confirmed` | `unknown`). The aliases are the user-confirmed `WorkspaceManifest.aliases`; an explicit ref alias
 * takes precedence over the exact name for that schematic reference (reason `alias-overrides-exact-match`).
 * Rows are ordered problems first and capped; `summary` and every `total` are exact. Pins are compared only for
 * `unique` / `alias` references: an ambiguous reference never guesses which pins belong together.
 */
export function linkBoardSchematic(board: BoardIndex, schematic: SchematicIndex, aliasInput?: AliasInput, options: LinkOptions = {}): LinkReport {
  const aliases = toAliases(aliasInput);
  const limits = {
    refs: clampLimit(options.maxRefRows, DEFAULT_LINK_LIMITS.maxRefRows), pins: clampLimit(options.maxPinRows, DEFAULT_LINK_LIMITS.maxPinRows), nets: clampLimit(options.maxNetRows, DEFAULT_LINK_LIMITS.maxNetRows),
    schematicOnly: clampLimit(options.maxSchematicOnlyNets, DEFAULT_LINK_LIMITS.maxSchematicOnlyNets), issues: clampLimit(options.maxAliasIssues, DEFAULT_LINK_LIMITS.maxAliasIssues),
  };

  const groups = new Map<string, SchPart[]>();
  for (const part of schematic.parts) push(groups, aliases.refs.get(part.refKey) ?? part.refKey, part);
  const order = [...new Set<string>([...groups.keys(), ...board.byRef.keys()])].sort(naturalCompare);

  const summary: LinkSummary = {
    refs: { unique: 0, ambiguous: 0, boardOnly: 0, schematicOnly: 0, alias: 0, unkeyedBoardComponents: board.stats.componentsWithoutRef },
    pins: { compared: 0, match: 0, netDiffers: 0, pinMissingOnBoard: 0, pinMissingOnSchematic: 0, ambiguous: 0, netUnknown: 0 },
    nets: { compared: 0, sameName: 0, aliasConfirmed: 0, differs: 0, unknown: 0, schematicOnly: 0 },
    disagreements: { refs: 0, pins: 0, nets: 0, total: 0 },
  };
  const refBuckets: Record<RefLinkStatus, RefLinkRow[]> = { ambiguous: [], 'schematic-only': [], 'board-only': [], alias: [], unique: [] };
  const pinBuckets: Record<PinStatus, PinLinkRow[]> = { ambiguous: [], 'net-differs': [], 'pin-missing-on-board': [], 'pin-missing-on-schematic': [], 'net-unknown': [], match: [] };
  const pinTotals: Record<PinStatus, number> = { ambiguous: 0, 'net-differs': 0, 'pin-missing-on-board': 0, 'pin-missing-on-schematic': 0, 'net-unknown': 0, match: 0 };
  const listMatches = options.includeMatches === true;
  interface NetAgg { name: string; id: string | null; same: number; alias: number; differs: number; unknown: number; schNets: Map<string, { documentId: string; netId: string; name: string; auto: boolean; pins: number }> }
  const netAgg = new Map<string, NetAgg>();
  /** Rows beyond the cap are never allocated: they would be cut anyway, the summary still counts them. */
  const room = (status: RefLinkStatus) => refBuckets[status].length < limits.refs;

  for (const target of order) {
    const parts = groups.get(target);
    const components = board.byRef.get(target) ?? [];
    if (!parts) {
      if (!components.length) continue;
      summary.refs.boardOnly++;
      if (!room('board-only')) continue;
      const caseSchematic = (schematic.refsByFold.get(fold(target)) ?? []).filter(key => key !== target);
      refBuckets['board-only'].push({
        status: 'board-only', ref: components[0].ref, boardComponentIds: capped(components.map(c => c.id), MAX_LIST), boardComponentsTotal: components.length, schematicRefs: [], schematicParts: [], schematicPartsTotal: 0,
        reasons: components.length > 1 ? ['several-board-parts', 'no-schematic-part'] : ['no-schematic-part'], caseInsensitive: { boardRefs: [], schematicRefs: capped(caseSchematic, MAX_LIST) },
      });
      continue;
    }
    const viaAlias = (part: SchPart) => aliases.refs.has(part.refKey);
    const aliased = aliases.refs.size ? parts.filter(viaAlias).length : 0;
    const reasons: RefReason[] = [];
    if (aliased) for (const part of parts) if (viaAlias(part) && part.refKey !== target && board.byRef.has(part.refKey)) { reasons.push('alias-overrides-exact-match'); break; }
    if (parts.some(part => part.dnp)) reasons.push('schematic-dnp');
    const describe = () => ({ schematicRefs: capped([...new Set(parts.map(part => part.ref))], MAX_LIST), schematicParts: capped(parts.slice(0, MAX_LIST).map(part => summarizePart(part, viaAlias(part) ? 'alias' : 'exact')), MAX_LIST), schematicPartsTotal: parts.length });

    if (!components.length) {
      summary.refs.schematicOnly++;
      if (!room('schematic-only')) continue;
      if (aliased) reasons.push('alias-target-missing');
      reasons.push('no-board-component');
      const caseBoard = (board.refsByFold.get(fold(target)) ?? []).filter(key => key !== target);
      refBuckets['schematic-only'].push({ status: 'schematic-only', ref: target, boardComponentIds: [], boardComponentsTotal: 0, ...describe(), reasons, caseInsensitive: { boardRefs: capped(caseBoard, MAX_LIST), schematicRefs: [] } });
      continue;
    }
    const ambiguity: RefReason[] = [];
    if (parts.length > 1) {
      const perRef = new Set<string>();
      for (const part of parts) { if (perRef.has(part.refKey)) { ambiguity.push('several-schematic-placements'); break; } perRef.add(part.refKey); }
    }
    if (components.length > 1) ambiguity.push('several-board-parts');
    if (parts.some(part => part.unannotated)) ambiguity.push('unannotated-schematic-reference');
    if (parts.some(part => part.duplicateAnnotation)) ambiguity.push('duplicate-annotation');
    const rowFor = (status: RefLinkStatus): RefLinkRow | null => room(status) ? {
      status, ref: components[0].ref, boardComponentIds: capped(components.map(c => c.id), MAX_LIST), boardComponentsTotal: components.length, ...describe(), reasons: [...ambiguity, ...reasons], caseInsensitive: { boardRefs: [], schematicRefs: [] },
    } : null;
    if (ambiguity.length) {
      summary.refs.ambiguous++;
      const row = rowFor('ambiguous');
      if (row) refBuckets.ambiguous.push(row);
      continue;
    }
    const status: RefLinkStatus = aliased ? 'alias' : 'unique';
    summary.refs[status]++;
    const row = rowFor(status);
    const counts: PinCounts = { match: 0, netDiffers: 0, missingOnBoard: 0, missingOnSchematic: 0, ambiguous: 0, unknown: 0 };
    if (row) { row.pins = counts; refBuckets[status].push(row); }

    const component = components[0];
    const boardPins = board.pinGroups.get(component.id) ?? EMPTY_PIN_GROUPS;
    const single = parts.length === 1 ? parts[0] : null;
    let several: Map<string, Array<{ part: SchPart; pin: SchPartPin }>> | undefined;
    let numbers: string[];
    if (single) numbers = mergeNumbers([...boardPins.keys()], [...single.pins.keys()]);
    else {
      several = new Map();
      for (const part of parts) for (const [number, pin] of part.pins) push(several, number, { part, pin });
      numbers = [...new Set<string>([...boardPins.keys(), ...several.keys()])].sort(naturalCompare);
    }
    for (const number of numbers) {
      const boardGroup = boardPins.get(number);
      let pin: SchPartPin | undefined, part: SchPart | undefined, count = 0;
      if (single) { pin = single.pins.get(number); if (pin) { part = single; count = 1; } }
      else { const found = several!.get(number); if (found) { count = found.length; pin = found[0].pin; part = found[0].part; } }
      const boardNet = boardGroup && boardGroup.nets.length === 1 ? boardGroup.nets[0] : '';
      let v: PinVerdict;
      if (boardGroup && !count) v = V.missingOnSchematic;
      else if (!boardGroup) v = V.missingOnBoard;
      else if (boardGroup.nets.length > 1) v = V.boardConflict;
      else if (count > 1) v = V.severalPins;
      else if (pin!.state === 'conflict') v = V.schematicConflict;
      else v = relateNets(boardNet, pin, aliases);
      summary.pins.compared++;
      pinTotals[v.status]++;
      switch (v.status) {
        case 'match': counts.match++; summary.pins.match++; break;
        case 'net-differs': counts.netDiffers++; summary.pins.netDiffers++; break;
        case 'pin-missing-on-board': counts.missingOnBoard++; summary.pins.pinMissingOnBoard++; break;
        case 'pin-missing-on-schematic': counts.missingOnSchematic++; summary.pins.pinMissingOnSchematic++; break;
        case 'ambiguous': counts.ambiguous++; summary.pins.ambiguous++; break;
        case 'net-unknown': counts.unknown++; summary.pins.netUnknown++; break;
      }
      if (v.status !== 'match' || listMatches) {
        const bucket = pinBuckets[v.status];
        if (bucket.length < limits.pins) {
          const net = count === 1 ? pin!.net : null;
          bucket.push({
            status: v.status, reason: v.reason, ref: component.ref, boardComponentId: component.id, schematicRef: (part ?? parts[0]).ref, pinNumber: number, boardPinIds: boardGroup ? capped(boardGroup.pins.map(p => p.id), MAX_LIST) : [], boardNet,
            schematic: count === 1 ? { partKey: part!.key, documentId: part!.documentId, netKey: net?.key ?? null, netId: net?.id ?? null, netName: net?.name ?? null, netAuto: net?.auto ?? false } : null, netRelation: v.relation,
          });
        }
      }
      if (boardNet && boardGroup && count === 1 && pin!.state !== 'conflict') {
        let agg = netAgg.get(boardNet);
        if (!agg) { agg = { name: boardGroup.pins.find(p => normalizeKey(p.net) === boardNet)?.net ?? boardNet, id: board.netByName.get(boardNet)?.[0]?.id ?? null, same: 0, alias: 0, differs: 0, unknown: 0, schNets: new Map() }; netAgg.set(boardNet, agg); }
        if (v.relation === 'same-name') agg.same++; else if (v.relation === 'alias-confirmed') agg.alias++; else if (v.relation === 'differs') agg.differs++; else agg.unknown++;
        const net = pin!.net;
        if (net) {
          const seen = agg.schNets.get(net.key);
          if (seen) seen.pins++; else agg.schNets.set(net.key, { documentId: net.documentId, netId: net.id, name: net.name, auto: net.auto, pins: 1 });
        }
      }
    }
  }

  const netRows: NetLinkRow[] = [];
  for (const agg of netAgg.values()) {
    const relation: NetRelation = agg.differs ? 'differs' : agg.alias ? 'alias-confirmed' : agg.same ? 'same-name' : 'unknown';
    summary.nets.compared++;
    if (relation === 'differs') summary.nets.differs++; else if (relation === 'alias-confirmed') summary.nets.aliasConfirmed++; else if (relation === 'same-name') summary.nets.sameName++; else summary.nets.unknown++;
    const schNets = [...agg.schNets.values()].sort((a, b) => b.pins - a.pins || naturalCompare(a.name, b.name) || naturalCompare(a.netId, b.netId));
    netRows.push({ boardNet: agg.name, boardNetId: agg.id, relation, comparedPins: agg.same + agg.alias + agg.differs + agg.unknown, pinsSameName: agg.same, pinsAliasConfirmed: agg.alias, pinsDiffer: agg.differs, pinsUnknown: agg.unknown, schematicNets: capped(schNets, 8), schematicNetsTotal: schNets.length });
  }
  netRows.sort((a, b) => NET_ORDER[a.relation] - NET_ORDER[b.relation] || naturalCompare(a.boardNet, b.boardNet));

  // Named schematic nets with no board net of that name and no confirmed alias: informational, never a link.
  const only = new Map<string, SchematicOnlyNetRow>();
  for (const net of schematic.nets) {
    if (net.auto || !net.nameKey || net.members.length === 0) continue;
    const names = [net.nameKey, ...net.aliasKeys];
    if (names.some(name => board.netByName.has(name) || (aliases.nets.has(name) && board.netByName.has(aliases.nets.get(name)!)))) continue;
    const row = only.get(net.documentId + SEP + net.nameKey);
    if (row) { row.netsTotal++; if (row.netIds.length < MAX_LIST) row.netIds.push(net.id); }
    else only.set(net.documentId + SEP + net.nameKey, { name: net.name, documentId: net.documentId, netIds: [net.id], netsTotal: 1 });
  }
  const onlyRows = [...only.values()].sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.documentId, b.documentId));
  summary.nets.schematicOnly = onlyRows.length;

  const issues: AliasIssue[] = [];
  for (const [from, to] of aliases.refs) {
    if (!schematic.partsByRef.has(from)) issues.push({ kind: 'ref', from, to, problem: 'source-missing' });
    else if (!board.byRef.has(to)) issues.push({ kind: 'ref', from, to, problem: 'target-missing' });
  }
  for (const [from, to] of aliases.nets) {
    if (!schematic.netsByAnyName.has(from)) issues.push({ kind: 'net', from, to, problem: 'source-missing' });
    else if (!board.netByName.has(to)) issues.push({ kind: 'net', from, to, problem: 'target-missing' });
  }
  issues.sort((a, b) => naturalCompare(a.kind, b.kind) || naturalCompare(a.from, b.from));

  const refRows: RefLinkRow[] = [];
  const refTotals: Record<RefLinkStatus, number> = { ambiguous: summary.refs.ambiguous, 'schematic-only': summary.refs.schematicOnly, 'board-only': summary.refs.boardOnly, alias: summary.refs.alias, unique: summary.refs.unique };
  let refTotal = 0;
  for (const status of Object.keys(REF_ORDER).sort((a, b) => REF_ORDER[a as RefLinkStatus] - REF_ORDER[b as RefLinkStatus]) as RefLinkStatus[]) {
    refTotal += refTotals[status];
    for (const row of refBuckets[status]) if (refRows.length < limits.refs) refRows.push(row);
  }
  const pinRows: PinLinkRow[] = [];
  let pinTotal = 0;
  for (const status of Object.keys(PIN_ORDER).sort((a, b) => PIN_ORDER[a as PinStatus] - PIN_ORDER[b as PinStatus]) as PinStatus[]) {
    if (status === 'match' && !listMatches) continue;
    pinTotal += pinTotals[status];
    for (const row of pinBuckets[status]) if (pinRows.length < limits.pins) pinRows.push(row);
  }
  summary.disagreements.refs = summary.refs.ambiguous + summary.refs.boardOnly + summary.refs.schematicOnly;
  summary.disagreements.pins = summary.pins.netDiffers + summary.pins.pinMissingOnBoard + summary.pins.pinMissingOnSchematic + summary.pins.ambiguous;
  summary.disagreements.nets = summary.nets.differs;
  summary.disagreements.total = summary.disagreements.refs + summary.disagreements.pins + summary.disagreements.nets;
  const list = <T>(rows: T[], limit: number): Listing<T> => ({ rows: capped(rows, limit), total: rows.length, truncated: rows.length > limit });
  return {
    version: 1, refs: { rows: refRows, total: refTotal, truncated: refTotal > refRows.length }, pins: { rows: pinRows, total: pinTotal, truncated: pinTotal > pinRows.length }, nets: list(netRows, limits.nets),
    schematicOnlyNets: list(onlyRows, limits.schematicOnly), aliasIssues: list(issues, limits.issues), summary,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Selection mapping (board <-> schematic)
// ---------------------------------------------------------------------------------------------------------------

export type MappingStatus = 'unique' | 'ambiguous' | 'missing';
export type MappingReason =
  | 'several-schematic-placements' | 'several-board-parts' | 'alias-merged-parts' | 'unannotated-schematic-reference' | 'duplicate-annotation' | 'schematic-pin-nets-conflict' | 'board-pin-nets-conflict'
  | 'no-schematic-part' | 'no-board-component' | 'pin-missing-on-schematic' | 'pin-missing-on-board' | 'unknown-component' | 'unknown-pin' | 'unknown-symbol' | 'virtual-symbol' | 'unknown-net' | 'several-schematic-nets' | 'several-board-nets' | 'no-schematic-net' | 'no-board-net';
/** `unique` = exactly one counterpart and no duplicate on either side; `ambiguous` = the UI must make the user choose; `missing` = nothing links. */
export interface Mapping<T> {
  status: MappingStatus;
  /** At most MAX_CANDIDATES, natural order; `total` is the exact count. */
  candidates: T[];
  total: number;
  truncated: boolean;
  /** Why the mapping is not `unique` (empty when it is). */
  reasons: MappingReason[];
  /** Same letters in another case: flagged, never counted in `status` (at most 16). */
  caseInsensitive: T[];
}
export const MAX_CANDIDATES = 64;
const nothing = <T>(reason: MappingReason): Mapping<T> => ({ status: 'missing', candidates: [], total: 0, truncated: false, reasons: [reason], caseInsensitive: [] });

export interface BoardSelection { componentId: string; pinId?: string }
export interface SchematicSelection { /** Optional when exactly one schematic document is indexed. */ documentId?: string; instancePath: string; symbolId: string; pinId?: string }
export interface SchematicPinTarget { number: string; name: string; placements: SchPinPlacement[]; netKey: string | null; netId: string | null; netName: string | null; netAuto: boolean; netConflict: boolean; noConnect: boolean }
export interface SchematicTarget {
  documentId: string;
  partKey: string;
  ref: string;
  via: 'exact' | 'alias' | 'case-insensitive';
  units: SchUnitPlacement[];
  sheets: Array<{ instancePath: string; defId: string; name: string; label: string; page: string }>;
  pin: SchematicPinTarget | null;
}
export interface BoardTarget { componentId: string; ref: string; side: BoardSide; via: 'exact' | 'alias' | 'case-insensitive'; pin: { number: string; pinIds: string[]; net: string; netConflict: boolean } | null }
export interface SchematicNetTarget { documentId: string; netKey: string; netId: string; name: string; auto: boolean; scope: SchNetEntry['scope']; scopePath?: string; memberCount: number; via: 'exact' | 'alias' | 'case-insensitive' }
export interface BoardNetTarget { name: string; id: string | null; pinCount: number; via: 'exact' | 'alias' | 'case-insensitive' }

function schematicTarget(part: SchPart, via: SchematicTarget['via'], number?: string): SchematicTarget {
  const pin = number === undefined ? undefined : part.pins.get(number);
  return {
    documentId: part.documentId, partKey: part.key, ref: part.ref, via, units: part.units.map(u => ({ ...u })),
    sheets: part.sheets.map(s => ({ instancePath: s.instancePath, defId: s.defId, name: s.name, label: s.label, page: s.page })),
    pin: pin ? { number: pin.number, name: pin.name, placements: capped(pin.placements, 64), netKey: pin.net?.key ?? null, netId: pin.net?.id ?? null, netName: pin.net?.name ?? null, netAuto: pin.net?.auto ?? false, netConflict: pin.state === 'conflict', noConnect: pin.noConnect } : null,
  };
}
const boardTarget = (component: BoardComponent, via: BoardTarget['via'], group?: BoardPinGroup): BoardTarget => ({
  componentId: component.id, ref: component.ref, side: component.side, via, pin: group ? { number: group.number, pinIds: group.pins.map(p => p.id), net: group.nets.length === 1 ? group.nets[0] : '', netConflict: group.nets.length > 1 } : null,
});
const schematicNetTarget = (net: SchNetEntry, via: SchematicNetTarget['via']): SchematicNetTarget => ({ documentId: net.documentId, netKey: net.key, netId: net.id, name: net.name, auto: net.auto, scope: net.scope, scopePath: net.scopePath, memberCount: net.members.length, via });

function finish<T>(candidates: T[], total: number, caseInsensitive: T[], reasons: MappingReason[], missing: MappingReason): Mapping<T> {
  const base = { candidates, total, truncated: total > candidates.length, caseInsensitive: capped(caseInsensitive, MAX_LIST) };
  return total === 0 ? { status: 'missing', reasons: reasons.length ? reasons : [missing], ...base } : { status: reasons.length ? 'ambiguous' : 'unique', reasons, ...base };
}

/** Schematic parts that correspond to a board reference key: exact ref (unless explicitly aliased away) plus refs aliased to it. */
function schematicPartsFor(schematic: SchematicIndex, aliases: CompiledAliases, boardKey: string): { parts: Array<{ part: SchPart; via: 'exact' | 'alias' }>; aliasedKeys: number } {
  const parts: Array<{ part: SchPart; via: 'exact' | 'alias' }> = [];
  if (!aliases.refs.has(boardKey)) for (const part of schematic.partsByRef.get(boardKey) ?? []) parts.push({ part, via: 'exact' });
  const reverse = aliases.refsReverse.get(boardKey) ?? [];
  for (const from of reverse) for (const part of schematic.partsByRef.get(from) ?? []) parts.push({ part, via: 'alias' });
  return { parts, aliasedKeys: reverse.length };
}

/** Board component (or one of its pins) → schematic placements, the pin identity and its net. */
export function mapBoardSelectionToSchematic(board: BoardIndex, schematic: SchematicIndex, selection: BoardSelection, aliasInput?: AliasInput): Mapping<SchematicTarget> {
  const aliases = toAliases(aliasInput);
  const component = board.componentById.get(selection.componentId);
  if (!component) return nothing('unknown-component');
  let number: string | undefined;
  if (selection.pinId !== undefined) {
    const pin = board.pinById.get(selection.pinId);
    if (!pin || pin.componentId !== component.id || !normalizeKey(pin.number)) return nothing('unknown-pin');
    number = normalizeKey(pin.number);
  }
  const key = normalizeKey(component.ref);
  const { parts, aliasedKeys } = schematicPartsFor(schematic, aliases, key);
  const caseInsensitive: SchematicTarget[] = [];
  if (!parts.length) {
    for (const other of schematic.refsByFold.get(fold(key)) ?? []) if (other !== key && !aliases.refs.has(other)) for (const part of schematic.partsByRef.get(other) ?? []) caseInsensitive.push(schematicTarget(part, 'case-insensitive', number));
    return { ...nothing('no-schematic-part'), caseInsensitive: capped(caseInsensitive, MAX_LIST) };
  }
  const matched = number === undefined ? parts : parts.filter(({ part }) => part.pins.has(number!));
  if (!matched.length) return nothing('pin-missing-on-schematic');
  const reasons: MappingReason[] = [];
  if ((board.byRef.get(key)?.length ?? 1) > 1) reasons.push('several-board-parts');
  const perRef = new Set<string>();
  let repeated = false;
  for (const { part } of parts) { if (perRef.has(part.refKey)) repeated = true; perRef.add(part.refKey); }
  if (repeated) reasons.push('several-schematic-placements');
  else if (matched.length > 1 && aliasedKeys) reasons.push('alias-merged-parts');
  if (parts.some(({ part }) => part.unannotated)) reasons.push('unannotated-schematic-reference');
  if (parts.some(({ part }) => part.duplicateAnnotation)) reasons.push('duplicate-annotation');
  if (number !== undefined && matched.some(({ part }) => part.pins.get(number!)!.state === 'conflict')) reasons.push('schematic-pin-nets-conflict');
  if (number !== undefined && (board.pinGroups.get(component.id)?.get(number)?.nets.length ?? 0) > 1) reasons.push('board-pin-nets-conflict');
  return finish(matched.slice(0, MAX_CANDIDATES).map(({ part, via }) => schematicTarget(part, via, number)), matched.length, [], reasons, 'no-schematic-part');
}

/** Schematic symbol (or one of its pins) → board component, pad(s) and board net. */
export function mapSchematicSelectionToBoard(board: BoardIndex, schematic: SchematicIndex, selection: SchematicSelection, aliasInput?: AliasInput): Mapping<BoardTarget> {
  const aliases = toAliases(aliasInput);
  const documentId = selection.documentId ?? (schematic.documents.length === 1 ? schematic.documents[0].documentId : undefined);
  if (documentId === undefined) return nothing('unknown-symbol');
  const qualified = documentId + SEP + symbolKey(selection.instancePath, selection.symbolId);
  const part = schematic.partBySymbol.get(qualified);
  if (!part) return nothing(schematic.virtualSymbols.has(qualified) ? 'virtual-symbol' : 'unknown-symbol');
  let number: string | undefined;
  if (selection.pinId !== undefined) {
    for (const pin of part.pins.values()) if (pin.placements.some(p => p.symbolId === selection.symbolId && p.instancePath === selection.instancePath && p.pinId === selection.pinId)) { number = pin.number; break; }
    if (number === undefined) return nothing('unknown-pin');
  }
  const alias = aliases.refs.get(part.refKey), target = alias ?? part.refKey, via: BoardTarget['via'] = alias !== undefined ? 'alias' : 'exact';
  const components = board.byRef.get(target) ?? [];
  const groupOf = (component: BoardComponent) => number === undefined ? undefined : board.pinGroups.get(component.id)?.get(number);
  if (!components.length) {
    const caseInsensitive: BoardTarget[] = [];
    for (const other of board.refsByFold.get(fold(target)) ?? []) if (other !== target) for (const component of board.byRef.get(other) ?? []) caseInsensitive.push(boardTarget(component, 'case-insensitive', groupOf(component)));
    return { ...nothing('no-board-component'), caseInsensitive: capped(caseInsensitive, MAX_LIST) };
  }
  const matched = number === undefined ? components : components.filter(component => groupOf(component));
  if (!matched.length) return nothing('pin-missing-on-board');
  const reasons: MappingReason[] = [];
  if (components.length > 1) reasons.push('several-board-parts');
  if ((schematic.partsByRef.get(part.refKey)?.length ?? 1) > 1) reasons.push('several-schematic-placements');
  if (part.unannotated) reasons.push('unannotated-schematic-reference');
  if (part.duplicateAnnotation) reasons.push('duplicate-annotation');
  if (number !== undefined && matched.some(component => groupOf(component)!.nets.length > 1)) reasons.push('board-pin-nets-conflict');
  if (number !== undefined && part.pins.get(number)?.state === 'conflict') reasons.push('schematic-pin-nets-conflict');
  return finish(matched.slice(0, MAX_CANDIDATES).map(component => boardTarget(component, via, groupOf(component))), matched.length, [], reasons, 'no-board-component');
}

/** Board net name → schematic nets: exact name (or merged alias name) and user-confirmed net aliases only. */
export function mapBoardNetToSchematic(board: BoardIndex, schematic: SchematicIndex, netName: string, aliasInput?: AliasInput): Mapping<SchematicNetTarget> {
  const aliases = toAliases(aliasInput);
  const key = normalizeKey(netName);
  if (!key || !board.netByName.has(key)) return nothing('unknown-net');
  const found = new Map<string, SchematicNetTarget>();
  for (const net of schematic.netsByAnyName.get(key) ?? []) found.set(net.key, schematicNetTarget(net, 'exact'));
  for (const from of aliases.netsReverse.get(key) ?? []) for (const net of schematic.netsByAnyName.get(from) ?? []) if (!found.has(net.key)) found.set(net.key, schematicNetTarget(net, 'alias'));
  const all = [...found.values()];
  const caseInsensitive: SchematicNetTarget[] = [];
  if (!all.length) for (const other of schematic.netsByFold.get(fold(key)) ?? []) if (other !== key) for (const net of schematic.netsByName.get(other) ?? []) caseInsensitive.push(schematicNetTarget(net, 'case-insensitive'));
  const reasons: MappingReason[] = [];
  if (all.length > 1) reasons.push('several-schematic-nets');
  if ((board.netByName.get(key)?.length ?? 1) > 1) reasons.push('several-board-nets');
  return finish(capped(all, MAX_CANDIDATES), all.length, caseInsensitive, reasons, 'no-schematic-net');
}

/** Schematic net → board nets: exact name (or merged alias name) and user-confirmed net aliases only. */
export function mapSchematicNetToBoard(board: BoardIndex, schematic: SchematicIndex, ref: { documentId?: string; netId: string }, aliasInput?: AliasInput): Mapping<BoardNetTarget> {
  const aliases = toAliases(aliasInput);
  const documentId = ref.documentId ?? (schematic.documents.length === 1 ? schematic.documents[0].documentId : undefined);
  const net = documentId === undefined ? undefined : schematic.netByKey.get(documentId + SEP + ref.netId);
  if (!net) return nothing('unknown-net');
  const found = new Map<string, BoardNetTarget>();
  const add = (entries: readonly BoardNetEntry[] | undefined, via: BoardNetTarget['via']) => { for (const entry of entries ?? []) { const id = entry.key + SEP + (entry.id ?? ''); if (!found.has(id)) found.set(id, { name: entry.name, id: entry.id, pinCount: entry.pins.length, via }); } };
  const names = [net.nameKey, ...net.aliasKeys];
  for (const name of names) add(board.netByName.get(name), 'exact');
  for (const name of names) { const to = aliases.nets.get(name); if (to !== undefined) add(board.netByName.get(to), 'alias'); }
  const all = [...found.values()].sort((a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.id ?? '', b.id ?? ''));
  const caseInsensitive: BoardNetTarget[] = [];
  if (!all.length) for (const name of names) for (const other of board.netsByFold.get(fold(name)) ?? []) if (other !== name) for (const entry of board.netByName.get(other) ?? []) caseInsensitive.push({ name: entry.name, id: entry.id, pinCount: entry.pins.length, via: 'case-insensitive' });
  return finish(capped(all, MAX_CANDIDATES), all.length, caseInsensitive, all.length > 1 ? ['several-board-nets'] : [], 'no-board-net');
}

// ---------------------------------------------------------------------------------------------------------------
// PDF text hits -> board
// ---------------------------------------------------------------------------------------------------------------

export type PdfLinkStatus = 'unique' | 'duplicate-hits' | 'ambiguous-board-ref' | 'missing';
export type PdfHitLiteral = 'exact' | 'case-differs' | 'unknown';
export interface PdfLinkHit extends Hit { literal: PdfHitLiteral }
export type PdfBoardTarget =
  | { kind: 'component'; componentId: string; ref: string; side: BoardSide; via: 'exact' | 'case-insensitive' }
  | { kind: 'net'; name: string; id: string | null; pinCount: number; via: 'exact' | 'case-insensitive' };
export interface PdfRefLink {
  documentId?: string;
  kind: RefCandidate['kind'];
  /** The candidate's own name as handed in. */
  name: string;
  /**
   * unique: one exact board target and one literal hit. duplicate-hits: the same name was found several times in the
   * PDF (explicit choice of the occurrence). ambiguous-board-ref: several board targets carry the exact name (explicit
   * choice of the part). missing: no exact board target, or no hit with the exact letters (only flagged alternates).
   */
  status: PdfLinkStatus;
  reasons: Array<'no-exact-board-target' | 'no-hits' | 'only-case-differing-hits' | 'duplicate-hits' | 'several-board-targets' | 'unverified-hit-text'>;
  /** Exact-name targets; several = explicit choice. */
  targets: PdfBoardTarget[];
  targetsTotal: number;
  /** Hits whose text has exactly the board's letters (or whose text could not be verified: `literal: 'unknown'`). */
  hits: PdfLinkHit[];
  hitsTotal: number;
  pages: number[];
  /** Hits that match only ignoring case: separate flagged candidates, never linked automatically. */
  caseInsensitiveHits: PdfLinkHit[];
  caseInsensitiveHitsTotal: number;
  /** Board refs / nets that equal the name only ignoring case (flagged, never linked). */
  caseInsensitiveTargets: PdfBoardTarget[];
  needsHitChoice: boolean;
  needsTargetChoice: boolean;
}
export interface PdfLinkReport {
  documentId?: string;
  links: PdfRefLink[];
  totalLinks: number;
  linksTruncated: boolean;
  /** The scan itself (session budget) was truncated: the links are exact but incomplete. */
  truncated: boolean;
  totalHits: number;
  counts: { unique: number; duplicateHits: number; ambiguousBoardRef: number; missing: number };
}
export interface PdfLinkOptions { documentId?: string; truncated?: boolean; totalHits?: number; maxLinks?: number; maxHitsPerLink?: number }
export const DEFAULT_PDF_LINK_LIMITS = Object.freeze({ maxLinks: 1000, maxHitsPerLink: 25 });

const edgePunctuation = /^[\s()[\]{}<>.,;:!?"'`*]+|[\s()[\]{}<>.,;:!?"'`*]+$/g;
const tokenPattern = /[^\s,;:()[\]{}<>"'|=]+/g;
const edgeKey = (value: string): string => value.normalize('NFKC').trim().replace(edgePunctuation, '').replace(/\s+/g, ' ');

/** Which letters the PDF text really has: the session matches uppercase, so a hit may be "r1" for the board's "R1". */
function hitLiteral(context: string, name: string): PdfHitLiteral {
  const exact = edgeKey(name), upper = exact.toUpperCase();
  let sawInsensitive = false;
  const visit = (token: string): boolean => {
    const key = edgeKey(token);
    if (key === exact) return true;
    if (key.toUpperCase() === upper) sawInsensitive = true;
    return false;
  };
  tokenPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(context)) !== null) {
    if (visit(match[0])) return 'exact';
    if (match[0].includes('/') && match[0].length > 1) for (const part of match[0].split('/')) if (part && visit(part)) return 'exact';
  }
  return sawInsensitive ? 'case-differs' : 'unknown';
}

/**
 * Links exact-token PDF candidates (src/lib/pdf/search.ts `extractRefCandidates` / `PdfSession.refCandidates`) to board
 * references and nets. Never links silently: duplicates (several hits, several board parts) are reported with their
 * status, case-only matches are separate flagged lists, partial names cannot occur (the candidate list is exact).
 * Accepts the candidate array or the whole `RefCandidateResult` (whose `truncated`/`totalHits` are passed through).
 */
export function resolvePdfRefHits(input: readonly RefCandidate[] | RefCandidateResult, board: BoardIndex, options: PdfLinkOptions = {}): PdfLinkReport {
  const candidates = Array.isArray(input) ? input as readonly RefCandidate[] : (input as RefCandidateResult).candidates;
  const result = Array.isArray(input) ? undefined : input as RefCandidateResult;
  const maxLinks = clampLimit(options.maxLinks, DEFAULT_PDF_LINK_LIMITS.maxLinks), maxHits = clampLimit(options.maxHitsPerLink, DEFAULT_PDF_LINK_LIMITS.maxHitsPerLink);
  const links: PdfRefLink[] = [];
  const counts = { unique: 0, duplicateHits: 0, ambiguousBoardRef: 0, missing: 0 };
  let totalHits = 0;
  for (const candidate of candidates) {
    totalHits += candidate.hits.length;
    const key = normalizeKey(candidate.name);
    const targets: PdfBoardTarget[] = [], alternates: PdfBoardTarget[] = [];
    if (candidate.kind === 'ref') {
      for (const component of board.byRef.get(key) ?? []) targets.push({ kind: 'component', componentId: component.id, ref: component.ref, side: component.side, via: 'exact' });
      for (const other of board.refsByFold.get(fold(key)) ?? []) if (other !== key) for (const component of board.byRef.get(other) ?? []) alternates.push({ kind: 'component', componentId: component.id, ref: component.ref, side: component.side, via: 'case-insensitive' });
    } else {
      for (const net of board.netByName.get(key) ?? []) targets.push({ kind: 'net', name: net.name, id: net.id, pinCount: net.pins.length, via: 'exact' });
      for (const other of board.netsByFold.get(fold(key)) ?? []) if (other !== key) for (const net of board.netByName.get(other) ?? []) alternates.push({ kind: 'net', name: net.name, id: net.id, pinCount: net.pins.length, via: 'case-insensitive' });
    }
    const exactHits: PdfLinkHit[] = [], otherHits: PdfLinkHit[] = [];
    let exactTotal = 0, otherTotal = 0, unverified = 0;
    const pages = new Set<number>();
    for (const hit of candidate.hits) {
      const literal = hitLiteral(hit.context, candidate.name);
      if (literal === 'case-differs') { otherTotal++; if (otherHits.length < maxHits) otherHits.push({ ...hit, literal }); continue; }
      exactTotal++; pages.add(hit.page);
      if (literal === 'unknown') unverified++;
      if (exactHits.length < maxHits) exactHits.push({ ...hit, literal });
    }
    const reasons: PdfRefLink['reasons'] = [];
    let status: PdfLinkStatus;
    if (!targets.length) { status = 'missing'; reasons.push('no-exact-board-target'); }
    else if (targets.length > 1) { status = 'ambiguous-board-ref'; reasons.push('several-board-targets'); if (exactTotal > 1) reasons.push('duplicate-hits'); }
    else if (exactTotal === 0) { status = 'missing'; reasons.push(otherTotal ? 'only-case-differing-hits' : 'no-hits'); }
    else if (exactTotal > 1) { status = 'duplicate-hits'; reasons.push('duplicate-hits'); }
    else status = 'unique';
    if (unverified) reasons.push('unverified-hit-text');
    if (status === 'unique') counts.unique++; else if (status === 'duplicate-hits') counts.duplicateHits++; else if (status === 'ambiguous-board-ref') counts.ambiguousBoardRef++; else counts.missing++;
    links.push({
      documentId: options.documentId, kind: candidate.kind, name: candidate.name, status, reasons, targets: capped(targets, MAX_LIST), targetsTotal: targets.length, hits: exactHits, hitsTotal: exactTotal,
      pages: [...pages].sort((a, b) => a - b).slice(0, 64), caseInsensitiveHits: otherHits, caseInsensitiveHitsTotal: otherTotal, caseInsensitiveTargets: capped(alternates, MAX_LIST),
      needsHitChoice: exactTotal > 1, needsTargetChoice: targets.length > 1,
    });
  }
  links.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'ref' ? -1 : 1) || naturalCompare(a.name, b.name));
  return {
    documentId: options.documentId, links: capped(links, maxLinks), totalLinks: links.length, linksTruncated: links.length > maxLinks, truncated: options.truncated ?? result?.truncated ?? false,
    totalHits: options.totalHits ?? result?.totalHits ?? totalHits, counts,
  };
}

/** Same as `resolvePdfRefHits` for several documents: one report per document, in the given order. */
export function resolvePdfDocuments(documents: ReadonlyArray<{ documentId: string; result: readonly RefCandidate[] | RefCandidateResult }>, board: BoardIndex, options: Omit<PdfLinkOptions, 'documentId' | 'truncated' | 'totalHits'> = {}): PdfLinkReport[] {
  return documents.map(({ documentId, result }) => resolvePdfRefHits(result, board, { ...options, documentId }));
}

// ---------------------------------------------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------------------------------------------

export type SearchSource = 'board-components' | 'board-nets' | 'schematic-symbols' | 'schematic-nets' | 'documents';
/** Ranking tiers, best first: literal equal (B18), equal ignoring case, literal prefix, prefix ignoring case, substring of the ref/name, other fields (value, package, ...), net of one of the part's pins. */
export type SearchTier = 'exact' | 'exact-insensitive' | 'prefix' | 'prefix-insensitive' | 'substring' | 'field' | 'pin-net';
export const SEARCH_TIERS: readonly SearchTier[] = ['exact', 'exact-insensitive', 'prefix', 'prefix-insensitive', 'substring', 'field', 'pin-net'];
export interface SearchMatch { tier: SearchTier; rank: number; field: 'ref' | 'value' | 'package' | 'fields' | 'net' | 'name' | 'alias'; /** true when only the letters' case differs from the query. */ caseInsensitive: boolean }
export interface BoardComponentRow { source: 'board-components'; componentId: string; ref: string; value: string; package: string; side: BoardSide; match: SearchMatch }
export interface BoardNetRow { source: 'board-nets'; name: string; id: string | null; pinCount: number; match: SearchMatch }
export interface SchematicSymbolRow { source: 'schematic-symbols'; documentId: string; partKey: string; ref: string; value: string; footprint: string; libId: string; instancePath: string; defId: string; symbolId: string; sheetName: string; sheetLabel: string; page: string; units: number[]; match: SearchMatch }
export interface SchematicNetRow { source: 'schematic-nets'; documentId: string; netKey: string; netId: string; name: string; auto: boolean; scope: SchNetEntry['scope']; scopePath?: string; sheetLabel?: string; page?: string; memberCount: number; match: SearchMatch }
export interface DocumentHitRow { source: 'documents'; documentId: string; documentName: string; page: number; itemIndex: number; x: number; y: number; width: number; height: number; context: string }
export type SearchRow = BoardComponentRow | BoardNetRow | SchematicSymbolRow | SchematicNetRow | DocumentHitRow;
export interface SearchGroup<R extends SearchRow = SearchRow> { source: SearchSource; rows: R[]; total: number; truncated: boolean }
/** Hits of one document for the query, as `PdfSession.find` returns them (the caller owns the PDF search; this function only groups and bounds). */
export interface DocumentSearchSource { documentId: string; name: string; hits: readonly Hit[]; /** Hits found when `hits` was cut by the session. */ total?: number; truncated?: boolean }
export interface SearchLimits { boardComponents: number; boardNets: number; schematicSymbols: number; schematicNets: number; documents: number; documentsPerDocument: number }
export const DEFAULT_SEARCH_LIMITS: Readonly<SearchLimits> = Object.freeze({ boardComponents: 300, boardNets: 100, schematicSymbols: 300, schematicNets: 100, documents: 200, documentsPerDocument: 50 });
export const MAX_QUERY_LENGTH = 256;
export interface SearchInput {
  query: string;
  board?: BoardIndex | null;
  schematic?: SchematicIndex | null;
  documents?: readonly DocumentSearchSource[];
  limits?: Partial<SearchLimits>;
}
export interface SearchResult {
  /** The normalized (NFKC, collapsed, trimmed, length-bounded) query actually searched. */
  query: string;
  groups: [SearchGroup<BoardComponentRow>, SearchGroup<BoardNetRow>, SearchGroup<SchematicSymbolRow>, SearchGroup<SchematicNetRow>, SearchGroup<DocumentHitRow>];
  total: number;
  truncated: boolean;
}

/** Tier of a ref/name against the query, or -1: literal equal, equal ignoring case, prefix, prefix ignoring case, substring. */
function nameTier(key: string, folded: string, q: string, qf: string): number {
  if (key === q) return 0;
  if (folded === qf) return 1;
  if (key.startsWith(q)) return 2;
  if (folded.startsWith(qf)) return 3;
  return folded.includes(qf) ? 4 : -1;
}
const matchOf = (tier: number, field: SearchMatch['field']): SearchMatch => ({ tier: SEARCH_TIERS[tier], rank: tier, field, caseInsensitive: tier === 1 || tier === 3 });

/** Collects indices per tier in the (already natural) iteration order, keeping at most `limit` per tier; `total` counts every match. */
class TierBuckets {
  readonly buckets: number[][] = SEARCH_TIERS.map(() => []);
  readonly fields: Map<number, SearchMatch['field']> = new Map();
  total = 0;
  constructor(readonly limit: number) {}
  add(tier: number, index: number, field?: SearchMatch['field']): void {
    this.total++;
    const bucket = this.buckets[tier];
    if (bucket.length < this.limit) { bucket.push(index); if (field) this.fields.set(index, field); }
  }
  select(): Array<{ index: number; tier: number }> {
    const picked: Array<{ index: number; tier: number }> = [];
    for (let tier = 0; tier < this.buckets.length && picked.length < this.limit; tier++) for (const index of this.buckets[tier]) { if (picked.length >= this.limit) break; picked.push({ index, tier }); }
    return picked;
  }
}
const makeGroup = <R extends SearchRow>(source: SearchSource, rows: R[], total: number): SearchGroup<R> => ({ source, rows, total, truncated: total > rows.length });

/**
 * One query over every source, grouped by source with page / sheet identity on each row. Ranking inside a group:
 * literal equal ref BEFORE case-insensitive equal (B18), then prefix, then substring, then value/package/net
 * (the legacy App search matched `ref value package` and the nets of the pins as substrings; nothing regresses),
 * stable natural order inside a tier. Pure and synchronous: callers run it on committed text only (never while an IME
 * composition is in progress). The query is NFKC-normalized with whitespace collapsed; an empty query yields no rows.
 */
export function searchAll(input: SearchInput): SearchResult {
  const query = normalizeQuery(input.query).slice(0, MAX_QUERY_LENGTH).trim();
  const qf = fold(query);
  const limits = {
    boardComponents: clampLimit(input.limits?.boardComponents, DEFAULT_SEARCH_LIMITS.boardComponents), boardNets: clampLimit(input.limits?.boardNets, DEFAULT_SEARCH_LIMITS.boardNets),
    schematicSymbols: clampLimit(input.limits?.schematicSymbols, DEFAULT_SEARCH_LIMITS.schematicSymbols), schematicNets: clampLimit(input.limits?.schematicNets, DEFAULT_SEARCH_LIMITS.schematicNets),
    documents: clampLimit(input.limits?.documents, DEFAULT_SEARCH_LIMITS.documents), documentsPerDocument: clampLimit(input.limits?.documentsPerDocument, DEFAULT_SEARCH_LIMITS.documentsPerDocument),
  };
  const empty = <R extends SearchRow>(source: SearchSource): SearchGroup<R> => makeGroup<R>(source, [], 0);
  if (!query) return { query, groups: [empty('board-components'), empty('board-nets'), empty('schematic-symbols'), empty('schematic-nets'), empty('documents')], total: 0, truncated: false };

  let boardComponents = empty<BoardComponentRow>('board-components'), boardNets = empty<BoardNetRow>('board-nets');
  const board = input.board;
  if (board) {
    const buckets = new TierBuckets(limits.boardComponents);
    for (let i = 0; i < board.components.length; i++) {
      const record = board.search[i];
      let tier = nameTier(record.key, record.folded, query, qf), field: SearchMatch['field'] = 'ref';
      if (tier < 0) {
        if (record.hay.includes(qf)) { tier = 5; field = record.value.includes(qf) ? 'value' : record.pkg.includes(qf) ? 'package' : 'fields'; }
        else if (record.nets.some(net => net.includes(qf))) { tier = 6; field = 'net'; }
        else continue;
      }
      buckets.add(tier, i, field);
    }
    boardComponents = makeGroup('board-components', buckets.select().map(({ index, tier }) => {
      const c = board.components[index];
      return { source: 'board-components' as const, componentId: c.id, ref: c.ref, value: c.value, package: c.package, side: c.side, match: matchOf(tier, buckets.fields.get(index) ?? 'ref') };
    }), buckets.total);
    const nets = new TierBuckets(limits.boardNets);
    for (let i = 0; i < board.nets.length; i++) {
      const tier = nameTier(board.nets[i].key, board.nets[i].folded, query, qf);
      if (tier >= 0) nets.add(tier, i);
    }
    boardNets = makeGroup('board-nets', nets.select().map(({ index, tier }) => { const n = board.nets[index]; return { source: 'board-nets' as const, name: n.name, id: n.id, pinCount: n.pins.length, match: matchOf(tier, 'name') }; }), nets.total);
  }

  let schematicSymbols = empty<SchematicSymbolRow>('schematic-symbols'), schematicNets = empty<SchematicNetRow>('schematic-nets');
  const schematic = input.schematic;
  if (schematic) {
    const buckets = new TierBuckets(limits.schematicSymbols);
    for (let i = 0; i < schematic.parts.length; i++) {
      const record = schematic.search[i];
      let tier = nameTier(record.key, record.folded, query, qf), field: SearchMatch['field'] = 'ref';
      if (tier < 0) {
        if (record.hay.includes(qf)) { tier = 5; field = record.value.includes(qf) ? 'value' : record.footprint.includes(qf) ? 'package' : 'fields'; }
        else continue;
      }
      buckets.add(tier, i, field);
    }
    schematicSymbols = makeGroup('schematic-symbols', buckets.select().map(({ index, tier }) => {
      const part = schematic.parts[index], sheet = part.sheets[0];
      return {
        source: 'schematic-symbols' as const, documentId: part.documentId, partKey: part.key, ref: part.ref, value: part.value, footprint: part.footprint, libId: part.libId, instancePath: part.units[0].instancePath, defId: part.units[0].defId,
        symbolId: part.units[0].symbolId, sheetName: sheet?.name ?? '', sheetLabel: sheet?.label ?? '', page: sheet?.page ?? '', units: part.units.map(u => u.unit), match: matchOf(tier, buckets.fields.get(index) ?? 'ref'),
      };
    }), buckets.total);
    const nets = new TierBuckets(limits.schematicNets);
    for (let i = 0; i < schematic.nets.length; i++) {
      const net = schematic.nets[i];
      let tier = nameTier(net.nameKey, net.folded, query, qf), field: SearchMatch['field'] = 'name';
      if (tier < 0 && net.aliasFolded.some(alias => alias.includes(qf))) { tier = 5; field = 'alias'; }
      if (tier >= 0) nets.add(tier, i, field);
    }
    schematicNets = makeGroup('schematic-nets', nets.select().map(({ index, tier }) => {
      const net = schematic.nets[index], sheet = net.scopePath === undefined ? undefined : schematic.sheets.get(net.documentId + SEP + net.scopePath);
      return { source: 'schematic-nets' as const, documentId: net.documentId, netKey: net.key, netId: net.id, name: net.name, auto: net.auto, scope: net.scope, scopePath: net.scopePath, sheetLabel: sheet?.label, page: sheet?.page, memberCount: net.members.length, match: matchOf(tier, nets.fields.get(index) ?? 'name') };
    }), nets.total);
  }

  const documentRows: DocumentHitRow[] = [];
  let documentTotal = 0, documentsTruncated = false;
  for (const document of input.documents ?? []) {
    documentTotal += Math.max(document.total ?? 0, document.hits.length);
    if (document.truncated || (document.total ?? 0) > document.hits.length) documentsTruncated = true;
    let sorted = document.hits;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].page < sorted[i - 1].page || (sorted[i].page === sorted[i - 1].page && sorted[i].itemIndex < sorted[i - 1].itemIndex)) { sorted = document.hits.slice().sort((a, b) => a.page - b.page || a.itemIndex - b.itemIndex || a.x - b.x || a.y - b.y); break; }
    }
    for (const hit of sorted.slice(0, limits.documentsPerDocument)) {
      if (documentRows.length < limits.documents) documentRows.push({ source: 'documents', documentId: document.documentId, documentName: document.name, page: hit.page, itemIndex: hit.itemIndex, x: hit.x, y: hit.y, width: hit.width, height: hit.height, context: hit.context });
    }
  }
  const documents = makeGroup('documents', documentRows, documentTotal);
  documents.truncated = documentsTruncated || documentTotal > documentRows.length;
  const groups: SearchResult['groups'] = [boardComponents, boardNets, schematicSymbols, schematicNets, documents];
  return { query, groups, total: groups.reduce((sum, g) => sum + g.total, 0), truncated: groups.some(g => g.truncated) };
}
