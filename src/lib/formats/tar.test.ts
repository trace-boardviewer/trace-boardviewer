import { describe, expect, it } from 'vitest';
import { expectScaling } from '../../test-support/timing';
import { BoardFormatError } from './common';
import { paxRecord, tarEntries, type TarEntry } from './odbpp-fixture';
import { TarReader, type TarEntryInfo, type TarLimits } from './tar';

const text = (data: Uint8Array) => new TextDecoder().decode(data);
interface Read { files: Record<string, string>; seen: TarEntryInfo[]; summary: ReturnType<TarReader['finish']> }
/** Feeds `bytes` in chunks of `chunk` bytes (0: all at once) and keeps every regular file `keep` accepts. */
function read(bytes: Uint8Array, options: { chunk?: number; keep?: (entry: TarEntryInfo) => boolean; limits?: Partial<TarLimits> } = {}): Read {
  const files: Record<string, string> = {}, seen: TarEntryInfo[] = [];
  const reader = new TarReader(entry => { seen.push(entry); return entry.type === 'file' && (options.keep?.(entry) ?? true); }, (path, data) => { files[path] = text(data); }, options.limits);
  const step = options.chunk || bytes.length || 1;
  for (let at = 0; at < bytes.length; at += step) reader.push(bytes.subarray(at, at + step));
  return { files, seen, summary: reader.finish() };
}
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const SAMPLE: TarEntry[] = [
  { path: 'job/', type: '5' },
  { path: 'job/matrix/matrix', data: 'STEP {\n NAME=PCB\n}\n' },
  { path: 'job/misc/info', data: 'UNITS=MM\n' },
  { path: 'job/empty', data: '' },
  { path: 'job/big', data: 'x'.repeat(1300) },
];

