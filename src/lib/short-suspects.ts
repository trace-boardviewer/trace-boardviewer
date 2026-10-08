/**
 * Short suspects: for one or more rails that read low resistance to ground, which parts to check first, where to cut the rail in
 * two, and what several shorted rails have in common.
 *
 * Evidence only: every suspect is a part of the board that has a pin on the shorted rail, every score is the sum of listed reasons,
 * and the weights are a stated heuristic (common failure patterns in board repair), never a measurement. Nothing is invented: a
 * part that is not in the file cannot appear, and a reason that the file cannot support (no value, no package) is simply absent.
 *
 * 1. Domain. Each rail is walked with the Rail walk (default 3 hops, definite links only): everything joined to it through 0 Ω
 *    parts, jumpers, fuses, ferrites, inductors and low-ohm resistors is the same DC node, so the short can sit anywhere on it.
 *    Ground nets are never entered and never accepted as a shorted rail.
 * 2. Suspects: every part with a pin on the domain, except the domain's own link parts (they are isolation points), test points,
 *    mechanical parts and parts that are not fitted (counted in `notFitted`). Weights (reason codes in brackets):
 *      capacitor between the rail and ground            40 [capacitor-to-ground]
 *        package 0805 or larger / 1206 or larger        +10 / +15 [large-package]   (large MLCCs crack and short)
 *        10 µF or more / 1 µF or more                   +10 / +5 [bulk-capacitance]
 *        tantalum or polymer (package or value says so) +15 [tantalum]
 *        rated voltage at least 80 % of the rail's      +10 [low-rating-margin] (rating from the value, rail from the name)
 *      TVS / ESD protection diode to ground             35 [tvs-to-ground]; other diode to ground 20 [diode-to-ground]
 *      transistor with a pin on ground                  30 [transistor-to-ground]
 *      IC with a pin on ground                          25 [ic-to-ground]; 4 or more pins on the rail +5 [major-load]
 *      connector with a ground pin                      10 [connector-to-ground]
 *      a link part (<= threshold) from the rail to ground  45 [ground-link]
 *        (a fitted 0 Ω strap or jumper to ground is a short, by design or by mistake)
 *      resistor to ground above the threshold           5 [resistor-to-ground]; any other part to ground 10 [other-to-ground]
 *      no pin on ground                                 3 [no-ground-pin]
 *      measured resistance (optional): below 1 Ω, capacitors, diodes and transistors +10 [hard-short]; 10 Ω or more, ICs +10 and
 *        capacitors -5 [soft-short] (a dead short is rarely an IC; tens of ohms rarely a capacitor)
 *      on two or more shorted rails                     +30 per extra rail [common-element]
 *    Flags: `easy-to-miss` for 0402 and smaller (too small to see when checking with freeze spray or IPA).
 *    When the board has no ground net at all, the kind weights apply as if every part reached ground and that is said.
 * 3. Isolation points: link parts inside the domain whose removal splits it in two (bridges of the domain's link graph, found with
 *    Tarjan's algorithm). Each lists the suspects on each side; they are ordered by how evenly they split the suspects (bisection
 *    order: lift the part, measure both pads to ground, and the side that still reads low holds the short). Parallel links
 *    (removing one does not split the domain) are listed after them. The first 50 are returned with their sides, all are counted.
 * 4. Common elements of several rails: rails whose domains overlap (joined through link parts), and parts with pins on two or more
 *    rails (a shared regulator, load, connector or a capacitor between rails).
 * 5. Decoupling groups: each capacitor suspect is assigned to the nearest IC suspect within `groupRadiusMm` (default 6 mm),
 *    "14 capacitors around U1": where on the board the candidates crowd.
 *
 * Cost: one rail walk per rail plus O(pins of the domain); the bridge search is linear in the domain size, the decoupling groups
 * use a grid, and nothing compares every suspect with every other.
 */
import { naturalCompare } from './crossprobe';
import type { NetGraph } from './net-graph';
import { wordsOfText } from './net-graph';
import type { PartKind } from './part-kind';
import { isTinyChip, partSize, type PackageSize } from './part-size';
import { parsePartValue } from './part-value';
import type { LinkCertainty, LinkClass, LinkSettings, PartLink } from './rail-links';
import { normalizeWalkOptions, walkFrom, type WalkCore } from './rail-walk';

export interface ShortedRail {
  readonly net: string;
  /** Measured resistance to ground in ohm, when known. */
  readonly resistanceOhms?: number;
}

