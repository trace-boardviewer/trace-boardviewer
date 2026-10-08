/*
 * The canonical board of the synthetic library: parts with pins, nets and positions, in millimetres. Writers (board-writers.ts) turn
 * it into files of several formats, documents (documents.ts) print its parts, and a revision is derived from it by changing a few
 * percent of the parts and renaming a few nets. The (reference, pin) set of a board is what the application fingerprints, so the
 * fingerprint of every generated board file is known without parsing it.
 */
import type { Rng } from './rng.ts';
import { sha256Hex } from './sha256.ts';
import { BUSES, BUS_SIGNALS, MPN_MARKERS, MPN_PREFIXES, MPN_SUFFIXES } from './words.ts';

export type PartClass = 'R' | 'C' | 'L' | 'FB' | 'D' | 'Q' | 'U' | 'J' | 'TP' | 'Y' | 'F';
export type Side = 'top' | 'bottom';
export type RailStyle = 'pp' | 'plus' | 'vcc' | 'num' | 'vdd';
export type RefScheme = 'gapped' | 'block';

export interface Pin { number: string; net: string; dx: number; dy: number }
export interface Part {
  ref: string;
  cls: PartClass;
  /** What the board file shows as the value: a resistance, a capacitance or the part number of an IC. */
  value: string;
  /** Part number (ICs, transistors, diodes); null for passives. */
  mpn: string | null;
  pkg: string;
  side: Side;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  pins: Pin[];
}
export interface BoardModel {
  width: number;
  height: number;
  parts: Part[];
  /** GenCAD text of the benchmark generator this board was read from (first revisions only: a derived revision has none). */
  benchText?: string;
  /** Part numbers the invented ICs of `benchText` carry, by device name (the text itself holds the generator's own labels). */
  benchDeviceValues?: Record<string, string>;
}

export interface BoardSpec {
  parts: number;
  refScheme: RefScheme;
  railStyle: RailStyle;
  /** BGA pins are named A1, B2 ... instead of 1, 2 ... */
  alphaBga: boolean;
}

export const GND = 'GND';
const R_VALUES = ['0', '10', '22', '33', '47', '100', '220', '330', '470', '1K', '2.2K', '4.7K', '10K', '22K', '47K', '100K', '1M'];
const C_VALUES = ['10PF', '22PF', '100PF', '1NF', '10NF', '100NF', '1UF', '2.2UF', '4.7UF', '10UF', '22UF', '47UF'];
const L_VALUES = ['470NH', '1UH', '2.2UH', '4.7UH', '10UH'];
const FB_VALUES = ['120R', '300R', '600R', '1K'];
const Y_VALUES = ['32.768KHZ', '24MHZ', '25MHZ', '12MHZ'];
const J_VALUES = ['USB-C', 'FPC-30P', 'HDR-10P', 'SD-CARD', 'DC-JACK', 'AUDIO-JACK'];
export const PASSIVE_CLASSES: readonly PartClass[] = ['R', 'C', 'L', 'FB'];
export const isPassive = (cls: PartClass): boolean => PASSIVE_CLASSES.includes(cls);

/** Part number: three invented letters, 3 to 5 digits, optional suffix and an optional lead-free or reel marker. `base` is the number without that marker. */
export function makeMpn(rng: Rng): { exact: string; base: string } {
  const prefix = rng.pick(MPN_PREFIXES) + rng.digits(rng.int(3, 5));
  const base = rng.chance(0.65) ? prefix + rng.pick(MPN_SUFFIXES) : prefix;
  const exact = rng.chance(0.2) ? base + rng.pick(MPN_MARKERS) : base;
  return { exact, base };
}
export const mpnBase = (exact: string): string => { for (const marker of MPN_MARKERS) if (exact.endsWith(marker)) return exact.slice(0, -marker.length); return exact; };

// ---- pin layouts ----------------------------------------------------------------------------------------------------------

const PITCH: Readonly<Record<string, number>> = { '0201': 0.6, '0402': 1.0, '0603': 1.6, '1008': 2.4, 'SOD-323': 2.4, 'SOT-23': 1.9, 'SOT-363': 1.3 };
const BGA_LETTERS = 'ABCDEFGHJKLMNPRTUVWY';

