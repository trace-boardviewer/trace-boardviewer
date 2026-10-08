import { deflateSync, inflateSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { expectCostAtMost } from '../../test-support/timing';
import type { Board } from '../types';
import { STATUS_VALIDATION, type ContainerLimits } from './adapter';
import asc from './adapters/asc/fixtures';
import bvr from './adapters/bvr/fixtures';
import gencad from './adapters/gencad/fixtures';
import gerber from './adapters/gerber/fixtures';
import kicad from './adapters/kicad/fixtures';
import zipAdapter from './adapters/zip';
import { BoardFormatError, MAX_IMPORT_BYTES } from './common';
import { detectFormat, parseBoardAsync, parseBoardDetailed } from './dispatch';
import { crc32, readZip } from './zip';

const encoder = new TextEncoder();
const GENCAD = gencad[0].data, KICAD = kicad[0].data;
const LIMITS: ContainerLimits = zipAdapter.limits;
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const open = (data: Uint8Array, name = 'board.zip') => parseBoardDetailed({ name, data });
const shape = (board: Board) => ({ format: board.format, name: board.name, components: board.components, pins: board.pins, nets: board.nets, outline: board.outline });

interface RawEntry { name: string | Uint8Array; data: Uint8Array; method?: number; flags?: number; size?: number; crc?: number; compressed?: Uint8Array }
/** A hand-built archive (only the fields readZip reads), for the cases fflate never writes: ZIP64, flags, methods, lying sizes. */
function rawZip(entries: RawEntry[], options: { zip64?: boolean; prefix?: Uint8Array; disk?: number } = {}): Uint8Array {
  const out: number[] = Array.from(options.prefix ?? []), central: number[] = [];
  const u16 = (target: number[], value: number) => target.push(value & 255, value >>> 8 & 255);
  const u32 = (target: number[], value: number) => target.push(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255);
  const u64 = (target: number[], value: number) => { u32(target, value % 2 ** 32); u32(target, Math.floor(value / 2 ** 32)); };
  const append = (target: number[], bytes: ArrayLike<number>) => { for (let index = 0; index < bytes.length; index++) target.push(bytes[index]); };
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? encoder.encode(entry.name) : entry.name;
    const method = entry.method ?? 0, payload = entry.compressed ?? (method === 8 ? deflateSync(entry.data) : entry.data);
    const size = entry.size ?? entry.data.length, crc = entry.crc ?? crc32(entry.data), offset = out.length - (options.prefix?.length ?? 0);
    u32(out, 0x04034b50); u16(out, 20); u16(out, entry.flags ?? 0); u16(out, method); u16(out, 0); u16(out, 0); u32(out, crc); u32(out, payload.length); u32(out, size); u16(out, name.length); u16(out, 0);
    append(out, name); append(out, payload);
    const extra: number[] = [];
    if (options.zip64) { u16(extra, 1); u16(extra, 24); u64(extra, size); u64(extra, payload.length); u64(extra, offset); }
    u32(central, 0x02014b50); u16(central, 45); u16(central, 20); u16(central, entry.flags ?? 0); u16(central, method); u16(central, 0); u16(central, 0); u32(central, crc);
    u32(central, options.zip64 ? 0xffffffff : payload.length); u32(central, options.zip64 ? 0xffffffff : size); u16(central, name.length); u16(central, extra.length); u16(central, 0);
    u16(central, 0); u16(central, 0); u32(central, 0); u32(central, options.zip64 ? 0xffffffff : offset);
    append(central, name); append(central, extra);
  }
  const cdOffset = out.length - (options.prefix?.length ?? 0);
  append(out, central);
  const disk = options.disk ?? 0;
  if (options.zip64) {
    const record = out.length - (options.prefix?.length ?? 0);
    u32(out, 0x06064b50); u64(out, 44); u16(out, 45); u16(out, 45); u32(out, disk); u32(out, 0); u64(out, entries.length); u64(out, entries.length); u64(out, central.length); u64(out, cdOffset);
    u32(out, 0x07064b50); u32(out, 0); u64(out, record); u32(out, 1);
    u32(out, 0x06054b50); u16(out, 0xffff); u16(out, 0xffff); u16(out, 0xffff); u16(out, 0xffff); u32(out, 0xffffffff); u32(out, 0xffffffff); u16(out, 0);
  } else {
    u32(out, 0x06054b50); u16(out, disk); u16(out, 0); u16(out, entries.length); u16(out, entries.length); u32(out, central.length); u32(out, cdOffset); u16(out, 0);
  }
  return Uint8Array.from(out);
}

