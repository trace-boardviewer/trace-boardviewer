import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { attribute, decodeEntities, localName, XmlScanner, type XmlAttributes, type XmlDoctype, type XmlLimits } from './ipc2581-xml';
import { expectScaling } from '../../test-support/timing';

// Original synthetic XML only; no vendor files.
type Event = string;
function events(text: string | string[], limits: Partial<XmlLimits> = {}): { log: Event[]; doctypes: XmlDoctype[] } {
  const log: Event[] = [], doctypes: XmlDoctype[] = [];
  const scanner = new XmlScanner({
    open: (name: string, attributes: XmlAttributes, depth: number) => { log.push(`<${name}${attributes.length ? ` ${JSON.stringify(attributes)}` : ''} @${depth}`); },
    close: (name: string, depth: number) => { log.push(`</${name} @${depth}`); },
    doctype: (doctype: XmlDoctype) => { doctypes.push(doctype); },
  }, 'Test XML', limits);
  for (const chunk of Array.isArray(text) ? text : [text]) scanner.write(chunk);
  scanner.end();
  return { log, doctypes };
}
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const chunks = (text: string, size: number): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
const SAMPLE = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- head -->\n<!DOCTYPE root SYSTEM "x.dtd">\n<root a="1" b=\'two\'>\n  <child x="&lt;&amp;&#65;&#x42;"/><!-- c --><?pi data?>\n  <other><![CDATA[ <not-a-tag> ]]>text</other>\n  <ns:item ns:attr="v" >body</ns:item >\n</root>\n<!-- tail -->\n';

describe('IPC-2581 XML scanner: events', () => {
  it('reports start and end tags with depth and entity-decoded attributes; self-closing tags open and close', () => {
    const { log, doctypes } = events(SAMPLE);
    expect(log).toEqual([
      '<root ["a","1","b","two"] @1', '<child ["x","<&AB"] @2', '</child @2', '<other @2', '</other @2', '<ns:item ["ns:attr","v"] @2', '</ns:item @2', '</root @1',
    ]);
    expect(doctypes).toEqual([{ root: 'root', entities: false, external: true }]);
  });
  it('gives the same events however the input is split into chunks (1, 2, 3, 7 and 64 characters)', () => {
    const whole = events(SAMPLE).log;
    for (const size of [1, 2, 3, 7, 64]) expect(events(chunks(SAMPLE, size)).log, `chunks of ${size}`).toEqual(whole);
  });
  it('stop() ends the scan at the next event; later input is ignored and end() checks nothing', () => {
    const seen: string[] = [];
    const scanner: XmlScanner = new XmlScanner({ open: name => { seen.push(name); if (name === 'b') scanner.stop(); }, close: () => undefined });
    scanner.write('<a><b/><c/>'); scanner.write('<<< not xml'); scanner.end();
    expect(seen).toEqual(['a', 'b']); expect(scanner.isStopped).toBe(true);
  });
  it('decodes only the five predefined entities and numeric references; anything else stays literal', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;')).toBe('<>&"\'');
    expect(decodeEntities('&#65;&#x1F600;&#0;&#xD800;&#x110000;&foo;&amp;lt; & ;')).toBe('A\u{1F600}&#0;&#xD800;&#x110000;&foo;&lt; & ;');
    expect(attribute(['a', '1', 'b', '2'], 'b')).toBe('2'); expect(attribute(['a', '1'], 'c')).toBeUndefined();
    expect(localName('ipc:Pin')).toBe('Pin'); expect(localName('Pin')).toBe('Pin');
  });
});

