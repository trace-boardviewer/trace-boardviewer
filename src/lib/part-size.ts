/**
 * Package size of a two-terminal chip part (resistor, capacitor, inductor, ferrite, fuse...) from its package or value text.
 *
 * Read, in order (the first that decides wins):
 *  1. A metric chip code marked as metric: "1005Metric" (KiCad "C_0402_1005Metric"), or an EIA case code after "EIA"
 *     ("CP_Tantalum_Case-B_EIA-3528-21"): 1005 is 1.0 x 0.5 mm, 3528 is 3.5 x 2.8 mm.
 *  2. An imperial chip code standing as its own word: 01005, 0201, 0402, 0603, 0805, 1008, 1206, 1210, 1806, 1812, 2010, 2220,
 *     2225, 2512 ("C0402" and "R0603" count too: one or two letters glued in front). A bare four-digit code is read as imperial,
 *     which is what board files mean almost always; a metric code needs the "Metric" or "EIA" mark.
 *  3. Otherwise null; `outlineSize` gives the size of the part's outline instead, which every format has but which includes
 *     silkscreen or courtyard margins in some.
 *
 * The package text is read before the value text. Words are bounded (160 characters per text), so the cost is linear.
 */
import type { BoardComponent } from './types';
import { wordsOfText } from './net-graph';

export interface PackageSize {
  /** The imperial code ("0402") when the size came from a code, else null. */
  readonly code: string | null;
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly areaMm2: number;
  readonly basis: 'imperial-code' | 'metric-code' | 'outline';
}

/** Imperial chip codes and their nominal body size in millimetres (length, width), with the metric code of the same size. */
const IMPERIAL: ReadonlyMap<string, readonly [number, number, string]> = new Map([
  ['01005', [0.4, 0.2, '0402']], ['0201', [0.6, 0.3, '0603']], ['0402', [1.0, 0.5, '1005']], ['0603', [1.6, 0.8, '1608']],
  ['0805', [2.0, 1.25, '2012']], ['1008', [2.5, 2.0, '2520']], ['1206', [3.2, 1.6, '3216']], ['1210', [3.2, 2.5, '3225']],
  ['1806', [4.5, 1.6, '4516']], ['1812', [4.5, 3.2, '4532']], ['2010', [5.0, 2.5, '5025']], ['2220', [5.7, 5.0, '5750']],
  ['2225', [5.7, 6.3, '5763']], ['2512', [6.3, 3.2, '6332']],
]);
/** Metric codes (also the EIA tantalum case sizes) -> imperial name when there is one, and size. */
const METRIC: ReadonlyMap<string, readonly [number, number, string | null]> = (() => {
  const map = new Map<string, readonly [number, number, string | null]>();
  for (const [imperial, [length, width, metric]] of IMPERIAL) map.set(metric, [length, width, imperial]);
  for (const [metric, length, width] of [['3528', 3.5, 2.8], ['6032', 6.0, 3.2], ['7343', 7.3, 4.3], ['7360', 7.3, 6.0], ['2012', 2.0, 1.25], ['1608', 1.6, 0.8]] as const) {
    if (!map.has(metric)) map.set(metric, [length, width, null]);
  }
  return map;
})();

const size = (code: string | null, length: number, width: number, basis: PackageSize['basis']): PackageSize =>
  Object.freeze({ code, lengthMm: length, widthMm: width, areaMm2: length * width, basis });

function fromWords(words: readonly string[]): PackageSize | null {
  // Metric marks first: they are explicit.
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word.length === 10 && word.endsWith('METRIC')) {
      const entry = METRIC.get(word.slice(0, 4));
      if (entry) return size(entry[2], entry[0], entry[1], 'metric-code');
    }
    if (word === 'EIA' && index + 1 < words.length) {
      const entry = METRIC.get(words[index + 1]);
      if (entry) return size(entry[2], entry[0], entry[1], 'metric-code');
    }
  }
  for (const word of words) {
    let digits = word;
    // "C0402", "R0603", "CC0402": up to two letters glued in front of the code.
    let letters = 0;
    while (letters < digits.length && letters < 3) { const code = digits.charCodeAt(letters); if (code >= 65 && code <= 90) letters++; else break; }
    if (letters > 2) continue;
    digits = digits.slice(letters);
    const entry = IMPERIAL.get(digits);
    if (entry) return size(digits, entry[0], entry[1], 'imperial-code');
  }
  return null;
}

/** The chip size named by the package (then the value) text, or null when neither names one. */
export function packageSize(component: Pick<BoardComponent, 'package' | 'value'>): PackageSize | null {
  return fromWords(wordsOfText(component.package)) ?? fromWords(wordsOfText(component.value));
}

/** The size of the part's bounds (outline or pads), always available; less exact than a code. Null for empty or broken bounds. */
export function outlineSize(component: Pick<BoardComponent, 'bounds'>): PackageSize | null {
  const bounds = component.bounds;
  if (!bounds) return null;
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) return null;
  return size(null, Math.max(width, height), Math.min(width, height), 'outline');
}

/** `packageSize`, else `outlineSize`. */
export function partSize(component: Pick<BoardComponent, 'package' | 'value' | 'bounds'>): PackageSize | null {
  return packageSize(component) ?? outlineSize(component);
}

/** 0201 and smaller, or 0402: small enough to be missed when looking for a hot or wet part. */
export const isTinyChip = (size: PackageSize | null): boolean => size !== null && size.basis !== 'outline' && size.areaMm2 <= 0.5 + 1e-9;
