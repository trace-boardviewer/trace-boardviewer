/**
 * Rail walk: from one supply net, follow the rail through its series link parts (see rail-links.ts) for up to three hops and say
 * which nets belong to it, at which hop, through which part and why.
 *
 * Walk: breadth-first over nets; a hop is one link part. From a net at hop h < `hops`, every link part on it leads to its other net,
 * which joins at hop h + 1 unless it is
 *  - ground (any net of the ground set of net-class.ts): never entered, never expanded (also when the walk starts on it);
 *  - no-connect: never a link end (rail-links.ts);
 *  - larger than `maxNetPins` pins (default 2,000): not entered, which stops an unnamed ground or a huge plane from flooding the walk;
 *  - reached only through a `possible` link while `includePossible` is off (the default).
 * Every net is entered once (loops and parallel links are reported, never walked twice), so a walk costs O(pins and parts on the
 * walked nets), never more than one pass over the board.
 *
 * After the walk every link part that touches a walked net is listed once with a status:
 *  - `walked`: the part through which its far net was first reached (the walk tree);
 *  - `loop`: both nets were walked through other parts (a parallel link or a ring);
 *  - `possible`: a possible link whose far net was not walked;
 *  - `ground`, `large-net`: the far net was excluded for that reason (a 0 Ω part to ground is a ground bridge: shown, never crossed);
 *  - `beyond-hops`: the far net would be the next hop.
 * Parts that would be links but are marked not fitted are listed separately. Test points on each walked net are listed as leaf
 * markers (they end a branch; they never link two nets).
 *
 * Pure and deterministic: equal inputs give equal output, ordered by hop, then natural name order.
 */
import { naturalCompare } from './crossprobe';
import type { NetKind } from './net-class';
import type { NetGraph } from './net-graph';
import type { PartKind } from './part-kind';
import { partSize } from './part-size';
import { linkOf, normalizeLinkSettings, otherNet, type LinkCertainty, type LinkClass, type LinkCode, type LinkSettings, type NotFittedLink, type PartLink } from './rail-links';

export interface RailWalkOptions extends LinkSettings {
  /** Hops to walk, 0 to 3; default 2. */
  hops?: number;
  /** Walk possible links too (unknown values, small inductors, open jumpers, diodes when enabled); default false. */
  includePossible?: boolean;
  /** Nets with more pins than this are not entered; default 2,000. */
  maxNetPins?: number;
}

export const DEFAULT_HOPS = 2;
export const MAX_HOPS = 3;
export const DEFAULT_MAX_NET_PINS = 2000;

export interface NormalizedWalkOptions {
  readonly thresholdOhms: number;
  readonly diodes: boolean;
  readonly hops: number;
  readonly includePossible: boolean;
  readonly maxNetPins: number;
}

export function normalizeWalkOptions(options: RailWalkOptions = {}, defaultHops = DEFAULT_HOPS): NormalizedWalkOptions {
  const link = normalizeLinkSettings(options);
  const rawHops = options.hops;
  const hops = typeof rawHops === 'number' && Number.isFinite(rawHops) ? Math.min(MAX_HOPS, Math.max(0, Math.floor(rawHops))) : defaultHops;
  const rawCap = options.maxNetPins;
  const maxNetPins = typeof rawCap === 'number' && !Number.isNaN(rawCap) ? Math.max(1, Math.floor(rawCap)) : DEFAULT_MAX_NET_PINS;
  return { ...link, hops, includePossible: options.includePossible === true, maxNetPins };
}

export type RailLinkStatus = 'walked' | 'loop' | 'possible' | 'ground' | 'large-net' | 'beyond-hops';

/** Index-level walk result, shared with the other net tools. */
export interface WalkCore {
  readonly options: NormalizedWalkOptions;
  /** Walked nets in walk order. */
  readonly order: readonly number[];
  /** Hop of every walked net. */
  readonly hopOf: ReadonlyMap<number, number>;
  /** The link part through which each net was first reached (absent for the start nets). */
  readonly via: ReadonlyMap<number, PartLink>;
  /** Every link part touching a walked net, once, with its status and the walked end it is seen from. */
  readonly links: ReadonlyArray<{ readonly link: PartLink; readonly from: number; readonly to: number; readonly status: RailLinkStatus }>;
  readonly notFitted: readonly NotFittedLink[];
}

