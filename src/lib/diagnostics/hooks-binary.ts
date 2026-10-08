/*
 * Structure hooks of the binary formats (original TRACE module, MIT): FZ/CAE containers, XZZ, CAST CST and Altium PcbDoc. They
 * report header fields from a per-format whitelist (versions, flags, declared counts), block tags with power-of-two length buckets
 * and, for containers, which pipeline step (container, decryption, decompression) completed. They never copy a byte of payload,
 * decrypted or decompressed content into a fact: decoded text only feeds the same keyword counts as the text hooks.
 */
import { CFB_MAGIC, readCompound } from '../formats/altium-cfb';
import { asciiPrefix, decodeText } from '../formats/common';
import { inflateZlib } from '../formats/compression';
import { fzKeyParityValid, rc6Feedback } from '../formats/crypto';
import { CONTENT_SIGNATURE, hasFzZlibHeader, isAppleDoubleMetadata, splitFzContainer, unwrapFzContainer } from '../formats/fz';
import { CAE_DEFAULT_KEY, FZ_DEFAULT_KEY } from '../formats/fz-default-keys';
import { log2Ceil, NO_SECTION } from './report';
import { textLines, type StructureHook, type StructureSink } from './structure';

const u32 = (data: Uint8Array, offset: number): number | undefined =>
  offset >= 0 && offset + 4 <= data.length ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true) : undefined;

// --- FZ (ASUS) / CAE (ASRock) ---------------------------------------------------------------------------------------------------------
const MIN_ZLIB = 6;
const FZ_BLOCKS = ['REFDES', 'NET_NAME', 'TESTVIA', 'GRAPHIC_DATA_NAME', 'CLASS', 'LOGOInfo', 'UnDrawSym'];
function fzContent(text: string, sink: StructureSink) {
  sink.section(NO_SECTION);
  for (const raw of textLines(text)) {
    const line = raw.trim();
    sink.line(raw, /[!\s]+/);
    if (!line) continue;
    if (line.startsWith('UNIT:')) {
      sink.keyword('UNIT:');
      const unit = line.slice(5).trim().toLowerCase();
      if (unit === 'millimeters') { sink.units('mm', 1); sink.code('unitCode', 1); } else if (unit === 'thou' || unit === 'mil' || unit === 'mils') { sink.units('thou', 0.0254); sink.code('unitCode', 3); } else sink.code('unitCode', 0);
      continue;
    }
    if (line.startsWith('A!')) {
      const block = FZ_BLOCKS.find(name => line.slice(2).startsWith(name)), word = block ? `A!${block}` : 'A!other';
      sink.keyword('A!', line.split('!').length - 1); sink.keyword(word); sink.section(word);
      continue;
    }
    if (line.startsWith('S!')) { sink.keyword('S!'); sink.row(line.slice(2).split('!').length); }
  }
}
export const fzHook: StructureHook = {
  id: 'fz', kind: 'binary', steps: ['header', 'decrypt', 'container', 'decompress'],
  keywords: ['UNIT:', 'A!', 'S!', ...FZ_BLOCKS.map(name => `A!${name}`), 'A!other'],
  collect(input, sink) {
    const base = input.extension === '.cae' ? 'cae' : 'fz';
    sink.units('thou', 0.0254); sink.padAngle('none');
    if (isAppleDoubleMetadata(input.data)) return;
    let data: Uint8Array;
    try { data = unwrapFzContainer(input.data); } catch { return; }
    const content = (bytes: Uint8Array): string | null => { try { return decodeText(bytes); } catch { return null; } };
    if (CONTENT_SIGNATURE.test(asciiPrefix(data, 64))) {
      sink.variant(base === 'cae' ? 'cae-text' : 'fz-text');
      for (const step of ['header', 'decrypt', 'container', 'decompress'] as const) sink.reached(step);
      const text = content(data);
      if (text !== null) fzContent(text, sink);
      return;
    }
    if (data.length < 4 + MIN_ZLIB + MIN_ZLIB + 4) return;
    let plain: Uint8Array;
    if (hasFzZlibHeader(data) && splitFzContainer(data)) {
      sink.variant(base === 'cae' ? 'cae-zlib' : 'fz-zlib'); sink.code('encrypted', 0);
      sink.reached('header'); sink.reached('decrypt');
      plain = data;
    } else {
      sink.variant(base === 'cae' ? 'cae-rc6' : 'fz-rc6'); sink.code('encrypted', 1);
      sink.reached('header');
      const key = input.keys.fzKey ?? (base === 'cae' ? CAE_DEFAULT_KEY : FZ_DEFAULT_KEY);
      if (key.length !== 44 || key.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff) || base === 'fz' && !fzKeyParityValid(key, base)) return;
      const head = rc6Feedback(data.subarray(0, 4 + MIN_ZLIB), key);
      if (!hasFzZlibHeader(head)) return;
      plain = rc6Feedback(data, key);
      sink.reached('decrypt');
    }
    const container = splitFzContainer(plain);
    if (!container) return;
    sink.reached('container'); sink.code('containerLayout', container.layout);
    let inflated: Uint8Array, description: Uint8Array;
    try { inflated = inflateZlib(container.content); description = inflateZlib(container.description, 16 * 1024 * 1024); } catch { return; }
    if (container.contentBytes !== undefined && container.contentBytes !== inflated.length || container.descriptionBytes !== undefined && container.descriptionBytes !== description.length) return;
    sink.reached('decompress');
    sink.code('contentLog2', log2Ceil(inflated.length)); sink.code('descriptionLog2', log2Ceil(description.length));
    const text = content(inflated);
    if (text !== null) fzContent(text, sink);
  },
};