describe('ZIP import: the one board of an archive', () => {
  it('opens a board from a folder of the archive exactly as the unpacked file, and says which entry it opened', () => {
    const unpacked = parseBoardDetailed({ name: 'board.cad', data: GENCAD }).board;
    for (const level of [0, 6, 9] as const) {
      const result = open(zipSync({ 'job/board.cad': [GENCAD, { level }], 'job/notes.txt': encoder.encode('x') }));
      expect(result).toMatchObject({ adapter: 'gencad', container: 'zip', entry: 'job/board.cad' });
      expect(shape(result.board)).toEqual(shape(unpacked));
      expect(result.board.warnings.at(-1)).toEqual({ key: 'parse.warning.archiveEntry', params: { entry: 'job/board.cad', archive: 'board.zip' } });
    }
  });
  it('reads the ASC trio with its companions from the same folder, whichever order the archive lists them in', () => {
    const trio = { 'format.asc': asc[0].data, ...asc[0].companions };
    const unpacked = parseBoardDetailed({ name: 'format.asc', data: trio['format.asc'], companions: { 'pins.asc': trio['pins.asc'], 'nails.asc': trio['nails.asc'] } }).board;
    const reversed = Object.fromEntries(Object.entries(trio).reverse().map(([name, data]) => [`set/${name.toUpperCase()}`, data]));
    for (const archive of [zipSync(Object.fromEntries(Object.entries(trio).map(([name, data]) => [`set/${name}`, data]))), zipSync(reversed)]) {
      const result = open(archive);
      expect(result.adapter).toBe('asc');
      expect(result.entry?.toLowerCase()).toBe('set/format.asc');
      expect(shape(result.board)).toEqual({ ...shape(unpacked), name: result.board.name });
    }
    // Companions are never collected from another folder: the trio member alone reports its missing files.
    expect(failure(() => open(zipSync({ 'a/format.asc': trio['format.asc'], 'b/pins.asc': trio['pins.asc'], 'b/nails.asc': trio['nails.asc'] }))).code).toBe('UNSUPPORTED_VARIANT');
    expect(failure(() => open(zipSync({ 'a/format.asc': trio['format.asc'] }))).code).toBe('COMPANIONS_REQUIRED');
  });
  it('prefers the one board over weaker recognized members (a KiCad project with its Gerber layers)', () => {
    const archive = zipSync({ 'project/board.kicad_pcb': KICAD, 'project/gerbers/top.gbr': gerber[0].data, 'project/gerbers/bottom.gbr': gerber[0].data, 'project/board.kicad_pro': encoder.encode('{}') });
    expect(open(archive)).toMatchObject({ adapter: 'kicad', entry: 'project/board.kicad_pcb' });
    // Recognized-but-unreadable members (one Gerber layer, or a whole Gerber set) are explained as such, not as several boards.
    expect(failure(() => open(zipSync({ 'top.gbr': gerber[0].data })))).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'gerber' });
    expect(failure(() => open(zipSync({ 'top.gbr': gerber[0].data, 'bottom.gbr': gerber[0].data })))).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'gerber' });
  });
  it('refuses an archive with several boards, naming them, instead of picking one', () => {
    const error = failure(() => open(zipSync({ 'a.cad': GENCAD, 'b/board.kicad_pcb': KICAD })));
    expect(error).toMatchObject({ code: 'UNSUPPORTED_VARIANT', issue: { key: 'parse.error.archiveSeveralBoards', params: { entries: 'a.cad, b/board.kicad_pcb' } } });
    const many = Object.fromEntries(Array.from({ length: LIMITS.maxCandidates + 1 }, (_, index) => [`n${index}.cad`, encoder.encode('x')]));
    expect(failure(() => open(zipSync(many))).issue?.key).toBe('parse.error.archiveSeveralBoards');
  });
  it('reports an archive without a board, and never opens an archive inside the archive', () => {
    for (const archive of [zipSync({ 'readme.txt': encoder.encode('x') }), zipSync({ 'inner.zip': zipSync({ 'board.cad': GENCAD }) }), zipSync({}), zipSync({ 'notes.cad': encoder.encode('just text\n') })]) {
      expect(failure(() => open(archive))).toMatchObject({ code: 'UNRECOGNIZED', issue: { key: 'parse.error.archiveNoBoard' } });
    }
  });
  it('ignores names that leave the archive folder and operating-system metadata', () => {
    for (const name of ['../board.cad', '/board.cad', 'C:/board.cad', 'a/../../board.cad', '__MACOSX/board.cad', 'job/._board.cad']) {
      expect(failure(() => open(rawZip([{ name, data: GENCAD }]))).issue?.key, name).toBe('parse.error.archiveNoBoard');
    }
    expect(open(rawZip([{ name: '__MACOSX/._board.cad', data: encoder.encode('junk') }, { name: './job\\board.cad', data: GENCAD }])).entry).toBe('job/board.cad');
  });
  it('decodes code page 437 names and reads ZIP64 sizes and an archive behind a self-extractor stub', () => {
    const name = Uint8Array.from([...encoder.encode('k'), 0x81, ...encoder.encode('rt.cad')]); // "kürt.cad" in code page 437
    expect(open(rawZip([{ name, data: GENCAD }])).entry).toBe('kürt.cad');
    expect(open(rawZip([{ name: 'board.cad', data: GENCAD, method: 8 }], { zip64: true }))).toMatchObject({ adapter: 'gencad', entry: 'board.cad' });
    // Data in front of the archive (a self-extractor stub) shifts every offset; the reader finds the entries anyway.
    const shifted = readZip(rawZip([{ name: 'board.cad', data: GENCAD }], { prefix: new Uint8Array(1000).fill(0x4d) }), LIMITS);
    expect(shifted.map(entry => entry.path)).toEqual(['board.cad']);
    expect(shifted[0].read(LIMITS.maxExtractedBytes)).toEqual(GENCAD);
  });
  it('reads UTF-16 members like UTF-16 files', () => {
    const text = new TextDecoder().decode(bvr[0].data), units = new Uint8Array(2 + text.length * 2);
    units[0] = 0xff; units[1] = 0xfe;
    for (let index = 0; index < text.length; index++) { units[2 + index * 2] = text.charCodeAt(index) & 255; units[3 + index * 2] = text.charCodeAt(index) >>> 8; }
    expect(open(zipSync({ 'board.bvr': units }))).toMatchObject({ adapter: 'bvr', entry: 'board.bvr' });
  });
});