export interface ShortSuspectOptions extends LinkSettings {
  /** Rail walk hops for the domain; default 3. */
  hops?: number;
  includePossible?: boolean;
  maxNetPins?: number;
  /** Suspects returned; default 100 (the total is always reported). */
  limit?: number;
  /** Radius of the decoupling groups in mm; default 6. */
  groupRadiusMm?: number;
}

export type SuspectReasonCode =
  | 'capacitor-to-ground' | 'large-package' | 'bulk-capacitance' | 'tantalum' | 'low-rating-margin' | 'tvs-to-ground' | 'diode-to-ground'
  | 'transistor-to-ground' | 'ic-to-ground' | 'major-load' | 'connector-to-ground' | 'ground-link' | 'resistor-to-ground' | 'other-to-ground'
  | 'no-ground-pin' | 'ground-unknown' | 'hard-short' | 'soft-short' | 'common-element' | 'sub-rail';

export interface SuspectReason {
  readonly code: SuspectReasonCode;
  readonly weight: number;
  readonly detail: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface Suspect {
  readonly componentId: string;
  readonly ref: string;
  readonly kind: PartKind;
  readonly value: string;
  readonly package: string;
  readonly sizeCode: string | null;
  readonly side: string;
  readonly score: number;
  /** 1 = check first. */
  readonly rank: number;
  /** Shorted rails (as given) whose domain the part touches. */
  readonly rails: readonly string[];
  /** Domain nets the part touches. */
  readonly nets: readonly string[];
  /** Lowest hop of those nets (0: on a shorted rail itself). */
  readonly hop: number;
  readonly toGround: boolean;
  readonly flags: ReadonlyArray<'easy-to-miss' | 'common-element'>;
  readonly reasons: readonly SuspectReason[];
}

export interface IsolationSide {
  /** Domain nets on this side (at most 24 names; `netCount` is exact). */
  readonly nets: readonly string[];
  readonly netCount: number;
  /** Suspects that reach ground on this side. */
  readonly suspects: number;
  /** Pin numbers of the isolation part on this side's net. */
  readonly pins: readonly string[];
}
export interface IsolationPoint {
  readonly componentId: string;
  readonly ref: string;
  readonly value: string;
  readonly linkClass: LinkClass;
  readonly certainty: LinkCertainty;
  readonly action: 'lift-and-measure';
  /** False for a parallel link: lifting it alone does not split the rail. */
  readonly splits: boolean;
  readonly sides: readonly [IsolationSide, IsolationSide];
  /** min(side suspects) / all suspects of that domain part, 0 to 0.5: 0.5 is a perfect halving. */
  readonly balance: number;
}

export interface RailReport {
  readonly net: string;
  readonly status: 'ok' | 'unknown-net' | 'ground' | 'no-connect';
  /** Voltage the net name suggests (a hint, never a reading). */
  readonly expectedVolts: number | null;
  readonly resistanceOhms: number | null;
  /** Nets of this rail's domain with their hop. */
  readonly domain: ReadonlyArray<{ readonly net: string; readonly hop: number }>;
}

export interface CommonElements {
  /** Rails whose domains overlap: they are one DC node through link parts. */
  readonly joined: ReadonlyArray<{ readonly rails: readonly [string, string]; readonly nets: readonly string[] }>;
  /** Parts with pins on the domains of two or more rails. */
  readonly sharedParts: ReadonlyArray<{ readonly componentId: string; readonly ref: string; readonly kind: PartKind; readonly value: string; readonly rails: readonly string[]; readonly score: number | null }>;
}

export interface DecouplingGroup {
  readonly anchor: { readonly componentId: string; readonly ref: string };
  readonly capacitors: readonly string[];
  readonly count: number;
}

export interface ShortSuspectReport {
  readonly rails: readonly RailReport[];
  readonly suspects: readonly Suspect[];
  /** All suspects before the limit. */
  readonly total: number;
  /** Parts on the domain left out because they are not fitted (DNP marker or listed as not populated). */
  readonly notFitted: number;
  readonly isolation: readonly IsolationPoint[];
  /** Link parts from the domain straight to ground (also scored as suspects). */
  readonly groundLinks: ReadonlyArray<{ readonly componentId: string; readonly ref: string; readonly value: string; readonly linkClass: LinkClass; readonly net: string }>;
  /** Present when two or more rails were walked. */
  readonly common: CommonElements | null;
  readonly groups: readonly DecouplingGroup[];
  /** Possible links that were not walked: the domain may be larger than shown. */
  readonly possibleLinks: number;
  /** Definite links leading past the last hop: the domain goes on beyond them (walk more hops to include it). */
  readonly beyondHops: number;
  /** Isolation points found; `isolation` holds the first MAX_ISOLATION_POINTS of them. */
  readonly isolationTotal: number;
  readonly groundKnown: boolean;
}

/** Kinds in the order a tie between equal scores is broken. */
const SUSPECT_KIND_ORDER: readonly PartKind[] = ['capacitor', 'diode', 'transistor', 'ic', 'connector'];
const TVS_WORDS = /^(?:TVS|ESD|SMAJ\w*|SMBJ\w*|SMCJ\w*|SMF\w*|PESD\w*|ESDA\w*|TPD\d\w*|SP0\d\w*|PRTR\w*|USBLC\w*|RCLAMP\w*|SRV05\w*|CDSOT\w*|ZENER)$/;
const TVS_PREFIX = /^(?:TVS|ESD|ZD|DZ|VR|VD)\d/i;
const TANTALUM_WORDS = /^(?:TANT\w*|TANTALUM|POLYMER|POSCAP|OSCON|CP|SPCAP|TPS[A-Z]?|TAJ\w*|T491\w*|T520\w*)$/;

/** A rated voltage written in the value text ("10uF 6.3V", "C_4u7_0402_10V"), or null. */
export function ratedVolts(value: string): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const text = value.length > 160 ? value.slice(0, 160) : value;
  let found: number | null = null;
  for (const token of text.split(/[\s_,/;()[\]]+/)) {
    if (token === '' || !/[vV]$/.test(token)) continue;
    const parsed = parsePartValue(token);
    if (parsed.quantity === 'voltage' && parsed.si !== null && parsed.si > 0) found = Math.max(found ?? 0, parsed.si);
  }
  return found;
}

