import { Gunzip, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { expectBoundedWork, expectCostAtMost, expectScaling } from '../../test-support/timing';
import { BoardFormatError } from './common';
import { parseOdbpp } from './odbpp';
import { bytesOf, compressZ, rawZip, rooted, tarEntries, tarOf, tgzOf, writeJob, zipOf } from './odbpp-fixture';
import { HEAD_INFLATE, pathEvidence, sniffOdbppHead, zipHeadNames } from './odbpp-sniff';

const job = writeJob();
const folder = rooted(job, 'odb/');
const SNIFF = 64 * 1024;
const text = () => bytesOf('lorem ipsum dolor sit amet\n'.repeat(500));
const head = (data: Uint8Array) => data.subarray(0, SNIFF);
const sniff = (data: Uint8Array, size = data.length) => sniffOdbppHead(head(data), size);
function prng(seed: number) { let state = seed >>> 0 || 1; return () => (state = (state ^ state << 13) >>> 0, state = (state ^ state >>> 17) >>> 0, state = (state ^ state << 5) >>> 0, state / 2 ** 32); }
const noise = (length: number, seed = length) => { const random = prng(seed), out = new Uint8Array(length); for (let index = 0; index < length; index++) out[index] = Math.floor(random() * 256); return out; };
const asEntries = (files: Record<string, string | Uint8Array>) => Object.entries(files).map(([path, data]) => ({ path, data }));

describe('pathEvidence', () => {
  it('rates entry names by what they show of an ODB++ product model', () => {
    expect(pathEvidence(['odb/matrix/matrix', 'odb/steps/pcb/eda/data'])).toMatchObject({ confidence: 0.98, matrix: true, stepData: true });
    expect(pathEvidence(['matrix/matrix'])).toMatchObject({ confidence: 0.9, matrix: true, stepData: false });
    expect(pathEvidence(['job/steps/pcb/layers/comp_+_top/components'])).toMatchObject({ confidence: 0.8, matrix: false, stepData: true });
    expect(pathEvidence(['job/steps/pcb/profile'])).toMatchObject({ confidence: 0.6, matrix: false, stepData: false });
    expect(pathEvidence(['../job/matrix/matrix'])).toMatchObject({ confidence: 0.6, unsafe: true });
    expect(pathEvidence(['docs/readme.txt', 'matrixes/matrix2', 'steps.txt']).confidence).toBe(0);
    expect(pathEvidence([]).confidence).toBe(0);
  });
});

describe('sniffOdbppHead', () => {
  it.each([
    ['tgz', tgzOf(folder), 'tgz'],
    ['tgz without a wrapper folder', tgzOf(job), 'tgz'],
    ['tar', tarOf(folder), 'tar'],
    ['tar.Z', compressZ(tarOf(folder)), 'tar.Z'],
    ['ZIP', zipOf(folder), 'zip'],
    ['ZIP with the model at its root', zipOf(job), 'zip'],
  ] as const)('%s with the product model: LIKELY, above the 60 of the ZIP container', (_label, data, container) => {
    const found = sniff(data);
    expect(found?.container).toBe(container);
    expect(found!.confidence).toBeGreaterThan(60);
    expect(found!.confidence).toBeLessThan(90);
    expect(found!.reason.length).toBeGreaterThan(0);
  });

  it('ranks matrix and step data above directory names alone', () => {
    const matrixAndData = sniff(tgzOf(folder))!.confidence;
    const directoriesOnly = sniff(tgzOf({ 'odb/steps/pcb/profile': 'x' }))!.confidence;
    const matrixOnly = sniff(tgzOf({ 'odb/matrix/matrix': 'STEP {\n}\n' }))!.confidence;
    expect(matrixAndData).toBeGreaterThan(matrixOnly);
    expect(matrixOnly).toBeGreaterThan(directoriesOnly);
    expect(directoriesOnly).toBeGreaterThan(60);
  });

  it('reads a ZIP whose entries use data descriptors or follow a large unrelated member', () => {
    const descriptors = rawZip([{ name: 'odb/matrix/matrix', data: 'STEP {\n}\n', flags: 8 }, { name: 'odb/steps/pcb/eda/data', data: '#\n', flags: 8 }]);
    expect(sniff(descriptors)?.confidence).toBeGreaterThan(60);
    const late = zipOf({ 'readme.txt': 'a'.repeat(20_000), ...folder });
    expect(sniff(late)?.confidence).toBeGreaterThan(60);
  });

  it('stays possible, never likely, when the names lie beyond the window', () => {
    // 80 KiB of an incompressible first member push the product model out of the 64 KiB window.
    const photo = noise(80 * 1024);
    const zip = zipOf({ 'photos/board.jpg': photo, ...folder });
    expect(sniff(zip)).toMatchObject({ confidence: 5, container: 'zip' });
    const entries = [{ path: 'photos/board.jpg', data: photo }, ...asEntries(folder)];
    const tgz = gzipSync(tarEntries(entries));
    expect(sniff(tgz)).toMatchObject({ confidence: 8, container: 'tgz' });
    const plain = tarEntries(entries);
    expect(sniff(plain)).toMatchObject({ confidence: 8, container: 'tar' });
  });

  it('says nothing about bytes that cannot be an ODB++ archive', () => {
    const tar = tarEntries([{ path: 'docs/readme.txt', data: 'hi' }]);
    for (const [label, data] of [
      ['empty', new Uint8Array(0)], ['text', text()], ['zeros', new Uint8Array(SNIFF)], ['gzip magic only', Uint8Array.from([0x1f, 0x8b])],
      ['a gzip stream of text', gzipSync(text())], ['a compress(1) stream of text', compressZ(text())], ['a tar without ODB++ names that ends inside the window', tar],
    ] as const) {
      expect(sniff(data), label).toBeNull();
    }
  });

  it('keeps a tar stream or a ZIP of other files as a weak candidate: the product model may follow the entries seen', () => {
    expect(sniff(tgzOf({ 'docs/readme.txt': 'hello' }))).toMatchObject({ confidence: 8, container: 'tgz' });
    expect(sniff(compressZ(tarOf({ 'docs/readme.txt': 'hello' })))).toMatchObject({ confidence: 8, container: 'tar.Z' });
    expect(sniff(zipOf({ 'docs/readme.txt': 'hello' }))).toMatchObject({ confidence: 5, container: 'zip' });
  });

  it('reports a product model that sits behind unsafe paths instead of calling the archive unknown', () => {
    const unsafe = tgzOf({ '../odb/matrix/matrix': 'STEP {\n}\n' });
    expect(sniff(unsafe)?.confidence).toBeGreaterThan(60);
    expect(() => parseOdbpp({ name: 'x.tgz', data: unsafe })).toThrow(BoardFormatError);
  });

  it('agrees with the reader about damaged archives: whatever it claims, the sniff has seen', () => {
    const random = prng(0xface);
    for (const [label, data] of [['tgz', tgzOf(folder)], ['zip', zipOf(folder)], ['tar', tarOf(folder)], ['tar.Z', compressZ(tarOf(folder))]] as const) {
      const variants: Uint8Array[] = [];
      for (const cut of [4, 8, 16, 18, 30, 64, 200, 512, 700, 1024, 1500, 2500, 4000, data.length >> 1, data.length - 40, data.length - 1]) if (cut > 0 && cut < data.length) variants.push(data.subarray(0, cut));
      for (let round = 0; round < 40; round++) { const copy = data.slice(); copy[Math.floor(random() * copy.length)] ^= 1 << Math.floor(random() * 8); variants.push(copy); }
      for (const variant of variants) {
        let claimed: boolean;
        try { claimed = parseOdbpp({ name: 'x.bin', data: variant }) !== null; } catch (error) { if (!(error instanceof BoardFormatError)) throw error; claimed = true; }
        if (claimed) expect(sniff(variant, data.length), `${label}: ${variant.length} bytes of ${data.length}`).not.toBeNull();
      }
    }
  });

  it('is total on hostile heads', () => {
    const random = prng(0xbadf00d);
    const starts: number[][] = [[0x50, 0x4b, 3, 4], [0x1f, 0x8b, 8], [0x1f, 0x9d, 0x90], []];
    for (const start of starts) for (let round = 0; round < 60; round++) {
      const data = Uint8Array.from({ length: 200 + Math.floor(random() * 4000) }, () => Math.floor(random() * 256));
      data.set(start);
      const found = sniffOdbppHead(data, data.length + (round % 3) * 1000);
      if (found) { expect(Number.isInteger(found.confidence) && found.confidence > 0 && found.confidence < 90).toBe(true); expect(found.reason.length).toBeGreaterThan(0); }
    }
    // ZIP headers with impossible fields: zero and oversized names, names past the end, sizes of 4 GiB.
    const header = (nameLength: number, size = 0xffffffff, flags = 0) => { const h = new Uint8Array(40); h.set([0x50, 0x4b, 3, 4], 0); h[6] = flags; h.set([size & 255, size >>> 8 & 255, size >>> 16 & 255, size >>> 24 & 255], 18); h[26] = nameLength & 255; h[27] = nameLength >>> 8; return h; };
    for (const bytes of [header(0), header(0xffff), header(600), header(30), header(5, 0), header(5, 12, 8)]) expect(() => zipHeadNames(bytes)).not.toThrow();
  });
});

describe('sniffOdbppHead: bounded and linear work', () => {
  it('inflates a bounded prefix of a decompression bomb, not the bomb', () => {
    const zeros = new Uint8Array(96 * 1024 * 1024);
    const bomb = gzipSync(zeros), bombHead = head(bomb);
    const tarBomb = gzipSync(tarEntries([{ path: 'payload.bin', data: zeros.subarray(0, 64 * 1024 * 1024) }]));
    expect(HEAD_INFLATE).toBeLessThanOrEqual(1024 * 1024);
    expect(sniffOdbppHead(bombHead, bomb.length)).toBeNull(); // zeros are no tar header
    expect(sniffOdbppHead(head(tarBomb), tarBomb.length)).toMatchObject({ confidence: 8 });
    // The window of a bomb expands to tens of MiB; the sniff stops after the first steps of it.
    const inflateAll = (data: Uint8Array) => () => { const stream = new Gunzip(() => {}); try { stream.push(data, true); } catch { /* a cut stream ends in an error after its output */ } };
    expectCostAtMost('bounded inflate of a bomb head', () => sniffOdbppHead(bombHead, bomb.length), inflateAll(bombHead), 0.5);
    expectCostAtMost('bounded inflate of a tar bomb head', () => sniffOdbppHead(head(tarBomb), tarBomb.length), inflateAll(head(tarBomb)), 0.5);
  });

  it('reads the window of a large archive in time that does not grow with the file', () => {
    expectBoundedWork('window of a growing ZIP', [1, 4, 16], mib => { const zip = zipOf({ ...folder, 'big.bin': noise(mib * 256 * 1024) }); return () => sniffOdbppHead(head(zip), zip.length); });
    expectBoundedWork('window of a growing tgz', [1, 4, 16], mib => { const tgz = tgzOf({ ...folder, 'big.bin': noise(mib * 256 * 1024) }); return () => sniffOdbppHead(head(tgz), tgz.length); });
  });

  it('scans the local headers of a window of any shape in linear time', () => {
    // Floods of signatures with absurd lengths and of empty names: every byte of the window is looked at once.
    const signatures = (size: number) => { const data = new Uint8Array(size); for (let at = 0; at + 4 <= size; at += 4) data.set([0x50, 0x4b, 3, 4], at); return data; };
    expectScaling('flood of signatures', [4096, 16_384, 65_536], size => { const data = signatures(size); return () => zipHeadNames(data); });
    const noName = (size: number) => { const data = new Uint8Array(size); for (let at = 0; at + 30 <= size; at += 30) data.set([0x50, 0x4b, 3, 4], at); return data; };
    expectScaling('flood of empty names', [4096, 16_384, 65_536], size => { const data = noName(size); return () => zipHeadNames(data); });
    const entries = (count: number) => zipOf(Object.fromEntries(Array.from({ length: count }, (_, index) => [`d${index}/f`, ''])));
    expectScaling('many local headers', [64, 256, 1024], count => { const zip = entries(count); return () => sniffOdbppHead(head(zip), zip.length); });
  });
});
