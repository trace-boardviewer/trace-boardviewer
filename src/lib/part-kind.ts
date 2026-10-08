/**
 * The one answer to "what kind of part is this": the board canvas (colour groups), the inspector, the search rows and the part
 * icons all read it from here, so they cannot disagree (a reference such as IC7 was a chip on the canvas and a capacitor in the
 * inspector, because each had its own rules).
 *
 * The rules, in order; the first one that decides wins and says why (`reason`) and how sure it is (`confidence`):
 *  1. The schematic symbol's library id, when the caller knows the board part has exactly one schematic counterpart.
 *  2. Words in the package or value that cannot belong to anything else: a test point, a mounting hole, a fiducial, a logo.
 *  3. The reference designator: its letters, matched exactly against a table that holds the compound and vendor prefixes (IC, PMIC,
 *     PU, FB, RN, TP, ...), then by the endings U and IC (MCU, PMIC, ...). A prefix that means two things (T, TR) or nothing known is
 *     left open for the next rule. The class letter is NOT read from the end of an unknown prefix: that is what turned IC, OSC,
 *     LCD, TR and RP into capacitors, diodes, resistors and connectors.
 *  4. Words in the package and value (LED, ferrite, switch, crystal, connector, chip packages, transistor packages), which resolve
 *     an open prefix and refine a known one inside its family (an L that is a ferrite bead, a D that is an LED).
 *  5. The pin count (a JP with four or more pins is a header, a part without pads is mechanical, one pad and a test-point word).
 *
 * Pure and allocation-light: it runs once per component of a board of 100k parts. No input is trusted: strings are cut to a fixed
 * length first and every pattern is anchored or bounded, so the cost is linear in that length.
 */
import type { MessageKey } from './i18n';
import type { BoardComponent } from './types';

export type PartKind =
  | 'ic' | 'capacitor' | 'resistor' | 'resistor-array' | 'inductor' | 'ferrite' | 'fuse' | 'diode' | 'led' | 'transistor'
  | 'crystal' | 'connector' | 'testpoint' | 'switch' | 'jumper' | 'mechanical' | 'part';
export const PART_KINDS: readonly PartKind[] = [
  'ic', 'capacitor', 'resistor', 'resistor-array', 'inductor', 'ferrite', 'fuse', 'diode', 'led', 'transistor',
  'crystal', 'connector', 'testpoint', 'switch', 'jumper', 'mechanical', 'part',
];
/** `high`: the schematic or an unambiguous designator / word said so; `medium`: a convention that has exceptions; `low`: a guess or no information. */
export type PartConfidence = 'high' | 'medium' | 'low';
export interface PartKindInput {
  /** Reference designator as the board file spells it. */
  ref: string;
  value?: string;
  /** Package or footprint name. */
  package?: string;
  /** Number of pads, when known. */
  pinCount?: number;
  /** Schematic library id of the part's symbol (`Device:R`), only when the cross-probe found exactly one counterpart. */
  libId?: string;
}
export interface PartKindResult {
  kind: PartKind;
  confidence: PartConfidence;
  /** Short English explanation for tests and diagnostics (never shown to users). */
  reason: string;
}
/** The component fields the classifier reads; `pinIds` supplies the pin count. */
export type PartKindSource = Pick<BoardComponent, 'ref'> & Partial<Pick<BoardComponent, 'value' | 'package' | 'pinIds'>>;

/** Catalog key of the label of each kind (checked against the catalogs by the compiler and by the localization tests). */
export const KIND_LABEL: Readonly<Record<PartKind, MessageKey>> = {
  ic: 'kind.ic', capacitor: 'kind.capacitor', resistor: 'kind.resistor', 'resistor-array': 'kind.resistorArray', inductor: 'kind.inductor',
  ferrite: 'kind.ferrite', fuse: 'kind.fuse', diode: 'kind.diode', led: 'kind.led', transistor: 'kind.transistor', crystal: 'kind.crystal',
  connector: 'kind.connector', testpoint: 'kind.testpoint', switch: 'kind.switch', jumper: 'kind.jumper', mechanical: 'kind.mechanical', part: 'kind.part',
};