export function pinLayout(pkg: string, count: number, alphaBga: boolean): Array<{ number: string; dx: number; dy: number }> {
  const round = (value: number): number => Math.round(value * 100) / 100;
  if (count === 1) return [{ number: '1', dx: 0, dy: 0 }];
  if (count === 2) { const half = (PITCH[pkg] ?? 1.0) / 2; return [{ number: '1', dx: -half, dy: 0 }, { number: '2', dx: half, dy: 0 }]; }
  if (pkg.startsWith('BGA')) {
    const side = Math.ceil(Math.sqrt(count)), pitch = 0.8;
    return Array.from({ length: count }, (_, i) => {
      const row = Math.floor(i / side), col = i % side;
      return { number: alphaBga ? `${BGA_LETTERS[row % BGA_LETTERS.length]}${col + 1 + Math.floor(row / BGA_LETTERS.length) * side}` : String(i + 1), dx: round((col - (side - 1) / 2) * pitch), dy: round((row - (side - 1) / 2) * pitch) };
    });
  }
  if (pkg.startsWith('QFN') || pkg.startsWith('QFP')) {
    const perSide = Math.ceil(count / 4), half = (perSide * 0.5) / 2 + 0.5;
    return Array.from({ length: count }, (_, i) => {
      const edge = Math.floor(i / perSide), at = (i % perSide - (perSide - 1) / 2) * 0.5;
      return { number: String(i + 1), dx: round(edge === 0 ? -half : edge === 2 ? half : edge === 1 ? at : -at), dy: round(edge === 1 ? -half : edge === 3 ? half : edge === 0 ? -at : at) };
    });
  }
  if (pkg.startsWith('CONN')) return Array.from({ length: count }, (_, i) => ({ number: String(i + 1), dx: round((i - (count - 1) / 2) * 0.5), dy: 0 }));
  // dual row (SOT, SOIC): pins 1..h down the left edge, h+1..n up the right edge
  const half = Math.ceil(count / 2), pitch = pkg.startsWith('SOIC') ? 1.27 : 0.95, width = pkg.startsWith('SOIC') ? 5.4 : 2.8;
  return Array.from({ length: count }, (_, i) => {
    const left = i < half, index = left ? i : count - 1 - i;
    return { number: String(i + 1), dx: left ? -width / 2 : width / 2, dy: round(((half - 1) / 2 - index) * pitch) };
  });
}

function icPackage(pins: number): string {
  if (pins <= 5) return 'SOT23-5';
  if (pins <= 6) return 'SOT23-6';
  if (pins <= 8) return 'SOIC8';
  if (pins <= 16) return 'SOIC16';
  if (pins <= 32) return `QFN${pins}`;
  if (pins <= 48) return `QFP${pins}`;
  return `BGA${pins}`;
}
const footprintSize = (pkg: string, pins: number): [number, number] => {
  if (pkg.startsWith('BGA')) { const side = Math.ceil(Math.sqrt(pins)) * 0.8 + 1.5; return [side, side]; }
  if (pkg.startsWith('QFN') || pkg.startsWith('QFP')) { const side = Math.ceil(pins / 4) * 0.5 + 2.5; return [side, side]; }
  if (pkg.startsWith('SOIC')) return [6.2, Math.ceil(pins / 2) * 1.27 + 1];
  if (pkg.startsWith('SOT23')) return [3.2, 2.4];
  if (pkg.startsWith('CONN')) return [pins * 0.5 + 2, 3];
  const pitch = PITCH[pkg] ?? 1.0;
  return [pitch + 1.2, 1.6];
};

// ---- rails and signals -----------------------------------------------------------------------------------------------------

const VOLTS = ['12V', '5V', '3V3', '2V5', '1V8', '1V5', '1V2', '1V05', '1V0', '0V9', '0V75'];
const DOMAINS = ['S0', 'S3', 'S5', 'ALW', 'CORE', 'PLL', 'DDR', 'GFX', 'USB'];

function railNames(rng: Rng, style: RailStyle, count: number): string[] {
  const names = new Set<string>();
  let guard = 0;
  while (names.size < count && guard++ < count * 20) {
    const volt = rng.pick(VOLTS), domain = rng.pick(DOMAINS);
    names.add(style === 'pp' ? `PP${volt}_${domain}` : style === 'plus' ? `+${volt}_${domain}` : style === 'vcc' ? `VCC_${volt}` : style === 'num' ? `${volt}_${domain}` : `VDD_${volt}`);
    if (style === 'vcc' || style === 'vdd') names.add(`${style === 'vcc' ? 'VCC' : 'VDD'}_${domain}`);
  }
  return [...names].slice(0, Math.max(2, count));
}

