/**
 * Shared nets: the nets that two or more chosen parts have in common.
 *
 * For a set of parts (up to 64, duplicates and unknown ids reported, not guessed) it lists
 *  - `common`: nets every chosen part touches;
 *  - `pairwise`: nets at least two (but not all) of them touch;
 *  - `matrix`: for each pair of parts, how many listed nets they share.
 * Each row names the pins (numbers) each part has on that net. Ground nets are left out by default and counted in `hiddenGround`
 * (a set of parts nearly always shares ground, which says nothing); no-connect nets are always left out.
 *
 * Cost: O(sum of the chosen parts' pins + rows), independent of the board size. Ordering: rows shared by more parts first, then the
 * natural order of net names.
 */
import { naturalCompare } from './crossprobe';
import type { NetKind } from './net-class';
import type { NetGraph } from './net-graph';

export const MAX_SHARED_PARTS = 64;

export interface SharedNetsOptions {
  /** List ground nets as well; default false. */
  includeGround?: boolean;
}

export interface SharedNetMember {
  readonly componentId: string;
  readonly ref: string;
  /** Pin numbers of this part on the net, natural order. */
  readonly pins: readonly string[];
}
export interface SharedNetRow {
  readonly net: string;
  readonly kind: NetKind;
  readonly members: readonly SharedNetMember[];
}
export interface SharedNetsResult {
  /** The chosen parts that exist, in the order given (duplicates removed). */
  readonly parts: ReadonlyArray<{ readonly componentId: string; readonly ref: string }>;
  /** Ids that name no part of the board. */
  readonly unknown: readonly string[];
  /** More ids than MAX_SHARED_PARTS were given; the rest were ignored. */
  readonly truncated: boolean;
  readonly common: readonly SharedNetRow[];
  readonly pairwise: readonly SharedNetRow[];
  /** Ground nets shared by at least two of the parts and left out (empty when `includeGround`). */
  readonly hiddenGround: readonly string[];
  /** matrix[i][j]: listed nets shared by parts i and j (common plus pairwise); the diagonal is each part's listed net count. */
  readonly matrix: readonly (readonly number[])[];
}

export function sharedNets(graph: NetGraph, componentIds: readonly string[], options: SharedNetsOptions = {}): SharedNetsResult {
  const parts: number[] = [];
  const unknown: string[] = [];
  const seen = new Set<number>();
  const seenUnknown = new Set<string>();
  let truncated = false;
  for (const id of componentIds) {
    const part = graph.partIndex(id);
    if (part < 0) { if (!seenUnknown.has(id)) { seenUnknown.add(id); unknown.push(id); } continue; }
    if (seen.has(part)) continue;
    if (parts.length >= MAX_SHARED_PARTS) { truncated = true; continue; }
    seen.add(part); parts.push(part);
  }
  // net -> bit set of parts (as a list of member positions).
  const members = new Map<number, number[]>();
  parts.forEach((part, position) => {
    for (const net of graph.partNets(part)) {
      if (graph.isNoConnect(net)) continue;
      const list = members.get(net);
      if (list) list.push(position); else members.set(net, [position]);
    }
  });
  const pinsOn = (part: number, net: number): string[] => {
    const numbers: string[] = [];
    for (const pin of graph.partPins(part)) if (graph.pinNet[pin] === net) numbers.push(graph.pin(pin).number);
    return [...new Set(numbers)].sort(naturalCompare);
  };
  const common: SharedNetRow[] = [], pairwise: SharedNetRow[] = [], hiddenGround: string[] = [];
  const size = parts.length;
  const matrix: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const [net, positions] of members) {
    if (graph.isGround(net) && !options.includeGround) { if (positions.length >= 2) hiddenGround.push(graph.netName(net)); continue; }
    for (const a of positions) for (const b of positions) matrix[a][b]++;
    if (positions.length < 2) continue;
    const row: SharedNetRow = {
      net: graph.netName(net), kind: graph.netKind(net),
      members: positions.map(position => ({ componentId: graph.component(parts[position]).id, ref: graph.component(parts[position]).ref, pins: pinsOn(parts[position], net) })),
    };
    (positions.length === size ? common : pairwise).push(row);
  }
  const byShare = (a: SharedNetRow, b: SharedNetRow) => b.members.length - a.members.length || naturalCompare(a.net, b.net);
  common.sort(byShare); pairwise.sort(byShare); hiddenGround.sort(naturalCompare);
  return {
    parts: parts.map(part => ({ componentId: graph.component(part).id, ref: graph.component(part).ref })), unknown, truncated,
    common: size >= 2 ? common : [], pairwise, hiddenGround, matrix,
  };
}