interface Domain { rail: number; railName: string; resistanceOhms: number | null; core: WalkCore }

export function findShortSuspects(graph: NetGraph, rails: ReadonlyArray<string | ShortedRail>, options: ShortSuspectOptions = {}): ShortSuspectReport {
  const walkOptions = normalizeWalkOptions(options, 3);
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 100;
  const radius = typeof options.groupRadiusMm === 'number' && Number.isFinite(options.groupRadiusMm) && options.groupRadiusMm > 0 ? options.groupRadiusMm : 6;
  const groundKnown = graph.classification.groundNets.length > 0;

  // 1. Domains.
  const reports: RailReport[] = [];
  const domains: Domain[] = [];
  const seenRails = new Set<number>();
  let minResistance: number | null = null;
  for (const entry of rails) {
    const name = typeof entry === 'string' ? entry : entry?.net;
    const ohms = typeof entry === 'object' && entry && typeof entry.resistanceOhms === 'number' && Number.isFinite(entry.resistanceOhms) && entry.resistanceOhms >= 0 ? entry.resistanceOhms : null;
    const net = graph.netIndex(String(name ?? ''));
    const base = { net: String(name ?? ''), expectedVolts: net >= 0 ? graph.netClass(net).expectedVoltage?.volts ?? null : null, resistanceOhms: ohms };
    if (net < 0) { reports.push({ ...base, status: 'unknown-net', domain: [] }); continue; }
    if (graph.isGround(net)) { reports.push({ ...base, status: 'ground', domain: [] }); continue; }
    if (graph.isNoConnect(net)) { reports.push({ ...base, status: 'no-connect', domain: [] }); continue; }
    if (seenRails.has(net)) continue;
    seenRails.add(net);
    const core = walkFrom(graph, [net], walkOptions);
    domains.push({ rail: net, railName: graph.netName(net), resistanceOhms: ohms, core });
    if (ohms !== null) minResistance = minResistance === null ? ohms : Math.min(minResistance, ohms);
    reports.push({ ...base, status: 'ok', domain: core.order.map(n => ({ net: graph.netName(n), hop: core.hopOf.get(n)! })) });
  }

  // Domain nets: hop (lowest over rails) and the rails reaching them.
  const netHop = new Map<number, number>();
  const netRails = new Map<number, Set<number>>();
  const domainLinks = new Map<number, PartLink>();
  const groundLinkParts = new Map<number, { link: PartLink; net: number }>();
  let possibleLinks = 0, beyondHops = 0;
  domains.forEach((domain, index) => {
    for (const net of domain.core.order) {
      const hop = domain.core.hopOf.get(net)!;
      netHop.set(net, Math.min(netHop.get(net) ?? Infinity, hop));
      let set = netRails.get(net);
      if (!set) { set = new Set(); netRails.set(net, set); }
      set.add(index);
    }
    for (const { link, from, status } of domain.core.links) {
      if (status === 'walked' || status === 'loop') domainLinks.set(link.part, link);
      else if (status === 'ground') groundLinkParts.set(link.part, { link, net: from });
      else if (status === 'possible') possibleLinks++;
      else if (status === 'beyond-hops') beyondHops++;
    }
  });

  // 2. Suspects.
  const kindRank = (kind: PartKind): number => { const rank = SUSPECT_KIND_ORDER.indexOf(kind); return rank < 0 ? SUSPECT_KIND_ORDER.length : rank; };
  interface Draft {
    part: number; kind: PartKind; size: PackageSize | null; nets: number[]; rails: Set<number>; hop: number; toGround: boolean; score: number;
    reasons: SuspectReason[]; flags: Set<'easy-to-miss' | 'common-element'>;
  }
  const drafts = new Map<number, Draft>();
  const notFittedParts = new Set<number>();
  for (const [net, hop] of netHop) {
    for (const part of graph.netParts(net)) {
      if (domainLinks.has(part)) continue;
      let draft = drafts.get(part);
      if (!draft) {
        const kind = graph.kindOf(part).kind;
        if (kind === 'testpoint' || kind === 'mechanical' || graph.partPins(part).length < 2) continue;
        if (graph.notFittedBy(part) !== null) { notFittedParts.add(part); continue; } // not on the board: it cannot short
        draft = { part, kind, size: partSize(graph.component(part)), nets: [], rails: new Set(), hop, toGround: false, score: 0, reasons: [], flags: new Set() };
        drafts.set(part, draft);
      }
      draft.nets.push(net);
      if (hop < draft.hop) draft.hop = hop;
      for (const rail of netRails.get(net)!) draft.rails.add(rail);
    }
  }
  const railName = (index: number) => domains[index].railName;
  for (const draft of drafts.values()) {
    const part = draft.part, kind = draft.kind, size = draft.size;
    const component = graph.component(part);
    let groundPins = 0, railPins = 0;
    const pins = graph.partPins(part);
    for (const pin of pins) {
      const net = graph.pinNet[pin];
      if (net < 0) continue;
      if (graph.isGround(net)) groundPins++;
      else if (netHop.has(net)) railPins++;
    }
    draft.toGround = groundPins > 0;
    const reaches = draft.toGround || !groundKnown;
    const add = (code: SuspectReasonCode, weight: number, detail: string, params?: Record<string, string | number>) => {
      draft.reasons.push(params ? { code, weight, detail, params } : { code, weight, detail });
      draft.score += weight;
    };
    const firstNet = graph.netName(draft.nets[0]);
    const where = groundKnown ? `between ${firstNet} and ground` : `on ${firstNet} (no ground net known)`;
    const words = kind === 'capacitor' || kind === 'diode' ? [...wordsOfText(component.package), ...wordsOfText(component.value)] : [];
    const groundLink = groundLinkParts.get(part);
    if (groundLink) {
      add('ground-link', 45, `${groundLink.link.linkClass} part (${component.value || 'no value'}) ties ${graph.netName(groundLink.net)} to ground`, { net: graph.netName(groundLink.net), linkClass: groundLink.link.linkClass });
    } else if (!reaches) {
      add('no-ground-pin', 3, `no pin on ground; touches ${draft.nets.map(n => graph.netName(n)).join(', ')}`);
    } else {
      switch (kind) {
        case 'capacitor': {
          add('capacitor-to-ground', 40, `capacitor ${where}`, { net: firstNet });
          if (size && size.basis !== 'outline') {
            if (size.areaMm2 >= 3.2 * 1.6 - 1e-9) add('large-package', 15, `${size.code ?? 'large'} package: large ceramic capacitors crack and short more often`, { size: size.code ?? '' });
            else if (size.areaMm2 >= 2.0 * 1.25 - 1e-9) add('large-package', 10, `${size.code ?? 'large'} package: large ceramic capacitors crack and short more often`, { size: size.code ?? '' });
          }
          const value = graph.valueOf(part);
          if (value.quantity === 'capacitance' && value.si !== null) {
            if (value.si >= 10e-6 - 1e-12) add('bulk-capacitance', 10, `${component.value}: bulk capacitance`, { value: component.value });
            else if (value.si >= 1e-6 - 1e-12) add('bulk-capacitance', 5, `${component.value}: 1 µF or more`, { value: component.value });
          }
          if (words.some(word => TANTALUM_WORDS.test(word))) add('tantalum', 15, 'tantalum or polymer capacitor (these fail short)');
          const rated = ratedVolts(component.value ?? '');
          const railVolts = maxRailVolts(graph, draft.nets);
          if (rated !== null && railVolts !== null && railVolts >= 0.8 * rated) add('low-rating-margin', 10, `rated ${rated} V on a ${railVolts} V rail`, { rated, rail: railVolts });
          break;
        }
        case 'diode': case 'led': {
          const tvs = kind === 'diode' && (TVS_PREFIX.test(component.ref) || words.some(word => TVS_WORDS.test(word)));
          if (tvs) add('tvs-to-ground', 35, `protection diode ${where}`, { net: firstNet });
          else add('diode-to-ground', 20, `${kind} ${where}`, { net: firstNet });
          break;
        }
        case 'transistor': add('transistor-to-ground', 30, `transistor ${where}`, { net: firstNet }); break;
        case 'ic':
          add('ic-to-ground', 25, `IC ${where}`, { net: firstNet });
          if (railPins >= 4) add('major-load', 5, `${railPins} pins on the rail: a major load`, { pins: railPins });
          break;
        case 'connector': add('connector-to-ground', 10, `connector ${where}: a plugged device or a damaged connector`, { net: firstNet }); break;
        case 'resistor': case 'resistor-array': add('resistor-to-ground', 5, `${kind} ${where}`, { net: firstNet }); break;
        default: add('other-to-ground', 10, `${kind} ${where}`, { net: firstNet });
      }
      if (!groundKnown) add('ground-unknown', 0, 'the board has no ground net, so every part is treated as reaching ground');
    }
    const ohms = draft.rails.size ? minOf([...draft.rails].map(rail => domains[rail].resistanceOhms)) : null;
    const reading = ohms ?? minResistance;
    if (reading !== null && reaches && !groundLink) {
      if (reading < 1 && (kind === 'capacitor' || kind === 'diode' || kind === 'transistor')) add('hard-short', 10, `${reading} Ω reads like a dead short`, { ohms: reading });
      else if (reading >= 10 && kind === 'ic') add('soft-short', 10, `${reading} Ω is more like a load or a leaky IC`, { ohms: reading });
      else if (reading >= 10 && kind === 'capacitor') add('soft-short', -5, `${reading} Ω is rarely a shorted capacitor`, { ohms: reading });
    }
    if (draft.rails.size >= 2) {
      draft.flags.add('common-element');
      add('common-element', 30 * (draft.rails.size - 1), `on ${draft.rails.size} shorted rails: ${[...draft.rails].map(railName).join(', ')}`, { rails: draft.rails.size });
    }
    if (draft.hop > 0) add('sub-rail', 0, `on ${graph.netName(draft.nets[0])}, ${draft.hop} link${draft.hop > 1 ? 's' : ''} from the shorted rail`, { hop: draft.hop });
    if (isTinyChip(size)) draft.flags.add('easy-to-miss');
  }
  const byEvidence = (a: Draft, b: Draft) => b.score - a.score || kindRank(a.kind) - kindRank(b.kind) || (b.size?.areaMm2 ?? -1) - (a.size?.areaMm2 ?? -1);
  const ordered = sortTop([...drafts.values()], byEvidence, (a, b) => naturalCompare(graph.component(a.part).ref, graph.component(b.part).ref) || a.part - b.part, limit);
  const suspects: Suspect[] = ordered.slice(0, limit).map((draft, index) => {
    const component = graph.component(draft.part);
    return {
      componentId: component.id, ref: component.ref, kind: draft.kind, value: component.value ?? '', package: component.package ?? '',
      sizeCode: draft.size?.code ?? null, side: component.side, score: draft.score, rank: index + 1, rails: [...draft.rails].sort((a, b) => a - b).map(railName),
      nets: draft.nets.map(net => graph.netName(net)), hop: draft.hop, toGround: draft.toGround, flags: [...draft.flags].sort(), reasons: draft.reasons,
    };
  });

  // 3. Isolation points.
  const suspectsByNet = new Map<number, number>();
  for (const draft of drafts.values()) {
    if (!(draft.toGround || !groundKnown)) continue;
    let primary = draft.nets[0];
    for (const net of draft.nets) if ((netHop.get(net) ?? 0) < (netHop.get(primary) ?? 0) || ((netHop.get(net) ?? 0) === (netHop.get(primary) ?? 0) && net < primary)) primary = net;
    suspectsByNet.set(primary, (suspectsByNet.get(primary) ?? 0) + 1);
  }
  const { points: isolation, total: isolationTotal } = isolationPoints(graph, [...netHop.keys()], [...domainLinks.values()], suspectsByNet);

  // 4. Common elements.
  let common: CommonElements | null = null;
  if (domains.length >= 2) {
    const joined: Array<{ rails: readonly [string, string]; nets: string[] }> = [];
    for (let i = 0; i < domains.length; i++) for (let j = i + 1; j < domains.length; j++) {
      const nets: string[] = [];
      for (const net of domains[i].core.order) if (domains[j].core.hopOf.has(net)) nets.push(graph.netName(net));
      if (nets.length) joined.push({ rails: [domains[i].railName, domains[j].railName], nets: nets.sort(naturalCompare) });
    }
    const partRails = new Map<number, Set<number>>();
    domains.forEach((domain, index) => {
      for (const net of domain.core.order) for (const part of graph.netParts(net)) {
        let set = partRails.get(part);
        if (!set) { set = new Set(); partRails.set(part, set); }
        set.add(index);
      }
    });
    const sharedParts = [...partRails].filter(([, set]) => set.size >= 2).map(([part, set]) => {
      const component = graph.component(part);
      return { componentId: component.id, ref: component.ref, kind: graph.kindOf(part).kind, value: component.value ?? '', rails: [...set].sort((a, b) => a - b).map(railName), score: drafts.get(part)?.score ?? null };
    });
    sharedParts.sort((a, b) => b.rails.length - a.rails.length || (b.score ?? -1) - (a.score ?? -1) || naturalCompare(a.ref, b.ref) || naturalCompare(a.componentId, b.componentId));
    common = { joined, sharedParts };
  }

  // 5. Decoupling groups.
  const groups = decouplingGroups(graph, [...drafts.values()].filter(d => d.toGround || !groundKnown), radius);

  const groundLinks = [...groundLinkParts.values()].map(({ link, net }) => ({ componentId: graph.component(link.part).id, ref: graph.component(link.part).ref, value: graph.component(link.part).value ?? '', linkClass: link.linkClass, net: graph.netName(net) }))
    .sort((a, b) => naturalCompare(a.ref, b.ref));
  return { rails: reports, suspects, total: drafts.size, notFitted: notFittedParts.size, isolation, isolationTotal, groundLinks, common, groups, possibleLinks, beyondHops, groundKnown };
}

