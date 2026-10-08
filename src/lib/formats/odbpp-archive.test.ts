import { gunzipSync, gzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { expectCostAtMost } from '../../test-support/timing';
import { BoardFormatError } from './common';
import { containerKind, crc32, DEFAULT_ODBPP_LIMITS, normalizeEntryPath, odbTail, readContainer, resolveLimits, sniffContainer, treeFromFiles, unlzw } from './odbpp-archive';
import { bytesOf, compressZ, crc, rawZip, rooted, tarEntries, tarOf, tgzOf, zipOf } from './odbpp-fixture';

const limits = (overrides: Parameters<typeof resolveLimits>[0] = {}) => resolveLimits(overrides);
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const text = (data: Uint8Array | undefined) => data === undefined ? undefined : new TextDecoder().decode(data);
const JOB = {
  'matrix/matrix': 'STEP {\nNAME=PCB\n}\n', 'misc/info': 'UNITS=MM\n', 'steps/pcb/eda/data': 'NET GND\n', 'steps/pcb/profile': 'S P 0\nSE\n',
  'steps/pcb/layers/comp_+_top/components': 'CMP 0 0 0 0 N R1 X\n', 'steps/pcb/layers/comp_+_top/features': 'F 0\n', 'steps/pcb/layers/top/features': 'F 0\n',
  'steps/pcb/netlists/cadnet/netlist': '$0 GND\n', 'steps/pcb/stephdr': 'X_DATUM=0\n', 'fonts/standard': 'XSIZE 1\n', 'symbols/r10/features': 'F 0\n',
};
const NEEDED = Object.keys(JOB).filter(path => odbTail(path)).sort();
/** Deterministic xorshift32 generator. */
function rng(seed: number) { let state = seed >>> 0 || 1; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; }; }

describe('entry paths', () => {
  it('normalizes separators and case and refuses anything that could leave the archive root', () => {
    expect(normalizeEntryPath('./Job\\Steps//PCB/./eda/DATA')).toBe('job/steps/pcb/eda/data');
    for (const unsafe of ['../matrix/matrix', 'job/../../etc/passwd', '/etc/passwd', '\\\\server\\share\\x', 'C:/odb/matrix/matrix', 'c:matrix', 'job/\0/matrix', 'a/'.repeat(600)]) {
      expect(normalizeEntryPath(unsafe), unsafe).toBeNull();
    }
    expect(normalizeEntryPath('a..b/c')).toBe('a..b/c');
  });

  it('finds the product-model root at most two directories deep', () => {
    expect(odbTail('matrix/matrix')).toEqual({ root: '', tail: 'matrix/matrix' });
    expect(odbTail('job/steps/pcb/layers/comp_+_bot/components.z')).toEqual({ root: 'job/', tail: 'steps/pcb/layers/comp_+_bot/components.z' });
    expect(odbTail('export/job/misc/info')).toEqual({ root: 'export/job/', tail: 'misc/info' });
    expect(odbTail('a/b/c/matrix/matrix')).toBeNull();
    expect(odbTail('job/steps/pcb/layers/top/features')).toBeNull(); // copper features are never kept
    expect(odbTail('job/steps/pcb/eda/data/extra')).toBeNull();
  });
});