/** The three body colours of the board canvas: chips and connectors stand out, everything else is one group. */
export type CanvasGroup = 'chip' | 'connector' | 'passive';
export const canvasGroup = (kind: PartKind): CanvasGroup => (kind === 'ic' ? 'chip' : kind === 'connector' ? 'connector' : 'passive');

// ---------------------------------------------------------------------------------------------------------------
// 1. Schematic library id
// ---------------------------------------------------------------------------------------------------------------

/** KiCad libraries whose every symbol is one kind. */
const LIB_KIND: ReadonlyArray<readonly [RegExp, PartKind]> = [
  [/^Connector/i, 'connector'], [/^TestPoint/i, 'testpoint'], [/^Jumper/i, 'jumper'], [/^Switch/i, 'switch'],
  [/^Oscillator/i, 'crystal'], [/^Crystal/i, 'crystal'], [/^LED/i, 'led'], [/^Fuse/i, 'fuse'], [/^Transistor/i, 'transistor'],
  [/^Diode/i, 'diode'], [/^Mechanical/i, 'mechanical'],
];
/** Checked before LIB_KIND: a transistor array is an integrated circuit. */
const LIB_IC_FIRST = /^Transistor_Array/i;
/** KiCad `Device:` symbols by name (the first matching pattern wins; names are case-insensitive). */
const DEVICE_KIND: ReadonlyArray<readonly [RegExp, PartKind]> = [
  [/^R_(?:Network|Pack|Array)/i, 'resistor-array'], [/^R_(?:Potentiometer|Variable|Trim|Photo)/i, 'part'], [/^R(?:_|$)/i, 'resistor'],
  [/^C_(?:Variable)/i, 'part'], [/^CP?(?:_|$)/i, 'capacitor'],
  [/^Ferrite/i, 'ferrite'], [/^L(?:_|$)/i, 'inductor'],
  [/^(?:Poly)?Fuse/i, 'fuse'], [/^LED/i, 'led'], [/^D(?:_|$)/i, 'diode'], [/^Q_/i, 'transistor'],
  [/^(?:Crystal|Resonator)/i, 'crystal'], [/^Thermistor|^Varistor|^Buzzer|^Speaker|^Microphone|^Battery|^Antenna|^Heater/i, 'part'],
];
/** Libraries of integrated circuits (all symbols in them are chips). */
const IC_LIBRARY = /^(?:MCU_|Regulator_|Interface|Memory_|Amplifier_|Comparator|Analog|Driver_|Power_Management|Timer|Reference_|Logic|74x|4xxx|CPU|FPGA_|Converter_|Battery_Management)/i;

