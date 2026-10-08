/*
 * Reads generated files back with the application's own readers, so a test can check what the ground truth says about a file
 * (its fingerprint, its pages, the text it prints) against what the application finds. Test and benchmark code only.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardFingerprint } from '../../board-fingerprint';
import { parseGenCad } from '../../gencad';
import { parseBrd } from '../../formats/brd';
import { parseBvr } from '../../formats/bvr';
import { parseIpc356 } from '../../formats/ipc356';
import { parseKicad } from '../../formats/kicad';
import { parsePinList } from '../../formats/pinlist-csv';
import { openPdf } from '../../pdf/document';
import type { PdfHandle } from '../../pdf/document';
import { configurePdfResources } from '../../pdf/worker';
import type { Board } from '../../types';
import type { BenchGenCad } from './bench-boards.ts';

/** The board of a generated file of the given writer format id; null when the application's reader declines it. */
export function readBoard(format: string, name: string, data: Uint8Array): Board | null {
  const input = { name, data };
  switch (format) {
    case 'gencad': return parseGenCad(new TextDecoder().decode(data), name);
    case 'bvr': return parseBvr(input);
    case 'brd2': return parseBrd(input);
    case 'kicad': return parseKicad(input);
    case 'ipc356': return parseIpc356(input);
    case 'pinlist': return parsePinList(input);
    default: return null;
  }
}

export async function fingerprintOfFile(format: string, name: string, data: Uint8Array): Promise<string | null> {
  const board = readBoard(format, name, data);
  return board ? boardFingerprint(board) : null;
}

/** Page count and the text of every page of a PDF (items joined by new lines). */
export async function readPdfText(data: Uint8Array): Promise<{ pages: number; text: string[] }> {
  const handle: PdfHandle = await openPdf(data);
  try {
    const text: string[] = [];
    for (let page = 1; page <= handle.pageCount; page++) text.push((await handle.getTextItems(page)).map(item => item.str).join('\n'));
    return { pages: handle.pageCount, text };
  } finally { await handle.destroy(); }
}

/** Points pdf.js at the copies of its resources in node_modules, so documents open in a test without a network or a built app. Safe to call twice. */
export function configurePdfForTests(): void {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const folder = (name: string): string => `${path.join(root, name).split(path.sep).join('/')}/`;
  configurePdfResources({
    workerSrc: pathToFileURL(path.join(root, 'legacy', 'build', 'pdf.worker.mjs')).href,
    cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
  });
}

/** The benchmark's GenCAD board generator (scripts/gen-synthetic-board.cjs) in the form the library generator takes. */
export function benchGenCadForTests(): BenchGenCad {
  const require = createRequire(import.meta.url);
  const generator = require('../../../../scripts/gen-synthetic-board.cjs') as { generateGenCad(options: { pins: number; seed: number }, sink: { write(text: string): void }): unknown };
  return (pins, seed) => {
    let text = '';
    generator.generateGenCad({ pins, seed }, { write: chunk => { text += chunk; } });
    return text;
  };
}