describe('containers', () => {
  const read = (data: Uint8Array, overrides = {}) => readContainer(data, limits(overrides));
  const kept = (data: Uint8Array) => { const tree = read(data)!; return [...tree.files.keys()].sort(); };

  it('keeps only the files a board needs, from gzip tar, plain tar, tar.Z, ZIP and a file set', () => {
    const rootedJob = rooted(JOB, 'job/');
    const expected = NEEDED.map(path => `job/${path}`);
    expect(kept(tgzOf(rootedJob))).toEqual(expected);
    expect(kept(tarOf(rootedJob))).toEqual(expected);
    expect(kept(compressZ(tarOf(rootedJob)))).toEqual(expected);
    expect(kept(zipOf(rootedJob))).toEqual(expected);
    expect([...treeFromFiles(Object.fromEntries(Object.entries(rootedJob).map(([path, data]) => [path, bytesOf(data)])), limits()).files.keys()].sort()).toEqual(expected);
    const tree = read(tgzOf(rootedJob))!;
    expect(tree).toMatchObject({ container: 'tgz', unsafePaths: 0, links: 0, duplicates: 0, compressedMembers: 0, endMissing: false });
    expect(text(tree.files.get('job/misc/info'))).toBe('UNITS=MM\n');
    expect(read(new TextEncoder().encode('not an archive at all, just text'))).toBeNull();
  });

  it('decompresses .Z members (UNIX compress) and prefers a plain copy over a compressed duplicate', () => {
    const eda = 'NET GND\n'.repeat(5000);
    const tree = read(tarOf({ 'job/steps/pcb/eda/data.Z': compressZ(new TextEncoder().encode(eda)), 'job/matrix/matrix': 'STEP {\nNAME=PCB\n}\n', 'job/misc/info.Z': compressZ(new TextEncoder().encode('UNITS=INCH\n')), 'job/misc/info': 'UNITS=MM\n' }))!;
    expect(text(tree.files.get('job/steps/pcb/eda/data'))).toBe(eda);
    expect(text(tree.files.get('job/misc/info'))).toBe('UNITS=MM\n');
    expect(tree.compressedMembers).toBe(1);
    expect(tree.duplicates).toBe(1);
    expect(tree.files.has('job/steps/pcb/eda/data.z')).toBe(false);
  });

  it('opens one nested archive inside a ZIP that holds no product model itself', () => {
    const outer = zipOf({ 'README.txt': 'export', 'board-odb.tgz': tgzOf(rooted(JOB, 'board/')) });
    const tree = read(outer)!;
    expect(tree.nested).toBe('board-odb.tgz');
    expect([...tree.files.keys()].sort()).toEqual(NEEDED.map(path => `board/${path}`));
    expect(sniffContainer(outer, limits())).toMatchObject({ container: 'zip', nested: 'board-odb.tgz' });
    // Two candidates are ambiguous: nothing is opened.
    expect(read(zipOf({ 'a.tgz': tgzOf(JOB), 'b.zip': zipOf(JOB) }))!.files.size).toBe(0);
  });

  it('ignores unsafe paths and links, and counts them', () => {
    const tar = tarEntries([
      { path: '../matrix/matrix', data: 'evil' }, { path: '/abs/misc/info', data: 'evil' }, { path: 'job/../steps/pcb/eda/data', data: 'evil' },
      { path: 'job/steps/pcb/profile', type: '2', link: '../../etc/passwd' }, { path: 'job/matrix/matrix', type: '1', link: 'job/misc/info' },
      { path: 'job/misc/info', data: 'UNITS=MM\n' },
    ]);
    const tree = read(tar)!;
    expect([...tree.files.keys()]).toEqual(['job/misc/info']);
    expect(tree).toMatchObject({ unsafePaths: 3, links: 2 });
    const zip = rawZip([{ name: 'job/steps/pcb/eda/data', data: '../../secret', symlink: true }, { name: '..\\matrix\\matrix', data: 'x' }, { name: 'job/misc/info', data: 'UNITS=MM\n' }]);
    expect(read(zip)).toMatchObject({ unsafePaths: 1, links: 1 });
    expect([...read(zip)!.files.keys()]).toEqual(['job/misc/info']);
  });

  it('checks every ZIP member against its CRC-32 and declared size, and refuses what it cannot read', () => {
    const entry = { name: 'job/misc/info', data: 'UNITS=MM\n' };
    expect(text(read(rawZip([entry]))!.files.get('job/misc/info'))).toBe('UNITS=MM\n');
    expect(text(read(rawZip([{ ...entry, method: 0 }]))!.files.get('job/misc/info'))).toBe('UNITS=MM\n');
    expect(text(read(rawZip([{ ...entry, zip64: true }]))!.files.get('job/misc/info'))).toBe('UNITS=MM\n');
    expect(failure(() => read(rawZip([{ ...entry, crcOverride: 1234 }]))).message).toMatch(/CRC-32/);
    expect(failure(() => read(rawZip([{ ...entry, sizeOverride: 5 }]))).message).toMatch(/expands beyond its declared size/);
    expect(failure(() => read(rawZip([{ ...entry, sizeOverride: 50 }]))).message).toMatch(/does not match its declared size/);
    expect(failure(() => read(rawZip([{ ...entry, method: 0, sizeOverride: 50 }]))).message).toMatch(/does not match its declared size/);
    expect(failure(() => read(rawZip([{ ...entry, flags: 1 }]))).code).toBe('UNSUPPORTED_VARIANT');
    expect(failure(() => read(rawZip([{ ...entry, method: 12 }]))).code).toBe('UNSUPPORTED_VARIANT');
    expect(failure(() => read(rawZip([entry], { disk: 1 }))).code).toBe('UNSUPPORTED_VARIANT');
    expect(failure(() => read(rawZip([entry], { omitDirectory: true }))).message).toMatch(/central directory is missing/);
    expect(read(rawZip([{ name: 'photo.jpg', data: 'x' }], { omitDirectory: true }))).toBeNull(); // not a product model: another reader may claim it
    const zip = rawZip([{ name: 'readme.txt', data: 'x' }, entry]);
    const second = zip.findIndex((byte, at) => at > 0 && byte === 0x50 && zip[at + 1] === 0x4b && zip[at + 2] === 3 && zip[at + 3] === 4);
    zip[second + 2] = 9; // break the second local header signature; the central directory still points at it
    expect(failure(() => read(zip)).message).toMatch(/local header/);
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
    expect(crc(bytesOf('123456789'))).toBe(0xcbf43926);
  });

  it('stops decompression bombs at the stream, entry and kept-byte budgets', () => {
    const zeros = new Uint8Array(32 << 20);
    // A gzip tar whose one huge unselected entry inflates past the stream budget: the work stops there.
    const huge = gzipSync(tarEntries([{ path: 'job/steps/pcb/layers/top/features', data: zeros }, { path: 'job/misc/info', data: 'UNITS=MM\n' }]), { level: 9 });
    expect(huge.length).toBeLessThan(200_000);
    expect(failure(() => read(huge, { maxStreamBytes: 4 << 20 })).code).toBe('LIMIT_EXCEEDED');
    // The refusal stops at the 4 MiB budget: far less work than inflating the 32 MiB entry.
    expectCostAtMost('stream budget on a bomb', () => { try { read(huge, { maxStreamBytes: 4 << 20 }); } catch { /* the refusal under test */ } }, () => gunzipSync(huge), 0.6);
    // A flood of zeros after the end-of-archive block is never inflated.
    const tail = new Uint8Array(tarOf({ 'job/misc/info': 'UNITS=MM\n' }).length + zeros.length);
    tail.set(tarOf({ 'job/misc/info': 'UNITS=MM\n' }));
    expect([...read(gzipSync(tail), { maxStreamBytes: 1 << 20 })!.files.keys()]).toEqual(['job/misc/info']);
    // ZIP: a member that declares more than the entry budget, and one that lies about its size.
    expect(failure(() => read(zipSync({ 'job/steps/pcb/eda/data': zeros }), { maxEntryBytes: 1 << 20 })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => read(rawZip([{ name: 'job/steps/pcb/eda/data', data: zeros.subarray(0, 4 << 20), sizeOverride: 100 }]))).message).toMatch(/expands beyond its declared size/);
    expect(failure(() => read(zipOf(rooted(JOB, 'job/')), { maxKeptBytes: 50 })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => read(tgzOf(rooted(JOB, 'job/')), { maxKeptBytes: 50 })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => read(tgzOf(rooted(JOB, 'job/')), { maxEntries: 3 })).code).toBe('LIMIT_EXCEEDED');
    // A .Z member that expands past the entry budget.
    const member = compressZ(new Uint8Array(2 << 20));
    expect(failure(() => read(tarOf({ 'job/steps/pcb/eda/data.Z': member }), { maxEntryBytes: 1 << 20 })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => read(new Uint8Array(100), { maxArchiveBytes: 10 })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => treeFromFiles({ 'misc/info': new Uint8Array(100) }, limits({ maxEntryBytes: 10 }))).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => treeFromFiles({ 'misc/info': 'x' as unknown as Uint8Array }, limits())).message).toMatch(/byte array/);
  });

  it('reports damaged and truncated streams as malformed archives, never as other errors', () => {
    const tgz = tgzOf(rooted(JOB, 'job/'));
    for (const cut of [20, 60, tgz.length >> 1]) expect(failure(() => read(tgz.subarray(0, cut))).code, `cut ${cut}`).toBe('INVALID_FORMAT');
    // A stream cut inside its 8-byte trailer still holds the whole archive up to the end-of-archive block: every kept entry is complete.
    expect(read(tgz.subarray(0, tgz.length - 1))!.files.size).toBe(NEEDED.length);
    const unterminated = gzipSync(tarEntries([{ path: 'job/misc/info', data: 'x'.repeat(700) }], { end: false }));
    for (const cut of [unterminated.length - 9, unterminated.length - 1]) expect(failure(() => read(unterminated.subarray(0, cut))).code, `cut ${cut}`).toBe('INVALID_FORMAT');
    const flipped = tgz.slice(); flipped[40] ^= 0xff;
    expect(failure(() => read(flipped))).toBeInstanceOf(BoardFormatError);
    const zip = zipOf(rooted(JOB, 'job/'));
    for (const cut of [10, zip.length >> 1, zip.length - 30]) expect(() => read(zip.subarray(0, cut)), `cut ${cut}`).not.toThrow(TypeError);
  });

  it('survives random corruption of every container with a board or a BoardFormatError only', () => {
    const random = rng(0xc0ffee);
    const samples = [tgzOf(rooted(JOB, 'job/')), tarOf(rooted(JOB, 'job/')), zipOf(rooted(JOB, 'job/')), compressZ(tarOf(rooted(JOB, 'job/')))];
    let errors = 0, trees = 0;
    for (let round = 0; round < 400; round++) {
      const sample = samples[round % samples.length], bytes = sample.slice();
      const flips = 1 + Math.floor(random() * 8);
      for (let flip = 0; flip < flips; flip++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const cut = random() < 0.3 ? Math.floor(random() * bytes.length) : bytes.length;
      try { if (readContainer(bytes.subarray(0, cut), limits({ maxStreamBytes: 8 << 20 }))) trees++; }
      catch (error) { expect(error, `round ${round}`).toBeInstanceOf(BoardFormatError); errors++; }
    }
    expect(errors + trees).toBeGreaterThan(300);
  });
});

