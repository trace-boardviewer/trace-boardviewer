import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { configurePdfResources } from '../../pdf/worker';
import { openPdf } from '../../pdf/document';
import type { PdfHandle } from '../../pdf/document';
import { parseKicadSch } from '../../schematic/kicad-sch';
import { symbolRef } from '../../schematic/model';
import { createRng } from './rng';
import { generateBoard } from './board-model';
import { appendPdfUpdate, buildBoardPdf, buildDatasheetPdf, buildManualPdf, buildScannedPdf, buildSchematicPdf, buildUnrelatedPdf } from './documents';
import { buildBomCsv, buildBomXlsx, buildKicadSchematic, buildUnrelatedText } from './text-docs';

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const folder = (name: string) => `${path.join(pdfjsRoot, name).replace(/\\/g, '/')}/`;
configurePdfResources({
  workerSrc: pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
  cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
});

async function pdfText(data: Uint8Array): Promise<{ pages: number; text: string[] }> {
  const handle: PdfHandle = await openPdf(data);
  try {
    const text: string[] = [];
    for (let page = 1; page <= handle.pageCount; page++) text.push((await handle.getTextItems(page)).map(item => item.str).join('\n'));
    return { pages: handle.pageCount, text };
  } finally { await handle.destroy(); }
}

const board = generateBoard(createRng('docs'), { parts: 90, refScheme: 'gapped', railStyle: 'pp', alphaBga: false });
const common = { board, revision: 'B', boardNumber: 'LA-Z123P', model: 'Heron 14', vendor: 'Alder', date: '2024-03-01' };

