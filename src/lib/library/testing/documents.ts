/*
 * PDF documents of the synthetic library, built with the repository's PDF fixture writer (src/lib/pdf/pdf-fixture.ts): schematics
 * with a title block, board PDFs, datasheets, service-manual prose, scanned and password-protected variants, unrelated PDFs, and
 * incremental updates that add an Info dictionary or padding (so a re-saved copy has other bytes and the same text).
 *
 * Every builder returns the bytes together with what a reader can find in them: the reference designators printed, the part numbers
 * printed (what a part-number extractor should return) and the decoys (net names, package names, dates, sheet numbers and values
 * that look like part numbers but are not). The ground truth stores these lists.
 */
import { buildPdfFixture, rc4Encryption } from '../../pdf/pdf-fixture.ts';
import type { FixtureOutlineItem, FixturePage, FixtureText } from '../../pdf/pdf-fixture.ts';
import type { BoardModel, Part } from './board-model.ts';
import { makeMpn, mpnBase, netNamesOf } from './board-model.ts';
import type { Rng } from './rng.ts';
import { PROSE_HEADINGS, PROSE_NOUNS, PROSE_PLACES, PROSE_VERBS } from './words.ts';

export interface PdfDoc {
  bytes: Uint8Array;
  pages: number;
  /** Reference designators printed as parts (not decoy tokens). */
  refs: string[];
  /** Part numbers printed (exact text). */
  partNumbers: string[];
  /** Part-number-like tokens printed that are not part numbers. */
  decoys: string[];
  /** Board numbers printed in the title block. */
  titleIds: string[];
}

const PAGE_W = 792, PAGE_H = 612;
const encoder = new TextEncoder();
const upper = (text: string): string => text.toUpperCase();
/** The fixture writes Helvetica with WinAnsi: keep texts to printable ASCII. */
const ascii = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');

class Collector {
  refs = new Set<string>();
  partNumbers = new Set<string>();
  decoys = new Set<string>();
  titleIds = new Set<string>();
  decoy(text: string): void { if (text.length >= 4) this.decoys.add(upper(text)); }
}

function sheetTitle(rng: Rng, index: number): string {
  return `${index} ${rng.pick(['POWER 3V3 RAILS', 'CPU CORE', 'MEMORY', 'USB AND PD', 'DISPLAY', 'AUDIO', 'EC AND KEYBOARD', 'STORAGE', 'CLOCKS', 'CHARGER', 'SENSORS', 'WIRELESS', 'DEBUG'])}`;
}

export interface SchematicSpec {
  board: BoardModel;
  revision: string;
  boardNumber: string;
  schematicNumber?: string;
  model: string;
  vendor: string;
  date: string;
  pages: number;
  /** Share of the board's parts printed (0.5 to 1). */
  coverage: number;
  /** The board number is printed in the title block. */
  titleBlockId: boolean;
  /** Extra parts that are not on the board (options, do-not-fit parts) as a share of the printed parts. */
  docOnlyShare: number;
  /** Texts per page besides the parts: net labels and notes. */
  fillerPerPage: number;
  outline: boolean;
  /** Bookmarks only; the document is encrypted with the password. */
  password?: string;
}

function pickPrintedParts(board: BoardModel, rng: Rng, coverage: number): Part[] {
  const count = Math.max(1, Math.round(board.parts.length * coverage));
  const chosen = new Set(rng.sample(board.parts.map((_, i) => i), count));
  return board.parts.filter((_, i) => chosen.has(i));
}