/** The kind a schematic library id stands for, or null when it is not one this classifier knows (the designator rules decide then). */
function fromLibId(libId: string): PartKindResult | null {
  const text = libId.length > 160 ? libId.slice(0, 160) : libId;
  const colon = text.indexOf(':');
  if (colon <= 0 || colon === text.length - 1) return null;
  const library = text.slice(0, colon), end = text.indexOf(':', colon + 1);
  const name = text.slice(colon + 1, end < 0 ? undefined : end);
  if (/^Device$/i.test(library)) {
    for (const [pattern, kind] of DEVICE_KIND) if (pattern.test(name)) return { kind, confidence: 'high', reason: `schematic symbol ${library}:${name}` };
    return null;
  }
  if (LIB_IC_FIRST.test(library)) return { kind: 'ic', confidence: 'high', reason: `schematic library ${library}` };
  for (const [pattern, kind] of LIB_KIND) if (pattern.test(library)) return { kind, confidence: 'high', reason: `schematic library ${library}` };
  if (IC_LIBRARY.test(library)) return { kind: 'ic', confidence: 'medium', reason: `schematic library ${library} holds integrated circuits` };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Reference designator table
// ---------------------------------------------------------------------------------------------------------------

type Open = 'open';
interface Rule { kind: PartKind | Open; confidence: PartConfidence }
const PREFIX_RULES = new Map<string, Rule>();
function add(kind: PartKind | Open, confidence: PartConfidence, ...prefixes: string[]): void {
  for (const prefix of prefixes) PREFIX_RULES.set(prefix, { kind, confidence });
}
// Integrated circuits (more compound endings in U and IC are caught by the suffix rule).
add('ic', 'high', 'U', 'IC', 'PU', 'MCU', 'CPU', 'GPU', 'SOC', 'FPGA', 'PMIC', 'VRAM', 'DDR');
add('capacitor', 'high', 'C', 'PC', 'EC', 'TC', 'CP', 'CAP', 'CAPACITOR');
add('resistor', 'high', 'R', 'PR', 'RES', 'RESISTOR');
add('resistor', 'medium', 'RS');
add('resistor-array', 'high', 'RN', 'RP', 'RA', 'RNET', 'RPACK');
add('inductor', 'high', 'L', 'PL', 'IND', 'INDUCTOR');
add('inductor', 'medium', 'FL'); // a filter or a ferrite bead: the value decides (see refine)
add('ferrite', 'high', 'FB', 'FER', 'FERRITE', 'BEAD');
add('fuse', 'high', 'F', 'PF', 'FU', 'FUSE');
add('diode', 'high', 'D', 'PD', 'ZD', 'DZ', 'DIODE');
add('diode', 'medium', 'BR', 'TVS', 'ESD');
add('led', 'high', 'LED');
add('led', 'medium', 'LD');
add('transistor', 'high', 'Q', 'PQ', 'FET', 'MOSFET', 'BJT');
add('open', 'low', 'T', 'TR', 'TRANS'); // a transistor or a transformer
add('crystal', 'high', 'X', 'Y', 'XTAL', 'XTL', 'XT', 'XO', 'OSC', 'CRYSTAL');
add('connector', 'high', 'J', 'P', 'CN', 'CON', 'CONN', 'CONNECTOR', 'JK', 'JACK', 'HDR', 'HEADER', 'SOCKET', 'SKT', 'RJ', 'PJ', 'PJP', 'AJ');
add('connector', 'medium', 'USB');
add('testpoint', 'high', 'TP', 'PP', 'TPT', 'TEST', 'TESTPOINT');
add('switch', 'high', 'SW', 'SWITCH', 'BTN', 'BUTTON', 'PB');
add('switch', 'medium', 'S');
add('jumper', 'high', 'JMP', 'JUMPER', 'SJ', 'LK'); // JP is decided by the pin count
add('mechanical', 'high', 'MH', 'HOLE', 'MTG', 'FID', 'FIDUCIAL', 'SP', 'STANDOFF', 'SCREW', 'NUT', 'HS', 'HEATSINK', 'SH', 'SHIELD', 'LOGO', 'FRAME', 'MECH');
add('mechanical', 'medium', 'H'); // a hole, or a header when the package says so (see classifyPart)
// Known to be none of the electrical classes: a guess from the package would only make them worse.
add('part', 'medium', 'RV', 'VR', 'POT', 'RT', 'TH', 'NTC', 'PTC', 'BT', 'BAT', 'BATT', 'K', 'RLY', 'M', 'MIC', 'SPK', 'BZ', 'BUZ', 'LS', 'ANT');

/** Letters of the designator before its number (`IC7` -> IC, `U$16` -> U, `J_USB1` -> J), upper case; '' when there are none. */
function lettersOf(ref: string): string {
  let end = 0;
  while (end < ref.length && end < 24) {
    const code = ref.charCodeAt(end);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) end++; else break;
  }
  return ref.slice(0, end).toUpperCase();
}

// ---------------------------------------------------------------------------------------------------------------
// 2 and 4. Words in the package and value
// ---------------------------------------------------------------------------------------------------------------

