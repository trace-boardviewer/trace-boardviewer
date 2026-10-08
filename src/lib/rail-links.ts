/**
 * Rail links: the parts a supply rail passes through in series, and why each one counts (or only might count) as a link.
 *
 * A link joins exactly two nets with (close to) no DC resistance, so for fault finding both nets are one electrical node: a short
 * on one reads on the other. Classes:
 *  - `jumper`: a resistor whose value reads 0 Ω, or a part of kind jumper (a solder jumper whose name says open is only possible);
 *  - `fuse`, `ferrite`: by kind, whatever the value says (a ferrite's value is its impedance at a frequency, not its DC resistance);
 *  - `inductor`: by kind, when the value is at least 0.1 µH, or unknown on a package larger than 0603 (or, without a package
 *    code, an outline of at least 8 mm²); a known smaller value (an RF inductor), an unknown value on a small package and an
 *    inductor of which neither value nor size is known are only possible;
 *  - `shunt`: a resistor at or below the threshold that is a current-sense part: below 0.1 Ω, or a 4-pad (Kelvin) resistor, whose
 *    two force nets are the two nets with the most of its pads (ties: the net with more pins on the board);
 *  - `low-ohm`: any other resistor at or below the threshold (default 1 Ω, adjustable from 0 to 10 Ω);
 *  - `diode`: only when asked for (`diodes: true`), always possible, one-way when the pin names say anode and cathode.
 *
 * Certainty: `definite` links are walked by default. `possible` ones (a resistor or jumper whose value cannot be read, a part
 * of unknown kind whose value reads as a low resistance, the small inductors, open solder jumpers, diodes) are listed and walked
 * only on explicit opt-in. A part that is not fitted (a marker such as DNP or NC in its value, or listed as not populated when the
 * graph was built) is never a link; it is reported as `not-fitted` so the technician sees that a link footprint exists. Nets
 * without a name and no-connect nets do not count.
 *
 * Results are cached per graph and settings: each part is looked at once per (threshold, diodes) pair.
 */
import type { NetGraph } from './net-graph';
import { wordsOfText } from './net-graph';
import { outlineSize, packageSize } from './part-size';

export type LinkClass = 'jumper' | 'fuse' | 'ferrite' | 'inductor' | 'shunt' | 'low-ohm' | 'diode';
export type LinkCertainty = 'definite' | 'possible';
/** Why a part is (or might be) a link; stable codes for the interface texts. */
export type LinkCode =
  | 'zero-ohm' | 'jumper-kind' | 'open-jumper' | 'fuse-kind' | 'ferrite-kind' | 'inductor-value' | 'inductor-package' | 'inductor-outline'
  | 'small-inductance' | 'small-inductor-package' | 'unknown-inductor' | 'shunt-value' | 'kelvin-shunt' | 'low-ohm-value' | 'unknown-value'
  | 'unknown-kind-low-ohm' | 'diode';

export interface LinkSettings {
  /** Largest resistance that still counts as a link, in ohm; default 1, clamped to 0..10. */
  thresholdOhms?: number;
  /** Diodes as possible one-way links (OR-ing diodes); default false. */
  diodes?: boolean;
}

export const DEFAULT_THRESHOLD_OHMS = 1;
export const MAX_THRESHOLD_OHMS = 10;
/** Resistors below this are current-sense shunts rather than plain low-ohm links. */
export const SHUNT_BELOW_OHMS = 0.1;
/** Inductors from this value on are power inductors. */
export const POWER_INDUCTANCE_H = 0.1e-6;
/** An inductor of unknown value and package whose outline covers at least this many mm² (a 1210 body) is a power inductor. */
export const POWER_INDUCTOR_OUTLINE_MM2 = 8;

export interface PartLink {
  readonly type: 'link';
  readonly part: number;
  readonly linkClass: LinkClass;
  readonly certainty: LinkCertainty;
  /** The two nets the part joins (for a Kelvin shunt its force nets). For a one-way diode: anode net first. */
  readonly nets: readonly [number, number];
  readonly oneWay: boolean;
  /** The parsed resistance in ohm, when the value reads as one. */
  readonly ohms: number | null;
  readonly code: LinkCode;
  /** Short English explanation (diagnostics and tests; the interface translates `code`). */
  readonly reason: string;
}
/** A part that would be a link but carries a not-fitted marker. */
export interface NotFittedLink {
  readonly type: 'not-fitted';
  readonly part: number;
  readonly linkClass: LinkClass;
  readonly nets: readonly [number, number];
  readonly reason: string;
}
export type LinkResult = PartLink | NotFittedLink | null;

export interface NormalizedLinkSettings { readonly thresholdOhms: number; readonly diodes: boolean }

export function normalizeLinkSettings(settings: LinkSettings = {}): NormalizedLinkSettings {
  const raw = settings.thresholdOhms;
  const thresholdOhms = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(MAX_THRESHOLD_OHMS, Math.max(0, raw)) : DEFAULT_THRESHOLD_OHMS;
  return { thresholdOhms, diodes: settings.diodes === true };
}

