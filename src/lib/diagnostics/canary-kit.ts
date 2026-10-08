/*
 * Test support for the diagnostic report (never imported by the application): original synthetic files of every format the
 * diagnostic collector describes, written by hand from the public format descriptions, with unique "canary" values in every place
 * where a real file carries content: reference designators, net names, pin names, part values, package names, titles, company
 * names, coordinates and the decryption key. The privacy tests prove that none of them reaches a report, in any encoding.
 * No vendor, customer or downloaded file is used anywhere.
 */
import CFB from 'cfb';
import { zlibSync } from 'fflate';
import { fzKeyParityValid, rc6Feedback } from '../formats/crypto';
import type { FormatId, HookId } from './report';

export const CANARY_PREFIX = 'QZX7';
/** Names seeded as text. Every value starts with a prefix no format keyword and no count can produce. */
export const NAMES = {
  refs: ['QZX7R101', 'QZX7U202', 'QZX7C303'],
  nets: ['QZX7NET_ALPHA', 'QZX7NET_BETA', 'QZX7NET_GAMMA'],
  values: ['QZX7V47K', 'QZX7V100NF'],
  packages: ['QZX7PKG_ONE', 'QZX7PKG_TWO'],
  pins: ['QZX7P1', 'QZX7P2'],
  title: 'QZX7TITLE Acme Customer Board Rev 9',
  company: 'QZX7CORP',
  layer: 'QZX7LAYER',
} as const;
/** Coordinates seeded as decimal text, by unit of the format that carries them. */
export const COORDS = {
  mm: ['71.3917', '52.8013', '38.4429'],
  inch: ['2.8107', '2.0787', '1.5135'],
  mil: ['2810.7391', '2078.7013', '1513.5411'],
  integer: ['73914417', '52801359', '44292288'],
  small: ['7391', '5280', '4429'],
} as const;
/** Canary decryption keys: FZ/CAE are 44 words (every word is a canary), XZZ is 16 hexadecimal digits. */
export const FZ_CANARY_KEY: readonly number[] = parityKey(0x51c3a7);
export const XZZ_CANARY_KEY = '9F3A7C51E2B84D06';

export interface BuiltFile {
  /** What the file is, for test names. */
  label: string;
  /** The name the parsers are given (the extension selects some readers). */
  name: string;
  data: Uint8Array;
  companions?: Record<string, Uint8Array>;
  options?: { fzKey?: number[]; xzzKey?: string };
  /** The reader that must claim the file, and the hook that must describe it. */
  format: FormatId;
  hook: HookId;
  /** Numbers the file carries as binary integers (checked as decimal text and as little- and big-endian bytes). */
  integers: number[];
}

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);
const lines = (rows: readonly string[], eol = '\n'): Uint8Array => utf8(rows.join(eol) + eol);
const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
const u16 = (value: number) => [value & 255, value >>> 8 & 255];
const [R1, U2, C3] = NAMES.refs, [NET_A, NET_B, NET_C] = NAMES.nets, [VALUE_A, VALUE_B] = NAMES.values, [PKG_A, PKG_B] = NAMES.packages, [PIN_1, PIN_2] = NAMES.pins;