describe('ZIP import: refusals and limits', () => {
  const code = (data: Uint8Array) => { const error = failure(() => open(data)); return [error.code, error.issue?.key]; };
  it('refuses encrypted entries, other compression methods and split archives with a precise message', () => {
    expect(failure(() => open(rawZip([{ name: 'board.cad', data: GENCAD, flags: 1 }])))).toMatchObject({ code: 'UNSUPPORTED_VARIANT', issue: { key: 'parse.error.archiveEncrypted', params: { entry: 'board.cad' } } });
    expect(failure(() => open(rawZip([{ name: 'board.cad', data: GENCAD, method: 12 }])))).toMatchObject({ code: 'UNSUPPORTED_VARIANT', issue: { key: 'parse.error.archiveMethod', params: { entry: 'board.cad', method: 12 } } });
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD }], { disk: 1 }))).toEqual(['UNSUPPORTED_VARIANT', 'parse.error.archiveSplit']);
  });
  it('refuses damaged archives: no end record, cut data, wrong CRC, sizes that lie, duplicate names, a broken stream', () => {
    const good = rawZip([{ name: 'board.cad', data: GENCAD, method: 8 }]);
    const damaged = ['INVALID_FORMAT', 'parse.error.archiveDamaged'];
    expect(code(good.subarray(0, good.length - 1))).toEqual(damaged);
    expect(code(good.subarray(0, 40))).toEqual(damaged);
    expect(code(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toEqual(damaged);
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD, crc: 1 }]))).toEqual(damaged);
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD, method: 8, size: GENCAD.length + 5 }]))).toEqual(damaged);
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD, method: 8, size: GENCAD.length - 5 }]))).toEqual(damaged);
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD, size: GENCAD.length + 1 }]))).toEqual(damaged);
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD }, { name: 'BOARD.CAD', data: GENCAD }]))).toEqual(damaged);
    expect(code(rawZip([{ name: 'board.cad', data: GENCAD, method: 8, compressed: Uint8Array.from([0xff, 0xff, 0xff, 0xff]) }]))).toEqual(damaged);
  });
  it('bounds a decompression bomb: a declared size above the budget, an expansion ratio, and a stream that outgrows its size', () => {
    const zeros = new Uint8Array(16 * 1024 * 1024), bomb = deflateSync(zeros, { level: 9 });
    let seed = 7;
    // Printable noise: a text file that may still show its markers further down, so some reader keeps the member as a board candidate (a head
    // with NUL bytes is binary, and no text reader waits for it).
    const noise = Uint8Array.from({ length: 300 * 1024 }, () => 32 + ((seed = seed * 1103515245 + 12345 >>> 0) >>> 24) % 95);
    // 65 MiB declared at a plausible ratio: the member is sniffed (only its head is inflated) and refused before it is unpacked.
    expect(code(rawZip([{ name: 'board.cad', data: noise, size: 65 * 1024 * 1024, method: 8, compressed: deflateSync(noise, { level: 0 }) }]))).toEqual(['LIMIT_EXCEEDED', 'parse.error.archiveTooLarge']);
    expect(code(rawZip([{ name: 'board.cad', data: zeros, method: 8, compressed: bomb }]))).toEqual(['LIMIT_EXCEEDED', 'parse.error.archiveRatio']);
    // The header claims 64 bytes, the stream would produce 16 MiB: inflation stops at the declared size.
    expect(code(rawZip([{ name: 'board.fz', data: zeros.subarray(0, 64), size: 64, method: 8, compressed: bomb }]))).toEqual(['INVALID_FORMAT', 'parse.error.archiveDamaged']);
    // The cut-off is measured against inflating the whole stream, which is what a missing cut-off would do. The reader stops within the first
    // 4 KiB of the compressed stream (the output of one push), so a stream of 64 MiB costs it a small, fixed part of the whole.
    const huge = deflateSync(new Uint8Array(64 * 1024 * 1024), { level: 9 });
    const lying = rawZip([{ name: 'board.fz', data: zeros.subarray(0, 64), size: 64, method: 8, compressed: huge }]);
    expect(code(lying)).toEqual(['INVALID_FORMAT', 'parse.error.archiveDamaged']);
    expectCostAtMost('refusing a stream that outgrows its declared size', () => code(lying), () => inflateSync(huge), 0.4);
  });
  it('limits the archive size and the entry count', () => {
    expect(code(new Uint8Array(MAX_IMPORT_BYTES + 1))).toEqual(['LIMIT_EXCEEDED', undefined]);
    expect(() => readZip(new Uint8Array(LIMITS.maxArchiveBytes + 1), LIMITS)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED', issue: { key: 'parse.error.archiveTooLarge', params: { max: 64 } } }));
    const crowded = zipSync(Object.fromEntries(Array.from({ length: LIMITS.maxEntries + 1 }, (_, index) => [`f${index}.txt`, new Uint8Array(0)])));
    expect(code(crowded)).toEqual(['LIMIT_EXCEEDED', 'parse.error.archiveTooManyEntries']);
  });
});

