/*
 * Text-based documents of the synthetic library: structured KiCad schematics (with a title block that carries the board number),
 * bills of materials as CSV and as a minimal XLSX workbook, and unrelated text files.
 */
import type { BoardModel, Part } from './board-model.ts';
import type { Rng } from './rng.ts';
import { buildZip } from './zip.ts';
import { PROSE_NOUNS, PROSE_PLACES, PROSE_VERBS } from './words.ts';

const encoder = new TextEncoder();
const clean = (text: string): string => text.replace(/["\\\r\n]/g, ' ');

// ---- KiCad schematic -------------------------------------------------------------------------------------------------------

export interface KicadSchSpec {
  board: BoardModel;
  title: string;
  revision: string;
  company: string;
  date: string;
  boardNumber: string;
  /** The board number is written into comment 1 of the title block. */
  includeBoardNumber: boolean;
}

const EFFECTS = '(effects (font (size 1.27 1.27)))';
const HIDDEN = '(effects (font (size 1.27 1.27)) (hide yes))';
const uuid = (rng: Rng): string => `${rng.alnum(8)}-${rng.alnum(4)}-4${rng.alnum(3)}-8${rng.alnum(3)}-${rng.alnum(12)}`.toLowerCase();

function libSymbol(id: string, numbers: readonly string[]): string {
  const rows = numbers.map((number, i) => `(pin passive line (at -5.08 ${(-i * 2.54).toFixed(2)} 0) (length 2.54) (name "~" ${EFFECTS}) (number "${clean(number)}" ${EFFECTS}))`);
  const height = (numbers.length * 2.54).toFixed(2);
  return `(symbol "${id}" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 2 0) ${EFFECTS}) (property "Value" "${id}" (at 0 -${(numbers.length * 2.54 + 2).toFixed(2)} 0) ${EFFECTS}) (property "Footprint" "" (at 0 0 0) ${HIDDEN}) (property "Datasheet" "~" (at 0 0 0) ${HIDDEN})
    (symbol "${id.split(':')[1]}_0_1" (rectangle (start -2.54 1.27) (end 2.54 -${height}) (stroke (width 0.254) (type default)) (fill (type background))))
    (symbol "${id.split(':')[1]}_1_1" ${rows.join(' ')}))`;
}

/** A single-sheet KiCad schematic (version 20231120) with one symbol per part and no wires. The library symbols carry the board's pin numbers, so the schematic and the board have the same (reference, pin) set. */
export function buildKicadSchematic(spec: KicadSchSpec, rng: Rng): Uint8Array {
  const root = uuid(rng);
  const signatureOf = (part: Part): string => part.pins.map(pin => pin.number).join('|');
  const signatures = [...new Set(spec.board.parts.map(signatureOf))].sort();
  const symbolOf = new Map(signatures.map((signature, i) => [signature, `Synth:S${i + 1}`] as const));
  const lib = signatures.map(signature => libSymbol(symbolOf.get(signature)!, signature.split('|'))).join('\n  ');
  const columns = 12;
  const symbols = spec.board.parts.map((part: Part, i) => {
    const x = 30 + (i % columns) * 30, y = 40 + Math.floor(i / columns) * 30;
    const properties = [
      `(property "Reference" "${part.ref}" (at ${x + 2} ${y} 90) ${EFFECTS})`, `(property "Value" "${clean(part.value)}" (at ${x - 2} ${y} 90) ${EFFECTS})`,
      `(property "Footprint" "${clean(part.pkg)}" (at ${x} ${y} 0) ${HIDDEN})`, `(property "Datasheet" "~" (at ${x} ${y} 0) ${HIDDEN})`,
      ...(part.mpn ? [`(property "MPN" "${clean(part.mpn)}" (at ${x} ${y} 0) ${HIDDEN})`] : []),
    ];
    return `(symbol (lib_id "${symbolOf.get(signatureOf(part))}") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid(rng)}")
  ${properties.join(' ')}
  (instances (project "synthetic" (path "/${root}" (reference "${part.ref}") (unit 1)))))`;
  });
  const comment = spec.includeBoardNumber ? `(comment 1 "Board ${clean(spec.boardNumber)}")` : '';
  const text = `(kicad_sch (version 20231120) (generator "synthetic") (generator_version "8.0") (uuid "${root}") (paper "A1")
  (title_block (title "${clean(spec.title)}") (date "${spec.date}") (rev "${clean(spec.revision)}") (company "${clean(spec.company)}") ${comment})
  (lib_symbols ${lib})
  ${symbols.join('\n  ')}
  (sheet_instances (path "/" (page "1"))))
`;
  return encoder.encode(text);
}

// ---- BOM ---------------------------------------------------------------------------------------------------------------------

export interface BomSpec { board: BoardModel; boardNumber: string; revision: string; title: string; includeTitle: boolean }
const BOM_HEADER = ['Ref', 'Value', 'MPN', 'Package', 'Qty'];

export function bomRows(spec: BomSpec): string[][] {
  return spec.board.parts.map(part => [part.ref, part.value && !part.mpn ? part.value : '', part.mpn ?? '', part.pkg, '1']);
}

export function buildBomCsv(spec: BomSpec): Uint8Array {
  const cell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines: string[] = [];
  if (spec.includeTitle) lines.push(`Bill of materials,${cell(spec.title)}`, `Board,${spec.boardNumber}`, `Revision,${spec.revision}`, '');
  lines.push(BOM_HEADER.join(','), ...bomRows(spec).map(row => row.map(cell).join(',')));
  return encoder.encode(lines.join('\r\n') + '\r\n');
}

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal workbook (one sheet of inline strings) written with the ZIP writer. */
export function buildBomXlsx(spec: BomSpec): Uint8Array {
  const rows: string[][] = [];
  if (spec.includeTitle) rows.push(['Bill of materials', spec.title], ['Board', spec.boardNumber], ['Revision', spec.revision], []);
  rows.push(BOM_HEADER, ...bomRows(spec));
  const column = (index: number): string => String.fromCharCode(65 + index);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="BOM" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  return buildZip(files.map(([name, text]) => ({ name, data: encoder.encode(text) })));
}

// ---- unrelated text -----------------------------------------------------------------------------------------------------------

export type UnrelatedTextKind = 'note' | 'log' | 'ini' | 'json' | 'html' | 'csv';

const sentence = (rng: Rng): string => `${rng.pick(PROSE_VERBS)} the ${rng.pick(PROSE_NOUNS)} at ${rng.pick(PROSE_PLACES)}.`;

export function buildUnrelatedText(kind: UnrelatedTextKind, rng: Rng, lines: number): Uint8Array {
  const rows = Array.from({ length: Math.max(1, lines) }, () => sentence(rng));
  let text: string;
  if (kind === 'log') text = rows.map((row, i) => `2023-0${rng.int(1, 9)}-${String(rng.int(10, 28))} 12:${String(i % 60).padStart(2, '0')}:00 INFO ${row}`).join('\n');
  else if (kind === 'ini') text = `[session]\nuser=technician\nlast=${rng.int(1, 999)}\n[notes]\n${rows.map((row, i) => `n${i}=${row}`).join('\n')}`;
  else if (kind === 'json') text = JSON.stringify({ notes: rows, count: rows.length, id: rng.alnum(8) }, null, 1);
  else if (kind === 'html') text = `<html><body><h1>Notes</h1>${rows.map(row => `<p>${row}</p>`).join('')}</body></html>`;
  else if (kind === 'csv') text = ['item,qty,price', ...rows.map((row, i) => `${row.split(' ')[1]}${i},${rng.int(1, 20)},${rng.int(1, 99)}.${rng.int(10, 99)}`)].join('\n');
  else text = rows.join('\n');
  return encoder.encode(text + '\n');
}
