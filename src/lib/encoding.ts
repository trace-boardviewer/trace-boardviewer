/**
 * Input normalization shared by the board and schematic dispatchers. A file may arrive as byte-order-marked UTF-16;
 * some adapters decode text (and would read it) while others sniff raw bytes (and would not), so the dispatchers
 * re-encode such a file as UTF-8 once, before any adapter runs, and every adapter sees the same characters.
 */

/**
 * UTF-8 bytes of a BOM-marked UTF-16 input (the mark itself is dropped); any other input is returned as it is. So is
 * UTF-16 that does not decode (an odd length, a lone surrogate): the binary adapters may still recognize such bytes
 * and the text adapters reject them on their own.
 */
export function utf16ToUtf8(data: Uint8Array): Uint8Array {
  const label = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : undefined;
  if (!label) return data;
  let text: string;
  try { text = new TextDecoder(label, { fatal: true }).decode(data); } catch { return data; }
  return new TextEncoder().encode(text);
}

/** The input with its primary file and every companion passed through `utf16ToUtf8`; the same object when nothing changed. */
export function utf8Input<T extends { data: Uint8Array; companions?: Record<string, Uint8Array> }>(input: T): T {
  const data = utf16ToUtf8(input.data);
  let companions = input.companions;
  if (companions) {
    const converted = Object.entries(companions).map(([name, bytes]) => [name, utf16ToUtf8(bytes)] as const);
    if (converted.some(([name, bytes]) => bytes !== companions![name])) companions = Object.fromEntries(converted);
  }
  if (data === input.data && companions === input.companions) return input;
  return { ...input, data, ...(companions ? { companions } : {}) };
}
