import { describe, expect, it } from 'vitest';
import type { GrayImage, OcrWord, QuarterTurn } from './contract';
import { encodePgm, joinUnderscoreSplits, mergePasses, parseTsvWords, planRaster, rgbaToGray, rotateGray, unrotateBox } from './raster';

const image = (width: number, height: number, fill: (x: number, y: number) => number): GrayImage => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { width, height, data };
};
const at = (img: GrayImage, x: number, y: number) => img.data[y * img.width + x];
const word = (text: string, x: number, y: number, width: number, height: number, confidence: number, rotation: QuarterTurn = 0): OcrWord => ({ text, x, y, width, height, confidence, rotation });

describe('greyscale conversion', () => {
  it('weights the channels like Rec. 601 and composites transparency over white', () => {
    const rgba = Uint8ClampedArray.of(255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128);
    const gray = rgbaToGray(rgba, 5, 1);
    expect([...gray.data]).toEqual([255, 0, 76, 255, 127]);
    expect(() => rgbaToGray(rgba, 6, 1)).toThrow(RangeError);
  });
});

describe('quarter-turn rotation and the inverse box mapping', () => {
  const source = image(5, 3, (x, y) => y * 10 + x);
  it('turns clockwise: the left column becomes the top row (read right to left)', () => {
    const turned = rotateGray(source, 1);
    expect([turned.width, turned.height]).toEqual([3, 5]);
    expect([at(turned, 0, 0), at(turned, 1, 0), at(turned, 2, 0)]).toEqual([20, 10, 0]);
    expect(rotateGray(source, 0)).toBe(source);
    expect(rotateGray(rotateGray(rotateGray(rotateGray(source, 1), 1), 1), 1).data).toEqual(source.data);
    expect(rotateGray(rotateGray(source, 1), 3).data).toEqual(source.data);
    expect(rotateGray(rotateGray(source, 2), 2).data).toEqual(source.data);
  });

  it.each([1, 2, 3] as const)('a box found in the image turned %i quarter turns maps back onto the same pixels', (turns) => {
    const big = image(40, 24, (x, y) => (x * 7 + y * 13) % 251);
    const turned = rotateGray(big, turns);
    const box = { x: 3, y: 5, width: 7, height: 4 };
    const back = unrotateBox(box, turns, big.width, big.height);
    // the pixels inside the box of the turned image are exactly the pixels inside the mapped box of the original
    const values: number[] = [];
    for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) values.push(at(turned, x, y));
    const originals: number[] = [];
    for (let y = back.y; y < back.y + back.height; y++) for (let x = back.x; x < back.x + back.width; x++) originals.push(at(big, x, y));
    expect(values.sort((a, b) => a - b)).toEqual(originals.sort((a, b) => a - b));
    expect(back.width * back.height).toBe(box.width * box.height);
  });
});

describe('engine input and output formats', () => {
  it('writes a binary PGM with the exact header and pixels', () => {
    const pgm = encodePgm(image(2, 2, (x, y) => x + y * 2));
    const header = new TextDecoder().decode(pgm.subarray(0, 11));
    expect(header).toBe('P5\n2 2\n255\n');
    expect([...pgm.subarray(11)]).toEqual([0, 1, 2, 3]);
  });

  it('reads word rows of the TSV output and drops empty, malformed and low-confidence words', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t3508\t2480\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t200\t60\t20\t91.5\tR101',
      '5\t1\t1\t1\t1\t2\t180\t200\t70\t20\t12\tnoise',
      '5\t1\t1\t1\t1\t3\t300\t200\t40\t20\t88\t   ',
      '5\t1\t1\t1\t1\t4\t300\t200\t0\t20\t88\tZERO',
      '5\t1\t1\t1\t1\t5\tx\t200\t5\t20\t88\tBAD',
      '5\t1\t2\t1\t1\t1\t400\t500\t80\t22\t77\tGND',
    ].join('\n');
    expect(parseTsvWords(tsv)).toEqual([
      { text: 'R101', x: 100, y: 200, width: 60, height: 20, confidence: 91.5 },
      { text: 'GND', x: 400, y: 500, width: 80, height: 22, confidence: 77 },
    ]);
    expect(parseTsvWords(tsv, { minConfidence: 0 }).map(w => w.text)).toEqual(['R101', 'noise', 'GND']);
    expect(parseTsvWords(tsv, { maxWords: 1 }).map(w => w.text)).toEqual(['R101']);
    expect(parseTsvWords(`5\t1\t1\t1\t1\t1\t0\t0\t9\t9\t99\t${'X'.repeat(300)}`)[0].text).toHaveLength(128);
  });
});