/** A 44-word key whose per-word parity satisfies the upstream FZ or CAE table, derived from a seed. */
export function parityKey(seed: number, variant: 'fz' | 'cae' = 'fz'): number[] {
  const table = variant === 'cae'
    ? [1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0]
    : [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
  const key = Array.from({ length: 44 }, (_, index) => {
    const word = (Math.imul(seed + index, 0x9e3779b1) ^ (seed * 7919)) >>> 0;
    const even = (word.toString(2).match(/1/g)?.length ?? 0) % 2 === 0 ? 1 : 0;
    return even === table[index] ? word : (word ^ 1) >>> 0;
  });
  if (!fzKeyParityValid(key, variant)) throw new Error('canary key construction failed');
  return key;
}

// --- Text formats -------------------------------------------------------------------------------------------------------------------
const [MX, MY, MZ] = COORDS.mm, [IX, IY, IZ] = COORDS.inch, [LX, LY, LZ] = COORDS.mil;

export function gencad(): BuiltFile {
  const rows = [
    '$HEADER', 'GENCAD 1.4', `USER "${NAMES.company}"`, `DRAWING "${NAMES.title}"`, 'UNITS MM', 'ORIGIN 0 0', '$ENDHEADER',
    '$BOARD', 'RECTANGLE 0 0 80 60', '$ENDBOARD',
    '$PADS', `PAD ${NAMES.layer}P ROUND -1`, 'CIRCLE 0 0 0.2', '$ENDPADS',
    '$PADSTACKS', `PADSTACK ${NAMES.layer}PS 0`, `PAD ${NAMES.layer}P TOP 0 0`, '$ENDPADSTACKS',
    '$SHAPES', `SHAPE ${PKG_A}`, 'RECTANGLE -2 -1 4 2', `PIN ${PIN_1} ${NAMES.layer}PS -1 0 TOP 0 0`, `PIN ${PIN_2} ${NAMES.layer}PS 1 0 TOP 0 0`, '$ENDSHAPES',
    '$COMPONENTS',
    `COMPONENT ${R1}`, `PLACE ${MX} ${MY}`, 'LAYER TOP', 'ROTATION 0', `SHAPE ${PKG_A} 0 0`, 'DEVICE QZX7D1',
    `COMPONENT ${U2}`, `PLACE ${MY} ${MZ}`, 'LAYER BOTTOM', 'ROTATION 90', `SHAPE ${PKG_A} 0 0`, 'DEVICE QZX7D2',
    '$ENDCOMPONENTS',
    '$DEVICES', 'DEVICE QZX7D1', `VALUE "${VALUE_A}"`, 'DEVICE QZX7D2', `VALUE "${VALUE_B}"`, '$ENDDEVICES',
    '$SIGNALS', `SIGNAL ${NET_A}`, `NODE ${R1} ${PIN_1}`, `NODE ${U2} ${PIN_1}`, `SIGNAL ${NET_B}`, `NODE ${R1} ${PIN_2}`, '$ENDSIGNALS',
  ];
  return { label: 'GenCAD 1.4', name: 'board.cad', data: lines(rows, '\r\n'), format: 'gencad', hook: 'gencad', integers: [] };
}

export function kicad(): BuiltFile {
  const footprint = (ref: string, value: string, x: string, y: string, pkg: string, net: number, netName: string) => [
    ` (footprint "${NAMES.layer}:${pkg}" (layer "F.Cu") (at ${x} ${y} 90) (property "Reference" "${ref}") (property "Value" "${value}")`,
    '  (fp_rect (start -3 -2) (end 3 2) (layer "F.Fab"))',
    `  (pad "${PIN_1}" smd rect (at 2 3 90) (size 2 1) (layers "F.Cu") (net ${net} "${netName}"))`,
    `  (pad "${PIN_2}" smd rect (at -2 3 90) (size 2 1) (layers "F.Cu") (net ${net} "${netName}")))`,
  ];
  const rows = [
    `(kicad_pcb (version 20240108) (generator "pcbnew") (general (title "${NAMES.title}") (company "${NAMES.company}"))`,
    ` (net 0 "") (net 1 "${NET_A}") (net 2 "${NET_B}")`,
    ...footprint(R1, VALUE_A, MX, MY, PKG_A, 1, NET_A),
    ...footprint(U2, VALUE_B, MY, MZ, PKG_B, 2, NET_B),
    ' (gr_rect (start 0 0) (end 80 60) (layer "Edge.Cuts")))',
  ];
  return { label: 'KiCad PCB 8', name: 'board.kicad_pcb', data: lines(rows), format: 'kicad', hook: 'kicad', integers: [] };
}

export function eagle(): BuiltFile {
  const wire = (x1: number, y1: number, x2: number, y2: number) => `<wire x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" width="0" layer="20"/>`;
  const layers = `<layers><layer number="1" name="Top" color="4" fill="1" visible="yes" active="yes"/><layer number="16" name="Bottom" color="1" fill="1" visible="yes" active="yes"/><layer number="20" name="Dimension" color="15" fill="1" visible="yes" active="yes"/></layers>`;
  const text = `<?xml version="1.0" encoding="utf-8"?>\n<eagle version="9.6.2"><drawing><settings><setting alwaysvectorfont="no"/></settings>${layers}<board><plain>${wire(0, 0, 80, 0)}${wire(80, 0, 80, 60)}${wire(80, 60, 0, 60)}${wire(0, 60, 0, 0)}</plain>`
    + `<libraries><library name="${NAMES.layer}lib"><packages><package name="${PKG_A}"><smd name="${PIN_1}" x="-1" y="0" dx="1" dy="1" layer="1"/><smd name="${PIN_2}" x="1" y="0" dx="1" dy="1" layer="1"/></package></packages></library></libraries>`
    + `<elements><element name="${R1}" library="${NAMES.layer}lib" package="${PKG_A}" value="${VALUE_A}" x="${MX}" y="${MY}"/><element name="${U2}" library="${NAMES.layer}lib" package="${PKG_A}" value="${VALUE_B}" x="${MY}" y="${MZ}" rot="R90"/></elements>`
    + `<signals><signal name="${NET_A}" class="0"><contactref element="${R1}" pad="${PIN_1}"/><contactref element="${U2}" pad="${PIN_1}"/></signal><signal name="${NET_B}" class="0"><contactref element="${R1}" pad="${PIN_2}"/></signal></signals></board></drawing></eagle>\n`;
  return { label: 'EAGLE board XML', name: 'board.brd', data: utf8(text), format: 'eagle', hook: 'eagle', integers: [] };
}

export function altiumAscii(): BuiltFile {
  const rows = [
    `|RECORD=Board|FILENAME=${NAMES.title}.PcbDoc|KIND=Protel_Advanced_PCB|VERSION=5.01|VX0=0mil|VY0=0mil|KIND0=0|VX1=3000mil|VY1=0mil|KIND1=0|VX2=3000mil|VY2=2000mil|KIND2=0|VX3=0mil|VY3=2000mil|KIND3=0`,
    `|RECORD=Net|NAME=${NET_A}`,
    `|RECORD=Component|LAYER=TOP|X=${LX}mil|Y=${LY}mil|ROTATION=90.000|PATTERN=${PKG_A}|SOURCEDESIGNATOR=${R1}|COMMENT=${VALUE_A}`,
    `|RECORD=Pad|NAME=${PIN_1}|COMPONENT=0|NET=0|LAYER=TOP|X=${LY}mil|Y=${LZ}mil|XSIZE=60mil|YSIZE=40mil|SHAPE=RECTANGLE|ROTATION=0`,
  ];
  return { label: 'Altium PcbDoc ASCII', name: 'board.pcbdoc', data: lines(rows, '\r\n'), format: 'altium', hook: 'altium', integers: [] };
}

const concat = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const block = (payload: Uint8Array | number[]) => concat(u32(payload.length), payload);
const propText = (record: Record<string, string>) => '|' + Object.entries(record).map(([key, value]) => `${key}=${value}`).join('|') + '|';
const textBlock = (record: Record<string, string>) => block([...utf8(propText(record)), 0]);
const pascal = (text: string) => block([text.length, ...utf8(text)]);
function altiumPad(name: string, x: number, y: number, net: number, component: number): Uint8Array {
  const main = new Uint8Array(110), view = new DataView(main.buffer);
  main[0] = 1; view.setUint16(1, 0, true); view.setUint16(3, net, true); view.setUint16(5, 0xffff, true); view.setUint16(7, component, true);
  view.setInt32(13, x, true); view.setInt32(17, y, true);
  for (const at of [21, 29, 37]) { view.setInt32(at, 600_000, true); view.setInt32(at + 4, 400_000, true); }
  main[49] = 2; main[50] = 2; main[51] = 2; view.setFloat64(52, 0, true); main[60] = 1;
  return concat([2], pascal(name), block([]), block([]), block([]), block(main), block([]));
}
export function altiumBinary(): BuiltFile {
  const [IA, IB] = COORDS.integer.map(Number);
  const nets = [NET_A, NET_B], components = [
    { SOURCEDESIGNATOR: R1, PATTERN: PKG_A, LAYER: 'TOP', X: `${LX}mil`, Y: `${LY}mil`, ROTATION: '90.000', COMMENT: VALUE_A },
    { SOURCEDESIGNATOR: U2, PATTERN: PKG_B, LAYER: 'BOTTOM', X: `${LY}mil`, Y: `${LZ}mil`, ROTATION: '0', COMMENT: VALUE_B },
  ];
  const pads = [altiumPad(PIN_1, IA, IB, 0, 0), altiumPad(PIN_2, IB, IA, 1, 0), altiumPad(PIN_1, IA, IA, 1, 1)];
  const board = { KIND: 'Protel_Advanced_PCB', VERSION: '5.01', FILENAME: NAMES.title, VX0: '0mil', VY0: '0mil', KIND0: '0', VX1: '3000mil', VY1: '0mil', KIND1: '0', VX2: '3000mil', VY2: '2000mil', KIND2: '0', VX3: '0mil', VY3: '2000mil', KIND3: '0' };
  const streams: Record<string, Uint8Array> = {
    '/Board6/Data': textBlock(board),
    '/Nets6/Data': concat(...nets.map(name => textBlock({ NAME: name }))), '/Nets6/Header': Uint8Array.from(u32(nets.length)),
    '/Components6/Data': concat(...components.map(record => textBlock(record))), '/Components6/Header': Uint8Array.from(u32(components.length)),
    '/Pads6/Data': concat(...pads), '/Pads6/Header': Uint8Array.from(u32(pads.length)),
  };
  const cfb = CFB.utils.cfb_new();
  for (const [path, content] of Object.entries(streams)) CFB.utils.cfb_add(cfb, path, content);
  const data = Uint8Array.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array);
  return { label: 'Altium PcbDoc compound file', name: 'board.PcbDoc', data, format: 'altium', hook: 'altium', integers: [IA, IB] };
}

