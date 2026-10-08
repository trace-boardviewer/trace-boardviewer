/**
 * Character helpers shared by the Library's recognition modules.
 *
 * Every recogniser here scans text once, by hand, with no regular expression that can backtrack, so its cost is linear in
 * the length of the text. Texts come from file names, folder names, PDF title blocks and board-file headers; none of them
 * is trusted. Two rules keep the cost and the output bounded:
 *
 *  - only the first `MAX_TEXT_LENGTH` UTF-16 units of a text are looked at;
 *  - a call returns at most `MAX_MATCHES` results.
 *
 * "Folding" maps one UTF-16 unit to one unit, so a position in the folded text is a position in the original text: ASCII
 * letters become upper case, full-width ASCII becomes ASCII, the dashes of Unicode become "-", the blanks of Unicode and the
 * control characters become " ". Nothing else changes (no normalisation that could shorten or lengthen the text).
 *
 * The optional `WorkMeter` counts the characters a call examines. Tests use it to show that the work grows linearly with
 * the input without measuring time.
 */

/** The longest text (in UTF-16 units) any recogniser looks at; the rest is ignored. */
export const MAX_TEXT_LENGTH = 100_000;
/** The most results a recogniser returns from one text. */
export const MAX_MATCHES = 256;
/** The longest token or identifier any recogniser reads; longer runs are skipped without being copied. */
export const MAX_TOKEN_LENGTH = 64;

/** Counts the characters a call examines (every scanned unit counts once per pass). Pass one to measure work. */
export interface WorkMeter { steps: number }

/** Adds `count` to an optional meter. */
export function tick(meter: WorkMeter | undefined, count = 1): void {
  if (meter !== undefined) meter.steps += count;
}

export const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;
/** Upper-case ASCII letter; call it on folded codes. */
export const isLetterCode = (code: number): boolean => code >= 65 && code <= 90;
export const isAlnumCode = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90);

/** Folds one UTF-16 unit for matching (see the header). */
export function foldCode(code: number): number {
  if (code < 128) {
    if (code >= 97 && code <= 122) return code - 32;
    return code < 33 ? 32 : code;
  }
  if (code >= 0xff01 && code <= 0xff5e) {
    const ascii = code - 0xfee0;
    return ascii >= 97 && ascii <= 122 ? ascii - 32 : ascii;
  }
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212 || code === 0xfe58 || code === 0xfe63 || code === 0x2043) return 45;
  if (code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200d) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff) return 32;
  return code;
}

/** The folded code at `index`, or -1 outside the text. */
export function foldedAt(text: string, index: number, length: number = text.length): number {
  return index >= 0 && index < length ? foldCode(text.charCodeAt(index)) : -1;
}

/** The number of units of `text` a recogniser looks at. Non-strings have none. */
export function scanLength(text: unknown): number {
  return typeof text === 'string' ? Math.min(text.length, MAX_TEXT_LENGTH) : 0;
}

/** The folded text of `text[from, to)` as a string (for short spans only). */
export function foldedSlice(text: string, from: number, to: number): string {
  let out = '';
  for (let index = from; index < to; index++) out += String.fromCharCode(foldCode(text.charCodeAt(index)));
  return out;
}

/** Where the scope of a recognised text comes from. A subset of the metadata sources of the Library model. */
export type RecognitionScope = 'name' | 'folder' | 'archive' | 'header' | 'pdf-metadata' | 'outline' | 'title-block' | 'schematic' | 'ocr' | 'body';

export const RECOGNITION_SCOPES: readonly RecognitionScope[] = ['name', 'folder', 'archive', 'header', 'pdf-metadata', 'outline', 'title-block', 'schematic', 'ocr', 'body'];

/** Letters of any script or digits, for words in the lexicons (the folded ASCII range plus the letters above it). */
export function isWordCode(code: number): boolean {
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  if (code < 0xc0) return false;
  if (code === 0xd7) return false;
  if (code === 0xf7) return false;
  if (code >= 0x2000 && code <= 0x2bff) return false;
  if (code >= 0x3000 && code <= 0x303f) return false;
  if (code >= 0xff00 && code <= 0xff65) return false;
  return !(code >= 0xd800 && code <= 0xdfff);
}

/** True when `code` is a letter of a script for the lexicons (not a digit). */
export const isWordLetterCode = (code: number): boolean => isWordCode(code) && !(code >= 48 && code <= 57);

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Lower-cases a short word and removes the accents (hu "alaplap" and "tápegység" share a key with their plain spellings). */
export function lexiconKey(word: string): string {
  let ascii = true;
  for (let index = 0; index < word.length; index++) if (word.charCodeAt(index) > 127) { ascii = false; break; }
  const lower = word.toLowerCase();
  return ascii ? lower : lower.normalize('NFD').replace(COMBINING_MARKS, '');
}