describe('underscore splits', () => {
  const plain = (text: string, x: number, y: number, width: number, height = 20, confidence = 90) => ({ text, x, y, width, height, confidence });
  it('joins a net name the segmentation split at its underscore, and nothing else', () => {
    const words = [plain('SW', 100, 100, 40), plain('_EN', 145, 101, 50, 20, 70), plain('GND', 300, 100, 60), plain('USB', 100, 200, 50), plain('_DM', 400, 200, 50), plain('X_', 100, 300, 30), plain('Y', 133, 300, 15)];
    const joined = joinUnderscoreSplits(words);
    expect(joined.map(word => word.text)).toEqual(['SW_EN', 'GND', 'USB', '_DM', 'X_Y']);
    expect(joined[0]).toMatchObject({ x: 100, y: 100, width: 95, height: 21, confidence: 70 });
  });
  it('never joins across lines', () => {
    expect(joinUnderscoreSplits([plain('A', 100, 100, 20), plain('_B', 122, 140, 20)]).map(word => word.text)).toEqual(['A', '_B']);
  });
});

describe('merging the passes', () => {
  it('keeps the more confident reading where two passes cover the same place, and both where they do not', () => {
    const horizontal = word('R12', 100, 100, 60, 20, 93, 0);
    const noiseOfHorizontal = word('Z', 105, 95, 50, 30, 31, 1);
    const vertical = word('GND', 400, 300, 20, 70, 88, 1);
    const noiseOfVertical = word('.,', 398, 310, 22, 60, 25, 0);
    const elsewhere = word('C7', 900, 900, 40, 20, 70, 0);
    const merged = mergePasses([[horizontal, noiseOfVertical, elsewhere], [noiseOfHorizontal, vertical]]);
    expect(merged.map(w => w.text)).toEqual(['R12', 'GND', 'C7']);
  });

  it('is bounded and returns reading order', () => {
    const many = Array.from({ length: 50 }, (_, i) => word(`W${i}`, (i % 10) * 100, Math.floor(i / 10) * 50, 40, 20, 50 + (i % 7)));
    const merged = mergePasses([many], 20);
    expect(merged).toHaveLength(20);
    for (let i = 1; i < merged.length; i++) expect(merged[i].y > merged[i - 1].y || (merged[i].y === merged[i - 1].y && merged[i].x >= merged[i - 1].x)).toBe(true);
  });
});

describe('raster plan', () => {
  it('bounds extreme aspect ratios and refuses invalid dimensions', () => {
    const thin = planRaster(1e12, 0.001, 300, 1000);
    expect(thin.width * thin.height).toBeLessThanOrEqual(1000);
    expect(thin.width).toBeLessThanOrEqual(32767);
    expect(() => planRaster(Infinity, 100, 300, 1000)).toThrow(RangeError);
    expect(() => planRaster(100, 100, 300, NaN)).toThrow(RangeError);
  });
  it('renders at the requested resolution and lowers it to stay within the pixel budget', () => {
    const a4 = planRaster(842, 595, 300, 40_000_000);
    expect(a4.scale).toBeCloseTo(300 / 72, 6);
    expect([a4.width, a4.height]).toEqual([3508, 2479]);
    const huge = planRaster(842 * 4, 595 * 4, 300, 40_000_000);
    expect(huge.width * huge.height).toBeLessThanOrEqual(40_000_000);
    expect(huge.dpi).toBeLessThan(300);
  });
});