export function samsungCad(): BuiltFile {
  const rows = [
    `###Panel Added: ${NAMES.title}`,
    `COMP  ${R1}   ${VALUE_A}  0  0  ${IX}  ${IY}  1  0`,
    `COMP  ${U2}   ${VALUE_B}  0  0  ${IY}  ${IZ}  2  0`,
    `C_PIN  ${R1}-${PIN_1}    ${IX}   ${IY}  0  0  0  X  /${NET_A}`,
    `C_PIN  ${U2}-${PIN_2}    ${IY}   ${IZ}  0  0  0  X  /${NET_B}`,
  ];
  return { label: 'Samsung CAD', name: 'board.cad', data: lines(rows), format: 'samsung-cad', hook: 'samsung-cad', integers: [] };
}

const sectionHeader = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `; ${NAMES.company} ${tag} header ${index + 1}`);
const BDV_ROWS = [
  '<<format.asc>>', ...sectionHeader(8, 'format'), `${IX} ${IY}`, `${IY} ${IZ}`, `${IZ} ${IX}`, '0.000 1.000',
  '<<pins.asc>>', ...sectionHeader(8, 'pins'),
  `Part ${R1} (T)`, `1  1  ${IX} ${IY}  1  ${NET_A}  5`, `Part ${U2} (B)`, `2  1  ${IY} ${IZ}  1  ${NET_B}  5`,
  '<<nails.asc>>', ...sectionHeader(7, 'nails'),
];
/** The reader's per-line cipher is its own inverse: every byte except CR, LF and NUL becomes (key - byte) mod 256; the key grows with each CR LF. */
function bdvCipher(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let key = 0xa0;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index];
    if (byte === 13 && data[index + 1] === 10) key++;
    out[index] = byte === 13 || byte === 10 || byte === 0 ? byte : (key - byte) & 0xff;
    if (key > 285) key = 159;
  }
  return out;
}
export const bdvPlain = (): BuiltFile => ({ label: 'Honhan BDV plain', name: 'board.bdv', data: lines(BDV_ROWS, '\r\n'), format: 'bdv', hook: 'bdv', integers: [] });
export const bdvEncoded = (): BuiltFile => ({ label: 'Honhan BDV encoded', name: 'board.bdv', data: bdvCipher(lines(BDV_ROWS, '\r\n')), format: 'bdv', hook: 'bdv', integers: [] });