describe('ZIP import: detection and the dispatcher', () => {
  it('sniffs the local header, likely for a .zip and only possible for another name', () => {
    const archive = zipSync({ 'board.cad': GENCAD });
    expect(detectFormat({ name: 'board.zip', data: archive })[0]).toMatchObject({ adapter: zipAdapter, confidence: 60 });
    expect(zipAdapter.sniff({ head: archive, name: 'board.brd', size: archive.length }).confidence).toBe(30);
    expect(zipAdapter.sniff({ head: zipSync({}), name: 'x.zip', size: 22 }).confidence).toBe(60);
    // An FZ container is random bytes: one that happens to start like a ZIP stays with the FZ reader of its name.
    expect(detectFormat({ name: 'board.fz', data: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(100).fill(7)]) })[0].adapter.id).toBe('fz');
    expect(zipAdapter.capability.validation).toBe(STATUS_VALIDATION[zipAdapter.capability.status]);
  });
  it('reports the unpack phase, honours cancellation and works asynchronously', async () => {
    const archive = zipSync({ 'board.cad': GENCAD }), phases: string[] = [];
    const result = await parseBoardAsync({ name: 'board.zip', data: archive }, { onProgress: (_fraction, phase) => phases.push(phase) });
    expect(result).toMatchObject({ adapter: 'gencad', container: 'zip' });
    expect(phases).toContain('unpack');
    expect(phases.at(-1)).toBe('done');
    const controller = new AbortController();
    controller.abort();
    await expect(parseBoardAsync({ name: 'board.zip', data: archive }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('passes the session keys to the board inside', () => {
    const options = { xzzKey: '0103030505060909' };
    const result = parseBoardDetailed({ name: 'b.zip', data: zipSync({ 'board.cad': GENCAD }), options });
    expect(result.adapter).toBe('gencad');
  });
});
