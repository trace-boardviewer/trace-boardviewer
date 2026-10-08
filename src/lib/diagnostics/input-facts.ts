/*
 * Input facts of the diagnostic report (original TRACE module, MIT): extension class, size bucket, container kind, text-likeness,
 * encoding guess, line endings, a 16-slice entropy profile and a known-magic label from a public signature list. No byte of the
 * file is ever copied into a fact: every value is a member of a closed enumeration or a rounded number.
 */
import { detectUnsupported } from '../formats/recognizers';
import { EXTENSIONS, log2Ceil, type Container, type DiagnosticReport, type Encoding, type LineEndings } from './report';

type InputFacts = DiagnosticReport['input'];
const TEXT_SAMPLE = 64 * 1024;
/** Control characters other than tab, line feed, form feed and carriage return; more than this share means binary. */
const MAX_CONTROL_SHARE = 0.005;

const startsWith = (data: Uint8Array, bytes: readonly number[], offset = 0): boolean =>
  data.length >= offset + bytes.length && bytes.every((byte, index) => data[offset + index] === byte);
const asciiAt = (data: Uint8Array, offset: number, text: string): boolean =>
  data.length >= offset + text.length && [...text].every((char, index) => data[offset + index] === char.charCodeAt(0));
/** A zlib stream header (deflate, 32 KiB window or less, no preset dictionary, valid check bits). */
const zlibAt = (data: Uint8Array, offset: number): boolean =>
  data.length >= offset + 6 && (data[offset] & 0x0f) === 8 && (data[offset] >> 4) <= 7 && ((data[offset] << 8) | data[offset + 1]) % 31 === 0 && !(data[offset + 1] & 0x20);

/** The extension class: a whitelisted lowercase extension, "other", or "none". Only the part after the last dot is looked at. */
export function extensionClass(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !(dot === 0 && base.length > 1)) return 'none';
  const extension = base.slice(dot).toLowerCase();
  return /^\.[a-z0-9_]{1,10}$/.test(extension) && EXTENSIONS.has(extension) ? extension : 'other';
}