// --- XZZ PCB ---------------------------------------------------------------------------------------------------------------------------
const XZZ_MAGIC = 'XZZPCB', XZZ_MARKER = 'v6v6555v6v6', XZZ_HEADER = 0x2c;
function indexOfText(data: Uint8Array, text: string): number {
  const first = text.charCodeAt(0);
  outer: for (let index = data.indexOf(first); index >= 0 && index + text.length <= data.length; index = data.indexOf(first, index + 1)) {
    for (let k = 1; k < text.length; k++) if (data[index + k] !== text.charCodeAt(k)) continue outer;
    return index;
  }
  return -1;
}
export const xzzHook: StructureHook = {
  id: 'xzz', kind: 'binary', steps: ['header'], keywords: [],
  collect(input, sink) {
    const { data } = input;
    if (data.length < XZZ_HEADER) return;
    const xor = data.length > 0x10 ? data[0x10] : 0;
    const clear = [...XZZ_MAGIC].every((char, index) => data[index] === char.charCodeAt(0));
    const obfuscated = !clear && xor !== 0 && [...XZZ_MAGIC].every((char, index) => (data[index] ^ xor) === char.charCodeAt(0));
    if (!clear && !obfuscated) return;
    sink.variant(obfuscated ? 'xzz-xor' : 'xzz-plain'); sink.code('obfuscated', obfuscated ? 1 : 0);
    sink.units('mil/10000', 2.54e-6); sink.padAngle('none');
    let buf = data;
    if (obfuscated) {
      const marker = indexOfText(data, XZZ_MARKER), end = marker < 0 ? data.length : marker;
      buf = data.slice();
      for (let index = 0; index < end; index++) buf[index] ^= xor;
    }
    const mainStart = u32(buf, 0x20)! + 0x20, netStart = u32(buf, 0x28)! + 0x20;
    const mainSize = u32(buf, mainStart), netSize = u32(buf, netStart);
    if (mainStart < XZZ_HEADER || netStart < XZZ_HEADER || mainSize === undefined || netSize === undefined) return;
    if (mainStart + 4 + mainSize > buf.length || netStart + 4 + netSize > buf.length) return;
    sink.reached('header');
    let nets = 0;
    for (let ptr = netStart + 4, end = netStart + 4 + netSize; ptr + 8 <= end && nets < 1_000_000; nets++) {
      const size = u32(buf, ptr)!;
      if (size < 8 || ptr + size > end) break;
      ptr += size;
    }
    sink.count('netRecords', nets);
    let blocks = 0, encrypted = 0;
    for (let ptr = mainStart + 4, end = mainStart + 4 + mainSize; ptr + 5 <= end && blocks < 4_000_000; blocks++) {
      const type = buf[ptr], size = u32(buf, ptr + 1)!;
      if (ptr + 5 + size > end) break;
      sink.block(type, size, 8);
      // A component block whose own size field does not fit is ciphertext (DES-ECB, whole 8-byte blocks).
      if (type === 0x07) { const inner = u32(buf, ptr + 5); if (inner === undefined || inner + 4 > size) encrypted++; }
      ptr += 5 + size;
    }
    sink.count('blocks', blocks); sink.code('encrypted', encrypted ? 1 : 0);
  },
};

