/*
 * Test support for the diagnostic report (never imported by the application): finds a secret in a report in any encoding a leak
 * could take - plain text in any letter case, UTF-8, UTF-16 (both byte orders), hexadecimal, base64 (all three alignments, also the
 * URL alphabet), URL percent-encoding and the decimal / byte forms of numbers. A report is searched as UTF-8, UTF-16LE and UTF-16BE.
 */
export interface Secrets {
  /** Strings seeded into a file (names, titles, key text). */
  strings?: readonly string[];
  /** Decimal numbers seeded as text. */
  numbers?: readonly string[];
  /** Integers seeded as binary values; searched as decimal text and as 32-bit little- and big-endian bytes. */
  integers?: readonly number[];
  /** Raw byte blobs (a key) searched in the encodings above. */
  blobs?: readonly Uint8Array[];
}

/** Labels whose needle is plain text: matched in any letter case (base64 is case-sensitive by nature). */
const CASE_INSENSITIVE = new Set(['text', 'encodeURIComponent', 'encodeURI', 'form-encoded', 'reversed']);
const utf16le = (text: string): Buffer => Buffer.from(text, 'utf16le');
const utf16be = (text: string): Buffer => Buffer.from(utf16le(text).swap16());

/** The base64 substrings that depend only on `bytes` whatever the bytes around them are (3 byte alignments). */
function base64Cores(bytes: Buffer, url = false): string[] {
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    const encoded = padded.toString(url ? 'base64url' : 'base64').replace(/=+$/, '');
    const first = Math.ceil(offset * 8 / 6), last = Math.floor((offset + bytes.length) * 8 / 6);
    if (last - first >= 6) cores.push(encoded.slice(first, last));
  }
  return cores;
}

function percent(bytes: Buffer, lower: boolean): string {
  let text = '';
  for (const byte of bytes) { const hex = byte.toString(16).padStart(2, '0'); text += `%${lower ? hex : hex.toUpperCase()}`; }
  return text;
}

/** Every form of one byte string a leak could take, as haystack-comparable text or bytes. */
function variantsOf(bytes: Buffer, label: string): Array<{ label: string; needle: string | Buffer }> {
  const out: Array<{ label: string; needle: string | Buffer }> = [{ label: `${label} bytes`, needle: bytes }];
  out.push({ label: `${label} hex`, needle: bytes.toString('hex') }, { label: `${label} HEX`, needle: bytes.toString('hex').toUpperCase() });
  out.push({ label: `${label} percent`, needle: percent(bytes, true) }, { label: `${label} PERCENT`, needle: percent(bytes, false) });
  for (const core of base64Cores(bytes)) out.push({ label: `${label} base64`, needle: core });
  for (const core of base64Cores(bytes, true)) out.push({ label: `${label} base64url`, needle: core });
  return out;
}

function stringVariants(text: string): Array<{ label: string; needle: string | Buffer }> {
  const out: Array<{ label: string; needle: string | Buffer }> = [];
  for (const form of new Set([text, text.toLowerCase(), text.toUpperCase()])) {
    out.push({ label: 'text', needle: form });
    out.push(...variantsOf(Buffer.from(form, 'utf8'), 'utf8'), ...variantsOf(utf16le(form), 'utf16le'), ...variantsOf(utf16be(form), 'utf16be'));
    out.push({ label: 'encodeURIComponent', needle: encodeURIComponent(form) }, { label: 'encodeURI', needle: encodeURI(form) }, { label: 'form-encoded', needle: encodeURIComponent(form).replace(/%20/g, '+') });
    out.push({ label: 'reversed', needle: [...form].reverse().join('') });
  }
  return out;
}

/** Descriptions of every place where a secret shows up in `reportText`; an empty list proves its absence in all forms. */
export function findLeaks(reportText: string, secrets: Secrets): string[] {
  const haystacks: Array<{ label: string; text: string; bytes: Buffer }> = [
    { label: 'utf8', text: reportText, bytes: Buffer.from(reportText, 'utf8') },
    { label: 'utf16le', text: utf16le(reportText).toString('latin1'), bytes: utf16le(reportText) },
    { label: 'utf16be', text: utf16be(reportText).toString('latin1'), bytes: utf16be(reportText) },
    { label: 'lowercase', text: reportText.toLowerCase(), bytes: Buffer.from(reportText.toLowerCase(), 'utf8') },
  ];
  const needles: Array<{ secret: string; label: string; needle: string | Buffer }> = [];
  for (const text of secrets.strings ?? []) if (text.length >= 4) for (const variant of stringVariants(text)) needles.push({ secret: text, ...variant });
  for (const number of secrets.numbers ?? []) if (number.length >= 5) for (const variant of stringVariants(number)) needles.push({ secret: number, ...variant });
  for (const value of secrets.integers ?? []) {
    if (!Number.isInteger(value) || Math.abs(value) < 1_000_000) continue;
    const word = Buffer.alloc(4);
    word.writeUInt32LE(value >>> 0);
    const little = Buffer.from(word), big = Buffer.from(word).reverse();
    for (const variant of stringVariants(String(value))) needles.push({ secret: String(value), ...variant });
    for (const bytes of [little, big]) needles.push(...variantsOf(bytes, 'u32').filter(variant => String(variant.needle).length >= 8 || Buffer.isBuffer(variant.needle)).map(variant => ({ secret: String(value), ...variant })));
    needles.push({ secret: String(value), label: 'hex8', needle: (value >>> 0).toString(16).padStart(8, '0') });
  }
  for (const blob of secrets.blobs ?? []) for (const variant of variantsOf(Buffer.from(blob), 'blob')) needles.push({ secret: `blob(${blob.length})`, ...variant });
  const leaks: string[] = [];
  for (const { secret, label, needle } of needles) {
    for (const haystack of haystacks) {
      const found = typeof needle === 'string'
        ? haystack.text.includes(needle) || (CASE_INSENSITIVE.has(label) && haystack.text.toLowerCase().includes(needle.toLowerCase()))
        : haystack.bytes.includes(needle);
      if (found) { leaks.push(`${secret}: ${label} found in ${haystack.label}`); break; }
    }
  }
  return leaks;
}
