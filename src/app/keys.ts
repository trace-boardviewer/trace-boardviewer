import type { ImportOptions } from '../lib/types';

export type KeyKind = 'fz' | 'xzz';
export type KeyCheck = { options: ImportOptions } | { error: string };

/**
 * FZ/CAE: 44 hexadecimal 32-bit words (0x optional; spaces, commas or new lines between them). XZZ: 16 hexadecimal digits.
 * The result is `{ options }` (ready for the parser) or `{ error }` (an English hint for the key dialog). Keys never persist.
 */
export function validateKeyText(kind: KeyKind, text: string): KeyCheck {
  // i18n: pending — validation hints are English like the parser diagnostics they accompany.
  if (kind === 'xzz') {
    const digits = text.replace(/\s+/g, '').replace(/^0x/i, '');
    if (!/^[0-9a-f]*$/i.test(digits)) return { error: 'Only hexadecimal digits (0-9, a-f) are allowed.' };
    return digits.length === 16 ? { options: { xzzKey: digits.toLowerCase() } } : { error: `Enter exactly 16 hexadecimal digits (${digits.length} so far).` };
  }
  const words = text.split(/[\s,;]+/).filter(Boolean);
  const bad = words.find(word => !/^(?:0x)?[0-9a-f]{1,8}$/i.test(word));
  if (bad) return { error: `"${bad.slice(0, 24)}" is not a hexadecimal 32-bit word.` };
  if (words.length !== 44) return { error: `Enter 44 hexadecimal 32-bit words (${words.length} so far).` };
  return { options: { fzKey: words.map(word => parseInt(word.replace(/^0x/i, ''), 16)) } };
}
export const parseKeyText = validateKeyText;