const ALLEGRO_LABELS: Readonly<Record<string, string>> = {
  '16.0': 'allegro-16.0', '16.2': 'allegro-16.2', '16.4': 'allegro-16.4', '16.5': 'allegro-16.5', '16.6': 'allegro-16.6',
  '17.2': 'allegro-17.2', '17.4': 'allegro-17.4', '17.5': 'allegro-17.5', '18.0 or newer': 'allegro-18',
};
/** The first matching label of a public signature list (file-type magics, and the vendor signatures the readers document). */
export function magicLabel(data: Uint8Array): string {
  if (startsWith(data, [0xef, 0xbb, 0xbf])) return 'utf8-bom';
  if (startsWith(data, [0xff, 0xfe])) return 'utf16le-bom';
  if (startsWith(data, [0xfe, 0xff])) return 'utf16be-bom';
  if (startsWith(data, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole-cfb';
  if (asciiAt(data, 0, 'SQLite format 3\0')) return 'sqlite';
  if (startsWith(data, [0, 1, 0, 0]) && asciiAt(data, 4, 'Standard Jet DB')) return 'jet-db';
  if (startsWith(data, [0, 1, 0, 0]) && asciiAt(data, 4, 'Standard ACE DB')) return 'ace-db';
  if (startsWith(data, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (asciiAt(data, 0, 'Rar!\x1a\x07')) return 'rar';
  if (asciiAt(data, 0, '%PDF-')) return 'pdf';
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (asciiAt(data, 257, 'ustar')) return 'tar';
  if (asciiAt(data, 0, 'XZZPCB')) return 'xzzpcb';
  if (data.length > 0x10 && data[0x10] !== 0 && [...'XZZPCB'].every((char, index) => (data[index] ^ data[0x10]) === char.charCodeAt(0))) return 'xzzpcb-xor';
  if (startsWith(data, [0x23, 0xe2, 0x63, 0x28])) return 'brd-encoded';
  if (asciiAt(data, 0, 'dd:1.3?,r?-=bb')) return 'bdv-encoded';
  if (data.length >= 12 && data[6] === 4 && data[7] === 0 && asciiAt(data, 8, 'CDev')) return 'cst-cdev';
  const allegro = detectUnsupported(data.length > 4096 ? data.subarray(0, 4096) : data);
  if (allegro?.id === 'allegro-brd' && allegro.detail && ALLEGRO_LABELS[allegro.detail]) return ALLEGRO_LABELS[allegro.detail];
  if (asciiAt(data, 0, '<?xml')) return 'xml-prolog';
  if (zlibAt(data, 0) && data[0] === 0x78) return 'zlib';
  return 'none';
}

/** The container kind behind the magic; a zlib stream right after a 4-byte length (the FZ layout) counts as zlib too. */
export function containerKind(data: Uint8Array, magic: string): Container {
  switch (magic) {
    case 'zip': return 'zip';
    case 'gzip': return 'gzip';
    case 'tar': return 'tar';
    case 'ole-cfb': return 'cfb';
    case 'sqlite': return 'sqlite';
    case 'jet-db': case 'ace-db': return 'jet';
    case 'zlib': return 'zlib';
    default: return zlibAt(data, 4) && data[4] === 0x78 ? 'zlib' : 'none';
  }
}

interface TextFacts { textLike: boolean; encoding: Encoding }
function textFacts(data: Uint8Array, magic: string): TextFacts {
  if (magic === 'utf16le-bom' || magic === 'utf16be-bom') {
    try {
      const sample = new TextDecoder(magic === 'utf16le-bom' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(data.subarray(0, TEXT_SAMPLE + (TEXT_SAMPLE % 2)), { stream: true });
      let controls = 0;
      for (let index = 0; index < sample.length; index++) { const code = sample.charCodeAt(index); if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) controls++; }
      if (controls <= sample.length * MAX_CONTROL_SHARE) return { textLike: true, encoding: magic };
    } catch { /* not UTF-16 after all */ }
    return { textLike: false, encoding: 'binary' };
  }
  const sample = data.subarray(0, TEXT_SAMPLE);
  let controls = 0, high = false;
  for (let index = 0; index < sample.length; index++) {
    const byte = sample[index];
    if (byte === 0) { controls = sample.length; break; }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controls++;
    else if (byte >= 0x80) high = true;
  }
  if (!sample.length || controls > sample.length * MAX_CONTROL_SHARE) return { textLike: false, encoding: 'binary' };
  if (magic === 'utf8-bom') return { textLike: true, encoding: 'utf8-bom' };
  if (!high) {
    for (let index = sample.length; index < data.length; index++) if (data[index] >= 0x80) { high = true; break; }
    if (!high) return { textLike: true, encoding: 'ascii' };
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); return { textLike: true, encoding: 'utf8' }; }
  catch { return { textLike: true, encoding: 'windows-1252' }; }
}

/** Which line terminators occur (bytes, so the same for every 8-bit text encoding; UTF-16 is read through its decoded text). */
function lineEndings(data: Uint8Array, facts: TextFacts): LineEndings {
  if (!facts.textLike) return 'n/a';
  let crlf = 0, lf = 0, cr = 0;
  if (facts.encoding === 'utf16le-bom' || facts.encoding === 'utf16be-bom') {
    let text = '';
    try { text = new TextDecoder(facts.encoding === 'utf16le-bom' ? 'utf-16le' : 'utf-16be').decode(data); } catch { return 'none'; }
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 13) { if (text.charCodeAt(index + 1) === 10) { crlf++; index++; } else cr++; } else if (code === 10) lf++;
    }
  } else {
    for (let index = 0; index < data.length; index++) {
      const byte = data[index];
      if (byte === 13) { if (data[index + 1] === 10) { crlf++; index++; } else cr++; } else if (byte === 10) lf++;
    }
  }
  const kinds = [crlf, lf, cr].filter(Boolean).length;
  if (!kinds) return 'none';
  if (kinds > 1) return 'mixed';
  return crlf ? 'crlf' : lf ? 'lf' : 'cr';
}

/** Shannon entropy (bits per byte, one decimal) of 16 equal slices of the file; an empty slice is 0. */
export function entropyProfile(data: Uint8Array): number[] {
  const slices: number[] = [];
  const counts = new Uint32Array(256);
  for (let slice = 0; slice < 16; slice++) {
    const start = Math.floor(data.length * slice / 16), end = Math.floor(data.length * (slice + 1) / 16), length = end - start;
    if (length <= 0) { slices.push(0); continue; }
    counts.fill(0);
    for (let index = start; index < end; index++) counts[data[index]]++;
    let bits = 0;
    for (const count of counts) if (count) { const p = count / length; bits -= p * Math.log2(p); }
    slices.push(Number(Math.min(8, Math.max(0, bits)).toFixed(1)));
  }
  return slices;
}

/** Every input fact of one file plus its companions (by name only: the companions' extensions and how many there are). */
export function inputFacts(name: string, data: Uint8Array, companions: Readonly<Record<string, Uint8Array>>): InputFacts {
  const magic = magicLabel(data);
  const text = textFacts(data, magic);
  const companionNames = Object.keys(companions).sort().slice(0, 8);
  return {
    extension: extensionClass(name),
    sizeLog2: Math.min(27, log2Ceil(data.length)),
    companions: { count: companionNames.length, extensions: companionNames.map(extensionClass) },
    container: containerKind(data, magic),
    textLike: text.textLike,
    encoding: text.encoding,
    lineEndings: lineEndings(data, text),
    entropy: entropyProfile(data),
    magic,
  };
}
