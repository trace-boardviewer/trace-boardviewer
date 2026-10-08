import { inflateSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { sniffDocument } from '../../../app/sniff';
import { sniffAny } from '../sniff-any';
import { checkFiles, checkTruth } from './check-truth';
import type { GroundTruth, TruthItem } from './ground-truth';
import { GROUND_TRUTH_SCHEMA } from './ground-truth';
import { validateJson } from './json-schema';
import type { MemoryLibrary } from './library';
import { generateMemoryLibrary } from './library';
import { PRESETS, parseByteSize, resolveOptions } from './presets';
import { benchGenCadForTests, configurePdfForTests, fingerprintOfFile, readPdfText } from './read-back';
import { sha256Hex } from './sha256';
import { BOMB_LIMITS, crc32, listZip } from './zip';

const MIB = 1024 * 1024;
const options = { files: 240, bytes: 20 * MIB, seed: 'library-tests' };
let library: MemoryLibrary;
const truth = (): GroundTruth => library.truth;
const bytesOf = (item: TruthItem): Uint8Array => library.files.get(item.path)!;
const loose = (): TruthItem[] => truth().items.filter(item => !item.container);

beforeAll(() => {
  configurePdfForTests();
  library = generateMemoryLibrary(options);
}, 120_000);

describe('size and determinism', () => {
  it('writes exactly the files asked for and stays within the byte budget, close to it', () => {
    expect(library.files.size).toBe(options.files);
    expect(truth().totals.files).toBe(options.files);
    let total = 0;
    for (const bytes of library.files.values()) total += bytes.length;
    expect(total).toBe(truth().totals.bytes);
    expect(total).toBeLessThanOrEqual(options.bytes);
    expect(total).toBeGreaterThan(options.bytes * 0.9);
  });

  it('gives the same bytes and the same truth for the same seed, and other bytes for another seed', () => {
    const again = generateMemoryLibrary(options);
    expect(JSON.stringify(again.truth)).toBe(JSON.stringify(library.truth));
    expect([...again.files.keys()]).toEqual([...library.files.keys()]);
    for (const [path, bytes] of library.files) expect(Buffer.from(again.files.get(path)!).equals(Buffer.from(bytes))).toBe(true);
    const other = generateMemoryLibrary({ ...options, seed: 'another' });
    expect(other.truth.items.map(item => item.sha256).join()).not.toBe(library.truth.items.map(item => item.sha256).join());
  }, 60_000);

  it('does not change a family when the file count changes (families depend on the seed and their index only)', () => {
    const smaller = generateMemoryLibrary({ ...options, files: 150, bytes: 12 * MIB });
    const first = smaller.truth.families[0], same = library.truth.families[0];
    expect({ ...first, revisions: first.revisions.map(revision => revision.revision) }).toEqual({ ...same, revisions: same.revisions.map(revision => revision.revision) });
  }, 60_000);

  it('lands close under the budget whether it is tight or generous, for several seeds, and keeps its truth consistent', () => {
    const shapes: Array<[number, number]> = [[100, 24 * 1024 * 100], [140, 60 * 1024 * 140], [150, 250 * 1024 * 150]];
    for (const [files, bytes] of shapes) for (const seed of ['budget-a', 'budget-b']) {
      const generated = generateMemoryLibrary({ files, bytes, seed });
      let total = 0;
      for (const content of generated.files.values()) total += content.length;
      expect(generated.files.size, `${files} files`).toBe(files);
      expect(total, `${files} files, ${bytes} bytes, ${seed}`).toBeLessThanOrEqual(bytes);
      expect(total, `${files} files, ${bytes} bytes, ${seed}`).toBeGreaterThan(bytes * 0.9);
      expect(checkTruth(generated.truth)).toEqual([]);
    }
  }, 120_000);

  it('rejects options that cannot be honoured', () => {
    expect(() => resolveOptions({ files: 10, bytes: 10 * MIB, seed: 1 })).toThrow(/files must be/);
    expect(() => resolveOptions({ files: 1000, bytes: 1000, seed: 1 })).toThrow(/budget of at least/);
    expect(() => resolveOptions({ files: 100, bytes: 10 * MIB })).toThrow(/seed/);
    expect(() => resolveOptions({ preset: 'huge' as never, seed: 1 })).toThrow(/preset/);
    expect(resolveOptions({ preset: 'medium', seed: 1 })).toMatchObject({ files: 5000, bytes: PRESETS.medium.bytes });
    expect(parseByteSize('64M')).toBe(64 * MIB);
    expect(parseByteSize('1.5g')).toBe(1.5 * 1024 * MIB);
    expect(() => parseByteSize('lots')).toThrow();
  });
});

describe('ground truth', () => {
  it('is consistent with itself and with the files', () => {
    expect(checkTruth(truth())).toEqual([]);
    expect(checkFiles(truth(), library.files, sha256Hex)).toEqual([]);
  });

  it('validates against its JSON schema, and a damaged truth does not', () => {
    const schema = GROUND_TRUTH_SCHEMA as unknown as Record<string, unknown>;
    const json = JSON.parse(JSON.stringify(truth())) as GroundTruth;
    expect(validateJson(schema, json)).toEqual([]);
    const broken = (change: (copy: GroundTruth & { [key: string]: unknown }) => void): string[] => { const copy = JSON.parse(JSON.stringify(json)); change(copy); return validateJson(schema, copy); };
    expect(broken(copy => { delete copy.items[0].kind; })).not.toEqual([]);
    expect(broken(copy => { (copy.items[0] as { role: string }).role = 'schematic-ish'; })).not.toEqual([]);
    expect(broken(copy => { copy.items[0].sha256 = 'abc'; })).not.toEqual([]);
    expect(broken(copy => { (copy.items[0] as { surprise?: number }).surprise = 1; })).not.toEqual([]);
    expect(broken(copy => { copy.schemaVersion = 2; })).not.toEqual([]);
    expect(broken(copy => { copy.families[0].id = 'family-1'; })).not.toEqual([]);
  });

  it('is caught by the consistency checks when it is damaged', () => {
    const copy = JSON.parse(JSON.stringify(truth())) as GroundTruth;
    copy.items[1].familyId = 'F9999';
    copy.totals.bytes += 1;
    const problems = checkTruth(copy);
    expect(problems.some(problem => problem.includes('unknown family'))).toBe(true);
    expect(problems.some(problem => problem.includes('totals.bytes'))).toBe(true);
    const files = new Map(library.files);
    files.delete(loose()[0].path);
    files.set('stray.txt', new Uint8Array(3));
    const changed = loose()[1];
    files.set(changed.path, new Uint8Array(changed.size));
    const fileProblems = checkFiles(truth(), files, sha256Hex);
    expect(fileProblems.some(problem => problem.startsWith('missing'))).toBe(true);
    expect(fileProblems.some(problem => problem.startsWith('unknown file'))).toBe(true);
    expect(fileProblems.some(problem => problem.includes('hash differs'))).toBe(true);
  });

  it('describes families with one to four revisions that change a few percent of the parts', () => {
    const counts = new Set(truth().families.map(family => family.revisions.length));
    expect([...counts].every(count => count >= 1 && count <= 4)).toBe(true);
    expect(counts.size).toBeGreaterThan(1);
    for (const family of truth().families) {
      family.revisions.forEach((revision, index) => {
        expect(revision.order).toBe(index + 1);
        if (index === 0) expect(revision.jaccardToPrevious).toBeNull();
        else {
          expect(revision.jaccardToPrevious!).toBeGreaterThan(0.85);
          expect(revision.jaccardToPrevious!).toBeLessThan(1);
          expect(revision.changedParts).toBeGreaterThan(0);
          expect(revision.changedParts).toBeLessThanOrEqual(Math.ceil(revision.parts * 0.1) + 2);
        }
        expect(revision.partNumbers.every(part => part.exact.startsWith(part.base))).toBe(true);
      });
    }
  });

  it('makes sibling families that look alike but are not the same board', () => {
    const sibling = generateMemoryLibrary({ files: 400, bytes: 32 * MIB, seed: 'sibling-hunt' }).truth.families.filter(family => family.siblingOf);
    for (const family of sibling) {
      expect(family.siblingJaccard!).toBeGreaterThan(0.3);
      expect(family.siblingJaccard!).toBeLessThan(0.7);
    }
  }, 60_000);

  it('covers the cases a collection has: copies, renamed and mis-named files, damage, documents of several kinds', () => {
    const flags = new Set(truth().items.flatMap(item => item.flags));
    for (const flag of ['copy', 'renamed-copy', 'wrong-extension', 'truncated', 'empty', 'zip-bomb', 'zip-slip', 'nested-archive', 'signature-only', 'encrypted-entry', 'in-archive', 'deep-path', 'unicode-name', 'upper-case-extension'] as const) expect(flags.has(flag), flag).toBe(true);
    const formats = new Set(truth().items.map(item => item.format));
    for (const format of ['gencad', 'bvr', 'brd2', 'kicad', 'ipc356', 'pinlist', 'pdf', 'png', 'jpeg', 'zip', 'rar', '7z', 'csv', 'firmware']) expect(formats.has(format), format).toBe(true);
    const roles = new Set(truth().items.map(item => item.role));
    for (const role of ['board', 'schematic', 'board-pdf', 'datasheet', 'service-manual', 'bom', 'photo', 'firmware', 'other']) expect(roles.has(role as never), role).toBe(true);
    const share = loose().filter(item => item.duplicateSet).length / loose().length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.5);
    expect(truth().items.some(item => item.joinStrength === 'strong')).toBe(true);
    expect(truth().items.some(item => item.joinStrength === 'weak')).toBe(true);
    expect(truth().items.some(item => item.joinStrength === 'none' && item.familyId)).toBe(true);
  });
});