describe('IPC-2581 XML scanner: well-formedness', () => {
  const malformed: Array<[string, RegExp]> = [
    ['', /no root element/], ['  \n ', /no root element/], ['<a>', /ends inside <a>/], ['<a><b></a>', /does not match <b>/], ['</a>', /has no start tag/],
    ['<a/><b/>', /second root element/], ['<a/>text', /text after the root/], ['x<a/>', /text before the root/], ['<a b="1" b="2"/>', /repeats the attribute b/],
    ['<a b=1/>', /unquoted attribute value/], ['<a b/>', /attribute without a value/], ['<a b="<"/>', /"<" inside an attribute value/], ['<a b="1"c="2"/>', /whitespace before an attribute/],
    ['<a / >', /does not close the tag/], ['< a/>', /starts no tag/], ['<a><!-- x', /ends inside a comment/], ['<![CDATA[x]]><a/>', /CDATA outside the root/],
    ['<a/><!DOCTYPE a>', /DOCTYPE after the root/], ['<!DOCTYPE a><!DOCTYPE a><a/>', /second DOCTYPE/], ['<a><!ELEMENT x ANY></a>', /unsupported markup declaration/],
    ['<a><? x?></a>', /processing instruction without a target/], ['<a b="1', /ends inside a start tag/], ['<a></a', /ends inside an end tag/], ['<a>\n\n<b></c></a>', /line 3/],
  ];
  it.each(malformed)('rejects %j as malformed', (text, message) => {
    const error = failure(() => events(text));
    expect(error.code).toBe('INVALID_FORMAT'); expect(error.message).toMatch(message); expect(error.message).toMatch(/^Test XML is malformed/);
  });
  it('accepts whitespace, comments and processing instructions around the root, a leading byte-order mark and repeated attributes beyond 16 checked by set', () => {
    expect(events('\n<?pi?><!-- a --><a/>\n<!-- b --><?pi x?>\n').log).toEqual(['<a @1', '</a @1']);
    const many = Array.from({ length: 40 }, (_, index) => `a${index}="${index}"`).join(' ');
    expect(events(`<x ${many}/>`).log[0]).toContain('"a39","39"');
    expect(failure(() => events(`<x ${many} a20="again"/>`)).message).toMatch(/repeats the attribute a20/);
  });
});

describe('IPC-2581 XML scanner: entities and DOCTYPE', () => {
  it('refuses a DOCTYPE that declares entities (internal, external, parameter) without expanding anything', () => {
    for (const subset of ['<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">', '<!ENTITY x SYSTEM "file:///etc/passwd">', '<!ENTITY % p "x">', '<!-- c --> <!ENTITY y "z">']) {
      const error = failure(() => events(`<!DOCTYPE a [${subset}]><a>&a;</a>`));
      expect(error.message, subset).toMatch(/declares entities .*never expanded/);
    }
  });
  it('reports entity declarations to a handler that accepts them (sniffing) and still never expands references', () => {
    const { log, doctypes } = (() => {
      const out: string[] = [], seen: XmlDoctype[] = [];
      const scanner = new XmlScanner({ open: (name, attributes) => { out.push(`${name}:${attribute(attributes, 'v')}`); }, close: () => undefined, doctype: doctype => { seen.push(doctype); return true; } });
      scanner.write('<!DOCTYPE a [<!ENTITY e "boom">]><a v="&e;"/>'); scanner.end();
      return { log: out, doctypes: seen };
    })();
    expect(doctypes).toEqual([{ root: 'a', entities: true, external: false }]); expect(log).toEqual(['a:&e;']);
  });
  it('reads a DOCTYPE with an internal subset of element declarations, quoted brackets and comments, and an external identifier it never resolves', () => {
    const { log, doctypes } = events('<!DOCTYPE IPC-2581 PUBLIC "-//x//y" "http://example.invalid/ipc.dtd" [ <!ELEMENT a ANY> <!ATTLIST a v CDATA "]>"> <!-- ] > --> ]><IPC-2581/>');
    expect(doctypes).toEqual([{ root: 'IPC-2581', entities: false, external: true }]); expect(log).toEqual(['<IPC-2581 @1', '</IPC-2581 @1']);
  });
});