export function bvr3(): BuiltFile {
  const part = (ref: string, side: string, x: string, y: string, net: string, pin: string) => [
    `PART_NAME ${ref}`, `PART_SIDE ${side}`, `PART_ORIGIN ${x} ${y}`, `PIN_NUMBER ${pin}`, `PIN_NAME ${pin}`, `PIN_SIDE ${side}`, 'PIN_ORIGIN 0 0', 'PIN_RADIUS 5', `PIN_NET ${net}`, 'PIN_END', 'PART_END',
  ];
  const rows = ['BVRAW_FORMAT_3', ...part(R1, 'T', LX, LY, NET_A, PIN_1), ...part(U2, 'B', LY, LZ, NET_B, PIN_2)];
  return { label: 'BVRAW_FORMAT_3', name: 'board.bvr', data: lines(rows, '\r\n'), format: 'bvr', hook: 'bvr', integers: [] };
}
export function bvr1(): BuiltFile {
  const rows = ['BVRAW_FORMAT_1', '<<Layout>>', 'X,Y', '0.000,0.000', '2.000, 0.000', '2.000 1.000', '0.000,1.000', '<<Pin>>', 'PART SIDE ID NAME X Y LAYER NET',
    `${R1}\t(T)\t1\t${PIN_1}\t${IX}\t${IY}\t1\t${NET_A}`, `${U2} (B) 1 ${PIN_2} ${IY} ${IZ} 2 ${NET_B}`, '<<Nail>>', 'TAG X Y TYPE GRID SIDE NETID NET', `${NAMES.layer}N1\t${IX} ${IY} 1 G1 (T) 3 ${NET_A}`];
  return { label: 'BVRAW_FORMAT_1', name: 'board.bvr', data: lines(rows), format: 'bvr1', hook: 'bvr', integers: [] };
}

