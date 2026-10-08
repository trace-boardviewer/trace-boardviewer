/*
 * Original TRACE module (MIT). Head-only identification of ODB++ archives for the adapter registry: what the first 64 KiB of an archive
 * (the sniff window) can say about the product model inside it, without reading the rest and without unpacking anything.
 *
 * Evidence is the same as the reader's own gate (sniffOdbpp in odbpp.ts): the entry names. gzip/compress/tar streams are inflated for at
 * most `HEAD_INFLATE` bytes and only their tar headers are read; a ZIP's local file headers are walked inside the window (a ZIP's central
 * directory sits at the end of the file, outside it). Entries that the window does not reach leave the verdict at "possible": the reader
 * decides when it has the whole file.
 */
import { containerKind, DEFAULT_ODBPP_LIMITS, looksOdb, looksOdbUnsafe, normalizeEntryPath, odbTail, resolveLimits, sniffContainer, type OdbppContainer, type OdbppLimits } from './odbpp-archive';

/** Inflated bytes inspected for tar headers. A 64 KiB head of a compressed stream can expand far beyond this; the rest is never produced. */
export const HEAD_INFLATE = 1024 * 1024;
const MAX_HEAD_ENTRIES = 4096, MAX_NAME_BYTES = 512;

/** What a list of entry names shows. `confidence` is the reader's own scale (0..1); 0 means nothing points to an ODB++ product model. */
export interface PathEvidence { confidence: number; matrix: boolean; stepData: boolean; hints: number; unsafe: boolean }
export function pathEvidence(paths: readonly string[], limits: OdbppLimits = DEFAULT_ODBPP_LIMITS): PathEvidence {
  const tails: string[] = [];
  for (const path of paths) {
    const normalized = normalizeEntryPath(path, limits.maxPathLength);
    const tail = normalized === null ? undefined : odbTail(normalized)?.tail;
    if (tail) tails.push(tail);
  }
  const matrix = tails.some(tail => tail.startsWith('matrix/matrix'));
  const stepData = tails.some(tail => /\/(?:eda\/data|components)(?:\.z)?$/.test(tail));
  const hints = paths.filter(path => looksOdb(path, limits)).length;
  // Entries that show the layout only behind absolute or ".." paths: recognized, so reading reports them instead of "not ODB++".
  const unsafe = !hints && paths.some(path => looksOdbUnsafe(path, limits));
  const confidence = matrix && stepData ? 0.98 : matrix ? 0.9 : stepData ? 0.8 : hints || unsafe ? 0.6 : 0;
  return { confidence, matrix, stepData, hints, unsafe };
}

const decoder = new TextDecoder('utf-8');
/** Names in the local file headers inside a ZIP head: a walk over headers with known sizes, a signature scan wherever the walk cannot continue. */
export function zipHeadNames(head: Uint8Array, limit = MAX_HEAD_ENTRIES): string[] {
  const names: string[] = [];
  let at = 0;
  while (at + 30 <= head.length && names.length < limit) {
    if (head[at] !== 0x50 || head[at + 1] !== 0x4b || head[at + 2] !== 3 || head[at + 3] !== 4) { at++; continue; }
    const flags = head[at + 6] | head[at + 7] << 8;
    const compressed = (head[at + 18] | head[at + 19] << 8 | head[at + 20] << 16 | head[at + 21] << 24) >>> 0;
    const nameLength = head[at + 26] | head[at + 27] << 8, extraLength = head[at + 28] | head[at + 29] << 8;
    if (nameLength === 0 || nameLength > MAX_NAME_BYTES || at + 30 + nameLength > head.length) { at++; continue; }
    names.push(decoder.decode(head.subarray(at + 30, at + 30 + nameLength)));
    const known = !(flags & 8) && compressed !== 0xffffffff;
    at += 30 + nameLength + extraLength + (known ? compressed : 0);
  }
  return names;
}

export interface OdbppHeadSniff {
  /** 0..100 in the adapter scale (docs/ADAPTERS.md). */
  confidence: number;
  reason: string;
  container: OdbppContainer;
}
/** Confidence of the adapter scale for the reader's own 0..1 verdict (LIKELY for names that show the layout, POSSIBLE when only a stream is seen). */
const SCALE: ReadonlyArray<readonly [number, number]> = [[0.98, 88], [0.9, 84], [0.8, 76], [0.6, 66]];
const scaled = (confidence: number): number => SCALE.find(([from]) => confidence >= from)?.[1] ?? 0;

/**
 * Verdict on the first bytes of a file of `size` bytes: null when the bytes cannot be an ODB++ archive, otherwise a confidence with a
 * reason. Total (never throws), bounded by HEAD_INFLATE and the head, linear.
 */
export function sniffOdbppHead(head: Uint8Array, size: number): OdbppHeadSniff | null {
  if (!(head instanceof Uint8Array)) return null;
  const kind = containerKind(head);
  if (!kind) return null;
  const complete = head.length >= size;
  const container: OdbppContainer = kind === 'gzip' ? 'tgz' : kind === 'compress' ? 'tar.Z' : kind;
  const limits = resolveLimits({ sniffBytes: HEAD_INFLATE, maxStreamBytes: HEAD_INFLATE, maxEntries: MAX_HEAD_ENTRIES, maxEntryBytes: HEAD_INFLATE, maxArchiveBytes: Math.max(1, head.length) });
  let paths: string[] = [], tar: boolean | null | undefined;
  try {
    if (kind === 'zip') paths = zipHeadNames(head);
    else { const found = sniffContainer(head, limits, 1); paths = found?.paths ?? []; tar = found?.tar; }
  } catch { paths = []; }
  const evidence = pathEvidence(paths, limits);
  const confidence = scaled(evidence.confidence);
  if (confidence) {
    const what = evidence.matrix && evidence.stepData ? 'matrix/matrix and step data' : evidence.matrix ? 'matrix/matrix' : evidence.stepData ? 'step data' : evidence.unsafe ? 'ODB++ names behind unsafe paths' : 'ODB++ directory names';
    return { confidence, reason: `${container === 'tgz' ? 'gzip tar' : container === 'tar.Z' ? 'compressed tar' : container === 'tar' ? 'tar' : 'ZIP'} entries show ${what}`, container };
  }
  // A compressed stream whose first block is no tar header is not a tar archive at all.
  if (tar === false) return null;
  // Nothing ODB++-like in the part of the archive the window shows. A tar that ends inside the window has no more entries; every other
  // stream may continue with the product model after the entries seen (and a compressed stream may expand past what is inspected).
  if (kind === 'tar' && complete) return null;
  const reason = kind === 'zip' ? 'ZIP whose ODB++ entries may lie beyond the sniff window' : 'compressed or tar stream whose ODB++ entries may lie beyond the sniff window';
  return { confidence: kind === 'zip' ? 5 : 8, reason, container };
}