const TEXT_LIMIT = 160;
interface Words {
  tokens: readonly string[];
  /** Two neighbouring tokens joined: "SOT-23" is the tokens SOT and 23, and the pair SOT23. */
  pairs: readonly string[];
}
/** Upper-case alphanumeric runs of each text ("LED_0603_1608Metric" -> LED, 0603, 1608METRIC), and the pairs of neighbours inside one text. */
function wordsOf(...texts: Array<string | undefined>): Words {
  const tokens: string[] = [], pairs: string[] = [];
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue;
    const upper = (text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text).toUpperCase();
    const first = tokens.length;
    let start = -1;
    for (let i = 0; i <= upper.length; i++) {
      const code = i < upper.length ? upper.charCodeAt(i) : 32;
      const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
      if (alnum) { if (start < 0) start = i; } else if (start >= 0) { tokens.push(upper.slice(start, i)); start = -1; }
    }
    for (let k = first; k + 1 < tokens.length; k++) pairs.push(tokens[k] + tokens[k + 1]);
  }
  return { tokens, pairs };
}
const has = (words: Words, ...wanted: string[]): boolean => words.tokens.some(token => wanted.includes(token));
const hasMatching = (words: Words, pattern: RegExp): boolean => words.tokens.some(token => pattern.test(token));
/** Like hasMatching, but a name the separators cut in two ("MOUNTING-HOLE", "SOT-23") matches as well. */
const hasForm = (words: Words, pattern: RegExp): boolean => hasMatching(words, pattern) || words.pairs.some(pair => pattern.test(pair));

/** Whole words only: a DB9 footprint called "...MountingHolesOffset9.12mm" is a connector, not a mounting hole. */
const MECHANICAL_FORM = /^(?:MOUNTINGHOLES?\d*|STANDOFFS?\d*|HEATSINKS?|FIDUCIAL[A-Z0-9]*|SPACERS?)$/;
const TESTPOINT_FORM = /^TESTPOINTS?$/;
const LOGO_TOKEN = /^LOGOS?$/;
const LED_TOKEN = /^LEDS?\d*$/;
const FERRITE_TOKEN = /^(?:FB|FERRITE|BEAD|BLM\d\w*)$/;
const SWITCH_TOKEN = /^(?:SW|SWITCH|BUTTON|PUSHBUTTON|TACT|TACTILE)$/;
const CRYSTAL_TOKEN = /^(?:CRYSTAL|XTAL|OSC|OSCILLATOR|RESONATOR)$/;
const CONNECTOR_TOKEN = /^(?:CONNECTOR|CONN|HEADER|PINHEADER|SOCKET|PINSOCKET|USB|HDMI|SATA|RJ45|FPC|FFC|JACK|RECEPTACLE|DISPLAYPORT)$/;
const JUMPER_TOKEN = /^(?:JUMPER|SOLDERJUMPER|JMP)$/;
const FUSE_TOKEN = /^(?:FUSE|POLYFUSE)$/;
const DIODE_TOKEN = /^(?:DIODE|SCHOTTKY|ZENER)$/;
/** SOD-123, SOD323F, ...: the small diode packages. */
const DIODE_PACKAGE = /^SOD\d{2,3}[A-Z]*$/;
/** A chip package: ball grid, no-lead, quad flat, small outline, land grid, chip scale, DIP. */
const CHIP_PACKAGE_TOKEN = /^(?:[A-Z]{0,4}BGA|[A-Z]{0,3}QFN|[A-Z]{0,3}DFN|[A-Z]{0,3}QFP|[A-Z]{0,3}SOIC|[A-Z]{0,3}SOP|[A-Z]{0,3}LGA|[A-Z]{0,3}CSP|PDSO|PLCC|DIP)\d*$/;
const TRANSISTOR_PACKAGE = /^(?:SOT23|SOT323|SOT523|SOT89|SOT223|SC70|TO92|TO220|TO252|TO263|D2?PAK)\d*$/;
const TRANSFORMER_TOKEN = /^(?:TRANSFORMER|XFMR|XFORMER)$/;
/** "600R@100MHz", "120R/100M", "120 ohm @ 100 MHz": the impedance of a ferrite bead at a frequency. Bounded, so it cannot backtrack badly. */
const FERRITE_IMPEDANCE = /^\d{1,5}(?:\.\d{1,3})?\s{0,2}(?:R|OHMS?|Ω|Z)?\s{0,2}[@/]\s{0,2}\d{1,5}(?:\.\d{1,3})?\s{0,2}[KMG]?(?:HZ)?$/i;

