/**
 * Connection path: how one part reaches another ("how does J1 feed U7?").
 *
 * 1. Nets both parts touch are a direct connection (ground and no-connect nets do not count).
 * 2. Otherwise a breadth-first search over nets, where one step crosses one link part (rail-links.ts: 0 Ω and jumpers, fuses,
 *    ferrites, inductors, low-ohm and shunt resistors; possible links only with `includePossible`), finds the path with the fewest
 *    parts. With `anyPassive` (opt-in) any resistor, capacitor, inductor, ferrite, fuse or jumper joining exactly two nets may be
 *    crossed as well, whatever its value. Ground and no-connect nets are never crossed; nets with more than `maxNetPins` pins are
 *    not crossed (they may still be the first or last net). One-way links are crossed only anode to cathode. The search stops at
 *    `maxLinks` parts (default 16).
 * Among paths of equal length the first in net and part order wins, so the answer is deterministic. Cost: at most one pass over the
 * board's nets and parts, each part classified once per settings (cached).
 */
import { naturalCompare } from './crossprobe';
import type { NetGraph } from './net-graph';
import { linkOf, normalizeLinkSettings, otherNet, type LinkCertainty, type LinkClass, type LinkSettings } from './rail-links';
import { DEFAULT_MAX_NET_PINS } from './rail-walk';
import type { PartKind } from './part-kind';

export interface ConnectionPathOptions extends LinkSettings {
  includePossible?: boolean;
  /** Also cross any two-net resistor, capacitor, inductor, ferrite, fuse or jumper; default false. */
  anyPassive?: boolean;
  /** Nets with more pins than this are not crossed; default 2,000. */
  maxNetPins?: number;
  /** Longest path searched, in parts; default 16 (Infinity: no limit; the search still visits each net once). */
  maxLinks?: number;
}

export const DEFAULT_MAX_LINKS = 16;
const PASSIVE_KINDS: ReadonlySet<PartKind> = new Set(['resistor', 'capacitor', 'inductor', 'ferrite', 'fuse', 'jumper']);

export interface PathPart {
  readonly componentId: string;
  readonly ref: string;
  readonly value: string;
  /** Link class, or 'passive' for a part crossed only because of `anyPassive`. */
  readonly linkClass: LinkClass | 'passive';
  readonly certainty: LinkCertainty | 'opt-in';
}
export interface PathStep {
  readonly net: string;
  /** The part that leads from this net to the next step; null on the last step. */
  readonly next: PathPart | null;
}
export interface ConnectionPathResult {
  readonly from: string;
  readonly to: string;
  readonly status: 'direct' | 'path' | 'none' | 'unknown-part' | 'same-part';
  /** Nets both parts touch (ground and no-connect left out), natural order. */
  readonly shared: readonly string[];
  /** Shortest path: the first net is one of `from`'s, the last one of `to`'s. Empty when there is none. */
  readonly steps: readonly PathStep[];
  /** Parts crossed. */
  readonly links: number;
}

interface Edge { part: number; far: number; linkClass: LinkClass | 'passive'; certainty: LinkCertainty | 'opt-in' }