export function buildSchematicPdf(spec: SchematicSpec, rng: Rng): PdfDoc {
  const found = new Collector();
  const printed = pickPrintedParts(spec.board, rng, spec.coverage);
  const known = new Set(spec.board.parts.map(part => part.ref));
  const extras: Part[] = [];
  const extraCount = Math.round(printed.length * spec.docOnlyShare);
  for (let i = 0; i < extraCount; i++) {
    let number = 9001 + i * 3;
    while (known.has(`R${number}`)) number++;
    const ic = rng.chance(0.2);
    const mpn = ic ? makeMpn(rng).exact : null;
    extras.push({ ref: ic ? `U${number}` : `R${number}`, cls: ic ? 'U' : 'R', value: mpn ?? '10K', mpn, pkg: ic ? 'QFN16' : '0402', side: 'top', x: 0, y: 0, rotation: 0, pins: [] });
  }
  const everything = [...printed, ...extras];
  const nets = netNamesOf(spec.board);
  const pages = Math.max(1, spec.pages);
  const out: FixturePage[] = [];
  const outline: FixtureOutlineItem[] = [];
  const labelBoard = rng.pick(['PCB P/N', 'BOARD', 'BOARD NO', 'PCB']);
  const labelDoc = rng.pick(['DWG NO', 'DOC NO', 'DOCUMENT NUMBER']);
  const docNumber = spec.schematicNumber ?? (spec.titleBlockId ? spec.boardNumber : `DOC-${rng.digits(4)}`);
  if (spec.titleBlockId) found.titleIds.add(upper(spec.boardNumber));
  found.decoy(docNumber); found.decoy(spec.date);
  for (let page = 0; page < pages; page++) {
    const texts: FixtureText[] = [];
    const title = sheetTitle(rng, page + 1);
    texts.push({ x: 30, y: 590, size: 11, text: ascii(`${spec.vendor.toUpperCase()} ${spec.model.toUpperCase()} - ${title}`) });
    // title block, bottom right
    const x0 = 520;
    const block: Array<[string, string]> = [['TITLE', `${spec.model.toUpperCase()} MAIN BOARD`], [labelDoc, docNumber], ...(spec.titleBlockId ? [[labelBoard, spec.boardNumber] as [string, string]] : []), ['REV', spec.revision], ['SHEET', `${page + 1} OF ${pages}`], ['DATE', spec.date]];
    block.forEach(([label, value], i) => { texts.push({ x: x0, y: 130 - i * 17, size: 5, text: ascii(label) }, { x: x0 + 52, y: 130 - i * 17, size: 7, text: ascii(value) }); });
    found.decoy(`${page + 1} OF ${pages}`);
    // parts of this page on a grid
    const from = Math.floor(page * everything.length / pages), to = Math.floor((page + 1) * everything.length / pages);
    const mine = everything.slice(from, to);
    const columns = Math.min(14, 5 + Math.floor(mine.length / 60)), rows = Math.max(1, Math.ceil(mine.length / columns));
    const rowHeight = Math.min(44, Math.max(10, 380 / rows)), columnWidth = 460 / columns;
    mine.forEach((part, i) => {
      const x = 30 + (i % columns) * columnWidth, y = Math.max(20, 560 - Math.floor(i / columns) * rowHeight);
      texts.push({ x, y, size: 8, text: ascii(part.ref) });
      found.refs.add(upper(part.ref));
      if (part.mpn) {
        const printedNumber = rng.chance(0.15) ? mpnBase(part.mpn) : part.mpn;
        texts.push({ x, y: y - 8, size: 6, text: ascii(printedNumber) });
        found.partNumbers.add(upper(printedNumber));
        if (part.cls === 'U') { texts.push({ x: x + 34, y: y - 8, size: 6, text: ascii(part.pkg) }); found.decoy(part.pkg); }
      } else if (part.value) { texts.push({ x: x + 34, y, size: 6, text: ascii(part.value) }); found.decoy(part.value); }
    });
    for (let i = 0; i < spec.fillerPerPage && nets.length; i++) {
      const name = rng.pick(nets);
      texts.push({ x: 30 + rng.int(0, 440), y: 170 + rng.int(0, 380), size: 5, text: ascii(name) });
      found.decoy(name);
    }
    out.push({ width: PAGE_W, height: PAGE_H, texts });
    if (spec.outline) outline.push({ title: title, page: page + 1 });
  }
  const options = { pages: out, ...(spec.outline ? { outline } : {}), ...(spec.password ? { encryption: rc4Encryption(spec.password) } : {}) };
  return { bytes: buildPdfFixture(options), pages, refs: [...found.refs].sort(), partNumbers: [...found.partNumbers].sort(), decoys: [...found.decoys].sort(), titleIds: [...found.titleIds] };
}

