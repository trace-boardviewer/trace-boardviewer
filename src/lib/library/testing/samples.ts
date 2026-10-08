/*
 * Small in-memory builders for tests of other Library modules: one board family (a board in several revisions and formats with the
 * schematic PDF of each revision) made from the same model, writers and document builders as the generator, without the file
 * layout, the chaos or the byte budget. For a whole library with ground truth use `generateMemoryLibrary` (library.ts).
 */
import type { BoardModel } from './board-model.ts';
import { deriveRevision, fingerprintOf, generateBoard, partNumbersOf, pinSetOf, pinSetSize } from './board-model.ts';
import type { BoardMeta } from './board-writers.ts';
import { boardWriter, boardWriters } from './board-writers.ts';
import { makeNumberOfShape, revisionLabels } from './board-numbers.ts';
import type { BoardNumberShapeId } from './board-numbers.ts';
import type { PdfDoc } from './documents.ts';
import { buildSchematicPdf } from './documents.ts';
import { createRng } from './rng.ts';

export interface SampleBoardFile { name: string; format: string; bytes: Uint8Array; fingerprint: string; pinCount: number; partNumbers: string[] }
export interface SampleRevision { label: string; board: BoardModel; boardFiles: SampleBoardFile[]; schematic: PdfDoc & { name: string } }
export interface SampleFamily { vendor: string; model: string; boardNumber: string; revisions: SampleRevision[] }

export interface SampleOptions {
  seed: string | number;
  /** Parts per board (default 90). */
  parts?: number;
  /** Revisions, 1 to 4 (default 2). */
  revisions?: number;
  /** Board writer ids (default: all of them). */
  formats?: string[];
  /** Shape of the board number (default 'la-code'). */
  shape?: BoardNumberShapeId;
  /** Print the board number in the title block of the schematic (default true). */
  titleBlockId?: boolean;
  /** Write the board number into the header of formats that have one (default true). */
  headerId?: boolean;
}

export function sampleFamily(options: SampleOptions): SampleFamily {
  const rng = createRng(`sample/${options.seed}`);
  const vendor = 'Alder', model = 'Heron 14';
  const boardNumber = makeNumberOfShape(options.shape ?? 'la-code', rng.fork('number'));
  const spec = { parts: options.parts ?? 90, refScheme: 'gapped', railStyle: 'pp', alphaBga: true } as const;
  const count = Math.min(4, Math.max(1, options.revisions ?? 2));
  const labels = revisionLabels('letter', count);
  const writers = options.formats ? options.formats.map(id => boardWriter(id)) : boardWriters();
  let board = generateBoard(rng.fork('board'), spec);
  const revisions: SampleRevision[] = labels.map((label, r) => {
    if (r > 0) board = deriveRevision(board, rng.fork(`revision/${r}`), 4, 1, spec).board;
    const meta: BoardMeta = { boardNumber, revision: label, title: `${vendor} ${model} mainboard`, vendor, date: `2024-0${r + 1}-01`, includeHeader: options.headerId !== false, valueStyle: 'plain' };
    const mpns = partNumbersOf(board).map(entry => entry.exact.toUpperCase());
    const boardFiles = writers.map((writer): SampleBoardFile => {
      const set = pinSetOf(board, writer.numbering);
      return { name: `${boardNumber} rev ${label}${writer.extensions[0]}`, format: writer.id, bytes: writer.write(board, meta, rng.fork(`write/${r}/${writer.id}`)), fingerprint: fingerprintOf(set), pinCount: pinSetSize(set), partNumbers: writer.carriesValues ? mpns : [] };
    });
    const doc = buildSchematicPdf({ board, revision: label, boardNumber, model, vendor, date: meta.date, pages: 3, coverage: 1, titleBlockId: options.titleBlockId !== false, docOnlyShare: 0, fillerPerPage: 6, outline: false }, rng.fork(`schematic/${r}`));
    return { label, board, boardFiles, schematic: { ...doc, name: `${boardNumber} schematic rev ${label}.pdf` } };
  });
  return { vendor, model, boardNumber, revisions };
}