const ferriteHint = (words: Words, value: string | undefined): boolean =>
  hasMatching(words, FERRITE_TOKEN) || (typeof value === 'string' && value.length <= 40 && FERRITE_IMPEDANCE.test(value.trim()));
const transistorPackage = (words: Words): boolean => hasForm(words, TRANSISTOR_PACKAGE);

/** Words that settle the kind whatever the designator says. */
function strongHint(words: Words): PartKindResult | null {
  if (words.tokens.length === 0) return null;
  if (has(words, 'TP') || hasForm(words, TESTPOINT_FORM)) return { kind: 'testpoint', confidence: 'high', reason: 'package or value says test point' };
  if (hasForm(words, MECHANICAL_FORM)) return { kind: 'mechanical', confidence: 'high', reason: 'package or value says mounting hole, standoff, fiducial, spacer or heatsink' };
  if (hasMatching(words, LOGO_TOKEN)) return { kind: 'mechanical', confidence: 'high', reason: 'package or value says logo' };
  return null;
}

/** Words that name a kind; used for a designator that decides nothing. */
function fromWords(words: Words, value: string | undefined, pinCount: number | undefined): PartKindResult | null {
  if (hasMatching(words, LED_TOKEN)) return { kind: 'led', confidence: 'medium', reason: 'package or value says LED' };
  if (hasMatching(words, SWITCH_TOKEN)) return { kind: 'switch', confidence: 'medium', reason: 'package or value says switch' };
  if (ferriteHint(words, value)) return { kind: 'ferrite', confidence: 'medium', reason: 'package or value looks like a ferrite bead' };
  if (hasMatching(words, FUSE_TOKEN)) return { kind: 'fuse', confidence: 'medium', reason: 'package or value says fuse' };
  if (hasMatching(words, CRYSTAL_TOKEN)) return { kind: 'crystal', confidence: 'medium', reason: 'package or value says crystal or oscillator' };
  if (hasMatching(words, JUMPER_TOKEN)) return { kind: 'jumper', confidence: 'medium', reason: 'package or value says jumper' };
  if (hasMatching(words, CONNECTOR_TOKEN)) return { kind: 'connector', confidence: 'medium', reason: 'package or value says connector' };
  if (hasMatching(words, CHIP_PACKAGE_TOKEN)) return { kind: 'ic', confidence: 'medium', reason: 'chip package' };
  if (transistorPackage(words)) {
    // The small SOT / TO packages hold a transistor with three or four pads and an integrated circuit with more.
    if (pinCount !== undefined && pinCount >= 5) return { kind: 'ic', confidence: 'low', reason: `${pinCount} pads in a small outline package` };
    if (pinCount === undefined || pinCount === 3 || pinCount === 4) return { kind: 'transistor', confidence: 'medium', reason: 'transistor package' };
  }
  if (hasMatching(words, DIODE_TOKEN) || hasForm(words, DIODE_PACKAGE)) return { kind: 'diode', confidence: 'medium', reason: 'package or value says diode' };
  return null;
}

