import { OCR_MAX_WORDS_PER_PAGE, OCR_MAX_WORD_LENGTH, OCR_MIN_WORD_CONFIDENCE } from './contract';
import type { GrayImage, OcrWord, QuarterTurn } from './contract';

/**
 * Pure raster and result helpers shared by the OCR worker, the page job and the tests: greyscale conversion, quarter-turn
 * rotation with the inverse box mapping, the PGM container the engine reads, Tesseract's TSV output and the merge of passes.
 */

export interface PixelBox { x: number; y: number; width: number; height: number }

/** RGBA (canvas `getImageData`) to 8-bit luminance (Rec. 601 weights), composited over white. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const count = width * height;
  if (rgba.length < count * 4) throw new RangeError('The RGBA buffer is smaller than width x height x 4.');
  const data = new Uint8Array(count);
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    const luminance = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    const alpha = rgba[j + 3];
    data[i] = alpha === 255 ? luminance : (luminance * alpha + 255 * (255 - alpha)) / 255;
  }
  return { width, height, data };
}

/** The image turned `turns` quarter turns clockwise (a new buffer; 0 returns the input itself). */
export function rotateGray(image: GrayImage, turns: QuarterTurn): GrayImage {
  const { width: w, height: h, data } = image;
  if (turns === 0) return image;
  const out = new Uint8Array(w * h);
  if (turns === 2) {
    for (let i = 0, last = w * h - 1; i <= last; i++) out[last - i] = data[i];
    return { width: w, height: h, data: out };
  }
  // 1: (x, y) -> (h - 1 - y, x) in a h x w image; 3: (x, y) -> (y, w - 1 - x).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (turns === 1) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = data[row + x];
    else for (let x = 0; x < w; x++) out[(w - 1 - x) * h + y] = data[row + x];
  }
  return { width: h, height: w, data: out };
}

/** Maps a box found in the image turned `turns` quarter turns clockwise back to the unturned `width` x `height` image. */
export function unrotateBox(box: PixelBox, turns: QuarterTurn, width: number, height: number): PixelBox {
  switch (turns) {
    case 1: return { x: box.y, y: height - (box.x + box.width), width: box.height, height: box.width };
    case 2: return { x: width - (box.x + box.width), y: height - (box.y + box.height), width: box.width, height: box.height };
    case 3: return { x: width - (box.y + box.height), y: box.x, width: box.height, height: box.width };
    default: return box;
  }
}

