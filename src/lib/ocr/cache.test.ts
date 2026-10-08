import { describe, expect, it } from 'vitest';
import { OcrResultCache } from './cache';
import type { TextItem } from '../pdf/document';

const items: TextItem[] = [{ str: 'R1', x: 0, y: 0, width: 10, height: 10, page: 1, source: 'ocr', confidence: 90 }];
const key = (document: string) => ({ document, language: 'eng' as const, dpi: 300 });

describe('OCR cache limits', () => {
  it('evicts the least recently used document', () => {
    const cache = new OcrResultCache({ documents: 2, words: 10 });
    cache.put(key('a'), 1, items);
    cache.put(key('b'), 1, items);
    cache.get(key('a'));
    cache.put(key('c'), 1, items);
    expect(cache.get(key('b'))).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.words).toBe(2);
  });

  it('also evicts a single oversized document', () => {
    const cache = new OcrResultCache({ documents: 2, words: 1 });
    cache.put(key('a'), 1, items);
    cache.put(key('a'), 2, items);
    expect(cache.get(key('a'))).toBeUndefined();
    expect(cache.words).toBe(0);
  });

  it('counts replacement pages without accumulating their old words', () => {
    const cache = new OcrResultCache({ documents: 1, words: 2 });
    cache.put(key('a'), 1, items);
    cache.put(key('a'), 1, []);
    expect(cache.words).toBe(0);
    expect(cache.get(key('a'))?.get(1)).toEqual([]);
  });
});
