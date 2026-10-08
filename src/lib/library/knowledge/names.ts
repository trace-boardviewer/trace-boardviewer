/**
 * Name metadata: what the folder chain, the file name and the archive name of a file say about its board.
 *
 * This is stage "name" of the Library scan (no file is opened): it cuts a relative path into its folders and its file name,
 * reads every segment with the board-number, revision, vendor, device-type and document-type recognisers, and keeps for each
 * result the segment it came from. The file name is read as a "name", folders as "folder" and archive names (`.zip`, `.rar`,
 * `.7z`) as "archive"; the extension of the file name is not part of the text but suggests a document type.
 *
 * Bounds: the last `MAX_SEGMENTS` segments of the path are read, each at most `MAX_SEGMENT_LENGTH` units; results are capped
 * by the recognisers. Total and linear in the length of the path.
 */
import { MAX_TEXT_LENGTH, type WorkMeter } from './chars';
import { recognizeBoardNumbers, type BoardNumberMatch } from './board-numbers';
import { parseRevisions, type RevisionMatch } from './revision';
import { deviceTypeHints, documentTypeHints, extensionOf, summarizeHints, vendorHints, type DeviceHint, type DocumentHint, type HintSummary, type VendorHint } from './hints';
import type { DeviceType, DocumentType } from './lexicon';

export const MAX_SEGMENTS = 12;
export const MAX_SEGMENT_LENGTH = 260;

export type NameSource = 'name' | 'folder' | 'archive';
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);

export interface Sourced<T> { value: T; source: NameSource; /** Index of the path segment (0 is the outermost one read). */ segment: number }

export interface PathAnalysis {
  boardNumbers: Array<Sourced<BoardNumberMatch>>;
  revisions: Array<Sourced<RevisionMatch>>;
  vendors: Array<Sourced<VendorHint>>;
  devices: Array<Sourced<DeviceHint>>;
  documents: Array<Sourced<DocumentHint>>;
  /** The strongest board number (the file name wins ties), revision, vendor and device type, and the document types by strength. */
  best: {
    boardNumber?: BoardNumberMatch;
    revision?: RevisionMatch;
    vendor?: HintSummary<string>;
    device?: HintSummary<DeviceType>;
    documents: Array<HintSummary<DocumentType>>;
  };
  /** The extension of the file name, lower case. */
  extension: string;
}

export interface PathOptions { meter?: WorkMeter }

/** Reads one name (a file name without its extension, a folder name or an archive name). */
export function analyzeName(text: string, source: NameSource, extension?: string, options: PathOptions = {}): Omit<PathAnalysis, 'best' | 'extension'> & { documentsFromExtension: DocumentHint[] } {
  const scope = source;
  const meter = options.meter;
  const wrap = <T,>(items: T[]): Array<Sourced<T>> => items.map(value => ({ value, source, segment: 0 }));
  const documents = documentTypeHints(text, { extension: extension ?? '', meter });
  return {
    boardNumbers: wrap(recognizeBoardNumbers(text, { scope, meter })),
    revisions: wrap(parseRevisions(text, { scope, meter })),
    vendors: wrap(vendorHints(text, { meter })),
    devices: wrap(deviceTypeHints(text, { meter })),
    documents: wrap(documents),
    documentsFromExtension: documents.filter(hint => hint.basis === 'extension' || hint.basis === 'weak-extension'),
  };
}

/** Splits a path at "/" and "\\" and drops empty and "." segments. */
export function pathSegments(path: string): string[] {
  if (typeof path !== 'string') return [];
  const text = path.length > MAX_TEXT_LENGTH ? path.slice(path.length - MAX_TEXT_LENGTH) : path;
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 47;
    if (code === 47 || code === 92) {
      const part = text.slice(start, index);
      if (part !== '' && part !== '.' && part !== '..') out.push(part.length > MAX_SEGMENT_LENGTH ? part.slice(0, MAX_SEGMENT_LENGTH) : part);
      start = index + 1;
    }
  }
  return out.length > MAX_SEGMENTS ? out.slice(out.length - MAX_SEGMENTS) : out;
}

/** Reads a relative path (folders, optional archive name, file name). Never opens anything. */
export function analyzePath(path: string, options: PathOptions = {}): PathAnalysis {
  const segments = pathSegments(path);
  const result: PathAnalysis = { boardNumbers: [], revisions: [], vendors: [], devices: [], documents: [], best: { documents: [] }, extension: '' };
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    const extension = extensionOf(segment);
    const isArchive = !last ? ARCHIVE_EXTENSIONS.has(extension) : false;
    const source: NameSource = last ? 'name' : isArchive ? 'archive' : 'folder';
    // The extension is cut off the file and archive names; a folder named "v2.5" keeps its text.
    const text = (last || isArchive) && extension !== '' ? segment.slice(0, segment.length - extension.length - 1) : segment;
    if (last) result.extension = extension;
    const analysis = analyzeName(text, source, last ? extension : '', options);
    for (const key of ['boardNumbers', 'revisions', 'vendors', 'devices', 'documents'] as const) {
      (result[key] as Array<Sourced<unknown>>).push(...(analysis[key] as Array<Sourced<unknown>>).map(item => ({ ...item, segment: index })));
    }
  });
  // The file name's own text wins over folders when confidence ties: prefer the later segment.
  const pick = <T extends { confidence: number }>(items: Array<Sourced<T>>): T | undefined => {
    let best: Sourced<T> | undefined;
    for (const item of items) if (!best || item.value.confidence > best.value.confidence || (item.value.confidence === best.value.confidence && item.segment >= best.segment)) best = item;
    return best?.value;
  };
  result.best.boardNumber = pick(result.boardNumbers);
  result.best.revision = pick(result.revisions);
  result.best.vendor = summarizeHints(result.vendors.map(item => item.value))[0];
  result.best.device = summarizeHints(result.devices.map(item => item.value))[0];
  result.best.documents = summarizeHints(result.documents.map(item => item.value));
  return result;
}