/** Walks from the given start nets (all at hop 0). Ground and no-connect start nets are kept at hop 0 and not expanded. */
export function walkFrom(graph: NetGraph, starts: readonly number[], options: NormalizedWalkOptions): WalkCore {
  const hopOf = new Map<number, number>();
  const via = new Map<number, PartLink>();
  const order: number[] = [];
  // Processing order never depends on the order of the file: nets of a level by name, and among links reaching the same new net
  // the one with the lowest reference wins.
  const byName = (a: number, b: number): number => { const x = graph.netName(a), y = graph.netName(b); return x < y ? -1 : x > y ? 1 : a - b; };
  const byRef = (a: PartLink, b: PartLink): number => {
    const x = graph.component(a.part), y = graph.component(b.part);
    return naturalCompare(x.ref, y.ref) || naturalCompare(x.id, y.id);
  };
  let level: number[] = [];
  for (const net of starts) if (net >= 0 && net < graph.netCount && !hopOf.has(net)) { hopOf.set(net, 0); level.push(net); }
  level.sort(byName);
  for (const net of level) order.push(net);
  const linkSettings = { thresholdOhms: options.thresholdOhms, diodes: options.diodes };
  const enterable = (link: PartLink, far: number): boolean =>
    far >= 0 && !graph.isGround(far) && !graph.isNoConnect(far) && graph.netPinCount(far) <= options.maxNetPins
    && (link.certainty === 'definite' || options.includePossible)
    && (!link.oneWay || link.nets[1] === far);
  for (let hop = 0; hop < options.hops && level.length; hop++) {
    const next: number[] = [];
    for (const net of level) {
      if (graph.isGround(net) || graph.isNoConnect(net)) continue;
      const claims = new Map<number, PartLink>();
      for (const part of graph.netParts(net)) {
        const result = linkOf(graph, part, linkSettings);
        if (!result || result.type !== 'link') continue;
        const far = otherNet(result, net);
        if (far < 0 || hopOf.has(far) || !enterable(result, far)) continue;
        const current = claims.get(far);
        if (!current || byRef(result, current) < 0) claims.set(far, result);
      }
      for (const [far, link] of claims) { hopOf.set(far, hop + 1); via.set(far, link); next.push(far); }
    }
    next.sort(byName);
    for (const net of next) order.push(net);
    level = next;
  }

  // Second pass: every link part touching a walked net, with the status the finished walk gives it.
  const seen = new Set<number>();
  const links: Array<{ link: PartLink; from: number; to: number; status: RailLinkStatus }> = [];
  const notFitted: NotFittedLink[] = [];
  for (const net of order) {
    if (graph.isGround(net) || graph.isNoConnect(net)) continue;
    for (const part of graph.netParts(net)) {
      if (seen.has(part)) continue;
      const result = linkOf(graph, part, linkSettings);
      if (!result) continue;
      if (result.type === 'not-fitted') {
        if (result.nets[0] === net || result.nets[1] === net) { seen.add(part); notFitted.push(result); }
        continue;
      }
      const far = otherNet(result, net);
      if (far < 0) continue;
      seen.add(part);
      const nearHop = hopOf.get(net)!, farHop = hopOf.get(far);
      let status: RailLinkStatus;
      let from = net, to = far;
      if (farHop !== undefined) {
        status = via.get(far)?.part === part || via.get(net)?.part === part ? 'walked' : 'loop';
        if (farHop < nearHop || (farHop === nearHop && byName(far, net) < 0)) { from = far; to = net; }
      } else if (graph.isGround(far)) status = 'ground';
      else if (result.certainty === 'possible' && !options.includePossible) status = 'possible';
      else if (result.oneWay && result.nets[1] !== far) status = 'possible';
      else if (graph.netPinCount(far) > options.maxNetPins) status = 'large-net';
      else status = 'beyond-hops';
      links.push({ link: result, from, to, status });
    }
  }
  return { options, order, hopOf, via, links, notFitted };
}

