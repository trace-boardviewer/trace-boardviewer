/*
 * Small board writers for the synthetic library: GenCAD, BVR3, BRD2, KiCad PCB, IPC-D-356 and a pin-list CSV. Each turns a BoardModel
 * into bytes a reader of the application parses (src/lib/library/testing/board-writers.test.ts checks every writer against the
 * real reader). The registry is open: a bigger writer (the benchmark's streaming GenCAD generator) can be registered under an id
 * of its own, and the generator picks it up through `boardWriters()`.
 */
import type { BoardModel, Part, PinNumbering } from './board-model.ts';
import { defaultNumber, ordinalNumber } from './board-model.ts';
import { patchBenchGencad } from './bench-boards.ts';
import type { Rng } from './rng.ts';

export interface BoardMeta {
  boardNumber: string;
  revision: string;
  title: string;
  vendor: string;
  /** YYYY-MM-DD */
  date: string;
  /** Write the board number and revision into the format's header where it has one. */
  includeHeader: boolean;
  /** IC values appear as "U7100_PARTNO" (the own reference in front) instead of "PARTNO". */
  valueStyle: 'plain' | 'ref-prefixed';
}

export interface BoardWriter {
  /** Format id of the ground truth ('gencad', 'bvr', 'brd2', 'kicad', 'ipc356', 'pinlist'). */
  id: string;
  variant?: string;
  /** Lower-case extensions, the first is the usual one. */
  extensions: readonly string[];
  /** The pin number the file keeps, which is what the reader's fingerprint sees. */
  numbering: PinNumbering;
  /** The file has a value column, so part numbers can be read from it. */
  carriesValues: boolean;
  /** The format has a header that can carry the board number (the writer uses it when `includeHeader`). */
  hasHeader: boolean;
  /** Selection weight of a family's formats. */
  weight: number;
  write(board: BoardModel, meta: BoardMeta, rng: Rng): Uint8Array;
}