/**
 * The first `limit` items in the order (primary, then tie), the rest after them in primary order only. The tie order (natural
 * reference order, the costly part on a rail of thousands of equal capacitors) is applied only to the items that can reach the
 * first `limit` places: those before the limit and every item tied on `primary` with the last of them.
 */
function sortTop<T>(items: T[], primary: (a: T, b: T) => number, tie: (a: T, b: T) => number, limit: number): T[] {
  items.sort(primary);
  if (items.length <= 1 || limit <= 0) return items;
  let end = Math.min(limit, items.length);
  const last = items[end - 1];
  while (end < items.length && primary(items[end], last) === 0) end++;
  const head = items.slice(0, end).sort((a, b) => primary(a, b) || tie(a, b));
  for (let index = 0; index < end; index++) items[index] = head[index];
  return items;
}

function minOf(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) if (value !== null && (best === null || value < best)) best = value;
  return best;
}

function maxRailVolts(graph: NetGraph, nets: readonly number[]): number | null {
  let best: number | null = null;
  for (const net of nets) {
    const volts = graph.netClass(net).expectedVoltage?.volts;
    if (typeof volts === 'number' && (best === null || Math.abs(volts) > best)) best = Math.abs(volts);
  }
  return best;
}

const LINK_ORDER: Record<LinkClass, number> = { fuse: 0, jumper: 1, ferrite: 2, inductor: 3, shunt: 4, 'low-ohm': 5, diode: 6 };
const MAX_SIDE_NETS = 24;
/** Isolation points returned (in bisection order); `isolationTotal` counts all. */
export const MAX_ISOLATION_POINTS = 50;