// ---------------------------------------------------------------------------------------------------------------
// Public result (names and ids)
// ---------------------------------------------------------------------------------------------------------------

export interface PartRef { readonly componentId: string; readonly ref: string }
export interface RailWalkNet {
  readonly net: string;
  readonly hop: number;
  readonly pinCount: number;
  readonly kind: NetKind;
  /** Voltage the net name suggests (a hint from the name, never a reading). */
  readonly expectedVolts: number | null;
  /** The link part and net it was first reached from; null for the start net. */
  readonly via: (PartRef & { readonly fromNet: string; readonly linkClass: LinkClass }) | null;
  /** Test points on this net: leaf markers, good places to measure the rail. */
  readonly testPoints: readonly PartRef[];
}
export interface RailWalkLink extends PartRef {
  readonly value: string;
  readonly linkClass: LinkClass;
  readonly certainty: LinkCertainty;
  readonly code: LinkCode;
  readonly reason: string;
  readonly ohms: number | null;
  readonly oneWay: boolean;
  /** The walked end (the one nearer the start) and the far end. */
  readonly from: string;
  readonly to: string;
  readonly fromHop: number;
  /** Hop of the far net, null when it was not walked. */
  readonly toHop: number | null;
  readonly status: RailLinkStatus;
}
export interface RailWalkResult {
  readonly start: string;
  readonly status: 'ok' | 'unknown-net' | 'ground' | 'no-connect';
  readonly options: NormalizedWalkOptions;
  readonly nets: readonly RailWalkNet[];
  /** Net names per hop, index = hop (0..hops). */
  readonly byHop: readonly (readonly string[])[];
  readonly links: readonly RailWalkLink[];
  readonly notFitted: ReadonlyArray<PartRef & { readonly value: string; readonly linkClass: LinkClass; readonly nets: readonly [string, string] }>;
  /** Distinct parts with a pin on a walked net. */
  readonly partCount: number;
}

const STATUS_ORDER: Record<RailLinkStatus, number> = { walked: 0, loop: 1, possible: 2, 'beyond-hops': 3, 'large-net': 4, ground: 5 };

/** Rail walk from the net called `netName`. */
export function railWalk(graph: NetGraph, netName: string, options: RailWalkOptions = {}): RailWalkResult {
  const normalized = normalizeWalkOptions(options);
  const start = graph.netIndex(netName);
  const empty = (status: RailWalkResult['status']): RailWalkResult => ({ start: netName, status, options: normalized, nets: [], byHop: [], links: [], notFitted: [], partCount: 0 });
  if (start < 0) return empty('unknown-net');
  const core = walkFrom(graph, [start], normalized);
  const status: RailWalkResult['status'] = graph.isGround(start) ? 'ground' : graph.isNoConnect(start) ? 'no-connect' : 'ok';
  return describeWalk(graph, netName, status, core);
}

export function describeWalk(graph: NetGraph, startName: string, status: RailWalkResult['status'], core: WalkCore): RailWalkResult {
  const ref = (part: number): PartRef => ({ componentId: graph.component(part).id, ref: graph.component(part).ref });
  const nets: RailWalkNet[] = core.order.map(net => {
    const link = core.via.get(net);
    const testPoints: PartRef[] = [];
    if (!graph.isGround(net)) for (const part of graph.netParts(net)) if (graph.kindOf(part).kind === 'testpoint') testPoints.push(ref(part));
    testPoints.sort((a, b) => naturalCompare(a.ref, b.ref));
    return {
      net: graph.netName(net), hop: core.hopOf.get(net)!, pinCount: graph.netPinCount(net), kind: graph.netKind(net),
      expectedVolts: graph.netClass(net).expectedVoltage?.volts ?? null,
      via: link ? { ...ref(link.part), fromNet: graph.netName(otherNet(link, net)), linkClass: link.linkClass } : null,
      testPoints,
    };
  });
  nets.sort((a, b) => a.hop - b.hop || naturalCompare(a.net, b.net));
  const byHop: string[][] = Array.from({ length: core.options.hops + 1 }, () => []);
  for (const net of nets) byHop[net.hop].push(net.net);
  const links: RailWalkLink[] = core.links.map(({ link, from, to, status }) => ({
    ...ref(link.part), value: graph.component(link.part).value ?? '', linkClass: link.linkClass, certainty: link.certainty, code: link.code, reason: link.reason,
    ohms: link.ohms, oneWay: link.oneWay, from: graph.netName(from), to: graph.netName(to), fromHop: core.hopOf.get(from)!, toHop: core.hopOf.get(to) ?? null, status,
  }));
  links.sort((a, b) => a.fromHop - b.fromHop || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || naturalCompare(a.ref, b.ref) || naturalCompare(a.componentId, b.componentId));
  const notFitted = core.notFitted.map(item => ({ ...ref(item.part), value: graph.component(item.part).value ?? '', linkClass: item.linkClass, nets: [graph.netName(item.nets[0]), graph.netName(item.nets[1])] as const }));
  notFitted.sort((a, b) => naturalCompare(a.ref, b.ref));
  const parts = new Set<number>();
  for (const net of core.order) if (!graph.isGround(net)) for (const part of graph.netParts(net)) parts.add(part);
  return { start: startName, status, options: core.options, nets, byHop, links, notFitted, partCount: parts.size };
}