interface SettingsCache { readonly thresholdOhms: number; readonly diodes: boolean; readonly results: Array<LinkResult | undefined> }
/**
 * Per graph, one result list for each (threshold, diodes) pair in use: normally one or two, so a linear look-up with no key text.
 * At most MAX_CACHED_SETTINGS are kept (the oldest goes first), so a threshold slider moved through many values cannot pile up lists.
 */
const MAX_CACHED_SETTINGS = 4;
const caches = new WeakMap<NetGraph, SettingsCache[]>();

function cacheFor(graph: NetGraph, settings: NormalizedLinkSettings): Array<LinkResult | undefined> {
  let list = caches.get(graph);
  if (!list) { list = []; caches.set(graph, list); }
  for (const entry of list) if (entry.thresholdOhms === settings.thresholdOhms && entry.diodes === settings.diodes) return entry.results;
  const results: Array<LinkResult | undefined> = new Array(graph.partCount);
  if (list.length >= MAX_CACHED_SETTINGS) list.shift();
  list.push({ thresholdOhms: settings.thresholdOhms, diodes: settings.diodes, results });
  return results;
}

/** The link a part forms, the not-fitted link it would form, or null. Cached per graph and settings. */
export function linkOf(graph: NetGraph, part: number, settings: NormalizedLinkSettings): LinkResult {
  if (part < 0 || part >= graph.partCount) return null;
  const cache = cacheFor(graph, settings);
  let result = cache[part];
  if (result === undefined) { result = classifyLink(graph, part, settings); cache[part] = result; }
  return result;
}

/** Nets of the part that have a real name (no-connect names left out), with the part's pin count on each. */
function realNets(graph: NetGraph, part: number): { nets: number[]; counts: number[] } {
  const all = graph.partNets(part), counts = graph.partNetPinCounts(part);
  const nets: number[] = [], pinCounts: number[] = [];
  for (let k = 0; k < all.length; k++) if (!graph.isNoConnect(all[k])) { nets.push(all[k]); pinCounts.push(counts[k]); }
  return { nets, counts: pinCounts };
}

const formatOhms = (ohms: number): string => (ohms === 0 ? '0 Ω' : ohms < 1 ? `${+(ohms * 1000).toPrecision(3)} mΩ` : `${+ohms.toPrecision(3)} Ω`);