const encodeLandrex = (data: Uint8Array) => data.map(byte => byte === 0 || byte === 10 || byte === 13 ? byte : ((~byte & 0xff) >>> 2 | (~byte & 0xff) << 6) & 0xff);
const [SX, SY, SZ] = COORDS.small;
const landrexRows = () => ['str_length:', '123', 'var_data:', '4 2 3 1', 'Format:', '0 0', '9000 0', '9000 9000', '0 9000', 'Parts:', `${R1} 1 2`, `${U2} 2 3`, 'Pins:',
  `${SX} ${SY} 0 1 ${NET_A}`, `${SY} ${SZ} 0 1 ${NET_B}`, `${SZ} ${SX} 0 2 ${NET_C}`, 'Nails:', `1 ${SX} ${SZ} 1 ${NET_A}`];
export const brdPlain = (): BuiltFile => ({ label: 'Landrex BRD plain', name: 'board.brd', data: lines(landrexRows()), format: 'brd', hook: 'brd', integers: [] });
export const brdEncoded = (): BuiltFile => ({ label: 'Landrex BRD encoded', name: 'board.brd', data: encodeLandrex(lines(landrexRows(), '\r\n')), format: 'brd', hook: 'brd', integers: [] });
export function brd2(): BuiltFile {
  const rows = ['BRDOUT: 4 9000 9000', '0 0', '9000 0', '9000 9000', '0 9000', 'NETS: 2', `1 ${NET_A}`, `2 ${NET_B}`, 'PARTS: 1', `${R1} 100 100 300 200 0 1`, 'PINS: 2', `${SX} ${SY} 1 1`, `${SY} ${SZ} 2 1`, 'NAILS: 0'];
  return { label: 'TOPTEST BRD2', name: 'board.brd', data: lines(rows), format: 'brd2', hook: 'brd', integers: [] };
}

export function asc(): BuiltFile {
  const trio: Record<string, Uint8Array> = {
    'format.asc': lines([...sectionHeader(8, 'format'), `${IX} ${IY}`, `${IY} ${IZ}`, `${IZ} ${IX}`, '0.000 1.000']),
    'pins.asc': lines([...sectionHeader(8, 'pins'), `Part ${R1} (T)`, `1  1  ${IX} ${IY}  1  ${NET_A}  5`, `Part ${U2} (B)`, `2  1  ${IY} ${IZ}  1  ${NET_B}  5`]),
    'nails.asc': lines(sectionHeader(7, 'nails')),
  };
  const { 'format.asc': primary, ...companions } = trio;
  return { label: 'ASC trio', name: 'format.asc', data: primary, companions, format: 'asc', hook: 'asc', integers: [] };
}

