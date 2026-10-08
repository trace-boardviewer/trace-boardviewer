/**
 * Number helpers shared by the decoders: counts on a display to SI values without accumulated rounding, and display text to
 * counts.
 */

/** value = count * 10^exp, with one division by an exact power of ten for negative exponents (no accumulated rounding). */
export function scaleCount(count: number, exp: number): number {
  return exp >= 0 ? count * 10 ** exp : count / 10 ** -exp;
}

/** The count with its decimal point, as the LCD shows it ("0.0850", "-12.34"). */
export function formatCount(count: number, decimals: number, negative: boolean): string {
  const digits = String(count).padStart(decimals + 1, '0');
  const text = decimals > 0 ? `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}` : digits;
  return negative ? `-${text}` : text;
}

/** A display text such as "-0.0850": the integer count, the decimals shown and the sign; null when it is not a plain number. */
export function parseDisplayNumber(text: string): { count: number; decimals: number; negative: boolean } | null {
  const compact = text.replace(/ /g, '');
  const match = /^(-?)(\d*)\.?(\d*)$/.exec(compact);
  if (!match || (match[2] === '' && match[3] === '')) return null;
  const digits = match[2] + match[3];
  if (digits.length > 9) return null;
  return { count: Number(digits), decimals: match[3].length, negative: match[1] === '-' };
}

/** The display shows over-range: an O (or a zero) and an L, the decimal point wherever the range puts it. */
export function isOverloadText(text: string): boolean {
  const compact = text.replace(/[ .]/g, '').toUpperCase();
  return compact === 'OL' || compact === '0L' || compact === '-OL' || compact === '-0L';
}

/** A signed value, without a negative zero. */
export function signed(magnitude: number, negative: boolean): number {
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}