/** Binary PGM (P5), the plainest image file the engine's Leptonica reads: no codec in JavaScript, no heap pointers. */
export function encodePgm(image: GrayImage): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${image.width} ${image.height}\n255\n`);
  const out = new Uint8Array(header.length + image.data.length);
  out.set(header);
  out.set(image.data, header.length);
  return out;
}

/**
 * Word rows (level 5) of Tesseract's TSV output: level page block par line word left top width height conf text.
 * Empty words, words below `minConfidence` and words beyond `maxWords` are dropped; text is trimmed and capped.
 */
export function parseTsvWords(tsv: string, options: { minConfidence?: number; maxWords?: number } = {}): Array<Omit<OcrWord, 'rotation'>> {
  const minConfidence = options.minConfidence ?? OCR_MIN_WORD_CONFIDENCE, maxWords = options.maxWords ?? OCR_MAX_WORDS_PER_PAGE;
  const words: Array<Omit<OcrWord, 'rotation'>> = [];
  for (const line of tsv.split('\n')) {
    if (!line.startsWith('5\t')) continue;
    const fields = line.split('\t');
    if (fields.length < 12) continue;
    const text = fields.slice(11).join(' ').replace(/\s+/g, ' ').trim().slice(0, OCR_MAX_WORD_LENGTH);
    const [x, y, width, height, confidence] = fields.slice(6, 11).map(Number);
    if (!text || ![x, y, width, height, confidence].every(Number.isFinite) || width <= 0 || height <= 0 || confidence < minConfidence) continue;
    words.push({ text, x, y, width, height, confidence: Math.max(0, Math.min(100, confidence)) });
    if (words.length >= maxWords) break;
  }
  return words;
}

/**
 * Sparse-text segmentation splits a word at the gap an underscore leaves ("SW_EN" comes out as "SW" + "_EN"), and net names are
 * full of underscores. Neighbours on one text line (in the coordinates of their pass) are joined back when the join point is an
 * underscore and the gap is under half the line height. The joined word keeps the lower confidence.
 */
export function joinUnderscoreSplits<T extends Omit<OcrWord, 'rotation'>>(words: readonly T[]): T[] {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: T[] = [];
  const used = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    let current = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const next = sorted[j];
      if (next.y > current.y + current.height) break;
      const top = Math.max(current.y, next.y), bottom = Math.min(current.y + current.height, next.y + next.height);
      const lineHeight = Math.max(current.height, next.height);
      const gap = next.x - (current.x + current.width);
      const underscore = current.text.endsWith('_') || next.text.startsWith('_');
      if (!underscore || bottom - top < 0.6 * Math.min(current.height, next.height) || gap < -0.25 * lineHeight || gap > 0.5 * lineHeight) continue;
      const x = Math.min(current.x, next.x), y = Math.min(current.y, next.y);
      current = {
        ...current, text: `${current.text}${next.text}`.slice(0, OCR_MAX_WORD_LENGTH), x, y,
        width: Math.max(current.x + current.width, next.x + next.width) - x, height: Math.max(current.y + current.height, next.y + next.height) - y,
        confidence: Math.min(current.confidence, next.confidence),
      };
      used.add(j);
    }
    out.push(current);
  }
  return out;
}

const area = (box: PixelBox) => Math.max(0, box.width) * Math.max(0, box.height);
function overlapShare(a: PixelBox, b: PixelBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-9, Math.min(area(a), area(b)));
}

/**
 * Merges the words of several passes (already mapped to one image): where two words cover the same place (more than half of the
 * smaller box), the more confident reading wins. A horizontal label read in the 0 degree pass beats the noise the 90 degree pass
 * makes of it, and the other way round for vertical labels. Output is in reading order (top to bottom, left to right), capped.
 */
export function mergePasses(passes: readonly (readonly OcrWord[])[], maxWords = OCR_MAX_WORDS_PER_PAGE): OcrWord[] {
  const all = passes.flat().sort((a, b) => b.confidence - a.confidence || a.rotation - b.rotation);
  const CELL = 128;
  const grid = new Map<string, OcrWord[]>();
  const cellsOf = (box: PixelBox) => {
    const keys: string[] = [];
    for (let cx = Math.floor(box.x / CELL); cx <= Math.floor((box.x + box.width) / CELL); cx++) {
      for (let cy = Math.floor(box.y / CELL); cy <= Math.floor((box.y + box.height) / CELL); cy++) keys.push(`${cx},${cy}`);
    }
    return keys;
  };
  const kept: OcrWord[] = [];
  for (const word of all) {
    const cells = cellsOf(word);
    let covered = false;
    for (const key of cells) {
      for (const other of grid.get(key) ?? []) if (overlapShare(word, other) > 0.5) { covered = true; break; }
      if (covered) break;
    }
    if (covered) continue;
    kept.push(word);
    for (const key of cells) { const list = grid.get(key); if (list) list.push(word); else grid.set(key, [word]); }
    if (kept.length >= maxWords) break;
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Resolution actually used for a page of `widthPt` x `heightPt` points: `dpi`, lowered until the raster fits `maxPixels`. */
export function planRaster(widthPt: number, heightPt: number, dpi: number, maxPixels: number): { scale: number; width: number; height: number; dpi: number } {
  if (![widthPt, heightPt, dpi, maxPixels].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Raster dimensions and budgets must be finite and positive.');
  const budget = Math.max(1, Math.floor(maxPixels));
  // Canvas implementations also limit each axis. Very thin pages must not defeat the area budget by rounding an axis to one.
  const axis = Math.min(32767, budget);
  const scale = Math.min(dpi / 72, Math.sqrt(budget / widthPt / heightPt), axis / widthPt, axis / heightPt);
  const width = Math.max(1, Math.floor(widthPt * scale)), height = Math.max(1, Math.floor(heightPt * scale));
  return { scale, width, height, dpi: scale * 72 };
}