describe('UNIX compress (LZW)', () => {
  const decode = (data: Uint8Array, max = 1 << 26) => { const chunks: Uint8Array[] = []; const size = unlzw(data, chunk => chunks.push(chunk.slice()), max); const out = new Uint8Array(size); let at = 0; for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; } return out; };
  it('round-trips the classic layout at every code width, with and without CLEAR codes', () => {
    const random = rng(7), noise = Uint8Array.from({ length: 80_000 }, () => Math.floor(random() * 256));
    const textual = new TextEncoder().encode('TOP 0 1.27 2.54 0 N 3 0 1\nSNT TOP T 4 1\nFID C 2 77\n'.repeat(4000));
    for (const [data, bits, clear] of [[textual, 16, true], [noise, 16, true], [noise, 9, true], [noise, 12, false], [textual, 10, true], [Uint8Array.of(7), 16, true]] as const) {
      expect(decode(compressZ(data, bits, clear)), `${data.length} bytes, ${bits} bits`).toEqual(data);
    }
    expect(decode(compressZ(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });
  it('rejects bad headers, impossible codes and output past the limit', () => {
    expect(failure(() => decode(Uint8Array.of(0x1f, 0x8b, 0x90))).message).toMatch(/compress signature/);
    expect(failure(() => decode(Uint8Array.of(0x1f, 0x9d, 0x91))).message).toMatch(/17-bit codes/);
    expect(failure(() => decode(Uint8Array.of(0x1f, 0x9d, 0x90, 0xff, 0x01))).message).toMatch(/invalid code/);
    expect(failure(() => decode(Uint8Array.of(0x1f, 0x9d, 0x90, 0x41, 0xfe, 0x03))).message).toMatch(/out of sequence/);
    expect(failure(() => decode(compressZ(new Uint8Array(100_000)), 1000)).code).toBe('LIMIT_EXCEEDED');
  });
});

describe('sniffing', () => {
  it('lists entry paths from a bounded prefix of each container kind', () => {
    const job = rooted(JOB, 'job/');
    for (const [bytes, container] of [[tgzOf(job), 'tgz'], [tarOf(job), 'tar'], [zipOf(job), 'zip'], [compressZ(tarOf(job)), 'tar.Z']] as const) {
      const found = sniffContainer(bytes, limits())!;
      expect(found.container, container).toBe(container);
      expect(found.paths).toContain('job/matrix/matrix');
    }
    expect(containerKind(new Uint8Array(10))).toBeNull();
    expect(sniffContainer(bytesOf('plain text'), limits())).toBeNull();
    // Only the first sniffBytes of a gzip stream are inflated: a model behind a big leading entry is not seen.
    const late = tgzOf({ 'big.bin': new Uint8Array(3 << 20), 'job/matrix/matrix': 'STEP {\nNAME=PCB\n}\n' });
    expect(sniffContainer(late, limits({ sniffBytes: 1 << 20 }))!.paths).toEqual(['big.bin']);
    expect(sniffContainer(late, limits())!.paths).toEqual(['big.bin', 'job/matrix/matrix']);
    // Damaged containers are still named, with whatever paths were readable.
    expect(sniffContainer(tgzOf(job).subarray(0, 30), limits())).toMatchObject({ container: 'tgz' });
  });
  it('validates limits', () => {
    expect(() => resolveLimits({ maxEntries: 0 })).toThrow(BoardFormatError);
    expect(() => resolveLimits({ maxStreamBytes: 1.5 })).toThrow(BoardFormatError);
    expect(resolveLimits({ maxEntryBytes: 1 << 30 }).maxEntryBytes).toBe(DEFAULT_ODBPP_LIMITS.maxEntryBytes);
  });
});