// --- FZ / CAE ------------------------------------------------------------------------------------------------------------------------
const fzText = () => lines([
  'UNIT:thou', 'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!', `S!${R1}!!${PKG_A}!NO!0!`, `S!${U2}!!${PKG_B}!YES!90!`,
  'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!', `S!${NET_A}!${R1}!1!${PIN_1}!${SX}!${SY}!!6!`, `S!${NET_B}!${U2}!2!${PIN_2}!${SY}!${SZ}!!6!`,
  'A!TESTVIA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!X!Y!LOC!RADIUS!', `S!Y!${NET_A}!${R1}!1!${PIN_1}!${SZ}!${SX}!T!10!`,
]);
const fzDescription = () => utf8(`${NAMES.title}\nPARTNO\tDESCRIPTION\tQTY\tLOCATIONS\tPARTNO2\n0001\t${VALUE_A}\t1\t${R1}\t\n0002\t${VALUE_B}\t1\t${U2}\t\n`);
const fzContainer = () => {
  const content = zlibSync(fzText()), description = zlibSync(fzDescription());
  return Uint8Array.from([...u32(content.length), ...content, ...u32(description.length), ...description, ...u32(description.length)]);
};
export const fzDecoded = (): BuiltFile => ({ label: 'FZ decoded content', name: 'board.fz', data: fzText(), format: 'fz', hook: 'fz', integers: [] });
export const caeDecoded = (): BuiltFile => ({ label: 'CAE decoded content', name: 'board.cae', data: fzText(), format: 'fz', hook: 'fz', integers: [] });
export const fzZlib = (): BuiltFile => ({ label: 'FZ unencrypted container', name: 'board.fz', data: fzContainer(), format: 'fz', hook: 'fz', integers: [] });
export const fzEncrypted = (): BuiltFile => ({
  label: 'FZ RC6 container', name: 'board.fz', data: rc6Feedback(fzContainer(), FZ_CANARY_KEY, true), options: { fzKey: [...FZ_CANARY_KEY] }, format: 'fz', hook: 'fz', integers: [...FZ_CANARY_KEY],
});
export const fzEncryptedWithoutKey = (): BuiltFile => ({ ...fzEncrypted(), label: 'FZ RC6 container, no key', options: undefined, integers: [] });

// --- Binary formats -------------------------------------------------------------------------------------------------------------------
const zeros = (count: number) => Array<number>(count).fill(0);
const xblock = (type: number, payload: number[]) => [type, ...u32(payload.length), ...payload];
const xpin = (name: string, x: number, y: number, net: number): number[] => {
  const body = [...zeros(4), ...u32(x), ...u32(y), ...zeros(8), ...u32(name.length), ...utf8(name), ...zeros(32), ...u32(net)];
  return [0x09, ...u32(body.length), ...body];
};
const xpart = (name: string, group: string, pins: number[][]): number[] => {
  const label = [0x06, ...u32(26 + 4 + name.length), ...zeros(26), ...u32(name.length), ...utf8(name)];
  const body = [...zeros(18), ...u32(group.length), ...utf8(group), ...label, ...pins.flat()];
  return [...u32(body.length), ...body];
};
const xline = (x1: number, y1: number, x2: number, y2: number) => xblock(0x05, [...u32(28), ...u32(x1), ...u32(y1), ...u32(x2), ...u32(y2), ...u32(10000), ...u32(0)]);
export function xzz(xor = 0): BuiltFile {
  const [A, B, C] = COORDS.integer.map(Number);
  const main = [
    xline(0, 0, 40_000_000, 0), xline(40_000_000, 0, 40_000_000, 30_000_000), xline(40_000_000, 30_000_000, 0, 30_000_000), xline(0, 30_000_000, 0, 0),
    xblock(0x07, xpart(R1, NAMES.layer, [xpin(PIN_1, A, B, 1), xpin(PIN_2, B, C, 2)])),
    xblock(0x07, xpart(U2, NAMES.layer, [xpin(PIN_1, C, A, 1)])),
  ].flat();
  const nets: Array<[number, string]> = [[1, NET_A], [2, NET_B]];
  const net = nets.flatMap(([index, name]) => [...u32(8 + name.length), ...u32(index), ...utf8(name)]);
  const mainStart = 0x30, netStart = mainStart + 4 + main.length;
  const header = [...utf8('XZZPCB'), ...zeros(mainStart - 6)];
  header.splice(0x20, 4, ...u32(mainStart - 0x20)); header.splice(0x28, 4, ...u32(netStart - 0x20));
  const trailer = [...utf8('v6v6555v6v6'), 1, 2, 3];
  const data = Uint8Array.from([...header, ...u32(main.length), ...main, ...u32(net.length), ...net, ...trailer]);
  if (xor) for (let index = 0; index < data.length - trailer.length; index++) data[index] ^= xor;
  return { label: xor ? 'XZZ PCB obfuscated' : 'XZZ PCB plain', name: 'board.pcb', data, options: { xzzKey: XZZ_CANARY_KEY }, format: 'xzz', hook: 'xzz', integers: [A, B, C] };
}

