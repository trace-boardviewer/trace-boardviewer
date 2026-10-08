/**
 * Net graph: the connectivity of one board as compact arrays, shared by the net tools (Net fan, Net tree, Rail walk, Shared nets,
 * connection path, probe points, short suspects, drop locator).
 *
 * Built once per board in O(pins + parts + nets) (one pass over the pins, one over the parts), it answers in O(1) or O(answer):
 *  - which nets a part touches, and with how many of its pins (`partNets`);
 *  - which parts touch a net (`netParts`, every part once, in part order) and which pins (`netPins`, in pin order);
 *  - the class of a net (ground, power, no-connect, signal) from `net-class.ts`, decided once for the whole board, so the
 *    largest-net ground fallback sees every net;
 *  - the kind of a part (`part-kind.ts`) and its parsed value (`part-value.ts`, with the hint the kind gives), each computed the first
 *    time it is asked for and then kept: a walk over one rail never classifies the other 30,000 parts of a board;
 *  - whether a part is fitted: not when the caller lists it (`notFitted`: a do-not-populate attribute of the file, or a part the
 *    technician has lifted) or when its value carries a not-fitted marker (DNP, NC, ...).
 *
 * Indices are positions: a net is its index in `netNames`, a part its index in `board.components`, a pin its index in
 * `board.pins`. They are handles of this graph only, like the ids of the board model; nothing here is meant to be persisted.
 *
 * Nets are taken from the pins (`pin.net`), in the order of `board.nets` first and then in pin order for any name `board.nets`
 * lacks, so a board whose net list and pins disagree still gives one consistent graph. The empty name is "no net" (index -1).
 * A pin whose `componentId` names no component belongs to no part (it still counts on its net).
 *
 * Pure: no DOM, no I/O, deterministic for a given board and options.
 */
import type { Board, BoardComponent, BoardPin } from './types';
import { classifyNets, type NetClass, type NetClassOptions, type NetClassification, type NetKind } from './net-class';
import { classifyComponent, type PartKind, type PartKindResult } from './part-kind';
import { parsePartValue, type PartValue, type ValueHint } from './part-value';

export interface NetGraphOptions extends NetClassOptions {
  /** Schematic library id per component id, only for parts whose cross-probe found exactly one counterpart (rule 1 of part-kind). */
  libIds?: ReadonlyMap<string, string>;
  /**
   * Component ids of parts that are not on the board: a do-not-populate attribute of the file (KiCad `dnp`, EAGLE `DNP`), or parts
   * the technician has lifted. They count as not fitted like a DNP marker in the value text.
   */
  notFitted?: ReadonlySet<string>;
}

/** Why a part counts as not fitted: listed by the caller (an attribute or a lifted part) or a marker in its value text. */
export type NotFittedBasis = 'listed' | 'value';

/** The value hint each kind gives the value parser: what a unit-less value of that kind means. */
export function valueHintFor(kind: PartKind): ValueHint | null {
  switch (kind) {
    case 'resistor': case 'resistor-array': return 'resistance';
    case 'capacitor': return 'capacitance';
    case 'inductor': return 'inductance';
    default: return null;
  }
}