describe('TarReader', () => {
  it('delivers the same regular files whatever the chunk size', () => {
    const bytes = tarEntries(SAMPLE);
    const whole = read(bytes);
    expect(Object.keys(whole.files)).toEqual(['job/matrix/matrix', 'job/misc/info', 'job/empty', 'job/big']);
    expect(whole.files['job/big']).toBe('x'.repeat(1300));
    expect(whole.files['job/empty']).toBe('');
    for (const chunk of [1, 7, 511, 512, 513, 4096]) expect(read(bytes, { chunk }).files, `chunk ${chunk}`).toEqual(whole.files);
    expect(whole.summary).toMatchObject({ headers: 5, files: 4, links: 0, other: 0, endMissing: false });
    expect(whole.seen.find(entry => entry.path === 'job/')?.type).toBe('directory');
  });

  it('joins the POSIX ustar prefix, but not the old GNU layout that reuses those bytes', () => {
    const posix = read(tarEntries([{ path: 'matrix', prefix: 'deep/product', data: 'm' }]));
    expect(posix.files).toEqual({ 'deep/product/matrix': 'm' });
    const gnu = read(tarEntries([{ path: 'matrix', prefix: 'ignored', data: 'm', gnuMagic: true }]));
    expect(gnu.files).toEqual({ matrix: 'm' });
  });

  it('applies pax path and size records and GNU long names to the next entry only', () => {
    const long = `job/${'very-long-directory-name/'.repeat(8)}steps/pcb/eda/data`;
    const result = read(tarEntries([{ path: long, data: 'NET GND\n', longName: 'pax' }, { path: `${long}2`, data: 'two', longName: 'gnu' }, { path: 'short', data: 's' }]));
    expect(result.files).toEqual({ [long]: 'NET GND\n', [`${long}2`]: 'two', short: 's' });
    const sized = new TextEncoder().encode(paxRecord('size', '3'));
    const bytes = tarEntries([{ path: 'PaxHeader/x', type: 'x', data: sized }, { path: 'file', data: 'abc', sizeOverride: 99 }]);
    expect(read(bytes).files).toEqual({ file: 'abc' });
  });

  it('reads base-256 sizes and accepts checksums summed over signed bytes', () => {
    expect(read(tarEntries([{ path: 'b256', data: 'payload', base256Size: true }])).files).toEqual({ b256: 'payload' });
    const bytes = tarEntries([{ path: 'café', data: 'z' }]); // a UTF-8 name has bytes above 127
    let signed = 0;
    for (let index = 0; index < 512; index++) { const byte = index >= 148 && index < 156 ? 32 : bytes[index]; signed += byte > 127 ? byte - 256 : byte; }
    bytes.set(new TextEncoder().encode(`${signed.toString(8).padStart(6, '0')}\0 `), 148);
    expect(read(bytes).files).toEqual({ 'café': 'z' });
  });

  it('never delivers links, devices or FIFOs, and counts them', () => {
    const result = read(tarEntries([
      { path: 'job/matrix/matrix', type: '2', link: '/etc/passwd' }, { path: 'job/hard', type: '1', link: 'job/misc/info' },
      { path: 'job/dev', type: '3' }, { path: 'job/fifo', type: '6' }, { path: 'job/misc/info', data: 'UNITS=MM\n' },
    ]));
    expect(result.files).toEqual({ 'job/misc/info': 'UNITS=MM\n' });
    expect(result.summary).toMatchObject({ links: 2, other: 2, files: 1 });
    expect(result.seen.map(entry => entry.type)).toEqual(['link', 'link', 'other', 'other', 'file']);
  });

  it('skips unselected entries without delivering them and ignores bytes after the end-of-archive block', () => {
    const bytes = tarEntries(SAMPLE), padded = new Uint8Array(bytes.length + 2048);
    padded.set(bytes); padded.fill(0x41, bytes.length); // junk after the end marker
    const result = read(padded, { keep: entry => entry.path.endsWith('info') });
    expect(result.files).toEqual({ 'job/misc/info': 'UNITS=MM\n' });
  });

  it('rejects damaged headers, truncation inside an entry and dangling extended headers', () => {
    expect(failure(() => read(tarEntries([{ path: 'a', data: 'a', breakChecksum: true }]))).message).toMatch(/invalid checksum/);
    const bytes = tarEntries([{ path: 'a', data: 'x'.repeat(700) }], { end: false });
    for (const cut of [100, 512, 600, 1024, 1500]) expect(failure(() => read(bytes.subarray(0, cut))).message, `cut ${cut}`).toMatch(/truncated/);
    const pax = new TextEncoder().encode(paxRecord('path', 'x'));
    expect(failure(() => read(tarEntries([{ path: 'p', type: 'x', data: pax }]))).message).toMatch(/extended header/);
    expect(failure(() => read(tarEntries([{ path: 'p', type: 'x', data: pax }], { end: false }))).message).toMatch(/extended header/);
    expect(failure(() => read(tarEntries([{ path: 'p', type: 'x', data: pax }, { path: 'q', type: 'x', data: pax }, { path: 'r', data: 'r' }]))).message).toMatch(/two pax/);
    expect(failure(() => read(tarEntries([{ path: 'p', type: 'x', data: '5 x\n' }, { path: 'r', data: 'r' }]))).message).toMatch(/malformed pax/);
    expect(failure(() => read(tarEntries([{ path: 'p', type: 'x', data: '99 path=x\n' }, { path: 'r', data: 'r' }]))).message).toMatch(/malformed pax/);
    const badSize = tarEntries([{ path: 'a', data: 'a' }]);
    badSize.set(new TextEncoder().encode('12x'), 124);
    expect(failure(() => read(badSize)).message).toMatch(/invalid octal size|invalid checksum/);
  });

  it('accepts a stream that stops at an entry boundary without the end-of-archive block, and says so', () => {
    const result = read(tarEntries(SAMPLE, { end: false }));
    expect(result.summary.endMissing).toBe(true);
    expect(Object.keys(result.files)).toHaveLength(4);
    expect(failure(() => read(new Uint8Array(0))).message).toMatch(/empty/);
  });

  it('enforces entry, size and metadata budgets with LIMIT_EXCEEDED', () => {
    const many = tarEntries(Array.from({ length: 20 }, (_, index) => ({ path: `f${index}`, data: 'x' })));
    expect(failure(() => read(many, { limits: { maxEntries: 10 } })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => read(tarEntries([{ path: 'big', data: 'x'.repeat(2000) }]), { limits: { maxEntryBytes: 1000 } })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => read(many, { limits: { maxKeptBytes: 5 } })).code).toBe('LIMIT_EXCEEDED');
    const meta = new TextEncoder().encode(paxRecord('comment', 'c'.repeat(3000)));
    expect(failure(() => read(tarEntries([{ path: 'p', type: 'x', data: meta }, { path: 'r', data: 'r' }]), { limits: { maxMetaBytes: 1024 } })).code).toBe('LIMIT_EXCEEDED');
    // An unselected entry larger than the per-entry budget is skipped, not refused: nothing of it is kept.
    expect(read(tarEntries([{ path: 'skip', data: 'x'.repeat(5000) }, { path: 'keep', data: 'k' }]), { keep: entry => entry.path === 'keep', limits: { maxEntryBytes: 1000 } }).files).toEqual({ keep: 'k' });
  });

  it('reads many entries in linear time', () => {
    const build = (count: number) => tarEntries(Array.from({ length: count }, (_, index) => ({ path: `job/steps/s${index}/stephdr`, data: 'X_DATUM=0\n' })));
    expectScaling('tar entries', [1000, 4000, 16000], count => { const bytes = build(count); return () => read(bytes, { chunk: 65536 }); });
  });
});