function signalNames(rng: Rng, count: number): string[] {
  const names = new Set<string>();
  let guard = 0;
  while (names.size < count && guard++ < count * 30) {
    const bus = rng.pick(BUSES);
    names.add(rng.chance(0.5) ? `${bus}${rng.int(0, 9)}_${rng.pick(BUS_SIGNALS)}` : `${bus}_${rng.pick(BUS_SIGNALS)}${rng.int(0, 31)}`);
  }
  return [...names];
}

// ---- generation ------------------------------------------------------------------------------------------------------------

const IC_PIN_COUNTS: ReadonlyArray<readonly [number, number]> = [[5, 18], [6, 8], [8, 20], [16, 14], [24, 8], [32, 8], [48, 6], [64, 8], [100, 6]];

interface Pools { rails: string[]; signals: string[]; icMpns: string[]; qMpns: string[]; dMpns: string[] }

function refNumbers(rng: Rng, scheme: RefScheme, cls: PartClass, count: number): number[] {
  if (scheme === 'gapped') {
    const span = Math.ceil(count * (1.15 + rng.next() * 0.75));
    return rng.sample(Array.from({ length: span }, (_, i) => i + 1), count).sort((a, b) => a - b);
  }
  const base = 100 * rng.int(10, 69);
  const span = Math.ceil(count * 1.3) + 2;
  return rng.sample(Array.from({ length: span }, (_, i) => base + i), count).sort((a, b) => a - b);
}

export function generateBoard(rng: Rng, spec: BoardSpec): BoardModel {
  const n = Math.max(6, spec.parts);
  const count = (share: number, min = 0): number => Math.max(min, Math.round(n * share));
  const mix: Array<[PartClass, number]> = [
    ['U', count(0.06, 1)], ['Q', count(0.03)], ['D', count(0.02)], ['J', count(0.015, 1)], ['TP', count(0.02)], ['Y', count(0.005)], ['L', count(0.03)], ['FB', count(0.03)], ['F', count(0.004)],
  ];
  const rest = Math.max(2, n - mix.reduce((sum, [, k]) => sum + k, 0));
  mix.push(['R', Math.round(rest * 0.45)], ['C', rest - Math.round(rest * 0.45)]);
  const pools: Pools = {
    rails: railNames(rng.fork('rails'), spec.railStyle, rng.int(4, Math.min(14, 4 + Math.floor(n / 25)))),
    signals: signalNames(rng.fork('signals'), Math.max(8, Math.round(n * 0.45))),
    icMpns: Array.from({ length: Math.max(1, Math.min(40, Math.round(count(0.06, 1) * 0.7))) }, () => makeMpn(rng).exact),
    qMpns: Array.from({ length: rng.int(2, 5) }, () => makeMpn(rng).exact),
    dMpns: Array.from({ length: rng.int(2, 5) }, () => makeMpn(rng).exact),
  };
  const parts: Part[] = [];
  const net = (cls: PartClass, role: 'a' | 'b' | 'c'): string => {
    const roll = rng.next();
    if (cls === 'C') return role === 'a' ? (roll < 0.6 ? rng.pick(pools.rails) : rng.pick(pools.signals)) : roll < 0.95 ? GND : rng.pick(pools.rails);
    if (cls === 'R') return role === 'a' ? (roll < 0.3 ? rng.pick(pools.rails) : rng.pick(pools.signals)) : roll < 0.4 ? GND : roll < 0.75 ? rng.pick(pools.signals) : rng.pick(pools.rails);
    if (cls === 'Q') return role === 'c' ? (roll < 0.7 ? GND : rng.pick(pools.rails)) : roll < 0.6 ? rng.pick(pools.signals) : rng.pick(pools.rails);
    if (cls === 'U' || cls === 'J') return roll < 0.14 ? rng.pick(pools.rails) : roll < 0.3 ? GND : roll < 0.33 ? '' : rng.pick(pools.signals);
    if (cls === 'TP') return roll < 0.7 ? rng.pick(pools.signals) : rng.pick(pools.rails);
    return roll < 0.5 ? rng.pick(pools.signals) : rng.pick(pools.rails);
  };
  for (const [cls, k] of mix) {
    const numbers = refNumbers(rng.fork(`refs/${cls}`), spec.refScheme, cls, k);
    for (let i = 0; i < k; i++) {
      let pinCount = 2, pkg: string, value: string, mpn: string | null = null;
      if (cls === 'U') {
        pinCount = rng.weighted(IC_PIN_COUNTS); pkg = icPackage(pinCount); mpn = rng.pick(pools.icMpns); value = mpn;
      } else if (cls === 'Q') { pinCount = 3; pkg = 'SOT-23'; mpn = rng.pick(pools.qMpns); value = mpn; }
      else if (cls === 'D') { pinCount = 2; pkg = rng.pick(['SOD-323', 'SOT-23']); if (pkg === 'SOT-23') pinCount = 3; mpn = rng.pick(pools.dMpns); value = mpn; }
      else if (cls === 'J') { pinCount = rng.int(4, 40); pkg = 'CONN'; value = rng.pick(J_VALUES); }
      else if (cls === 'TP') { pinCount = 1; pkg = 'TP'; value = ''; }
      else if (cls === 'Y') { pinCount = rng.pick([2, 4]); pkg = 'SOT-363'; value = rng.pick(Y_VALUES); }
      else if (cls === 'F') { pkg = '0603'; value = '2A'; }
      else if (cls === 'R') { pkg = rng.weighted([['0402', 6], ['0201', 3], ['0603', 2]]); value = rng.pick(R_VALUES); }
      else if (cls === 'C') { pkg = rng.weighted([['0402', 6], ['0201', 3], ['0603', 2]]); value = rng.pick(C_VALUES); }
      else if (cls === 'L') { pkg = rng.pick(['0603', '1008']); value = rng.pick(L_VALUES); }
      else { pkg = '0402'; value = rng.pick(FB_VALUES); }
      const layout = pinLayout(pkg, pinCount, spec.alphaBga);
      const pins: Pin[] = layout.map((slot, at) => ({ number: slot.number, dx: slot.dx, dy: slot.dy, net: net(cls, at === 0 ? 'a' : at === 1 ? 'b' : 'c') }));
      parts.push({ ref: `${cls}${numbers[i]}`, cls, value, mpn, pkg, side: rng.chance(0.62) ? 'top' : 'bottom', x: 0, y: 0, rotation: rng.pick([0, 90, 180, 270] as const), pins });
    }
  }
  return layout({ width: 0, height: 0, parts: rng.shuffle(parts).sort((a, b) => classOrder(a.cls) - classOrder(b.cls) || compareRefs(a.ref, b.ref)) });
}