export interface NetGraph {
  readonly board: Board;
  readonly netCount: number;
  readonly partCount: number;
  readonly pinCount: number;
  /** Net names by net index. */
  readonly netNames: readonly string[];
  /** Net index of every pin, -1 for a pin without a net. */
  readonly pinNet: Int32Array;
  /** Part index of every pin, -1 for a pin whose component is missing. */
  readonly pinPart: Int32Array;
  /** Net classes of the whole board (ground, power, no-connect, signal). */
  readonly classification: NetClassification;
  netIndex(name: string): number;
  partIndex(componentId: string): number;
  pinIndex(pinId: string): number;
  netName(net: number): string;
  netClass(net: number): NetClass;
  netKind(net: number): NetKind;
  isGround(net: number): boolean;
  /** No-connect by name (NC, UNCONNECTED...); a pin without any net is index -1 and never reaches this. */
  isNoConnect(net: number): boolean;
  /** Pins on a net (pin indices, ascending). */
  netPins(net: number): Int32Array;
  netPinCount(net: number): number;
  /** Distinct parts on a net (part indices, ascending). */
  netParts(net: number): Int32Array;
  /** Distinct nets of a part (net indices, in the order its pins first reach them). */
  partNets(part: number): Int32Array;
  /** How many pins of the part sit on each net of `partNets(part)` (same order). */
  partNetPinCounts(part: number): Int32Array;
  /** Pin indices of a part (the order of its `pinIds`, unknown ids skipped). */
  partPins(part: number): Int32Array;
  component(part: number): BoardComponent;
  pin(pin: number): BoardPin;
  /** Part kind, classified the first time it is asked for. */
  kindOf(part: number): PartKindResult;
  /** Parsed value with the hint of the part's kind, parsed the first time it is asked for. */
  valueOf(part: number): PartValue;
  /** Whether the part is not fitted, and why: listed in `options.notFitted` first, then a marker in the value (DNP, NC, ...); null when fitted. */
  notFittedBy(part: number): NotFittedBasis | null;
}

const EMPTY = new Int32Array(0);

class Graph implements NetGraph {
  readonly netCount: number;
  readonly partCount: number;
  readonly pinCount: number;
  readonly classification: NetClassification;
  private readonly classes: NetClass[];
  private readonly kinds: Array<PartKindResult | undefined>;
  private readonly values: Array<PartValue | undefined>;

  constructor(
    readonly board: Board,
    readonly netNames: readonly string[],
    private readonly netByName: ReadonlyMap<string, number>,
    private readonly partById: ReadonlyMap<string, number>,
    private readonly pinById: ReadonlyMap<string, number>,
    readonly pinNet: Int32Array,
    readonly pinPart: Int32Array,
    private readonly netPinStart: Int32Array, private readonly netPinList: Int32Array,
    private readonly netPartStart: Int32Array, private readonly netPartList: Int32Array,
    private readonly partNetStart: Int32Array, private readonly partNetList: Int32Array, private readonly partNetCounts: Int32Array,
    private readonly partPinStart: Int32Array, private readonly partPinList: Int32Array,
    private readonly libIds: ReadonlyMap<string, string> | undefined,
    private readonly listedNotFitted: ReadonlySet<string> | undefined,
    options: NetClassOptions,
  ) {
    this.netCount = netNames.length;
    this.partCount = board.components.length;
    this.pinCount = board.pins.length;
    this.classification = classifyNets(netNames.map((name, net) => ({ name, pinCount: netPinStart[net + 1] - netPinStart[net] })), board.pins.length, options);
    this.classes = netNames.map(name => this.classification.classOf(name));
    this.kinds = new Array(this.partCount);
    this.values = new Array(this.partCount);
  }

  netIndex(name: string): number { return typeof name === 'string' && name !== '' ? this.netByName.get(name) ?? -1 : -1; }
  partIndex(componentId: string): number { return this.partById.get(componentId) ?? -1; }
  pinIndex(pinId: string): number { return this.pinById.get(pinId) ?? -1; }
  netName(net: number): string { return this.netNames[net] ?? ''; }
  netClass(net: number): NetClass { return this.classes[net]; }
  netKind(net: number): NetKind { return this.classes[net]?.kind ?? 'no-connect'; }
  isGround(net: number): boolean { return this.classes[net]?.kind === 'ground'; }
  isNoConnect(net: number): boolean { return net < 0 || this.classes[net]?.kind === 'no-connect'; }
  netPins(net: number): Int32Array { return net < 0 || net >= this.netCount ? EMPTY : this.netPinList.subarray(this.netPinStart[net], this.netPinStart[net + 1]); }
  netPinCount(net: number): number { return net < 0 || net >= this.netCount ? 0 : this.netPinStart[net + 1] - this.netPinStart[net]; }
  netParts(net: number): Int32Array { return net < 0 || net >= this.netCount ? EMPTY : this.netPartList.subarray(this.netPartStart[net], this.netPartStart[net + 1]); }
  partNets(part: number): Int32Array { return part < 0 || part >= this.partCount ? EMPTY : this.partNetList.subarray(this.partNetStart[part], this.partNetStart[part + 1]); }
  partNetPinCounts(part: number): Int32Array { return part < 0 || part >= this.partCount ? EMPTY : this.partNetCounts.subarray(this.partNetStart[part], this.partNetStart[part + 1]); }
  partPins(part: number): Int32Array { return part < 0 || part >= this.partCount ? EMPTY : this.partPinList.subarray(this.partPinStart[part], this.partPinStart[part + 1]); }
  component(part: number): BoardComponent { return this.board.components[part]; }
  pin(pin: number): BoardPin { return this.board.pins[pin]; }

