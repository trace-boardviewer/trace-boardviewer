import { expect, it } from 'vitest';
import { mergeRecognizedText } from './search';
import type { TextIndex } from './search';
import type { TextItem } from './document';

it('bounds the merged index when early recognized pages precede later native text', () => {
  const item = (page: number): TextItem => ({ page, str: 'R1', x: 0, y: 0, width: 10, height: 10 });
  const base: TextIndex = { pageCount: 3, indexedPages: 3, truncated: false, items: [item(2), item(3)], pageStarts: [0, 0, 1, 2] };
  const recognized = new Map([[1, [{ ...item(1), source: 'ocr' as const, confidence: 90 }]]]);
  const merged = mergeRecognizedText(base, recognized, 2);
  expect(merged.items.map(value => value.page)).toEqual([1, 2]);
  expect(merged.pageStarts).toEqual([0, 1, 2, 2]);
  expect(merged.truncated).toBe(true);
});