/** Letters first, then the number as a number ("C9" before "C10"), without locale tables (the order must not depend on the platform's ICU data). */
function compareRefs(a: string, b: string): number {
  const x = /^([A-Z]*)(\d*)(.*)$/.exec(a)!, y = /^([A-Z]*)(\d*)(.*)$/.exec(b)!;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  const nx = Number(x[2] || 0), ny = Number(y[2] || 0);
  if (nx !== ny) return nx - ny;
  return x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0;
}

const CLASS_ORDER: PartClass[] = ['U', 'J', 'Y', 'Q', 'D', 'L', 'FB', 'F', 'R', 'C', 'TP'];
const classOrder = (cls: PartClass): number => CLASS_ORDER.indexOf(cls);

/** Places the parts of each side on rows of a rectangle; returns a board with its width and height. */
function layout(board: BoardModel): BoardModel {
  let area = 0;
  for (const part of board.parts) { const [w, h] = footprintSize(part.pkg, part.pins.length); area += (w + 1) * (h + 1); }
  const rowWidth = Math.max(24, Math.ceil(Math.sqrt(area / 2 * 1.4)));
  let height = 0;
  for (const side of ['top', 'bottom'] as const) {
    let x = 1, y = 1, rowHeight = 0;
    for (const part of board.parts) {
      if (part.side !== side) continue;
      const [w, h] = footprintSize(part.pkg, part.pins.length);
      if (x + w > rowWidth) { x = 1; y += rowHeight + 1; rowHeight = 0; }
      part.x = Math.round((x + w / 2) * 100) / 100; part.y = Math.round((y + h / 2) * 100) / 100;
      x += w + 1; rowHeight = Math.max(rowHeight, h);
    }
    height = Math.max(height, y + rowHeight + 1);
  }
  board.width = rowWidth + 1; board.height = Math.ceil(height) + 1;
  return board;
}