export interface BoardPdfSpec { board: BoardModel; boardNumber: string; revision: string; model: string; printTitle: boolean }

/** A board drawing as a PDF: every reference on its place of the TOP and BOTTOM page, a few net names, no part numbers. */
export function buildBoardPdf(spec: BoardPdfSpec): PdfDoc {
  const found = new Collector();
  const out: FixturePage[] = [];
  const nets = netNamesOf(spec.board).slice(0, 12);
  for (const side of ['top', 'bottom'] as const) {
    const texts: FixtureText[] = [{ x: 30, y: 590, size: 12, text: `${side.toUpperCase()} SIDE ASSEMBLY` }];
    if (spec.printTitle) { texts.push({ x: 30, y: 572, size: 8, text: ascii(`${spec.model.toUpperCase()}  PCB ${spec.boardNumber}  REV ${spec.revision}`) }); found.titleIds.add(upper(spec.boardNumber)); }
    for (const part of spec.board.parts) {
      if (part.side !== side) continue;
      texts.push({ x: 20 + (part.x / spec.board.width) * (PAGE_W - 60), y: 30 + (part.y / spec.board.height) * (PAGE_H - 110), size: 4, text: ascii(part.ref) });
      found.refs.add(upper(part.ref));
    }
    nets.forEach((name, i) => { texts.push({ x: 30 + i * 60, y: 14, size: 4, text: ascii(name) }); found.decoy(name); });
    out.push({ width: PAGE_W, height: PAGE_H, texts });
  }
  return { bytes: buildPdfFixture({ pages: out }), pages: out.length, refs: [...found.refs].sort(), partNumbers: [], decoys: [...found.decoys].sort(), titleIds: [...found.titleIds] };
}

export interface DatasheetSpec { mpn: string; pages: number; variants: number }

/** A datasheet: part number title, the standard headings, a pin table and an ordering table. The part numbers are the base and its ordering variants. */
export function buildDatasheetPdf(spec: DatasheetSpec, rng: Rng): PdfDoc {
  const found = new Collector();
  const base = mpnBase(spec.mpn);
  const variants = [spec.mpn, base];
  const packages = ['QFN-16', 'SOIC-8', 'SOT23-5', 'QFP-48'];
  for (let i = 0; i < spec.variants; i++) variants.push(`${base}${rng.pick(['X', 'Y', 'Z'])}${rng.int(1, 9)}`);
  const unique = [...new Set(variants)];
  for (const variant of unique) found.partNumbers.add(upper(variant));
  const sections = ['FEATURES', 'ABSOLUTE MAXIMUM RATINGS', 'ELECTRICAL CHARACTERISTICS', 'PIN CONFIGURATION', 'ORDERING INFORMATION', 'TYPICAL PERFORMANCE', 'APPLICATION INFORMATION'];
  const out: FixturePage[] = [];
  for (let page = 0; page < Math.max(1, spec.pages); page++) {
    const texts: FixtureText[] = [{ x: 50, y: 740, size: page === 0 ? 20 : 10, text: ascii(page === 0 ? base : `${base} DATASHEET`) }, { x: 520, y: 20, size: 7, text: `PAGE ${page + 1} OF ${spec.pages}` }];
    found.decoy(`${page + 1} OF ${spec.pages}`);
    const heading = sections[page % sections.length];
    texts.push({ x: 50, y: 700, size: 12, text: heading });
    if (heading === 'ORDERING INFORMATION') {
      unique.forEach((variant, i) => { const pkg = packages[i % packages.length]; texts.push({ x: 50, y: 670 - i * 14, size: 8, text: ascii(`${variant}   ${pkg}   TAPE AND REEL   ${[250, 1000, 3000][i % 3]}`) }); found.decoy(pkg); });
    } else if (heading === 'PIN CONFIGURATION') {
      for (let pin = 1; pin <= 8; pin++) texts.push({ x: 50, y: 680 - pin * 14, size: 8, text: `${pin}   ${rng.pick(['VIN', 'SW', 'FB', 'EN', 'GND', 'BOOT', 'PGOOD', 'COMP'])}   ${rng.pick(['INPUT SUPPLY', 'SWITCH NODE', 'FEEDBACK', 'ENABLE'])}` });
    } else {
      for (let line = 0; line < 12; line++) { const volt = `${rng.int(1, 5)}.${rng.int(0, 9)}V`; texts.push({ x: 50, y: 680 - line * 16, size: 8, text: `${rng.pick(['SUPPLY VOLTAGE', 'OUTPUT CURRENT', 'SWITCHING FREQUENCY', 'JUNCTION TEMPERATURE', 'QUIESCENT CURRENT'])}   ${volt}   ${rng.int(10, 900)}MA` }); found.decoy(volt); }
    }
    out.push({ width: 612, height: 792, texts });
  }
  return { bytes: buildPdfFixture({ pages: out }), pages: out.length, refs: [], partNumbers: [...found.partNumbers].sort(), decoys: [...found.decoys].sort(), titleIds: [] };
}