  kindOf(part: number): PartKindResult {
    let kind = this.kinds[part];
    if (!kind) {
      const component = this.board.components[part];
      kind = classifyComponent(component, this.libIds?.get(component.id));
      this.kinds[part] = kind;
    }
    return kind;
  }

  notFittedBy(part: number): NotFittedBasis | null {
    if (part < 0 || part >= this.partCount) return null;
    if (this.listedNotFitted?.has(this.board.components[part].id)) return 'listed';
    return this.valueOf(part).notFitted ? 'value' : null;
  }

  valueOf(part: number): PartValue {
    let value = this.values[part];
    if (!value) {
      const text = this.board.components[part].value;
      value = parsePartValue(typeof text === 'string' ? text : '', valueHintFor(this.kindOf(part).kind));
      this.values[part] = value;
    }
    return value;
  }
}

/** Builds the net graph of a board in linear time. Options: ground patterns and fallback share (net-class) and unique schematic library ids. */
export function buildNetGraph(board: Board, options: NetGraphOptions = {}): NetGraph {
  const pins = board.pins, components = board.components;
  const pinCount = pins.length, partCount = components.length;

  const netByName = new Map<string, number>();
  const netNames: string[] = [];
  const addNet = (name: string): number => {
    let net = netByName.get(name);
    if (net === undefined) { net = netNames.length; netByName.set(name, net); netNames.push(name); }
    return net;
  };
  for (const net of board.nets) if (typeof net.name === 'string' && net.name !== '') addNet(net.name);

  const partById = new Map<string, number>();
  for (let part = 0; part < partCount; part++) if (!partById.has(components[part].id)) partById.set(components[part].id, part);
  const pinById = new Map<string, number>();
  const pinNet = new Int32Array(pinCount), pinPart = new Int32Array(pinCount);
  for (let index = 0; index < pinCount; index++) {
    const pin = pins[index];
    if (!pinById.has(pin.id)) pinById.set(pin.id, index);
    pinNet[index] = typeof pin.net === 'string' && pin.net !== '' ? addNet(pin.net) : -1;
    pinPart[index] = partById.get(pin.componentId) ?? -1;
  }
  const netCount = netNames.length;

  // Pins per net (CSR, ascending pin index).
  const netPinStart = new Int32Array(netCount + 1);
  for (let index = 0; index < pinCount; index++) if (pinNet[index] >= 0) netPinStart[pinNet[index] + 1]++;
  for (let net = 0; net < netCount; net++) netPinStart[net + 1] += netPinStart[net];
  const netPinList = new Int32Array(netPinStart[netCount]);
  const fill = netPinStart.slice(0, netCount);
  for (let index = 0; index < pinCount; index++) if (pinNet[index] >= 0) netPinList[fill[pinNet[index]]++] = index;

  // Pins per part: the component's own pin list, else the pins that point at it.
  const partPinStart = new Int32Array(partCount + 1);
  const partPinScratch: number[] = [];
  const claimed = new Uint8Array(pinCount);
  for (let part = 0; part < partCount; part++) {
    const ids = components[part].pinIds;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        const index = pinById.get(id);
        if (index !== undefined && pinPart[index] === part && !claimed[index]) { claimed[index] = 1; partPinScratch.push(index); }
      }
    }
    partPinStart[part + 1] = partPinScratch.length;
  }
  // Pins that name a part which does not list them are still that part's pins.
  let orphans = 0;
  for (let index = 0; index < pinCount; index++) if (!claimed[index] && pinPart[index] >= 0) orphans++;
  let partPinList: Int32Array;
  if (orphans === 0) partPinList = Int32Array.from(partPinScratch);
  else {
    const extra: number[][] = [];
    for (let index = 0; index < pinCount; index++) if (!claimed[index] && pinPart[index] >= 0) (extra[pinPart[index]] ??= []).push(index);
    const merged: number[] = [];
    const starts = new Int32Array(partCount + 1);
    for (let part = 0; part < partCount; part++) {
      for (let k = partPinStart[part]; k < partPinStart[part + 1]; k++) merged.push(partPinScratch[k]);
      const more = extra[part];
      if (more) for (const index of more) merged.push(index);
      starts[part + 1] = merged.length;
    }
    partPinStart.set(starts);
    partPinList = Int32Array.from(merged);
  }

  // Distinct nets per part, with the pin count on each (CSR, order of first appearance).
  const stamp = new Int32Array(netCount).fill(-1);
  const slot = new Int32Array(netCount);
  const partNetStart = new Int32Array(partCount + 1);
  const partNetScratch: number[] = [], partCountScratch: number[] = [];
  for (let part = 0; part < partCount; part++) {
    for (let k = partPinStart[part]; k < partPinStart[part + 1]; k++) {
      const net = pinNet[partPinList[k]];
      if (net < 0) continue;
      if (stamp[net] !== part) { stamp[net] = part; slot[net] = partNetScratch.length; partNetScratch.push(net); partCountScratch.push(1); }
      else partCountScratch[slot[net]]++;
    }
    partNetStart[part + 1] = partNetScratch.length;
  }
  const partNetList = Int32Array.from(partNetScratch), partNetCounts = Int32Array.from(partCountScratch);

  // Distinct parts per net (CSR, ascending part index): the transpose of partNets.
  const netPartStart = new Int32Array(netCount + 1);
  for (let k = 0; k < partNetList.length; k++) netPartStart[partNetList[k] + 1]++;
  for (let net = 0; net < netCount; net++) netPartStart[net + 1] += netPartStart[net];
  const netPartList = new Int32Array(netPartStart[netCount]);
  const partFill = netPartStart.slice(0, netCount);
  for (let part = 0; part < partCount; part++) {
    for (let k = partNetStart[part]; k < partNetStart[part + 1]; k++) netPartList[partFill[partNetList[k]]++] = part;
  }

  return new Graph(board, netNames, netByName, partById, pinById, pinNet, pinPart, netPinStart, netPinList, netPartStart, netPartList,
    partNetStart, partNetList, partNetCounts, partPinStart, partPinList, options.libIds, options.notFitted,
    { groundPatterns: options.groundPatterns, fallbackShare: options.fallbackShare });
}

