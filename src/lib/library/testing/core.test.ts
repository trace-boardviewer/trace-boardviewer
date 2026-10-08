import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEncryptedLookalike, buildFiller, buildFirmware, buildJpeg, buildPng, FIRMWARE_SIZES } from './binary';
import { BOARD_NUMBER_SHAPES, makeNumberOfShape, nearMissNumber, pickBoardNumberShape, revisionLabels, revisionText } from './board-numbers';
import { PathBook, foldForMatch, nameEvidence, sanitizeSegment } from './names';
import { createRng } from './rng';
import { sha256Hex } from './sha256';
import { BOMB_LIMITS, buildZip, crc32, listZip, signatureOnly, zeroBombEntry } from './zip';

describe('random numbers', () => {
  it('give the same stream for the same seed and different streams for different seeds', () => {
    const a = createRng('seed'), b = createRng('seed'), c = createRng('other');
    const first = Array.from({ length: 20 }, () => a.u32());
    expect(Array.from({ length: 20 }, () => b.u32())).toEqual(first);
    expect(Array.from({ length: 20 }, () => c.u32())).not.toEqual(first);
    expect(createRng(5).u32()).toBe(createRng('5').u32());
  });

  it('are fixed numbers, the same on every platform (integer arithmetic only)', () => {
    const rng = createRng('fixed');
    expect([rng.u32(), rng.u32(), rng.int(0, 99), rng.digits(6), rng.letters(4)]).toMatchInlineSnapshot(`
      [
        549924522,
        2440584125,
        78,
        "946226",
        "LJYL",
      ]
    `);
  });

  it('derive a stream from the path, not from how much the parent has drawn', () => {
    const parent = createRng('p');
    const before = parent.fork('child').u32();
    for (let i = 0; i < 50; i++) parent.u32();
    expect(parent.fork('child').u32()).toBe(before);
    expect(parent.fork('child/x').u32()).toBe(createRng('p').fork('child').fork('x').u32());
    expect(parent.fork('other').u32()).not.toBe(before);
  });

  it('stay inside their ranges and pick, weigh, shuffle and sample sensibly', () => {
    const rng = createRng('ranges');
    for (let i = 0; i < 500; i++) { const value = rng.int(3, 7); expect(value >= 3 && value <= 7).toBe(true); const unit = rng.next(); expect(unit >= 0 && unit < 1).toBe(true); }
    expect(() => rng.int(5, 1)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 2000; i++) counts[rng.weighted([['a', 9], ['b', 1]] as const)]++;
    expect(counts.a).toBeGreaterThan(counts.b * 5);
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(rng.shuffle(items).slice().sort((x, y) => x - y)).toEqual(items);
    expect(new Set(rng.sample(items, 10)).size).toBe(10);
    expect(rng.sample(items, 100)).toHaveLength(30);
    expect(rng.letters(200)).not.toMatch(/[IO0-9]/);
    expect(rng.bytes(33)).toHaveLength(33);
  });
});