/**
 * Bridges of the domain's link multigraph, each with the suspects on its two sides; parallel links after them. Splits and balances
 * come from the DFS subtree weights in O(1) per link; the net lists of the two sides are built only for the points returned, so the
 * cost is O(nets + links) plus O(nets) per returned point.
 */
function isolationPoints(graph: NetGraph, nets: readonly number[], links: readonly PartLink[], suspectsByNet: ReadonlyMap<number, number>): { points: IsolationPoint[]; total: number } {
  const local = new Map<number, number>();
  const sortedNets = [...nets].sort((a, b) => a - b);
  sortedNets.forEach((net, index) => local.set(net, index));
  const n = sortedNets.length;
  const usable = links.filter(link => local.has(link.nets[0]) && local.has(link.nets[1]) && link.nets[0] !== link.nets[1]).sort((a, b) => a.part - b.part);
  // Adjacency (edge ids).
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  usable.forEach((link, edge) => { adjacency[local.get(link.nets[0])!].push(edge); adjacency[local.get(link.nets[1])!].push(edge); });
  const otherEnd = (edge: number, node: number): number => { const a = local.get(usable[edge].nets[0])!, b = local.get(usable[edge].nets[1])!; return a === node ? b : a; };
  const weight = sortedNets.map(net => suspectsByNet.get(net) ?? 0);

  // Iterative Tarjan: discovery order, low links, DFS-tree subtree weights and the DFS root (component) of each node.
  const disc = new Int32Array(n).fill(-1), low = new Int32Array(n), parentEdge = new Int32Array(n).fill(-1), subtree = new Float64Array(n), root = new Int32Array(n);
  const order: number[] = [];
  const childOf = new Map<number, number>(); // bridge edge -> its child node in the DFS tree
  let time = 0;
  for (let start = 0; start < n; start++) {
    if (disc[start] >= 0) continue;
    const stack: Array<[number, number]> = [[start, 0]];
    disc[start] = low[start] = time++; root[start] = start; order.push(start);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [node, next] = top;
      if (next < adjacency[node].length) {
        top[1]++;
        const edge = adjacency[node][next];
        if (edge === parentEdge[node]) continue; // the tree edge itself; a parallel link to the parent is a back edge
        const to = otherEnd(edge, node);
        if (disc[to] < 0) {
          disc[to] = low[to] = time++; parentEdge[to] = edge; root[to] = start; order.push(to);
          stack.push([to, 0]);
        } else if (disc[to] < low[node]) low[node] = disc[to];
      } else {
        stack.pop();
        subtree[node] += weight[node];
        if (stack.length) {
          const parent = stack[stack.length - 1][0];
          subtree[parent] += subtree[node];
          if (low[node] < low[parent]) low[parent] = low[node];
          if (low[node] > disc[parent]) childOf.set(parentEdge[node], node);
        }
      }
    }
  }
  const componentTotal = new Map<number, number>();
  for (let node = 0; node < n; node++) componentTotal.set(root[node], (componentTotal.get(root[node]) ?? 0) + weight[node]);
  // finish[v]: the largest discovery time in v's DFS subtree (children are discovered after their parent, so a reverse pass works).
  const finish = Int32Array.from(disc);
  for (let k = order.length - 1; k >= 0; k--) {
    const node = order[k];
    if (parentEdge[node] >= 0) { const parent = otherEnd(parentEdge[node], node); if (finish[node] > finish[parent]) finish[parent] = finish[node]; }
  }
  const inSubtree = (node: number, child: number): boolean => root[node] === root[child] && disc[node] >= disc[child] && disc[node] <= finish[child];

  interface Item { link: PartLink; a: number; b: number; child: number; suspectsA: number; suspectsB: number; balance: number }
  const items: Item[] = usable.map((link, edge) => {
    const a = local.get(link.nets[0])!, b = local.get(link.nets[1])!;
    const child = childOf.get(edge);
    if (child === undefined) return { link, a, b, child: -1, suspectsA: weight[a], suspectsB: weight[b], balance: 0 };
    const total = componentTotal.get(root[child]) ?? 0, inner = subtree[child];
    const aInside = inSubtree(a, child);
    const suspectsA = aInside ? inner : total - inner, suspectsB = aInside ? total - inner : inner;
    return { link, a, b, child, suspectsA, suspectsB, balance: total > 0 ? Math.min(suspectsA, suspectsB) / total : 0 };
  });
  const refOf = (item: Item) => graph.component(item.link.part).ref;
  items.sort((x, y) => Number(y.child >= 0) - Number(x.child >= 0) || y.balance - x.balance || (y.suspectsA + y.suspectsB) - (x.suspectsA + x.suspectsB)
    || LINK_ORDER[x.link.linkClass] - LINK_ORDER[y.link.linkClass] || naturalCompare(refOf(x), refOf(y)) || x.link.part - y.link.part);

  const pinsOn = (part: number, net: number): string[] => {
    const numbers: string[] = [];
    for (const pin of graph.partPins(part)) if (graph.pinNet[pin] === net) numbers.push(graph.pin(pin).number);
    return [...new Set(numbers)].sort(naturalCompare);
  };
  const points = items.slice(0, MAX_ISOLATION_POINTS).map((item): IsolationPoint => {
    const { link, a, b, child } = item;
    let sideA: number[], sideB: number[];
    if (child >= 0) {
      const inner: number[] = [], outer: number[] = [];
      for (let node = 0; node < n; node++) if (root[node] === root[child]) (inSubtree(node, child) ? inner : outer).push(node);
      [sideA, sideB] = inSubtree(a, child) ? [inner, outer] : [outer, inner];
    } else { sideA = [a]; sideB = [b]; }
    const describe = (side: number[], net: number, suspects: number): IsolationSide => {
      const names = side.map(node => graph.netName(sortedNets[node])).sort(naturalCompare);
      return { nets: names.slice(0, MAX_SIDE_NETS), netCount: names.length, suspects, pins: pinsOn(link.part, net) };
    };
    const component = graph.component(link.part);
    return {
      componentId: component.id, ref: component.ref, value: component.value ?? '', linkClass: link.linkClass, certainty: link.certainty, action: 'lift-and-measure',
      splits: child >= 0, sides: [describe(sideA, link.nets[0], item.suspectsA), describe(sideB, link.nets[1], item.suspectsB)], balance: item.balance,
    };
  });
  return { points, total: items.length };
}

