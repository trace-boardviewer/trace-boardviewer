import { describe, expect, it } from 'vitest';
import { SCHEMATIC_LIMITS, SchematicError } from './model';
import { childList, childLists, DEFAULT_SEXPR_LIMITS, isAtom, isList, listHead, parseNumber, readSexpr, type SexprList } from './sexpr';

const read = (text: string, limits = {}) => readSexpr(text, limits);
const shape = (node: unknown): unknown => {
  const n = node as { kind: string; value?: string; quoted?: boolean; items?: unknown[] };
  return n.kind === 'atom' ? (n.quoted ? `"${n.value}"` : n.value) : n.items!.map(shape);
};
const fails = (fn: () => unknown, code: string, message?: RegExp): SchematicError => {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(SchematicError);
    const e = error as SchematicError;
    expect(e.code).toBe(code);
    expect(e.format).toBe('kicad-sch');
    if (message) expect(e.message).toMatch(message);
    return e;
  }
  throw new Error('expected a SchematicError');
};

describe('s-expression reader', () => {
  it('reads nested lists, bare atoms and quoted strings with their kind', () => {
    const { root, nodes } = read('(kicad_sch (version 20231120) (name "a b") ())');
    expect(shape(root)).toEqual(['kicad_sch', ['version', '20231120'], ['name', '"a b"'], []]);
    expect(nodes).toBe(9);
    expect(isList(root)).toBe(true);
    expect(isAtom(root.items[0]!)).toBe(true);
    expect(listHead(root)).toBe('kicad_sch');
    expect(listHead(root.items[3] as SexprList)).toBeUndefined();
  });

  it('does not treat a quoted first item as the head of a list', () => {
    const { root } = read('("kicad_sch" 1)');
    expect(listHead(root)).toBeUndefined();
  });

  it('decodes escapes, keeps unknown escapes verbatim and allows multi-line strings', () => {
    const { root } = read('(t "q\\"uote" "back\\\\slash" "tab\\there" "nl\\nx" "un\\qknown" "two\nlines" "ünï😀")');
    expect(root.items.slice(1).map((n) => (n as { value: string }).value)).toEqual([
      'q"uote', 'back\\slash', 'tab\there', 'nl\nx', 'un\\qknown', 'two\nlines', 'ünï😀',
    ]);
  });

  it('accepts CRLF, tabs and form feeds and tracks 1-based line numbers', () => {
    const { root } = read('(a\r\n\t(b\r\n\f c)\r\n  (d))');
    const b = root.items[1] as SexprList;
    const d = root.items[2] as SexprList;
    expect(root.line).toBe(1);
    expect(b.line).toBe(2);
    expect(d.line).toBe(4);
    expect((b.items[1] as { line: number }).line).toBe(3);
  });

  it('reads pipe-delimited opaque blobs (embedded data) as one quoted atom', () => {
    const { root } = read('(data |AAAA\nBBBB==|)');
    expect(shape(root)).toEqual(['data', '"AAAA\nBBBB=="']);
    fails(() => read('(data |AAAA'), 'INVALID_FORMAT', /unterminated/i);
  });

  it('ignores whitespace around the single top-level list and rejects anything else', () => {
    expect(shape(read('  \n(a)\n\n').root)).toEqual(['a']);
    fails(() => read(''), 'INVALID_FORMAT', /empty/i);
    fails(() => read('   \n'), 'INVALID_FORMAT', /empty/i);
    fails(() => read('atom'), 'INVALID_FORMAT', /expected "\("/i);
    fails(() => read('(a) (b)'), 'INVALID_FORMAT', /after the closing parenthesis.*line 1/);
    fails(() => read('(a) x'), 'INVALID_FORMAT', /after the closing parenthesis/);
  });

  it('reports precise positions for unterminated strings and unbalanced parentheses', () => {
    fails(() => read('(a\n  (b "oops\n c))'), 'INVALID_FORMAT', /unterminated string starting at line 2, column 6/i);
    fails(() => read('(a "x\\'), 'INVALID_FORMAT', /unterminated string/i);
    fails(() => read('(a (b'), 'INVALID_FORMAT', /unclosed.*"\("|2 unclosed/i);
    fails(() => read('(a)\n)'), 'INVALID_FORMAT', /unexpected "\)" at line 2, column 1/i);
    fails(() => read('(a))'), 'INVALID_FORMAT', /after the closing parenthesis|unexpected "\)"/i);
    const e = fails(() => read('(a\n(b\n(c)'), 'INVALID_FORMAT');
    expect(e.message).toMatch(/line 2/);
  });

  it('rejects a quote in the middle of a bare token', () => {
    fails(() => read('(a b"c")'), 'INVALID_FORMAT', /quote.*line 1, column 5/i);
  });

  it('enforces nesting depth with a limit error, iteratively', () => {
    const nest = (n: number) => '('.repeat(n) + ')'.repeat(n);
    expect(read(nest(SCHEMATIC_LIMITS.maxNestingDepth)).nodes).toBe(SCHEMATIC_LIMITS.maxNestingDepth);
    fails(() => read(nest(SCHEMATIC_LIMITS.maxNestingDepth + 1)), 'LIMIT_EXCEEDED', /nest/i);
    // far beyond any call-stack budget: only an iterative reader survives
    const deep = 200_000;
    expect(read(nest(deep), { maxDepth: deep }).nodes).toBe(deep);
    fails(() => read('('.repeat(1_000_000)), 'LIMIT_EXCEEDED', /nest/i);
  });

  it('enforces the node budget and the text size budget', () => {
    expect(read('(a b c)', { maxNodes: 4 }).nodes).toBe(4);
    fails(() => read('(a b c)', { maxNodes: 3 }), 'LIMIT_EXCEEDED', /nodes/i);
    fails(() => read('(a)', { maxChars: 2 }), 'LIMIT_EXCEEDED', /characters/i);
    expect(DEFAULT_SEXPR_LIMITS.maxNodes).toBe(SCHEMATIC_LIMITS.maxExpression);
    expect(DEFAULT_SEXPR_LIMITS.maxDepth).toBe(SCHEMATIC_LIMITS.maxNestingDepth);
  });

  it('reads a very wide list quickly without recursion', () => {
    const count = 500_000;
    const { root, nodes } = read(`(a ${'1 '.repeat(count)})`);
    expect(root.items).toHaveLength(count + 1);
    expect(nodes).toBe(count + 2);
  });

  it('finds children by head', () => {
    const { root } = read('(s (at 1 2) (pin "1") (pin "2") (at 9 9))');
    expect(childLists(root, 'pin')).toHaveLength(2);
    expect(shape(childList(root, 'at'))).toEqual(['at', '1', '2']);
    expect(childList(root, 'missing')).toBeUndefined();
  });
});