// --- CAST CST ----------------------------------------------------------------------------------------------------------------------------
export const cstHook: StructureHook = {
  id: 'cst', kind: 'binary', steps: ['header'], keywords: ['CDev', 'CPad'],
  collect(input, sink) {
    const { data } = input;
    if (!(data.length >= 12 && data[6] === 4 && data[7] === 0 && asciiPrefix(data.subarray(8, 12), 4) === 'CDev')) return;
    sink.variant('cst-int16'); sink.units('mil', 0.0254); sink.padAngle('none');
    sink.reached('header'); sink.keyword('CDev');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const parts = view.getInt16(0, true);
    sink.count('declaredParts', Math.max(0, parts));
    // Component records: name length byte, name, 4 bytes, layer code, 6 bytes; the layer code is the block tag (0x0c top, 0x01 bottom).
    let offset = 12, walked = 0;
    for (; walked < Math.max(0, parts) && offset < data.length; walked++) {
      const length = data[offset];
      if (offset + 1 + length + 11 > data.length) break;
      sink.block(data[offset + 1 + length + 4], 1 + length + 11, 8);
      offset += 1 + length + 11;
    }
    if (walked === parts && offset >= 2) sink.count('declaredNets', Math.max(0, view.getInt16(offset - 2, true)));
    for (let index = offset; index + 4 <= data.length; index++) {
      if (data[index] === 67 && data[index + 1] === 80 && data[index + 2] === 97 && data[index + 3] === 100) {
        if (index >= 8 && view.getUint16(index - 2, true) === 4) { sink.keyword('CPad'); sink.count('declaredPins', Math.max(0, view.getInt16(index - 8, true))); }
        break;
      }
    }
  },
};