/** Anchors whose grown bounds cover more grid cells than this are checked by every capacitor instead. */
const MAX_ANCHOR_CELLS = 4096;

/**
 * Each capacitor suspect joins the nearest IC suspect whose bounds lie within `radius` of its position. The ICs are put in a grid
 * of `radius`-sized cells over their bounds grown by the radius, so a capacitor looks only at the ICs of its own cell: the cost is
 * O(capacitors + ICs x cells per IC), not capacitors x ICs.
 */
function decouplingGroups(graph: NetGraph, drafts: ReadonlyArray<{ part: number; kind: PartKind }>, radius: number): DecouplingGroup[] {
  const anchors = drafts.filter(d => d.kind === 'ic').map(d => d.part).sort((a, b) => a - b);
  const capacitors = drafts.filter(d => d.kind === 'capacitor').map(d => d.part).sort((a, b) => a - b);
  if (!anchors.length || !capacitors.length) return [];
  const cellOf = (value: number) => Math.floor(value / radius);
  const grid = new Map<string, number[]>();
  const wide: number[] = [];
  for (const anchor of anchors) {
    const b = graph.component(anchor).bounds;
    if (!b || ![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) continue;
    const x0 = cellOf(b.minX - radius), x1 = cellOf(b.maxX + radius), y0 = cellOf(b.minY - radius), y1 = cellOf(b.maxY + radius);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_ANCHOR_CELLS) { wide.push(anchor); continue; }
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const key = `${cx},${cy}`;
      const list = grid.get(key);
      if (list) list.push(anchor); else grid.set(key, [anchor]);
    }
  }
  const members = new Map<number, number[]>();
  for (const cap of capacitors) {
    const position = graph.component(cap).position;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    let best = -1, bestDistance = Infinity;
    const consider = (anchor: number) => {
      const b = graph.component(anchor).bounds;
      const dx = position.x < b.minX ? b.minX - position.x : position.x > b.maxX ? position.x - b.maxX : 0;
      const dy = position.y < b.minY ? b.minY - position.y : position.y > b.maxY ? position.y - b.maxY : 0;
      const distance = Math.hypot(dx, dy);
      if (distance <= radius && (distance < bestDistance || (distance === bestDistance && anchor < best))) { bestDistance = distance; best = anchor; }
    };
    for (const anchor of grid.get(`${cellOf(position.x)},${cellOf(position.y)}`) ?? []) consider(anchor);
    for (const anchor of wide) consider(anchor);
    if (best >= 0) { const list = members.get(best); if (list) list.push(cap); else members.set(best, [cap]); }
  }
  const groups = [...members].map(([anchor, caps]) => ({
    anchor: { componentId: graph.component(anchor).id, ref: graph.component(anchor).ref },
    capacitors: caps.map(cap => graph.component(cap).ref).sort(naturalCompare), count: caps.length,
  }));
  groups.sort((a, b) => b.count - a.count || naturalCompare(a.anchor.ref, b.anchor.ref) || naturalCompare(a.anchor.componentId, b.anchor.componentId));
  return groups;
}