describe('parseNumber', () => {
  it('accepts plain decimal and exponent forms and normalizes negative zero', () => {
    for (const [text, value] of [['0', 0], ['-0', 0], ['12', 12], ['-1.5', -1.5], ['+3', 3], ['.5', 0.5], ['-.5', -0.5], ['2.', 2], ['1e-3', 0.001], ['1.5E2', 150]] as const) {
      const n = parseNumber(text, 'value');
      expect(n).toBe(value);
      expect(Object.is(n, -0)).toBe(false);
    }
  });

  it('rejects non-numbers and non-finite results with INVALID_FORMAT', () => {
    for (const text of ['', 'abc', '1,5', '0x10', '1_0', '--1', '1e', 'Infinity', 'NaN', '1e999', '-1e999', '1 2']) {
      fails(() => parseNumber(text, 'width'), 'INVALID_FORMAT', /width/);
    }
  });

  it('takes a 40,000-digit token in linear time and keeps its results', () => {
    const started = performance.now();
    expect(parseNumber('0'.repeat(40_000) + '25', 'x')).toBe(25);
    expect(parseNumber('0'.repeat(40_000) + '.5', 'x')).toBe(0.5);
    for (const text of ['1'.repeat(40_000) + 'x', '1'.repeat(40_000) + 'e', '1'.repeat(40_000)]) fails(() => parseNumber(text, 'width'), 'INVALID_FORMAT', /width/);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('names the offending line when a node is passed', () => {
    const { root } = read('(a\n b)');
    fails(() => parseNumber(root.items[1] as never, 'x'), 'INVALID_FORMAT', /line 2/);
  });

  it('refuses a quoted string where a number is required', () => {
    const { root } = read('(a "1")');
    fails(() => parseNumber(root.items[1] as never, 'x'), 'INVALID_FORMAT', /quoted/);
  });
});