function classifyLink(graph: NetGraph, part: number, settings: NormalizedLinkSettings): LinkResult {
  const component = graph.component(part);
  const pinTotal = graph.partPins(part).length;
  const { nets, counts } = realNets(graph, part);
  if (nets.length < 2) return null;
  const kind = graph.kindOf(part).kind;
  const pair = (a: number, b: number): readonly [number, number] => [a, b];
  const link = (linkClass: LinkClass, certainty: LinkCertainty, joined: readonly [number, number], code: LinkCode, reason: string, ohms: number | null = null, oneWay = false): PartLink =>
    ({ type: 'link', part, linkClass, certainty, nets: joined, oneWay, ohms, code, reason });
  const notFittedBy = graph.notFittedBy(part);
  const notFitted = (linkClass: LinkClass, joined: readonly [number, number]): NotFittedLink =>
    ({ type: 'not-fitted', part, linkClass, nets: joined, reason: notFittedBy === 'listed' ? `${linkClass} not fitted (listed as not populated)` : `${linkClass} marked not fitted (${component.value})` });

  switch (kind) {
    case 'resistor': {
      let joined: readonly [number, number];
      let kelvin = false;
      // A 4-pad resistor is a Kelvin (current-sense) part whatever the number of nets its pads reach: two (the sense pads tied to the
      // force pads), three or four (separate sense nets).
      if (pinTotal === 4 && nets.length >= 2 && nets.length <= 4) { joined = forceNets(graph, nets, counts); kelvin = true; }
      else if (nets.length === 2) joined = pair(nets[0], nets[1]);
      else return null;
      const value = graph.valueOf(part);
      const known = value.quantity === 'resistance' && value.si !== null;
      // Above the threshold it is no link, fitted or not; at or below it (or unreadable) a missing part is a link footprint.
      if (known && (value.si! < 0 || value.si! > settings.thresholdOhms)) return null;
      if (notFittedBy) return notFitted(kelvin ? 'shunt' : 'low-ohm', joined);
      if (known) {
        const ohms = value.si!;
        if (ohms === 0 && (!kelvin || nets.length === 2)) return link('jumper', 'definite', joined, 'zero-ohm', 'resistor value reads 0 Ω', 0);
        if (kelvin) return link('shunt', 'definite', joined, 'kelvin-shunt', `4-pad resistor of ${formatOhms(ohms)}`, ohms);
        if (ohms < SHUNT_BELOW_OHMS) return link('shunt', 'definite', joined, 'shunt-value', `resistor of ${formatOhms(ohms)} (current sense)`, ohms);
        return link('low-ohm', 'definite', joined, 'low-ohm-value', `resistor of ${formatOhms(ohms)}, at or below ${formatOhms(settings.thresholdOhms)}`, ohms);
      }
      return link(kelvin ? 'shunt' : 'low-ohm', 'possible', joined, 'unknown-value', component.value ? `resistor value "${component.value}" cannot be read` : 'resistor without a value');
    }
    case 'jumper': {
      if (nets.length !== 2) return null;
      const joined = pair(nets[0], nets[1]);
      const words = [...wordsOfText(component.value), ...wordsOfText(component.package)];
      const normallyClosed = words.includes('BRIDGED') || words.includes('CLOSED') || (words.includes('NC') && words.some(word => word.startsWith('JUMPER') || word.startsWith('SOLDERJUMPER')));
      if (notFittedBy === 'listed' || (notFittedBy === 'value' && !normallyClosed)) return notFitted('jumper', joined);
      if (!normallyClosed && (words.includes('OPEN') || words.includes('NO'))) return link('jumper', 'possible', joined, 'open-jumper', 'jumper whose name says normally open');
      return link('jumper', 'definite', joined, 'jumper-kind', 'part of kind jumper');
    }
    case 'fuse': case 'ferrite': {
      if (nets.length !== 2) return null;
      const joined = pair(nets[0], nets[1]);
      if (notFittedBy) return notFitted(kind, joined);
      return link(kind, 'definite', joined, kind === 'fuse' ? 'fuse-kind' : 'ferrite-kind', `part of kind ${kind}`);
    }
    case 'inductor': {
      if (nets.length !== 2) return null;
      const joined = pair(nets[0], nets[1]);
      const value = graph.valueOf(part);
      if (notFittedBy) return notFitted('inductor', joined);
      if (value.quantity === 'inductance' && value.si !== null) {
        if (value.si >= POWER_INDUCTANCE_H) return link('inductor', 'definite', joined, 'inductor-value', `inductor of ${component.value}`);
        return link('inductor', 'possible', joined, 'small-inductance', `inductor of ${component.value}, below 0.1 µH (a signal or RF part)`);
      }
      const size = packageSize(component);
      if (size) {
        if (size.areaMm2 <= 1.6 * 0.8 + 1e-9) return link('inductor', 'possible', joined, 'small-inductor-package', `inductor of unknown value in a small package (${size.code ?? 'chip'})`);
        return link('inductor', 'definite', joined, 'inductor-package', `inductor of unknown value in a ${size.code ?? 'large'} package`);
      }
      const outline = outlineSize(component);
      if (outline && outline.areaMm2 >= POWER_INDUCTOR_OUTLINE_MM2) {
        return link('inductor', 'definite', joined, 'inductor-outline', `inductor of unknown value, ${+outline.lengthMm.toFixed(1)} x ${+outline.widthMm.toFixed(1)} mm`);
      }
      return link('inductor', 'possible', joined, 'unknown-inductor', 'inductor of unknown value and size');
    }
    case 'diode': {
      if (!settings.diodes || nets.length !== 2) return null;
      const direction = diodeDirection(graph, part);
      if (direction) return link('diode', 'possible', direction, 'diode', 'diode, one-way from anode to cathode', null, true);
      return link('diode', 'possible', pair(nets[0], nets[1]), 'diode', 'diode, direction unknown');
    }
    case 'part': {
      if (nets.length !== 2) return null;
      const value = graph.valueOf(part);
      if (notFittedBy || value.quantity !== 'resistance' || value.si === null || value.unitless || value.si < 0 || value.si > settings.thresholdOhms) return null;
      return link(value.si === 0 ? 'jumper' : 'low-ohm', 'possible', pair(nets[0], nets[1]), 'unknown-kind-low-ohm', `part of unknown kind whose value reads ${formatOhms(value.si)}`, value.si);
    }
    default: return null;
  }
}

/** The two force nets of a Kelvin resistor: most of its pads, then most pins on the board, then the lower net index. */
function forceNets(graph: NetGraph, nets: readonly number[], counts: readonly number[]): readonly [number, number] {
  const order = nets.map((net, k) => k).sort((a, b) => counts[b] - counts[a] || graph.netPinCount(nets[b]) - graph.netPinCount(nets[a]) || nets[a] - nets[b]);
  const first = nets[order[0]], second = nets[order[1]];
  return first < second ? [first, second] : [second, first];
}

/** Anode and cathode nets from pin names A/K (also ANODE/CATHODE), or null. */
function diodeDirection(graph: NetGraph, part: number): readonly [number, number] | null {
  let anode = -1, cathode = -1;
  for (const pin of graph.partPins(part)) {
    const name = String(graph.pin(pin).name ?? '').trim().toUpperCase();
    const net = graph.pinNet[pin];
    if (net < 0) continue;
    if (name === 'A' || name === 'ANODE') { if (anode >= 0 && anode !== net) return null; anode = net; }
    else if (name === 'K' || name === 'C' || name === 'CATHODE') { if (cathode >= 0 && cathode !== net) return null; cathode = net; }
  }
  return anode >= 0 && cathode >= 0 && anode !== cathode ? [anode, cathode] : null;
}

/** The net on the other side of a link, or -1 when `net` is not one of its two nets. */
export const otherNet = (link: { nets: readonly [number, number] }, net: number): number => (link.nets[0] === net ? link.nets[1] : link.nets[1] === net ? link.nets[0] : -1);