describe('IPC-2581 XML scanner: bounds', () => {
  const limited = (text: string, limits: Partial<XmlLimits>) => failure(() => events(text, limits));
  it('bounds depth, element count, attributes, value, tag, name and markup lengths with LIMIT_EXCEEDED', () => {
    const cases: Array<[string, Partial<XmlLimits>, RegExp]> = [
      [`${'<a>'.repeat(9)}${'</a>'.repeat(9)}`, { maxDepth: 8 }, /nesting deeper than 8/],
      [`<r>${'<a/>'.repeat(10)}</r>`, { maxElements: 10 }, /more than 10 elements/],
      [`<a ${Array.from({ length: 5 }, (_, index) => `k${index}="v"`).join(' ')}/>`, { maxAttributes: 4 }, /more than 4 attributes/],
      [`<a v="${'x'.repeat(101)}"/>`, { maxAttributeValue: 100 }, /attribute value longer than 100/],
      [`<a${' '.repeat(200)}/>`, { maxTag: 100 }, /tag longer than 100/],
      [`<${'n'.repeat(65)}/>`, { maxName: 64 }, /name longer than 64/],
      [`<a><!--${'-'.repeat(10)}${'x'.repeat(200)}--></a>`, { maxMarkup: 100 }, /comment longer than 100/],
      [`<a><![CDATA[${'x'.repeat(200)}]]></a>`, { maxMarkup: 100 }, /CDATA section longer than 100/],
      [`<?pi ${'x'.repeat(200)}?><a/>`, { maxMarkup: 100 }, /processing instruction longer than 100/],
      [`<!DOCTYPE a [${'<!ELEMENT b ANY>'.repeat(20)}]><a/>`, { maxTag: 100 }, /DOCTYPE longer than 100/],
    ];
    for (const [text, limits, message] of cases) {
      const error = limited(text, limits);
      expect(error.code, text.slice(0, 40)).toBe('LIMIT_EXCEEDED'); expect(error.message).toMatch(message);
    }
  });
  it('rejects an unfinished construct that is already longer than its bound while input is still arriving', () => {
    const scanner = new XmlScanner({ open: () => undefined, close: () => undefined }, 'Test XML', { maxTag: 1000, maxMarkup: 1000 });
    scanner.write('<root>');
    expect(() => { for (let index = 0; index < 20; index++) scanner.write(`<!--${'x'.repeat(100)}`); }).toThrow(/comment longer than 1000/);
    const tag = new XmlScanner({ open: () => undefined, close: () => undefined }, 'Test XML', { maxTag: 1000 });
    expect(() => { tag.write('<root a="'); for (let index = 0; index < 20; index++) tag.write('x'.repeat(100)); }).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
  it('stays linear on pathological input: a comment and a long tag written one character per chunk, long text runs and many attributes', () => {
    // A scanner that rescans the unfinished construct at every chunk is quadratic: it needs minutes for 200,000 chunks, so a regression fails at the first pair.
    const comment = (chunks: number): string[] => { const scanner = new XmlScanner({ open: () => undefined, close: () => undefined }); scanner.write('<root><!--'); for (let index = 0; index < chunks; index++) scanner.write('-'); scanner.write('></root>'); scanner.end(); return []; };
    const longTag = (chunks: number): string[] => { const opened: string[] = [], tag = new XmlScanner({ open: name => { opened.push(name); }, close: () => undefined }); tag.write('<root'); for (let index = 0; index < chunks; index++) tag.write(' '); tag.write('/>'); tag.end(); return opened; };
    expectScaling('a comment, one character per chunk', [12_500, 50_000, 200_000], chunks => () => comment(chunks));
    expectScaling('a long tag, one character per chunk', [31_250, 125_000, 500_000], chunks => () => longTag(chunks));
    expectScaling('long text runs', [12_500, 50_000, 200_000], count => { const text = `<root>${'text without markup '.repeat(count)}</root>`; return () => events(text); });
    expectScaling('many attributes', [125, 500, 2000], count => { const text = `<root>${`<a ${Array.from({ length: 100 }, (_, index) => `k${index}="${index}"`).join(' ')}/>`.repeat(count)}</root>`; return () => events(text); });
    expect(comment(200_000)).toEqual([]);
    expect(longTag(500_000)).toEqual(['root']);
  });
});