const encoder = new TextEncoder();
const mil = (mm: number): number => Math.round(mm / 0.0254);
const clean = (text: string): string => text.replace(/["\\\r\n]/g, ' ');
const displayValue = (part: Part, meta: BoardMeta): string => (part.mpn && meta.valueStyle === 'ref-prefixed' ? `${part.ref}_${part.value}` : part.value);

// ---- GenCAD ---------------------------------------------------------------------------------------------------------------

function writeGencad(board: BoardModel, meta: BoardMeta): Uint8Array {
  // A board that came from the benchmark generator keeps that generator's text (header and IC values patched).
  if (board.benchText) return encoder.encode(patchBenchGencad(board.benchText, meta.includeHeader ? { drawing: meta.boardNumber, revision: meta.revision, user: `${meta.vendor} synthetic library` } : null, board.benchDeviceValues ?? {}));
  const shapes = new Map<string, string>();
  const shapeLines: string[] = [];
  const devices = new Map<string, string>();
  const deviceLines: string[] = [];
  const components: string[] = [];
  const signals = new Map<string, string[]>();
  for (const part of board.parts) {
    const signature = `${part.pkg}|${part.pins.map(pin => `${pin.number}@${pin.dx},${pin.dy}`).join(';')}`;
    let shape = shapes.get(signature);
    if (!shape) {
      shape = `S${shapes.size + 1}`;
      shapes.set(signature, shape);
      shapeLines.push(`SHAPE ${shape}`, ...part.pins.map(pin => `PIN ${pin.number} PS ${pin.dx} ${pin.dy} TOP 0 0`));
    }
    const deviceKey = `${part.value}|${part.pkg}`;
    let device = devices.get(deviceKey);
    if (!device) {
      device = `D${devices.size + 1}`;
      devices.set(deviceKey, device);
      deviceLines.push(`DEVICE ${device}`, `VALUE "${clean(part.value)}"`, `PACKAGE "${clean(part.pkg)}"`);
    }
    components.push(`COMPONENT ${part.ref}`, `PLACE ${part.x} ${part.y}`, `LAYER ${part.side === 'top' ? 'TOP' : 'BOTTOM'}`, `ROTATION ${part.rotation}`, `SHAPE ${shape} 0 0`, `DEVICE ${device}`);
    if (part.mpn && meta.valueStyle === 'ref-prefixed') components.push(`VALUE "${clean(displayValue(part, meta))}"`);
    for (const pin of part.pins) if (pin.net) (signals.get(pin.net) ?? signals.set(pin.net, []).get(pin.net)!).push(`NODE ${part.ref} ${pin.number}`);
  }
  const header = ['$HEADER', 'GENCAD 1.4', `USER "${clean(meta.vendor)} synthetic library"`];
  if (meta.includeHeader) header.push(`DRAWING "${clean(meta.boardNumber)}"`, `REVISION "${clean(meta.revision)}"`);
  header.push('UNITS MM', 'ORIGIN 0 0', '$ENDHEADER');
  const signalLines: string[] = [];
  for (const [name, nodes] of signals) signalLines.push(`SIGNAL ${/[\s"]/.test(name) ? `"${name}"` : name}`, ...nodes);
  const text = [
    ...header, '$BOARD', `RECTANGLE 0 0 ${board.width} ${board.height}`, '$ENDBOARD',
    '$PADS', 'PAD P ROUND -1', 'CIRCLE 0 0 0.2', '$ENDPADS', '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS',
    '$SHAPES', ...shapeLines, '$ENDSHAPES', '$COMPONENTS', ...components, '$ENDCOMPONENTS', '$DEVICES', ...deviceLines, '$ENDDEVICES', '$SIGNALS', ...signalLines, '$ENDSIGNALS', '',
  ].join('\n');
  return encoder.encode(text);
}

// ---- BVR3 -----------------------------------------------------------------------------------------------------------------

function writeBvr3(board: BoardModel): Uint8Array {
  const lines = ['BVRAW_FORMAT_3', `OUTLINE_POINTS 0 0 ${mil(board.width)} 0 ${mil(board.width)} ${mil(board.height)} 0 ${mil(board.height)}`];
  let unconnected = 0;
  for (const part of board.parts) {
    const side = part.side === 'top' ? 'T' : 'B';
    lines.push(`PART_NAME ${part.ref}`, `PART_SIDE ${side}`, `PART_ORIGIN ${mil(part.x)} ${mil(part.y)}`, `PART_MOUNT ${part.cls === 'J' ? 'TH' : 'SMD'}`);
    for (const pin of part.pins) {
      lines.push(`PIN_NUMBER ${pin.number}`, `PIN_SIDE ${side}`, `PIN_ORIGIN ${mil(pin.dx)} ${mil(pin.dy)}`, `PIN_RADIUS ${part.cls === 'J' ? 20 : 8}`, `PIN_NET ${pin.net || `UNCONNECTED${++unconnected}`}`, 'PIN_END');
    }
    lines.push('PART_END');
  }
  return encoder.encode(lines.join('\r\n') + '\r\n');
}

// ---- BRD2 -----------------------------------------------------------------------------------------------------------------

function writeBrd2(board: BoardModel): Uint8Array {
  const netIds = new Map<string, number>();
  const idOf = (name: string): number => netIds.get(name) ?? (netIds.set(name, netIds.size + 1), netIds.size);
  const partRows: string[] = [], pinRows: string[] = [];
  let start = 0;
  for (const part of board.parts) {
    const half = 100;
    partRows.push(`${part.ref} ${mil(part.x) - half} ${mil(part.y) - half} ${mil(part.x) + half} ${mil(part.y) + half} ${start} ${part.side === 'top' ? 1 : 2}`);
    for (const pin of part.pins) pinRows.push(`${mil(part.x + pin.dx)} ${mil(part.y + pin.dy)} ${idOf(pin.net || 'UNCONNECTED1')} ${part.side === 'top' ? 1 : 2}`);
    start += part.pins.length;
  }
  const w = mil(board.width), h = mil(board.height);
  const lines = [`BRDOUT: 4 ${w} ${h}`, '0 0', `${w} 0`, `${w} ${h}`, `0 ${h}`, `NETS: ${netIds.size}`, ...[...netIds].map(([name, id]) => `${id} ${name}`), `PARTS: ${partRows.length}`, ...partRows, `PINS: ${pinRows.length}`, ...pinRows];
  return encoder.encode(lines.join('\n') + '\n');
}

// ---- KiCad PCB ------------------------------------------------------------------------------------------------------------

function writeKicad(board: BoardModel, meta: BoardMeta): Uint8Array {
  const q = (text: string): string => `"${clean(text)}"`;
  const netIds = new Map<string, number>([['', 0]]);
  const idOf = (name: string): number => netIds.get(name) ?? (netIds.set(name, netIds.size), netIds.size - 1);
  const footprints: string[] = [];
  for (const part of board.parts) {
    const layer = part.side === 'top' ? 'F.Cu' : 'B.Cu';
    const thru = part.cls === 'J';
    const pads = part.pins.map(pin => {
      const net = pin.net ? ` (net ${idOf(pin.net)} ${q(pin.net)})` : '';
      return thru
        ? `(pad ${q(pin.number)} thru_hole circle (at ${pin.dx} ${pin.dy}) (size 1.2 1.2) (drill 0.7) (layers "*.Cu" "*.Mask")${net})`
        : `(pad ${q(pin.number)} smd rect (at ${pin.dx} ${pin.dy}) (size 0.5 0.5) (layers ${q(layer)})${net})`;
    });
    footprints.push(`(footprint ${q(`Synthetic:${part.pkg}`)} (layer ${q(layer)}) (at ${part.x} ${part.y} ${part.rotation}) (property "Reference" ${q(part.ref)}) (property "Value" ${q(displayValue(part, meta))}) ${pads.join(' ')})`);
  }
  const title = meta.includeHeader ? `(title_block (title ${q(meta.title)}) (date ${q(meta.date)}) (rev ${q(meta.revision)}) (company ${q(meta.vendor)}) (comment 1 ${q(`Board ${meta.boardNumber}`)}))` : '';
  const text = `(kicad_pcb (version 20240108) (generator "synthetic") (generator_version "1.0") (general (thickness 1.6)) (paper "A3") ${title}
  ${[...netIds].map(([name, id]) => `(net ${id} ${q(name)})`).join(' ')}
  ${footprints.join('\n  ')}
  (gr_rect (start 0 0) (end ${board.width} ${board.height}) (layer "Edge.Cuts")))
`;
  return encoder.encode(text);
}

// ---- IPC-D-356 ------------------------------------------------------------------------------------------------------------

function writeIpc356(board: BoardModel, meta: BoardMeta): Uint8Array {
  const lines = ['C  Synthetic IPC-D-356A netlist written for the library test set (no real design)'];
  if (meta.includeHeader) lines.push(`P  JOB   ${meta.boardNumber}`, `P  TITLE ${meta.title.slice(0, 60)}`);
  lines.push('P  VER   IPC-D-356A', 'P  CODE  00', 'P  UNITS CUST 0', 'P  arrayDim   N');
  const coordinate = (axis: 'X' | 'Y', mm: number): string => { const value = Math.round(mm / 0.00254); return `${axis}${value < 0 ? '-' : '+'}${String(Math.abs(value)).padStart(6, '0')}`; };
  for (const part of board.parts) {
    for (const pin of part.pins) {
      const through = part.cls === 'J';
      const net = (pin.net ? pin.net.slice(-14) : 'N/C').padEnd(14);
      const access = through ? 'A00' : part.side === 'top' ? 'A01' : 'A02';
      lines.push(`${through ? '317' : '327'}${net}   ${part.ref.slice(0, 6).padEnd(6)}-${pin.number.slice(0, 4).padEnd(4)} ${through ? 'D0472P' : '      '}${access}${coordinate('X', part.x + pin.dx)}${coordinate('Y', part.y + pin.dy)}X0236Y0236R000S${part.side === 'top' ? '2' : '1'}`);
    }
  }
  lines.push('999');
  return encoder.encode(lines.join('\n') + '\n');
}

// ---- pin-list CSV ---------------------------------------------------------------------------------------------------------

function writePinList(board: BoardModel, meta: BoardMeta): Uint8Array {
  const cell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines: string[] = [];
  if (meta.includeHeader) lines.push(`Pin list for board ${meta.boardNumber} revision ${meta.revision}`, `Exported for ${meta.title}`, '');
  lines.push('Ref,Pin,Net,Value,Package,X (mm),Y (mm),Side');
  for (const part of board.parts) for (const pin of part.pins) lines.push([part.ref, pin.number, pin.net, displayValue(part, meta), part.pkg, (part.x + pin.dx).toFixed(2), (part.y + pin.dy).toFixed(2), part.side === 'top' ? 'F.Cu' : 'B.Cu'].map(cell).join(','));
  return encoder.encode(lines.join('\r\n') + '\r\n');
}

const BUILT_IN: BoardWriter[] = [
  { id: 'gencad', variant: 'GENCAD 1.4', extensions: ['.cad', '.gcd'], numbering: defaultNumber, carriesValues: true, hasHeader: true, weight: 30, write: (board, meta) => writeGencad(board, meta) },
  { id: 'bvr', variant: 'BVRAW_FORMAT_3', extensions: ['.bvr'], numbering: defaultNumber, carriesValues: false, hasHeader: false, weight: 20, write: board => writeBvr3(board) },
  { id: 'kicad', extensions: ['.kicad_pcb'], numbering: defaultNumber, carriesValues: true, hasHeader: true, weight: 14, write: (board, meta) => writeKicad(board, meta) },
  { id: 'brd2', variant: 'BRD2', extensions: ['.brd'], numbering: ordinalNumber, carriesValues: false, hasHeader: false, weight: 12, write: board => writeBrd2(board) },
  { id: 'ipc356', variant: 'IPC-D-356A', extensions: ['.ipc', '.d356'], numbering: defaultNumber, carriesValues: false, hasHeader: true, weight: 10, write: (board, meta) => writeIpc356(board, meta) },
  { id: 'pinlist', extensions: ['.csv'], numbering: defaultNumber, carriesValues: true, hasHeader: true, weight: 8, write: (board, meta) => writePinList(board, meta) },
];

const registry = new Map<string, BoardWriter>(BUILT_IN.map(writer => [writer.id, writer]));

/** Adds or replaces a writer (the full GenCAD board set registers its writer under 'gencad'). */
export function registerBoardWriter(writer: BoardWriter): void { registry.set(writer.id, writer); }
export const boardWriters = (): BoardWriter[] => [...registry.values()];
export const boardWriter = (id: string): BoardWriter => {
  const writer = registry.get(id);
  if (!writer) throw new Error(`no board writer for format "${id}"`);
  return writer;
};