describe('SHA-256', () => {
  it('agrees with Node on empty, short, block-sized and long inputs', () => {
    const rng = createRng('sha');
    for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = rng.bytes(length);
      expect(sha256Hex(data), `${length}`).toBe(createHash('sha256').update(data).digest('hex'));
    }
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('board numbers and revisions', () => {
  const patterns: Record<string, RegExp> = {
    'logic-board-820': /^820-\d{5}$/, 'schematic-051': /^051-\d{4,5}$/, 'la-code': /^LA-[A-Z]\d{3}P?$/, 'nm-code': /^NM-[A-Z]\d{3}$/, 'da0-code': /^DA0[0-9A-Z]{3}MB\d[A-Z]\d$/,
    'dotted-48': /^\d{2}\.\d[A-Z]{2}\d{2}\.\d{3}[A-Z]?$/, '6050a': /^6050A[1-9]\d{6}$/, 'ms-code': /^MS-(\d{4,5}|\d{2}[A-Z]\d)$/, ba41: /^BA41-\d{5}[A-Z]$/, 'gpu-109': /^109-[A-Z]\d{5}-\d{2}$/,
    'cn-code': /^CN-0[A-Z]{2}\d{3}$/, 'model-sm': /^SM-[A-Z]\d{3}[A-Z]{1,2}$/, 'model-a4': /^A[1-9]\d{3}$/, 'generic-mb': /^MB-[A-Z]{2}\d{2}$/,
  };
  it('follow the shapes of the design table with random digits', () => {
    const rng = createRng('shapes');
    for (const shape of BOARD_NUMBER_SHAPES) for (let i = 0; i < 40; i++) expect(makeNumberOfShape(shape.id, rng), shape.id).toMatch(patterns[shape.id]);
    expect(new Set(Array.from({ length: 200 }, () => pickBoardNumberShape(rng))).size).toBeGreaterThan(8);
  });

  it('make near-miss numbers that keep the shape but are another number', () => {
    const rng = createRng('near');
    for (const shape of BOARD_NUMBER_SHAPES) for (let i = 0; i < 20; i++) {
      const original = makeNumberOfShape(shape.id, rng), near = nearMissNumber(original, rng);
      expect(near).not.toBe(original);
      expect(near.length).toBeGreaterThanOrEqual(original.length);
    }
  });

  it('label revisions in four schemes and write them in several ways', () => {
    expect(revisionLabels('letter', 3)).toEqual(['A', 'B', 'C']);
    expect(revisionLabels('dotted', 4)).toEqual(['R1.0', 'R1.1', 'R2.0', 'R2.1']);
    expect(revisionLabels('rev-number', 2)).toEqual(['REV1.0', 'REV2.0']);
    expect(revisionLabels('stage', 4)).toEqual(['EVT', 'DVT', 'PVT', 'MP']);
    const rng = createRng('rev');
    expect(new Set(Array.from({ length: 60 }, () => revisionText('B', 'letter', rng))).size).toBeGreaterThan(3);
  });
});

describe('names and paths', () => {
  it('folds case, accents and punctuation for matching', () => {
    expect(foldForMatch('Árvíztűrő LA-Z123P')).toBe('arvizturolaz123p');
    expect(sanitizeSegment('a<b>:c?.')).toBe('a_b__c_');
    expect(sanitizeSegment('con')).toBe('_con');
    expect(sanitizeSegment('x'.repeat(300))).toHaveLength(200);
  });

  it('never hands out two paths that differ only in case or in Unicode normalisation', () => {
    const book = new PathBook();
    const first = book.file(['Alder', 'Heron'], 'Board.BVR');
    const second = book.file(['ALDER', 'heron'], 'board.bvr');
    const third = book.file(['alder', 'HERON'], 'Board.bvr');
    expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(second[2]).toBe('board (2).bvr');
    expect(third[2]).toBe('Board (3).bvr');
    expect(book.has(['Alder', 'Heron', 'BOARD.bvr'])).toBe(true);
    const nfc = book.file(['d'], 'café.txt'), nfd = book.file(['d'], 'café.txt');
    expect(nfd[1]).not.toBe(nfc[1]);
  });

  it('finds what a path says about a family: number or model in the name or in a folder', () => {
    const family = { vendor: 'Alder', model: 'Heron 14', boardNumber: 'LA-Z123P', deviceType: 'laptop' as const };
    expect(nameEvidence(['Drive', 'la-z123p rev B.pdf'], family)).toEqual(['name-id']);
    expect(nameEvidence(['Drive', 'LA_Z123P', 'file.bvr'], family)).toEqual(['folder-id']);
    expect(nameEvidence(['Alder', 'Heron 14', 'scan 4.pdf'], family)).toEqual(['folder-model']);
    expect(nameEvidence(['x', 'IMG_1234.jpg'], family)).toEqual([]);
    expect(nameEvidence(['x', 'Alder heron14 schematic.pdf'], family)).toEqual(['name-model']);
  });
});

describe('ZIP writer and directory reader', () => {
  it('writes archives that an independent reader unpacks, with stored and deflated entries', () => {
    const rng = createRng('zip');
    const text = new TextEncoder().encode('hello hello hello hello hello hello hello hello hello hello hello hello hello hello hello hello hello');
    const random = rng.bytes(500);
    const zip = buildZip([{ name: 'a.txt', data: text }, { name: 'dir/b.bin', data: random }, { name: 'dir/', }, { name: 'tiny.txt', data: new Uint8Array([1, 2, 3]) }, { name: 'stored.txt', data: text, method: 'store' }]);
    const files = unzipSync(zip);
    expect(Object.keys(files).filter(name => !name.endsWith('/')).sort()).toEqual(['a.txt', 'dir/b.bin', 'stored.txt', 'tiny.txt']);
    expect(Buffer.from(files['dir/b.bin']).equals(Buffer.from(random))).toBe(true);
    const listing = listZip(zip)!;
    expect(listing.map(entry => entry.name)).toEqual(['a.txt', 'dir/b.bin', 'dir/', 'tiny.txt', 'stored.txt']);
    expect(listing[0]).toMatchObject({ size: text.length, method: 8, crc: crc32(text) });
    expect(listing[2].directory).toBe(true);
  });

  it('writes hostile names, the encrypted flag and a missing end exactly as asked', () => {
    const zip = buildZip([{ name: '../../x.txt', data: new Uint8Array([1]) }, { name: 'secret', data: new Uint8Array([9, 9]), encrypted: true }, { name: 'ünï.txt', data: new Uint8Array([2]) }]);
    const listing = listZip(zip)!;
    expect(listing.map(entry => entry.name)).toEqual(['../../x.txt', 'secret', 'ünï.txt']);
    expect(listing[1].encrypted).toBe(true);
    expect(listing[2].flags & 0x0800).not.toBe(0);
    expect(listZip(buildZip([{ name: 'a', data: new Uint8Array(100) }], { truncateTail: true }))).toBeNull();
    expect(listZip(new Uint8Array(10))).toBeNull();
    expect(() => buildZip(Array.from({ length: 70_000 }, (_, i) => ({ name: `f${i}` })))).toThrow();
  });

  it('makes bombs that stay inside their bounds', () => {
    const entry = zeroBombEntry('big.img', 16);
    const zip = buildZip([entry]);
    const [listed] = listZip(zip)!;
    expect(listed.size).toBe(16 * 1024 * 1024);
    expect(zip.length).toBeLessThan(BOMB_LIMITS.maxFileBytes);
    expect(listed.size / listed.compressedSize).toBeGreaterThan(BOMB_LIMITS.minRatio);
    expect(() => zeroBombEntry('huge', 65)).toThrow(RangeError);
    expect(zeroBombEntry('big.img', 16).raw!.bytes).toBe(entry.raw!.bytes);
  });

  it('writes signature-only RAR and 7z files', () => {
    const rng = createRng('sig');
    expect(Array.from(signatureOnly('rar4', rng).subarray(0, 7))).toEqual([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    expect(Array.from(signatureOnly('rar5', rng).subarray(0, 8))).toEqual([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
    expect(Array.from(signatureOnly('7z', rng).subarray(0, 6))).toEqual([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  });
});

describe('binary files', () => {
  it('writes photos that carry their padding inside a valid container', () => {
    const rng = createRng('photos');
    const png = buildPng(rng, { width: 40, height: 30, padBytes: 5000 });
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(5000);
    const jpeg = buildJpeg(rng, { width: 40, height: 30, padBytes: 70_000 });
    expect(Array.from(jpeg.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(jpeg.subarray(jpeg.length - 2))).toEqual([0xff, 0xd9]);
    expect(jpeg.length).toBeGreaterThan(70_000);
    expect(buildPng(createRng('a'), { width: 8, height: 8 }).length).toBe(buildPng(createRng('a'), { width: 8, height: 8 }).length);
  });

  it('writes firmware in power-of-two sizes with blank flash at the ends, and encrypted look-alikes without a signature', () => {
    const rng = createRng('fw');
    expect(FIRMWARE_SIZES.every(size => Math.log2(size) === Math.round(Math.log2(size)))).toBe(true);
    const image = buildFirmware(rng, 65_536);
    expect(image).toHaveLength(65_536);
    expect(image[0]).toBe(0xff);
    expect(image[65_535]).toBe(0xff);
    const xzz = buildEncryptedLookalike(rng, 'xzz', 4000);
    expect(new TextDecoder('latin1').decode(xzz)).toContain('v6v6555v6v6');
    expect(new TextDecoder('latin1').decode(buildEncryptedLookalike(rng, 'fz', 4000))).not.toContain('v6v6555v6v6');
  });

  it('writes filler that is quick, exact in size, repeatable and not repetitive from block to block', () => {
    const a = buildFiller(createRng('f'), 1_000_003), b = buildFiller(createRng('f'), 1_000_003);
    expect(a).toHaveLength(1_000_003);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const big = buildFiller(createRng('f'), 600_000);
    expect(Buffer.from(big.subarray(0, 4096)).equals(Buffer.from(big.subarray(262_144, 262_144 + 4096)))).toBe(false);
    expect(buildFiller(createRng('f'), 10)).toHaveLength(10);
  });
});
