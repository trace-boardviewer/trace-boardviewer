import { describe, expect, it } from 'vitest';
import { parseQuery } from './query';
describe('library query grammar', () => {
  it.each([
    ['', [], []], ['TPS51225', [{ field: 'any', value: 'TPS51225' }], []],
    ['part:TPS51225', [{ field: 'part', value: 'TPS51225', match: 'exact' }], []],
    ['exact:TPS51225R', [{ field: 'part', value: 'TPS51225R', match: 'exact' }], []],
    ['base:TPS51225', [{ field: 'part', value: 'TPS51225', match: 'base' }], []],
    ['prefix:TPS51', [{ field: 'part', value: 'TPS51', match: 'prefix' }], []],
    ['part:TPS51*', [{ field: 'part', value: 'TPS51', match: 'prefix' }], []],
    ['family:buck-ctl', [{ field: 'part', value: 'buck-ctl', match: 'family' }], []],
    ['board:QX-Z123', [{ field: 'board', value: 'QX-Z123' }], []],
    ['rail:+3V3', [{ field: 'rail', value: '+3V3' }], []],
    ['file:"rev B.pdf"', [{ field: 'file', value: 'rev B.pdf' }], []],
    ['file:"a\\"b"', [{ field: 'file', value: 'a"b' }], []],
    ['unknown:x', [{ field: 'any', value: 'unknown:x' }], []],
    ['constructor:x', [{ field: 'any', value: 'constructor:x' }], []],
    ['__proto__:x', [{ field: 'any', value: '__proto__:x' }], []],
    ['part:', [], ['missing-value']], ['prefix:AB', [], ['short-prefix']],
    ['ref:U7000', [], ['ref-needs-group']],
    ['file:"unfinished', [{ field: 'file', value: 'unfinished' }], ['unclosed-quote']],
    ['part:ＴＰＳ５１２２５', [{ field: 'part', value: 'TPS51225', match: 'exact' }], []],
    ['x'.repeat(201), [], ['too-long']],
  ])('parses %s', (text, terms, issues) => { expect(parseQuery(text)).toEqual({ terms, issues }); });
  it('allows references only in a group and combines literal terms', () => {
    expect(parseQuery('ref:U7000 rail:+3V3 file:power', 'group1').terms).toEqual([{ field: 'ref', value: 'U7000' }, { field: 'rail', value: '+3V3' }, { field: 'file', value: 'power' }]);
  });
  it('is total on arbitrary values and bounded strings', () => {
    for (const value of [null, {}, [], 42, Symbol('q'), 'x'.repeat(200000)]) expect(() => parseQuery(value)).not.toThrow();
    let seed = 7;
    for (let n = 0; n < 2000; n++) {
      let s = '';
      for (let i = 0; i < n % 201; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; s += 'a :"\\*\n\u00e9'[seed % 9]; }
      const result = parseQuery(s);
      expect(result.terms.length).toBeLessThanOrEqual(s.length);
      expect(parseQuery(s)).toEqual(result);
    }
  });
});