export function connectionPath(graph: NetGraph, fromId: string, toId: string, options: ConnectionPathOptions = {}): ConnectionPathResult {
  const from = graph.partIndex(fromId), to = graph.partIndex(toId);
  const result = (status: ConnectionPathResult['status'], shared: string[] = [], steps: PathStep[] = []): ConnectionPathResult =>
    ({ from: fromId, to: toId, status, shared, steps, links: Math.max(0, steps.length - 1) });
  if (from < 0 || to < 0) return result('unknown-part');
  if (from === to) return result('same-part');
  const usable = (net: number) => net >= 0 && !graph.isGround(net) && !graph.isNoConnect(net);
  const startNets = [...graph.partNets(from)].filter(usable).sort((a, b) => a - b);
  const targetNets = new Set([...graph.partNets(to)].filter(usable));
  const shared = startNets.filter(net => targetNets.has(net)).map(net => graph.netName(net)).sort(naturalCompare);
  if (shared.length) return result('direct', shared, [{ net: shared[0], next: null }]);

  const settings = normalizeLinkSettings(options);
  const includePossible = options.includePossible === true, anyPassive = options.anyPassive === true;
  const maxNetPins = typeof options.maxNetPins === 'number' && !Number.isNaN(options.maxNetPins) ? Math.max(1, Math.floor(options.maxNetPins)) : DEFAULT_MAX_NET_PINS;
  const maxLinks = typeof options.maxLinks === 'number' && !Number.isNaN(options.maxLinks) ? Math.max(1, Math.floor(options.maxLinks)) : DEFAULT_MAX_LINKS;

  const edgeFrom = (part: number, net: number): Edge | null => {
    const link = linkOf(graph, part, settings);
    if (link && link.type === 'link' && (link.certainty === 'definite' || includePossible)) {
      const far = otherNet(link, net);
      if (far >= 0 && (!link.oneWay || link.nets[0] === net)) return { part, far, linkClass: link.linkClass, certainty: link.certainty };
    }
    if (!anyPassive || !PASSIVE_KINDS.has(graph.kindOf(part).kind)) return null;
    const nets = [...graph.partNets(part)].filter(n => !graph.isNoConnect(n));
    if (nets.length !== 2 || graph.notFittedBy(part) !== null) return null;
    const far = nets[0] === net ? nets[1] : nets[1] === net ? nets[0] : -1;
    return far >= 0 ? { part, far, linkClass: 'passive', certainty: 'opt-in' } : null;
  };

  // Per reached net: its depth, the part it was reached through and the net before it (numbers only: no object per net).
  const depth = new Map<number, number>();
  const viaPart = new Map<number, number>();
  const viaNet = new Map<number, number>();
  const queue: number[] = [];
  for (const net of startNets) { depth.set(net, 0); queue.push(net); }
  let found = -1;
  for (let head = 0; head < queue.length && found < 0; head++) {
    const net = queue[head], d = depth.get(net)!;
    if (d >= maxLinks) continue;
    for (const part of graph.netParts(net)) {
      if (part === from || part === to) continue;
      const edge = edgeFrom(part, net);
      if (!edge || !usable(edge.far) || depth.has(edge.far)) continue;
      const isTarget = targetNets.has(edge.far);
      if (!isTarget && graph.netPinCount(edge.far) > maxNetPins) continue;
      depth.set(edge.far, d + 1); viaPart.set(edge.far, part); viaNet.set(edge.far, net);
      if (isTarget) { found = edge.far; break; }
      queue.push(edge.far);
    }
  }
  if (found < 0) return result('none');
  // Walk back from the target, then turn the list around (unshift would make a long path quadratic).
  const steps: PathStep[] = [{ net: graph.netName(found), next: null }];
  for (let net = found; viaPart.has(net);) {
    const part = viaPart.get(net)!, before = viaNet.get(net)!;
    const edge = edgeFrom(part, before)!; // the same edge the search crossed
    const component = graph.component(part);
    steps.push({ net: graph.netName(before), next: { componentId: component.id, ref: component.ref, value: component.value ?? '', linkClass: edge.linkClass, certainty: edge.certainty } });
    net = before;
  }
  steps.reverse();
  return result('path', [], steps);
}

export const MAX_PATH_PARTS = 8;

/** Connection paths between every pair of up to eight parts (first given first). */
export function connectionPaths(graph: NetGraph, componentIds: readonly string[], options: ConnectionPathOptions = {}): ConnectionPathResult[] {
  const ids = [...new Set(componentIds)].slice(0, MAX_PATH_PARTS);
  const results: ConnectionPathResult[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) results.push(connectionPath(graph, ids[i], ids[j], options));
  return results;
}