// ---------------------------------------------------------------------------------------------------------------
// Fault-finding list of a rail
// ---------------------------------------------------------------------------------------------------------------

export interface RailPartRow extends PartRef {
  readonly kind: PartKind;
  readonly value: string;
  /** Imperial chip code when the package names one. */
  readonly sizeCode: string | null;
  /** Body area in mm² (from the chip code, else the outline). */
  readonly areaMm2: number | null;
  /** Lowest hop of the walked nets the part touches. */
  readonly hop: number;
  /** Walked nets the part touches. */
  readonly nets: readonly string[];
  /** Whether it also touches a ground net. */
  readonly toGround: boolean;
  /** The link class when the part is one of the rail's link parts. */
  readonly linkClass: LinkClass | null;
  /** Not on the board (DNP marker in the value, or listed as not populated): listed for completeness, it cannot be the fault. */
  readonly notFitted: boolean;
}

/** Kinds in the order a technician checks them on a shorted rail: capacitors first. */
export const FAULT_KIND_ORDER: readonly PartKind[] = ['capacitor', 'diode', 'transistor', 'ic', 'ferrite', 'inductor', 'fuse', 'jumper', 'resistor', 'resistor-array', 'led', 'crystal', 'connector', 'switch', 'testpoint', 'part', 'mechanical'];

/** Every part on the walked nets of a rail walk: capacitors first, then larger packages first, then natural reference order. */
export function railPartList(graph: NetGraph, core: WalkCore): RailPartRow[] {
  const rank = new Map(FAULT_KIND_ORDER.map((kind, index) => [kind, index] as const));
  const linkClassOf = new Map<number, LinkClass>();
  for (const { link } of core.links) linkClassOf.set(link.part, link.linkClass);
  const rows = new Map<number, { hop: number; nets: number[] }>();
  for (const net of core.order) {
    if (graph.isGround(net)) continue;
    const hop = core.hopOf.get(net)!;
    for (const part of graph.netParts(net)) {
      const row = rows.get(part);
      if (row) { row.nets.push(net); if (hop < row.hop) row.hop = hop; } else rows.set(part, { hop, nets: [net] });
    }
  }
  const result: RailPartRow[] = [];
  for (const [part, row] of rows) {
    const component = graph.component(part);
    const size = partSize(component);
    let toGround = false;
    for (const net of graph.partNets(part)) if (graph.isGround(net)) { toGround = true; break; }
    result.push({
      componentId: component.id, ref: component.ref, kind: graph.kindOf(part).kind, value: component.value ?? '', sizeCode: size?.code ?? null,
      areaMm2: size ? size.areaMm2 : null, hop: row.hop, nets: row.nets.map(net => graph.netName(net)), toGround, linkClass: linkClassOf.get(part) ?? null,
      notFitted: graph.notFittedBy(part) !== null,
    });
  }
  result.sort((a, b) => (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99) || (b.areaMm2 ?? -1) - (a.areaMm2 ?? -1) || naturalCompare(a.ref, b.ref) || naturalCompare(a.componentId, b.componentId));
  return result;
}