describe('what the files really are', () => {
  it('gives every board file the fingerprint the application computes from it', async () => {
    const boards = loose().filter(item => item.fingerprint && !item.flags.includes('truncated'));
    expect(boards.length).toBeGreaterThan(30);
    for (const item of boards) expect(await fingerprintOfFile(item.format!, item.path.split('/').pop()!, bytesOf(item)), `${item.format} ${item.path}`).toBe(item.fingerprint);
  });

  it('is sniffed as the kind the truth records (documents and images)', () => {
    let checked = 0;
    for (const item of loose()) {
      if (item.flags.includes('encrypted') || item.flags.includes('truncated') || item.size < 5) continue;
      const sniffed = sniffDocument(bytesOf(item));
      if (item.kind === 'pdf') expect(sniffed, item.path).toEqual({ kind: 'pdf', format: 'pdf' });
      else if (item.kind === 'image') expect(sniffed, item.path).toEqual({ kind: 'image', format: item.format });
      else if (item.kind === 'schematic') expect(sniffed, item.path).toEqual({ kind: 'schematic', format: 'kicad_sch' });
      else if (item.kind === 'board' || item.kind === 'text' || item.kind === 'firmware') expect(sniffed, item.path).toBeNull();
      else continue;
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('is typed by the sniffer of the Library as the truth says (a bill of materials may look like a pin list, never certainly)', () => {
    let checked = 0;
    for (const item of loose()) {
      const bytes = bytesOf(item);
      const verdict = sniffAny({ head: bytes.subarray(0, 65_536), name: item.path.split('/').pop()!, size: bytes.length });
      if (item.role === 'bom' && item.format === 'csv') { expect(verdict.certainty, item.path).not.toBe('certain'); continue; }
      if (item.size === 0 || item.kind === 'unknown') { expect(verdict.kind, item.path).toBe('unknown'); continue; }
      expect({ kind: verdict.kind, format: verdict.format }, item.path).toEqual({ kind: item.kind, format: item.format });
      if (item.needsKey) expect(verdict.needsKey ?? verdict.candidates.find(candidate => candidate.format === item.format)?.needsKey, item.path).toBe(item.needsKey);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('prints in each PDF what the truth says it prints', async () => {
    const pdfs = loose().filter(item => item.kind === 'pdf' && !item.flags.includes('truncated') && !item.flags.includes('password-protected') && !item.flags.includes('scanned'));
    const withNumbers = pdfs.filter(item => item.partNumbers?.length).slice(0, 12);
    expect(withNumbers.length).toBeGreaterThan(3);
    for (const item of withNumbers) {
      const { pages, text } = await readPdfText(bytesOf(item));
      expect(pages, item.path).toBe(item.pages);
      const all = text.join('\n');
      for (const number of item.partNumbers!) expect(all, `${item.path} ${number}`).toContain(number);
      for (const decoy of (item.decoys ?? []).slice(0, 5)) expect(all, `${item.path} ${decoy}`.toUpperCase()).toContain(decoy);
    }
    for (const item of pdfs.filter(entry => entry.role === 'schematic' && entry.joinStrength === 'strong').slice(0, 4)) {
      const family = truth().families.find(entry => entry.id === item.familyId)!;
      const { text } = await readPdfText(bytesOf(item));
      if (item.evidence.includes('title-id')) expect(text[0], item.path).toContain(family.boardNumber.toUpperCase());
    }
    const scanned = pdfs.length ? loose().filter(item => item.flags.includes('scanned')) : [];
    for (const item of scanned) expect((await readPdfText(bytesOf(item))).text.every(page => page === '')).toBe(true);
  }, 60_000);

  it('keeps firmware images at power-of-two sizes and encrypted-looking boards without a signature', () => {
    for (const item of loose().filter(entry => entry.kind === 'firmware')) expect(Math.log2(item.size)).toBe(Math.round(Math.log2(item.size)));
    for (const item of loose().filter(entry => entry.flags.includes('encrypted') && entry.kind === 'board')) {
      expect(item.needsKey).toBeDefined();
      const head = new TextDecoder('latin1').decode(bytesOf(item).subarray(0, 64));
      expect(/^(\$HEADER|GENCAD|BVRAW|\(kicad|BRDOUT|XZZPCB)/.test(head)).toBe(false);
    }
  });
});

describe('hostile archives', () => {
  const archivesWith = (flag: string): TruthItem[] => loose().filter(item => item.kind === 'archive' && item.flags.includes(flag as never));

  it('writes ZIP bombs that are small on disk, bounded when inflated, and flagged', () => {
    const bombs = archivesWith('zip-bomb');
    expect(bombs.length).toBeGreaterThan(0);
    for (const bomb of bombs) {
      const bytes = bytesOf(bomb);
      expect(bytes.length).toBeLessThanOrEqual(BOMB_LIMITS.maxFileBytes);
      const entries = listZip(bytes)!;
      let total = 0;
      for (const entry of entries) {
        total += entry.size;
        expect(entry.size).toBeLessThanOrEqual(BOMB_LIMITS.maxEntryBytes);
        expect(entry.name.endsWith('.zip')).toBe(false);
      }
      expect(total).toBeLessThanOrEqual(BOMB_LIMITS.maxTotalBytes);
      const heavy = entries.filter(entry => entry.size >= 1024 * 1024);
      expect(heavy.length).toBeGreaterThan(0);
      for (const entry of heavy) expect(entry.size / entry.compressedSize).toBeGreaterThanOrEqual(BOMB_LIMITS.minRatio);
      const members = truth().items.filter(item => item.container?.archive === bomb.path && item.flags.includes('zip-bomb'));
      expect(members.map(member => member.container!.entry).sort()).toEqual(heavy.map(entry => entry.name).sort());
      for (const member of members) { expect(member.sha256).toBeNull(); expect(member.declaredSize).toBeLessThanOrEqual(BOMB_LIMITS.maxEntryBytes); }
    }
  });

  it('really inflates a bomb entry to zeros of the declared size, with the recorded checksum', () => {
    const bytes = bytesOf(archivesWith('zip-bomb')[0]);
    const entry = listZip(bytes)!.find(candidate => candidate.size >= 1024 * 1024)!;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    const data = inflateSync(bytes.subarray(start, start + entry.compressedSize));
    expect(data.length).toBe(entry.size);
    expect(data.every(byte => byte === 0)).toBe(true);
    expect(crc32(data)).toBe(entry.crc);
  });

  it('writes zip-slip names exactly as given and marks the archive and its bad members', () => {
    const slips = archivesWith('zip-slip');
    expect(slips.length).toBeGreaterThan(0);
    const names = listZip(bytesOf(slips[0]))!.map(entry => entry.name);
    expect(names).toEqual(expect.arrayContaining(['../../outside/evil.txt', '/absolute/evil.bin', 'C:\\Windows\\Temp\\evil.dll', 'docs/../../../up.txt', '..\\..\\back.txt']));
    const bad = truth().items.filter(item => item.container?.archive === slips[0].path && item.flags.includes('zip-slip'));
    expect(bad.length).toBe(5);
    expect(bad.every(item => item.familyId === null && item.joinStrength === 'none')).toBe(true);
    // nothing of this reaches the file system: the library's own paths never contain a parent reference
    for (const item of loose()) expect(item.path.split('/').some(segment => segment === '..' || segment === '.')).toBe(false);
  });

  it('nests an archive in an archive once, lists the inner members as unreachable, and holds no archive inside a bomb', () => {
    const nested = archivesWith('nested-archive');
    expect(nested.length).toBeGreaterThan(0);
    const outer = listZip(bytesOf(nested[0]))!;
    expect(outer.some(entry => entry.name === 'inner/boards.zip')).toBe(true);
    const inner = truth().items.filter(item => item.container?.archive === nested[0].path && item.container.entry.startsWith('inner/boards.zip!/'));
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every(item => item.joinStrength === 'none' && item.evidence.length === 0)).toBe(true);
    for (const bomb of archivesWith('zip-bomb')) expect(listZip(bytesOf(bomb))!.some(entry => /\.(zip|rar|7z)$/i.test(entry.name))).toBe(false);
  });

  it('flags an encrypted entry, cuts a download short, and writes RAR and 7z files as signatures only', () => {
    const encrypted = loose().filter(item => truth().items.some(member => member.container?.archive === item.path && member.flags.includes('encrypted-entry')));
    expect(encrypted.length).toBeGreaterThan(0);
    expect(listZip(bytesOf(encrypted[0]))!.some(entry => entry.encrypted)).toBe(true);
    const cut = archivesWith('truncated').filter(item => item.format === 'zip');
    expect(cut.length).toBeGreaterThan(0);
    expect(listZip(bytesOf(cut[0]))).toBeNull();
    const signatures = archivesWith('signature-only');
    expect(signatures.map(item => item.format).sort()).toEqual(['7z', 'rar', 'rar']);
    for (const item of signatures) expect(item.size).toBeLessThan(64);
    expect(bytesOf(signatures.find(item => item.format === '7z')!).subarray(0, 6)).toEqual(Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c));
  });

  it('can leave the hostile cases out', () => {
    const calm = generateMemoryLibrary({ files: 120, bytes: 8 * MIB, seed: 'calm', hostile: false });
    const flags = new Set(calm.truth.items.flatMap(item => item.flags));
    for (const flag of ['zip-bomb', 'zip-slip', 'signature-only', 'encrypted-entry', 'nested-archive'] as const) expect(flags.has(flag), flag).toBe(false);
    expect(checkTruth(calm.truth)).toEqual([]);
  }, 60_000);
});

describe('benchmark boards', () => {
  it('uses the benchmark generator for the first revision of some families when it is given', () => {
    const generated = generateMemoryLibrary({ files: 160, bytes: 14 * MIB, seed: 'bench-share', benchGenCad: benchGenCadForTests(), benchShare: 1 });
    expect(checkTruth(generated.truth)).toEqual([]);
    expect(checkFiles(generated.truth, generated.files, sha256Hex)).toEqual([]);
    const text = [...generated.files.entries()].filter(([path]) => /\.(cad|gcd)$/i.test(path)).map(([, bytes]) => new TextDecoder().decode(bytes));
    expect(text.some(content => content.includes('UNITS MM') && content.includes('$PADSTACKS') && content.includes('FP_0402'))).toBe(true);
  }, 60_000);

});