describe('schematic PDF', () => {
  const spec = { ...common, pages: 6, coverage: 0.9, titleBlockId: true, docOnlyShare: 0.05, fillerPerPage: 12, outline: true };
  const doc = buildSchematicPdf(spec, createRng('sch'));
  it('prints the title block on every page and reports what it printed', async () => {
    const { pages, text } = await pdfText(doc.bytes);
    expect(pages).toBe(6);
    for (const page of text) { expect(page).toContain('LA-Z123P'); expect(page).toContain('Heron 14'.toUpperCase()); expect(page).toContain('2024-03-01'); }
    expect(doc.titleIds).toEqual(['LA-Z123P']);
    const all = text.join('\n');
    for (const ref of doc.refs) expect(all).toContain(ref);
    for (const number of doc.partNumbers) expect(all).toContain(number);
    expect(doc.refs.length).toBeGreaterThan(70);
    expect(doc.partNumbers.length).toBeGreaterThan(2);
  });
  it('covers the requested share of the board references and adds a few that are not on the board', () => {
    const boardRefs = new Set(board.parts.map(part => part.ref));
    const shared = doc.refs.filter(ref => boardRefs.has(ref)).length;
    expect(shared / boardRefs.size).toBeGreaterThan(0.85);
    expect(shared / boardRefs.size).toBeLessThan(0.95);
    const extra = doc.refs.length - shared;
    expect(extra).toBeGreaterThan(0);
    expect(extra / doc.refs.length).toBeLessThan(0.1);
  });
  it('leaves the board number out of the title block when asked', async () => {
    const plain = buildSchematicPdf({ ...spec, titleBlockId: false, outline: false }, createRng('sch'));
    expect(plain.titleIds).toEqual([]);
    expect((await pdfText(plain.bytes)).text.join('\n')).not.toContain('LA-Z123P');
  });
  it('is deterministic', () => {
    expect(Buffer.from(buildSchematicPdf(spec, createRng('sch')).bytes).equals(Buffer.from(doc.bytes))).toBe(true);
  });
  it('can be encrypted with a password', async () => {
    const locked = buildSchematicPdf({ ...spec, outline: false, password: 'secret' }, createRng('sch'));
    await expect(openPdf(locked.bytes)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
  });
});

describe('other PDFs', () => {
  it('writes a board PDF with every reference and the title line on request', async () => {
    const doc = buildBoardPdf({ board, boardNumber: 'LA-Z123P', revision: 'B', model: 'Heron 14', printTitle: true });
    expect(doc.refs).toHaveLength(board.parts.length);
    const { pages, text } = await pdfText(doc.bytes);
    expect(pages).toBe(2);
    expect(text.join('\n')).toContain('PCB LA-Z123P REV B');
  });
  it('writes a datasheet with the headings and the ordering table', async () => {
    const mpn = board.parts.find(part => part.mpn)!.mpn!;
    const doc = buildDatasheetPdf({ mpn, pages: 7, variants: 2 }, createRng('ds'));
    const { pages, text } = await pdfText(doc.bytes);
    expect(pages).toBe(7);
    const all = text.join('\n');
    for (const heading of ['ABSOLUTE MAXIMUM RATINGS', 'ELECTRICAL CHARACTERISTICS', 'PIN CONFIGURATION', 'ORDERING INFORMATION']) expect(all).toContain(heading);
    expect(doc.partNumbers).toContain(mpn);
    for (const number of doc.partNumbers) expect(all).toContain(number);
  });
  it('writes a manual with prose and, when asked, the board number in running text', async () => {
    const doc = buildManualPdf({ model: 'Heron 14', vendor: 'Alder', pages: 5, boardNumber: 'LA-Z123P' }, createRng('man'));
    const { pages, text } = await pdfText(doc.bytes);
    expect(pages).toBe(5);
    expect(text[0]).toContain('SERVICE MANUAL');
    expect(text[0]).toContain('LA-Z123P');
    expect(doc.refs).toEqual([]);
    expect(doc.partNumbers).toEqual([]);
  });
  it('writes scanned pages without a text layer', async () => {
    const { pages, text } = await pdfText(buildScannedPdf(3).bytes);
    expect(pages).toBe(3);
    expect(text.every(page => page === '')).toBe(true);
  });
  it('writes an unrelated PDF', async () => {
    const doc = buildUnrelatedPdf(2, createRng('inv'));
    expect((await pdfText(doc.bytes)).text[0]).toContain('INVOICE');
  });
});

describe('incremental update', () => {
  const base = buildSchematicPdf({ ...common, pages: 3, coverage: 1, titleBlockId: true, docOnlyShare: 0, fillerPerPage: 4, outline: false }, createRng('upd')).bytes;
  it('adds an Info dictionary and padding and keeps the text', async () => {
    const updated = appendPdfUpdate(base, { info: { title: 'Heron 14 schematic', producer: 'Synthetic Resaver 2' }, padding: new Uint8Array(5000).fill(7) });
    expect(updated.length).toBeGreaterThan(base.length + 5000);
    expect(Buffer.from(updated.subarray(0, base.length)).equals(Buffer.from(base))).toBe(true);
    const before = await pdfText(base), after = await pdfText(updated);
    expect(after.pages).toBe(before.pages);
    expect(after.text).toEqual(before.text);
    expect(new TextDecoder('latin1').decode(updated)).toContain('/Producer (Synthetic Resaver 2)');
  });
  it('can be applied twice', async () => {
    const twice = appendPdfUpdate(appendPdfUpdate(base, { info: { title: 'a' } }), { padding: new Uint8Array(100) });
    expect((await pdfText(twice)).pages).toBe(3);
  });
});

describe('KiCad schematic', () => {
  const data = buildKicadSchematic({ board, title: 'Heron 14 mainboard', revision: 'B', company: 'Alder', date: '2024-03-01', boardNumber: 'LA-Z123P', includeBoardNumber: true }, createRng('ksch'));
  it('parses with one symbol per part and keeps the title block', () => {
    const schematic = parseKicadSch({ name: 'board.kicad_sch', data, companions: {} });
    expect(schematic).not.toBeNull();
    const refs = schematic!.defs.flatMap(def => def.symbols.map(symbol => symbolRef(symbol)));
    expect(new Set(refs)).toEqual(new Set(board.parts.map(part => part.ref)));
    const text = new TextDecoder().decode(data);
    expect(text).toContain('(rev "B")');
    expect(text).toContain('Board LA-Z123P');
  });
});

describe('BOM and unrelated text', () => {
  const spec = { board, boardNumber: 'LA-Z123P', revision: 'B', title: 'Heron 14', includeTitle: true };
  it('writes a CSV with one row per part and the board number in the title rows', () => {
    const lines = new TextDecoder().decode(buildBomCsv(spec)).trim().split(/\r\n/);
    expect(lines[1]).toBe('Board,LA-Z123P');
    expect(lines.length).toBe(board.parts.length + 5);
  });
  it('writes a workbook that unzips to one worksheet with the same rows', () => {
    const files = unzipSync(buildBomXlsx(spec));
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
    expect((sheet.match(/<row /g) ?? []).length).toBe(board.parts.length + 5);
    expect(sheet).toContain('LA-Z123P');
  });
  it('writes unrelated text of every kind', () => {
    for (const kind of ['note', 'log', 'ini', 'json', 'html', 'csv'] as const) expect(buildUnrelatedText(kind, createRng(kind), 5).length).toBeGreaterThan(20);
  });
});