function sentence(rng: Rng): string {
  return `${rng.pick(PROSE_VERBS)} the ${rng.pick(PROSE_NOUNS)} near ${rng.pick(PROSE_PLACES)} and keep the ${rng.pick(PROSE_NOUNS)} aside.`;
}

export interface ManualSpec { model: string; vendor: string; pages: number; boardNumber?: string }

/** Service manual prose: headings and sentences, the model name on the first page, optionally the board number in running text. */
export function buildManualPdf(spec: ManualSpec, rng: Rng): PdfDoc {
  const out: FixturePage[] = [];
  const found = new Collector();
  for (let page = 0; page < Math.max(1, spec.pages); page++) {
    const texts: FixtureText[] = [];
    if (page === 0) {
      texts.push({ x: 60, y: 720, size: 20, text: ascii(`${spec.vendor} ${spec.model}`) }, { x: 60, y: 690, size: 14, text: 'SERVICE MANUAL' });
      if (spec.boardNumber) { texts.push({ x: 60, y: 660, size: 9, text: ascii(`The main board of this model carries the number ${spec.boardNumber}.`) }); found.titleIds.add(upper(spec.boardNumber)); }
    } else {
      texts.push({ x: 60, y: 730, size: 14, text: rng.pick(PROSE_HEADINGS) });
      for (let line = 0; line < 22; line++) texts.push({ x: 60, y: 700 - line * 16, size: 9, text: ascii(`${line + 1}. ${sentence(rng)}`) });
      if (rng.chance(0.3)) { texts.push({ x: 60, y: 330, size: 9, text: 'Use the T5 driver for the M2 screws.' }); found.decoy('T5'); found.decoy('M2'); }
    }
    texts.push({ x: 290, y: 24, size: 8, text: `${page + 1}` });
    out.push({ width: 612, height: 792, texts });
  }
  return { bytes: buildPdfFixture({ pages: out }), pages: out.length, refs: [], partNumbers: [], decoys: [...found.decoys].sort(), titleIds: [...found.titleIds] };
}