// ---- revisions -------------------------------------------------------------------------------------------------------------

export interface RevisionChange { valueChanges: number; removed: number; added: number; renamedNets: number }

/** The next revision: `percent` of the parts change (60 % value or part-number swaps, 20 % removed, 20 % added), a few nets are renamed. */
export function deriveRevision(previous: BoardModel, rng: Rng, percent: number, renamedNets: number, spec: Pick<BoardSpec, 'alphaBga'>): { board: BoardModel; change: RevisionChange } {
  const board: BoardModel = { width: previous.width, height: previous.height, parts: previous.parts.map(part => ({ ...part, pins: part.pins.map(pin => ({ ...pin })) })) };
  const changes = Math.max(1, Math.round(board.parts.length * percent / 100));
  const swaps = Math.max(1, Math.round(changes * 0.6)), removals = Math.round(changes * 0.2), additions = Math.max(1, changes - swaps - removals);
  const candidates = rng.shuffle(board.parts.map((_, i) => i));
  let valueChanges = 0;
  for (const index of candidates.slice(0, swaps)) {
    const part = board.parts[index];
    if (part.mpn) { part.mpn = makeMpn(rng).exact; part.value = part.mpn; }
    else if (part.cls === 'R') part.value = rng.pick(R_VALUES.filter(v => v !== part.value));
    else if (part.cls === 'C') part.value = rng.pick(C_VALUES.filter(v => v !== part.value));
    else if (part.cls === 'L') part.value = rng.pick(L_VALUES.filter(v => v !== part.value));
    else if (part.cls === 'FB') part.value = rng.pick(FB_VALUES.filter(v => v !== part.value));
    else continue;
    valueChanges++;
  }
  const doomed = new Set(candidates.slice(swaps, swaps + removals).filter(i => isPassive(board.parts[i].cls) || board.parts[i].cls === 'TP'));
  board.parts = board.parts.filter((_, i) => !doomed.has(i));
  const nets = [...new Set(board.parts.flatMap(part => part.pins.map(pin => pin.net)))].filter(name => name && name !== GND);
  let added = 0;
  for (let i = 0; i < additions && nets.length; i++) {
    const cls: PartClass = rng.chance(0.55) ? 'R' : 'C';
    const used = new Set(board.parts.map(part => part.ref));
    let number = 1;
    for (const part of board.parts) if (part.cls === cls) number = Math.max(number, Number(part.ref.slice(cls.length)) + 1);
    while (used.has(`${cls}${number}`)) number++;
    const pkg = rng.pick(['0402', '0201']);
    const layoutPins = pinLayout(pkg, 2, spec.alphaBga);
    const side: Side = rng.chance(0.6) ? 'top' : 'bottom';
    const anchor = board.parts[rng.int(0, board.parts.length - 1)];
    board.parts.push({
      ref: `${cls}${number}`, cls, value: cls === 'R' ? rng.pick(R_VALUES) : rng.pick(C_VALUES), mpn: null, pkg, side, x: anchor.x, y: Math.min(board.height - 1, anchor.y + 2), rotation: 0,
      pins: layoutPins.map((slot, at) => ({ ...slot, net: at === 0 ? rng.pick(nets) : GND })),
    });
    added++;
  }
  const renameable = nets.filter(name => !/^TP/.test(name));
  const renames = new Map<string, string>();
  for (const name of rng.sample(renameable, renamedNets)) renames.set(name, /_S0$/.test(name) ? name.replace(/_S0$/, '_ON') : /^[+A-Z]+\d/.test(name) ? name + '_R' : name + '_N');
  if (renames.size) for (const part of board.parts) for (const pin of part.pins) { const to = renames.get(pin.net); if (to) pin.net = to; }
  return { board, change: { valueChanges, removed: doomed.size, added, renamedNets: renames.size } };
}

/**
 * A different board that looks like this one: `renumber` of the references get new numbers (the pins, nets and part numbers stay),
 * about 4 % of the parts disappear, a few nets are renamed. Its (reference, pin) similarity to the original is about 0.4 to 0.65, and
 * the generator keeps the shared references below 0.75 of either board, so a document of one covers less than 0.8 of the other.
 */
