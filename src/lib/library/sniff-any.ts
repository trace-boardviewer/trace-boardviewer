import { sniffDocument } from '../../app/sniff';
import { SNIFF_BYTES, type FormatAdapter, type SniffInput, type SupportStatus } from '../formats/adapter';
import { ambiguousCandidates, rankAdapters, sniffHead } from '../formats/dispatch';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS } from '../formats/registry';
import { extensionOf } from '../formats/sniff';
import type { LibraryKind } from './model';
export type { SniffInput } from '../formats/adapter';
export interface SniffCandidate { kind: LibraryKind; format: string; confidence: number; variant?: string; needsKey?: 'fz' | 'xzz'; status?: SupportStatus; tooLarge?: boolean }
export interface SniffVerdict { kind: LibraryKind; format?: string; confidence: number; certainty: 'certain' | 'likely' | 'possible' | 'ambiguous' | 'none'; alternatives: string[]; candidates: SniffCandidate[]; variant?: string; needsKey?: 'fz' | 'xzz'; status?: SupportStatus; tooLarge?: boolean }
const none = (): SniffVerdict => ({ kind: 'unknown', confidence: 0, certainty: 'none', alternatives: [], candidates: [] });
/**
 * Pure, total, head-only. No reads, archive expansion, parsing, key requests or content-sized allocations.
 * Boards and ZIP archives are identified by the format registry (the sniffs the dispatcher ranks, so a listing and an
 * import agree); documents and the kinds no board reader covers (RAR, 7z, gzip, spreadsheets, firmware) are classified here.
 */
export function sniffAny(input: SniffInput, registry: readonly FormatAdapter[] = [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS]): SniffVerdict {
  try {
    if (!(input?.head instanceof Uint8Array) || typeof input.name !== 'string' || input.name.length > 4096 || !Number.isSafeInteger(input.size) || input.size < 0) return none();
    const raw = input.head.subarray(0, Math.min(SNIFF_BYTES, input.size));
    const name = input.name.split(/[\\/]/).pop() ?? '';
    const extension = extensionOf(name);
    // The dispatcher's view of the head: valid UTF-16 re-encoded as UTF-8, and a head that ends before the file is marked as such.
    const bounded = sniffHead(raw, name, input.size), head = bounded.head;
    const registered = rankAdapters(bounded, registry);
    const ranked: { candidate: SniffCandidate; owns: boolean }[] = registered.map(({ adapter, confidence, variant, needsKey }) => {
      const budget = 'maxInputBytes' in adapter.limits ? adapter.limits.maxInputBytes : adapter.limits.maxArchiveBytes;
      return { candidate: { kind: adapter.kind === 'container' ? 'archive' : ['.zip', '.epro', '.tgz'].includes(extension) ? 'board-archive' : 'board', format: adapter.id, confidence, ...(variant ? { variant } : {}), ...(needsKey ? { needsKey } : {}), status: adapter.capability.status, ...(input.size > budget ? { tooLarge: true } : {}) }, owns: adapter.extensions.includes(extension) };
    });
    const add = (kind: LibraryKind, format: string, confidence: number) => ranked.push({ candidate: { kind, format, confidence }, owns: false });
    const doc = sniffDocument(head);
    if (doc) add(doc.kind, doc.format, 100);
    const magic = (...bytes: number[]) => bytes.every((v, at) => raw[at] === v);
    const t = new TextDecoder('windows-1252').decode(raw);
    const zip = magic(0x50, 0x4b, 3, 4) || magic(0x50, 0x4b, 5, 6) || magic(0x50, 0x4b, 7, 8);
    // OOXML is only likely from local-head names; ZIP directory validation belongs to the scanner. The ZIP itself is the registry's container.
    if (zip && extension === '.xlsx' && t.includes('[Content_Types].xml') && t.includes('xl/')) add('spreadsheet', 'xlsx', 80);
    if (magic(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) add('archive', 'rar', 100);
    if (magic(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) add('archive', '7z', 100);
    if (magic(0x1f, 0x8b, 8)) add('archive', 'gzip', 100);
    if (magic(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) && extension === '.xls') add('spreadsheet', 'xls', 70);
    if (magic(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) && extension === '.schdoc') add('schematic', 'altium-sch', 85);
    const binary = raw.some(byte => byte < 9 || byte > 13 && byte < 32);
    if (['.bin', '.rom', '.fd', '.cap', '.bio'].includes(extension) && input.size >= 1024 && Number.isInteger(Math.log2(input.size)) && binary) add('firmware', 'firmware', 50);
    if (!zip && ['.csv', '.tsv'].includes(extension) && !raw.includes(0) && t.includes(extension === '.csv' ? ',' : '\t')) add('spreadsheet', extension.slice(1), 30);
    ranked.sort((a, b) => b.candidate.confidence - a.candidate.confidence || Number(b.owns) - Number(a.owns) || (a.candidate.format < b.candidate.format ? -1 : a.candidate.format > b.candidate.format ? 1 : 0));
    const candidates = ranked.map(c => c.candidate);
    // The dispatcher's own rule: two board readers CERTAIN about the head. Containers and documents never count.
    const certainBoards = ambiguousCandidates(registered);
    if (certainBoards.length) return { kind: 'board', confidence: certainBoards[0].confidence, certainty: 'ambiguous', alternatives: certainBoards.map(c => c.adapter.id), candidates };
    const top = candidates[0];
    if (top) return { ...top, certainty: top.confidence >= 90 ? 'certain' : top.confidence >= 50 ? 'likely' : 'possible', alternatives: candidates.slice(1).filter(c => c.confidence >= 50 && c.format !== top.format).map(c => c.format), candidates };
    if (raw.length && !binary) return { kind: 'text', format: 'text', confidence: 20, certainty: 'possible', alternatives: [], candidates: [{ kind: 'text', format: 'text', confidence: 20 }] };
    return none();
  } catch { return none(); }
}