/** An L that is a ferrite bead, a D that is an LED, a J that is a solder jumper: the same family, said more exactly by the package or value. */
function refine(rule: PartKindResult, words: Words, value: string | undefined): PartKindResult {
  switch (rule.kind) {
    case 'inductor': return ferriteHint(words, value) ? { kind: 'ferrite', confidence: 'high', reason: `${rule.reason}; package or value looks like a ferrite bead` } : rule;
    case 'diode': return hasMatching(words, LED_TOKEN) ? { kind: 'led', confidence: 'high', reason: `${rule.reason}; package or value says LED` } : rule;
    case 'connector': return hasMatching(words, JUMPER_TOKEN) ? { kind: 'jumper', confidence: 'medium', reason: `${rule.reason}; package or value says jumper` } : rule;
    default: return rule;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------------------------------------------

const part = (confidence: PartConfidence, reason: string): PartKindResult => ({ kind: 'part', confidence, reason });

export function classifyPart(input: PartKindInput): PartKindResult {
  if (typeof input.libId === 'string' && input.libId !== '') {
    const fromSchematic = fromLibId(input.libId);
    if (fromSchematic) return fromSchematic;
  }
  const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
  const pinCount = typeof input.pinCount === 'number' && Number.isInteger(input.pinCount) && input.pinCount >= 0 ? input.pinCount : undefined;
  const value = typeof input.value === 'string' ? input.value : undefined;
  const words = wordsOf(input.package, value);

  const strong = strongHint(words);
  if (strong) return strong;
  if (ref.startsWith('#')) return part('high', 'virtual symbol, not a physical part');

  const letters = lettersOf(ref);
  const rule = PREFIX_RULES.get(letters);
  if (rule && rule.kind !== 'open') {
    if (letters === 'H' && hasMatching(words, CONNECTOR_TOKEN)) return { kind: 'connector', confidence: 'medium', reason: 'designator H with a header package' };
    return refine({ kind: rule.kind, confidence: rule.confidence, reason: `designator ${letters}` }, words, value);
  }
  if (letters === 'JP') return jumperOrHeader(pinCount);
  if (!rule) {
    if (letters.length >= 2 && letters.endsWith('U')) return { kind: 'ic', confidence: 'medium', reason: `designator ${letters} ends in U` };
    if (letters.length >= 3 && letters.endsWith('IC')) return { kind: 'ic', confidence: 'medium', reason: `designator ${letters} ends in IC` };
    if (/^[APLHSK](?:CN|CON)$/.test(letters)) return { kind: 'connector', confidence: 'medium', reason: `designator ${letters} is a connector with a vendor letter` };
  }
  // The designator decides nothing: the package and value, then the pin count.
  if (rule && hasMatching(words, TRANSFORMER_TOKEN)) return part('medium', `designator ${letters} with a transformer package or value`);
  const named = fromWords(words, value, pinCount);
  if (named) return named;
  if (rule) { // T, TR: a transistor with three pads, else probably a transformer
    if (pinCount === 3) return { kind: 'transistor', confidence: 'low', reason: `designator ${letters} with three pads` };
    return part('low', `designator ${letters} is a transistor or a transformer`);
  }
  if (pinCount === 0) return { kind: 'mechanical', confidence: 'low', reason: 'no pads' };
  if (pinCount === 1 && (has(words, 'PAD', 'TEST', 'POINT') || hasForm(words, TESTPOINT_FORM))) return { kind: 'testpoint', confidence: 'medium', reason: 'one pad and a test-point word' };
  return part('low', letters ? `unknown designator ${letters}` : 'no designator');
}

function jumperOrHeader(pinCount: number | undefined): PartKindResult {
  if (pinCount !== undefined && pinCount >= 4) return { kind: 'connector', confidence: 'medium', reason: `designator JP with ${pinCount} pads is a header` };
  return { kind: 'jumper', confidence: pinCount === undefined ? 'medium' : 'high', reason: pinCount === undefined ? 'designator JP' : `designator JP with ${pinCount} pads` };
}

/** `classifyPart` for a board component (the pin count comes from its pad list); `libId` only when the cross-probe is unique. */
export function classifyComponent(component: PartKindSource, libId?: string): PartKindResult {
  return classifyPart({ ref: component.ref, value: component.value, package: component.package, pinCount: component.pinIds?.length, libId });
}