export function deriveSibling(base: BoardModel, rng: Rng, renumber: number): BoardModel {
  const parts = base.parts.map(part => ({ ...part, pins: part.pins.map(pin => ({ ...pin })) }));
  const highest = new Map<PartClass, number>();
  for (const part of parts) highest.set(part.cls, Math.max(highest.get(part.cls) ?? 0, Number(part.ref.slice(part.cls.length)) || 0));
  const keep = parts.filter(() => !rng.chance(0.04));
  for (const part of keep) {
    if (!rng.chance(renumber)) continue;
    const next = (highest.get(part.cls) ?? 0) + 1;
    highest.set(part.cls, next);
    part.ref = `${part.cls}${next}`;
  }
  const board: BoardModel = { width: base.width, height: base.height, parts: keep };
  const names = netNamesOf(board).filter(name => name !== GND);
  for (const name of rng.sample(names, Math.max(2, Math.round(names.length * 0.1)))) {
    const to = `${name}_B`;
    for (const part of board.parts) for (const pin of part.pins) if (pin.net === name) pin.net = to;
  }
  return board;
}

// ---- identity --------------------------------------------------------------------------------------------------------------

export type PinSet = Array<[string, string[]]>;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The pin number a file format keeps for pin `index` of a part. */
export type PinNumbering = (part: Part, index: number) => string;
export const defaultNumber: PinNumbering = (part, index) => part.pins[index].number;
/** Formats without pin numbers (BRD2) number the pins 1..n in file order. */
export const ordinalNumber: PinNumbering = (_part, index) => String(index + 1);

/** The canonical (ref, pin) set, as the application's boardPinSet builds it. `number` maps a pin to the number the file format keeps. */
export function pinSetOf(board: BoardModel, number: PinNumbering = defaultNumber): PinSet {
  const byRef = new Map<string, Set<string>>();
  for (const part of board.parts) {
    const ref = part.ref.trim().toUpperCase();
    if (!ref) continue;
    const set = byRef.get(ref) ?? new Set<string>();
    part.pins.forEach((_pin, index) => { const value = number(part, index).trim().toUpperCase(); if (value && !value.startsWith('~')) set.add(value); });
    if (set.size) byRef.set(ref, set);
  }
  return [...byRef.keys()].sort(compare).map(ref => [ref, [...byRef.get(ref)!].sort(compare)] as [string, string[]]);
}

const FINGERPRINT_HEAD = 'trace-board-fingerprint/1\n';
/** The application's fingerprint recipe (src/lib/board-fingerprint.ts, FINGERPRINT_VERSION 1): "fp1:" and the SHA-256 hex of the head line and the JSON pin set. */
export function fingerprintOf(set: PinSet): string { return `fp1:${sha256Hex(new TextEncoder().encode(FINGERPRINT_HEAD + JSON.stringify(set)))}`; }
export function pinSetSize(set: PinSet): number { let size = 0; for (const [, pins] of set) size += pins.length; return size; }

/** Jaccard similarity of two pin sets over their (ref, pin) pairs. */
export function jaccard(a: PinSet, b: PinSet): number {
  const keys = new Set<string>();
  for (const [ref, pins] of a) for (const pin of pins) keys.add(`${ref}\u0000${pin}`);
  let shared = 0, union = keys.size;
  for (const [ref, pins] of b) for (const pin of pins) { if (keys.has(`${ref}\u0000${pin}`)) shared++; else union++; }
  return union === 0 ? 1 : shared / union;
}

export const netNamesOf = (board: BoardModel): string[] => [...new Set(board.parts.flatMap(part => part.pins.map(pin => pin.net)).filter(Boolean))].sort(compare);
export const refSetOf = (board: BoardModel): Set<string> => new Set(board.parts.map(part => part.ref.toUpperCase()));
export const countPins = (board: BoardModel): number => board.parts.reduce((sum, part) => sum + part.pins.length, 0);

/** Part numbers of a board with the references that carry them (ICs, transistors and diodes). */
export function partNumbersOf(board: BoardModel): Array<{ exact: string; base: string; refs: string[] }> {
  const byMpn = new Map<string, string[]>();
  for (const part of board.parts) if (part.mpn) (byMpn.get(part.mpn) ?? byMpn.set(part.mpn, []).get(part.mpn)!).push(part.ref);
  return [...byMpn.keys()].sort(compare).map(exact => ({ exact, base: mpnBase(exact), refs: byMpn.get(exact)!.slice().sort(compare) }));
}