export function cst(): BuiltFile {
  const data: number[] = [];
  const text = (value: string) => data.push(...utf8(value));
  const [X, Y, Z] = COORDS.small.map(Number);
  const parts = [R1, U2], nets = [NET_A, NET_B];
  data.push(...u16(parts.length), 0, 0, 0, 0, ...u16(4)); text('CDev');
  parts.forEach((ref, index) => { data.push(ref.length); text(ref); data.push(0, 0, 0, 0, index ? 1 : 12, 0, 0, 0, 0, ...u16(index === parts.length - 1 ? nets.length : 0)); });
  for (const net of nets) { data.push(net.length); text(net); }
  const pins: Array<[number, number, number, number]> = [[0, 0, X, Y], [1, 1, Y, Z], [1, 0, Z, X]];
  data.push(...u16(pins.length), 0, 0, 0, 0, ...u16(4)); text('CPad');
  pins.forEach(([part, net, x, y], index) => data.push(...u16(part), ...u16(index + 1), ...u16(net), ...u16(x), ...u16(y), ...u16(0), 0, 0, 0, 0));
  return { label: 'CAST CST', name: 'board.cst', data: Uint8Array.from(data), format: 'cst', hook: 'cst', integers: [X, Y, Z] };
}

/** One file of every format and variant the collector describes with a structure hook. */
export const ALL_BUILDERS: ReadonlyArray<() => BuiltFile> = [
  gencad, kicad, eagle, altiumAscii, altiumBinary, samsungCad, bdvPlain, bdvEncoded, bvr3, bvr1, brdPlain, brdEncoded, brd2, asc, fzDecoded, caeDecoded, fzZlib, fzEncrypted,
  () => xzz(), () => xzz(0x5a), cst,
];
/** Every canary string seeded above (names, titles, layers); numbers are the coordinate lists. */
export const CANARY_STRINGS: readonly string[] = [
  ...NAMES.refs, ...NAMES.nets, ...NAMES.values, ...NAMES.packages, ...NAMES.pins, NAMES.title, NAMES.company, NAMES.layer, CANARY_PREFIX, XZZ_CANARY_KEY, XZZ_CANARY_KEY.toLowerCase(),
];
export const CANARY_NUMBERS: readonly string[] = [...COORDS.mm, ...COORDS.inch, ...COORDS.mil, ...COORDS.integer, ...COORDS.small];

/** Everything a leak check must look for in the report of `file` (strings, numbers, integers and the key material). */
export function secretsOf(file: BuiltFile) {
  const key = file.options?.fzKey;
  const keyBytes = key ? Buffer.concat(key.map(word => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(word >>> 0); return bytes; })) : null;
  const keyBigEndian = key ? Buffer.concat(key.map(word => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(word >>> 0); return bytes; })) : null;
  return {
    strings: [...CANARY_STRINGS, 'Acme', 'Customer', ...(file.options?.xzzKey ? [file.options.xzzKey, file.options.xzzKey.toLowerCase()] : []), ...(key ?? []).map(word => String(word >>> 0))],
    numbers: CANARY_NUMBERS,
    integers: file.integers,
    blobs: [...(keyBytes ? [keyBytes] : []), ...(keyBigEndian ? [keyBigEndian] : [])],
  };
}