/** A PDF about something else (an invoice, a letter): text only, no board content. */
export function buildUnrelatedPdf(pages: number, rng: Rng): PdfDoc {
  const out: FixturePage[] = [];
  const found = new Collector();
  const invoice = `INV-${rng.digits(5)}`;
  found.decoy(invoice);
  for (let page = 0; page < Math.max(1, pages); page++) {
    const texts: FixtureText[] = [{ x: 60, y: 730, size: 16, text: page === 0 ? `INVOICE ${invoice}` : 'CONTINUED' }];
    for (let line = 0; line < 18; line++) texts.push({ x: 60, y: 700 - line * 18, size: 10, text: ascii(`${rng.pick(['Labour', 'Delivery', 'Consultation', 'Storage', 'Courier', 'Shelving'])} ${rng.int(1, 40)} units ${rng.int(10, 990)}.00`) });
    out.push({ width: 612, height: 792, texts });
  }
  return { bytes: buildPdfFixture({ pages: out }), pages: out.length, refs: [], partNumbers: [], decoys: [...found.decoys].sort(), titleIds: [] };
}

/** A scanned document: every page is a raster image and there is no text layer. */
export function buildScannedPdf(pages: number): PdfDoc {
  const out: FixturePage[] = Array.from({ length: Math.max(1, pages) }, () => ({ width: PAGE_W, height: PAGE_H, image: true }));
  return { bytes: buildPdfFixture({ pages: out }), pages: out.length, refs: [], partNumbers: [], decoys: [], titleIds: [] };
}

// ---- incremental updates ---------------------------------------------------------------------------------------------------

export interface PdfUpdate { info?: { title?: string; subject?: string; producer?: string }; padding?: Uint8Array }

const latin1 = (bytes: Uint8Array): string => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return text; };
const literal = (text: string): string => `(${text.replace(/[\\()]/g, match => `\\${match}`).replace(/[^\x20-\x7e]/g, '?')})`;

/** Appends an incremental update (valid PDF) with an Info dictionary and/or an unreferenced padding stream. Not for encrypted files. */
export function appendPdfUpdate(pdf: Uint8Array, update: PdfUpdate): Uint8Array {
  const tail = latin1(pdf.subarray(Math.max(0, pdf.length - 2048)));
  const startxref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  const trailerAt = tail.lastIndexOf('trailer');
  const trailer = trailerAt >= 0 ? tail.slice(trailerAt) : '';
  const size = /\/Size (\d+)/.exec(trailer), root = /\/Root (\d+) 0 R/.exec(trailer);
  if (!startxref || !size || !root) throw new Error('the PDF has no classic trailer to extend');
  const objects: Uint8Array[] = [];
  let infoNumber = 0;
  let next = Number(size[1]);
  if (update.info) {
    infoNumber = next++;
    const { title, subject, producer } = update.info;
    objects.push(encoder.encode(`<< ${title ? `/Title ${literal(title)} ` : ''}${subject ? `/Subject ${literal(subject)} ` : ''}${producer ? `/Producer ${literal(producer)} ` : ''}>>`));
  }
  if (update.padding?.length) {
    const head = encoder.encode(`<< /Length ${update.padding.length} >>\nstream\n`), end = encoder.encode('\nendstream');
    const body = new Uint8Array(head.length + update.padding.length + end.length);
    body.set(head); body.set(update.padding, head.length); body.set(end, head.length + update.padding.length);
    next++;
    objects.push(body);
  }
  const firstNumber = Number(size[1]);
  const chunks: Uint8Array[] = [pdf];
  const offsets: number[] = [];
  let offset = pdf.length;
  objects.forEach((body, i) => {
    offsets.push(offset);
    for (const part of [encoder.encode(`${firstNumber + i} 0 obj\n`), body, encoder.encode('\nendobj\n')]) { chunks.push(part); offset += part.length; }
  });
  const xref = `xref\n${firstNumber} ${objects.length}\n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}`;
  const tailText = `trailer\n<< /Size ${next} /Root ${root[1]} 0 R${infoNumber ? ` /Info ${infoNumber} 0 R` : ''} /Prev ${startxref[1]} >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(encoder.encode(xref + tailText));
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