// --- Altium PcbDoc (binary compound file and ASCII) ------------------------------------------------------------------------------------
const ALTIUM_STORAGES = [
  'Board6', 'Components6', 'Nets6', 'Pads6', 'Tracks6', 'Vias6', 'Arcs6', 'Fills6', 'Regions6', 'ShapeBasedRegions6', 'Texts6', 'Polygons6', 'Classes6', 'Rules6',
  'Dimensions6', 'ComponentBodies6', 'ShapeBasedComponentBodies6', 'Models', 'ModelsNoEmbed', 'FileHeader', 'FileVersionInfo', 'Library', 'WideStrings6', 'Connections6',
  'DifferentialPairs6', 'Embeddeds6', 'EmbeddedBoards6', 'EmbeddedFonts6', 'ExtendedPrimitiveInformation', 'FromTos6', 'Coordinates6', 'PadViaLibrary', 'Textures',
  'BoardRegions', 'SmartUnions', 'Advanced Placer Options6', 'Design Rule Checker Options6', 'Pin Swap Options6',
];
const ALTIUM_RECORDS = ['Board', 'Component', 'Net', 'Pad', 'Track', 'Via', 'Arc', 'Fill', 'Region', 'Text', 'Polygon', 'Class', 'Rule', 'Dimension', 'ComponentBody', 'Model'];
const startsWithMagic = (data: Uint8Array) => CFB_MAGIC.every((byte, index) => data[index] === byte);
function altiumBinary(data: Uint8Array, sink: StructureSink) {
  sink.reached('header'); sink.units('mil/10000', 2.54e-6); sink.padAngle('absolute');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 32) { sink.code('cfbMajorVersion', view.getUint16(26, true)); sink.code('cfbSectorShift', view.getUint16(30, true)); }
  let compound;
  try { compound = readCompound(data, () => { throw new Error('compound'); }); } catch { sink.variant(data.length >= 28 && view.getUint16(26, true) === 4 ? 'altium-cfb-v4' : 'altium-cfb'); return; }
  sink.reached('container');
  const header = compound.stream('/FileHeader');
  sink.variant(header && /Schematic Capture/i.test(asciiPrefix(header, 512)) ? 'altium-schematic' : 'altium-cfb');
  const storages = new Set<string>();
  for (const path of compound.paths) { const top = path.split('/')[1]; if (top) storages.add(top); }
  let other = 0;
  for (const name of [...storages].sort()) { if (ALTIUM_STORAGES.includes(name)) sink.keyword(`/${name}`); else other++; }
  sink.count('streams', compound.paths.length); sink.count('otherStreams', other);
  const declared = (path: string) => { const stream = compound.stream(path); return stream && stream.length >= 4 ? u32(stream, 0) : undefined; };
  const parts = declared('/Components6/Header'), pins = declared('/Pads6/Header'), nets = declared('/Nets6/Header');
  if (parts !== undefined) sink.count('declaredParts', parts);
  if (pins !== undefined) sink.count('declaredPins', pins);
  if (nets !== undefined) sink.count('declaredNets', nets);
  // Pads6 records: a type byte, then six length-prefixed sub-records; the block is the type with the whole record length.
  const pads = compound.stream('/Pads6/Data');
  if (pads) {
    for (let offset = 0, records = 0; offset < pads.length && records < 1_000_000; records++) {
      let at = offset + 1;
      for (let sub = 0; sub < 6 && at !== -1; sub++) { const length = u32(pads, at); at = length === undefined || at + 4 + length > pads.length ? -1 : at + 4 + length; }
      if (at === -1) break;
      sink.block(pads[offset], at - offset, 8);
      offset = at;
    }
  }
}
function altiumAscii(data: Uint8Array, sink: StructureSink) {
  let text: string;
  try { text = decodeText(data); } catch { return; }
  sink.units('per-value'); sink.padAngle('absolute');
  sink.variant(/^\|?HEADER=[^\n]*Schematic/im.test(text.slice(0, 4096)) ? 'altium-schematic' : 'altium-ascii');
  sink.section(NO_SECTION);
  let board = false;
  for (const raw of textLines(text)) {
    const kind = /\|RECORD=([A-Za-z]+)\|/.exec(raw)?.[1];
    if (kind) {
      const word = ALTIUM_RECORDS.includes(kind) ? `RECORD=${kind}` : 'RECORD=other';
      if (kind === 'Board') board = true;
      sink.section(word); sink.keyword(word, raw.split('|').filter(Boolean).length);
    }
    sink.line(raw, /[|=\s]+/);
  }
  if (board) sink.reached('header');
  sink.reached('container');
}
export const altiumHook: StructureHook = {
  id: 'altium', kind: 'binary', steps: ['header', 'container'],
  keywords: [...ALTIUM_STORAGES.map(name => `/${name}`), ...ALTIUM_RECORDS.map(name => `RECORD=${name}`), 'RECORD=other'],
  collect(input, sink) {
    if (startsWithMagic(input.data)) altiumBinary(input.data, sink);
    else if (/\|RECORD=/.test(asciiPrefix(input.data, 64 * 1024))) altiumAscii(input.data, sink);
  },
};

/** An unrecognized binary file: its input facts say all there is to say without a format. */
export const genericBinaryHook: StructureHook = { id: 'generic-binary', kind: 'binary', steps: [], keywords: [], collect() {} };
