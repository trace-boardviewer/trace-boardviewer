import { isSchDoc } from '../../electron/altium-sniff.mjs';
import { xmlRoot } from '../../electron/xml-prolog.mjs';
import { sniffImage } from '../lib/images';
import type { DocumentKind } from '../lib/documents';

export interface SniffedDocument {
  kind: DocumentKind;
  /** 'pdf' | 'png' | 'jpeg' | 'webp' | 'svg' | 'kicad_sch' | 'eeschema' | 'eagle' | 'eeschema-lib' (the same vocabulary as DocumentPayload.format). */
  format: string;
}

const HEAD_BYTES = 256 * 1024;
const text = (data: Uint8Array, length: number) => {
  let start = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  const end = Math.min(data.length, start + length);
  let out = '';
  for (; start < end; start += 8192) out += String.fromCharCode(...data.subarray(start, Math.min(end, start + 8192)));
  return out;
};

/**
 * Browser-fallback twin of the native content sniffing (electron/documents.cjs): the kind comes from the BYTES, never from
 * the extension. A PDF is a document, not a boardview or a netlist. EAGLE XML is recognized by its root element after the
 * prolog (the scanner is shared with the native side) and counts as a schematic only when it contains a `<schematic`
 * element (a board or a library is not one). Returns `null` for anything else.
 */
export function sniffDocument(data: Uint8Array): SniffedDocument | null {
  if (data.length < 5) return null;
  const pdfHead = text(data.subarray(0, Math.min(data.length, 1024)), 1024);
  if (pdfHead.includes('%PDF-')) return { kind: 'pdf', format: 'pdf' };
  if (isSchDoc(data)) return { kind: 'schematic', format: 'altium-sch' };
  const image = sniffImage(data);
  if (image) return { kind: 'image', format: image };
  const head = text(data, HEAD_BYTES);
  const trimmed = head.replace(/^[\s\0]+/, '');
  if (/^\(kicad_sch[\s(]/.test(trimmed)) return { kind: 'schematic', format: 'kicad_sch' };
  if (/^EESchema Schematic File Version\b/.test(trimmed)) return { kind: 'schematic', format: 'eeschema' };
  if (/^EESchema-(?:LIBRARY|DOCLIB)\b/.test(trimmed)) return { kind: 'schematic', format: 'eeschema-lib' };
  if (trimmed.startsWith('<')) {
    const xml = xmlRoot(trimmed);
    if (xml !== null && 'root' in xml && xml.root === 'eagle' && /<schematic[\s>]/.test(head)) return { kind: 'schematic', format: 'eagle' };
  }
  return null;
}