/** Pad area in mm² from the pad geometry (rectangle w×h, round/ellipse π/4·w·h, radius πr²), or null when the file gives no size. */
export function padArea(pin: Pick<BoardPin, 'radius' | 'width' | 'height' | 'shape'>): number | null {
  const width = pin.width, height = pin.height;
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 && Number.isFinite(width * height)) {
    return pin.shape === 'round' ? (Math.PI / 4) * width * height : width * height;
  }
  if (typeof width === 'number' && width > 0 && Number.isFinite(width) && height === undefined) return pin.shape === 'round' ? (Math.PI / 4) * width * width : width * width;
  if (typeof pin.radius === 'number' && pin.radius > 0 && Number.isFinite(pin.radius)) return Math.PI * pin.radius * pin.radius;
  return null;
}

/** Upper-case alphanumeric words of a text (bounded): "C_0402_1005Metric" -> C, 0402, 1005METRIC. */
export function wordsOfText(text: string | undefined, limit = 160): string[] {
  if (typeof text !== 'string' || text === '') return [];
  const upper = (text.length > limit ? text.slice(0, limit) : text).toUpperCase();
  const words: string[] = [];
  let start = -1;
  for (let index = 0; index <= upper.length; index++) {
    const code = index < upper.length ? upper.charCodeAt(index) : 32;
    const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
    if (alnum) { if (start < 0) start = index; } else if (start >= 0) { words.push(upper.slice(start, index)); start = -1; }
  }
  return words;
}
