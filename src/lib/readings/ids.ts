/**
 * Reading ids derived from what a reading is (not random), so that importing or migrating the same source twice yields the same ids
 * and `planImport` recognizes what the family already holds. The hash is FNV-1a 64 (deterministic, not a security hash); an id is
 * `<prefix>-<16 hexadecimal digits>`, which fits the id pattern of schema.ts.
 */

/** 64-bit FNV-1a of a string (UTF-16 code units) as 16 hexadecimal digits. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** `<prefix>-<hash of the parts joined by NUL>`; the prefix is 1 to 16 lower-case letters. */
export function stableReadingId(prefix: string, ...parts: readonly string[]): string {
  if (!/^[a-z]{1,16}$/.test(prefix)) throw new Error('A reading id prefix is 1 to 16 lower-case letters.');
  return `${prefix}-${fnv1a64(parts.join('\u0000'))}`;
}
