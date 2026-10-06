import { describe, expect, it } from 'vitest';
import { SCHEMATIC_LIMITS, SchematicError, type Schematic, type SchPin, type SchSymbol } from './model';
import { parseEagleSch } from './eagle-sch';

// All fixtures are original synthetic EAGLE XML written for these tests (no vendor or third-party data).

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (xml: string, name = 'test.sch') => parseEagleSch({ name, data: bytes(xml) });
const must = (xml: string): Schematic => { const result = parse(xml); if (!result) throw new Error('expected a schematic'); return result; };
const codes = (s: Schematic) => s.diagnostics.map(d => d.code);
const symbolOf = (s: Schematic, id: string, def = 0): SchSymbol => { const found = s.defs[def].symbols.find(symbol => symbol.id === id); if (!found) throw new Error(`no symbol ${id}`); return found; };
const pinOf = (symbol: SchSymbol, number: string): SchPin => { const found = symbol.pins.find(pin => pin.number === number); if (!found) throw new Error(`no pin ${number} on ${symbol.id}`); return found; };
const thrown = (action: () => unknown): SchematicError => { try { action(); } catch (error) { if (error instanceof SchematicError) return error; throw error; } throw new Error('expected a SchematicError'); };

const RES = `<symbol name="RES"><wire x1="-2.54" y1="1.016" x2="2.54" y2="1.016" width="0.254" layer="94"/><rectangle x1="-1" y1="-0.5" x2="1" y2="0.5" layer="94"/>
<pin name="P1" x="-5.08" y="0" visible="off" length="short" direction="pas"/><pin name="P2" x="5.08" y="0" visible="off" length="short" direction="pas" rot="R180"/>
<text x="0" y="2.54" size="1.778" layer="95" align="bottom-center">&gt;NAME</text><text x="0" y="-2.54" size="1.778" layer="96" align="top-center">&gt;VALUE</text></symbol>`;
const OPAMP = `<symbol name="OPAMP"><wire x1="-2.54" y1="5.08" x2="-2.54" y2="-5.08" width="0.254" layer="94"/><wire x1="-2.54" y1="5.08" x2="5.08" y2="0" width="0.254" layer="94"/><wire x1="5.08" y1="0" x2="-2.54" y2="-5.08" width="0.254" layer="94"/>
<pin name="IN+" x="-7.62" y="2.54" length="middle" direction="in"/><pin name="IN-" x="-7.62" y="-2.54" length="middle" direction="in"/><pin name="OUT" x="10.16" y="0" length="middle" direction="out" rot="R180"/></symbol>`;
const PWR = `<symbol name="PWR"><pin name="V+" x="0" y="7.62" visible="pad" length="short" direction="pwr" rot="R270"/><pin name="V-" x="0" y="-7.62" visible="pad" length="short" direction="pwr" rot="R90"/></symbol>`;
const LED = `<symbol name="LED"><pin name="A" x="-5.08" y="0" length="short" direction="pas"/><pin name="C" x="5.08" y="0" length="short" direction="pas" rot="R180"/></symbol>`;
const EP = `<symbol name="EPIC"><pin name="VIN" x="-7.62" y="0" length="middle" direction="pwr"/><pin name="GND" x="0" y="-7.62" length="middle" direction="pwr" rot="R90"/></symbol>`;
const NOSTUB = `<symbol name="PT"><pin name="X" x="0" y="0" length="point" direction="nc"/><pin name="Y" x="2.54" y="0" length="point" direction="hiz"/></symbol>`;
const connects = (...items: Array<[string, string, string]>) => `<connects>${items.map(([gate, pin, pad]) => `<connect gate="${gate}" pin="${pin}" pad="${pad}"/>`).join('')}</connects>`;

const TEST_LIB = `<library name="test"><packages><package name="R0805"><smd name="1" x="-1" y="0" dx="1" dy="1" layer="1"/><smd name="2" x="1" y="0" dx="1" dy="1" layer="1"/></package></packages>
<symbols>${RES}${OPAMP}${PWR}${LED}${EP}${NOSTUB}</symbols><devicesets>
<deviceset name="R" prefix="R"><gates><gate name="G$1" symbol="RES" x="0" y="0"/></gates><devices><device name="0805" package="R0805">${connects(['G$1', 'P1', '1'], ['G$1', 'P2', '2'])}<technologies><technology name=""/></technologies></device>
<device name="SWAPPED" package="R0805">${connects(['G$1', 'P1', '2'], ['G$1', 'P2', '1'])}</device><device name="HALF" package="R0805">${connects(['G$1', 'P1', '1'])}</device></devices></deviceset>
<deviceset name="TL072" prefix="U"><gates><gate name="A" symbol="OPAMP" x="0" y="0" addlevel="next" swaplevel="1"/><gate name="B" symbol="OPAMP" x="0" y="-15.24" addlevel="next" swaplevel="1"/><gate name="P" symbol="PWR" x="20" y="0" addlevel="request"/></gates>
<devices><device name="D" package="SO8">${connects(['A', 'IN+', '3'], ['A', 'IN-', '2'], ['A', 'OUT', '1'], ['B', 'IN+', '5'], ['B', 'IN-', '6'], ['B', 'OUT', '7'], ['P', 'V+', '8'], ['P', 'V-', '4'])}</device></devices></deviceset>
<deviceset name="LED" prefix="D"><gates><gate name="G$1" symbol="LED" x="0" y="0"/></gates><devices><device name="" package="LED3">${connects(['G$1', 'A', '2'], ['G$1', 'C', '1'])}</device></devices></deviceset>
<deviceset name="EPIC" prefix="U"><gates><gate name="G$1" symbol="EPIC" x="0" y="0"/></gates><devices><device name="QFN" package="QFN8">${connects(['G$1', 'VIN', '1'], ['G$1', 'GND', '2 EP 9'])}</device></devices></deviceset>
<deviceset name="TP" prefix="TP"><gates><gate name="G$1" symbol="PT" x="0" y="0"/></gates><devices><device name=""/></devices></deviceset>
<deviceset name="NOSYM" prefix="X"><gates><gate name="G$1" symbol="MISSING" x="0" y="0"/></gates><devices><device name="" package="SO8">${connects(['G$1', 'A', '1'])}</device></devices></deviceset>
</devicesets></library>`;
const SUPPLY_LIB = `<library name="supply1"><symbols><symbol name="GND"><wire x1="-1.27" y1="-1.27" x2="1.27" y2="-1.27" width="0.254" layer="94"/><pin name="GND" x="0" y="0" visible="off" length="point" direction="sup" rot="R270"/></symbol>
<symbol name="VCC"><pin name="VCC" x="0" y="0" visible="off" length="point" direction="sup" rot="R90"/></symbol></symbols><devicesets>
<deviceset name="GND" prefix="GND"><gates><gate name="1" symbol="GND" x="0" y="0"/></gates><devices><device name=""/></devices></deviceset>
<deviceset name="VCC" prefix="P+"><gates><gate name="1" symbol="VCC" x="0" y="0"/></gates><devices><device name=""/></devices></deviceset></devicesets></library>`;

interface Doc { version?: string; libraries?: string; parts?: string; sheets: string; extra?: string; before?: string }
const document = ({ version = '9.6.2', libraries = TEST_LIB + SUPPLY_LIB, parts = '', sheets, extra = '', before = '' }: Doc) =>
  `${before}<eagle version="${version}"><drawing><settings><setting alwaysvectorfont="no"/></settings><grid distance="0.1" unitdist="inch" unit="inch" style="lines" multiple="1" display="no" altdistance="0.01" altunitdist="inch" altunit="inch"/>
<layers><layer number="91" name="Nets" color="2" fill="1" visible="yes" active="yes"/></layers><schematic xreflabel="%F%N/%S.%C%R" xrefpart="/%S.%C%R"><libraries>${libraries}</libraries><attributes/><variantdefs/><classes><class number="0" name="default" width="0" drill="0"/></classes>${extra}<parts>${parts}</parts><sheets>${sheets}</sheets></schematic></drawing></eagle>`;
const part = (name: string, deviceset: string, device: string, extra = '', library = 'test') => `<part name="${name}" library="${library}" deviceset="${deviceset}" device="${device}"${extra}/>`;
const inst = (partName: string, gate: string, x: number, y: number, rot = '', extra = '') => `<instance part="${partName}" gate="${gate}" x="${x}" y="${y}"${rot ? ` rot="${rot}"` : ''}${extra}/>`;
const pinref = (partName: string, gate: string, pin: string) => `<pinref part="${partName}" gate="${gate}" pin="${pin}"/>`;
const net = (name: string, ...segments: string[]) => `<net name="${name}" class="0">${segments.map(s => `<segment>${s}</segment>`).join('')}</net>`;
const sheet = (instances: string, nets = '', extra = '') => `<sheet>${extra}<instances>${instances}</instances><busses/><nets>${nets}</nets></sheet>`;
const wire = (x1: number, y1: number, x2: number, y2: number, extra = '') => `<wire x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" width="0.1524" layer="91"${extra}/>`;
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const point = (p: { x: number; y: number }, x: number, y: number) => { close(p.x, x); close(p.y, y); };

describe('recognition by XML root', () => {
  const minimal = document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 10, 10)) });
  it('accepts the usual declaration + DOCTYPE prologue and reports the file version', () => {
    const s = must(`<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n${minimal}`);
    expect(s.format).toBe('eagle-sch'); expect(s.formatLabel).toBe('EAGLE schematic (version 9.6.2)'); expect(s.sourceUnit).toBe('mm'); expect(s.name).toBe('test');
  });
  it.each([
    ['a bare <eagle> root', minimal],
    ['a comment-prefixed document', `<!-- exported by a tool -->\n<!-- second -->\n${minimal}`],
    ['a DOCTYPE-prefixed document without a declaration', `<!DOCTYPE eagle SYSTEM "eagle.dtd">\n${minimal}`],
    ['a DOCTYPE with an internal subset that declares no entity', `<!DOCTYPE eagle [ <!ELEMENT eagle ANY> ]>\n${minimal}`],
    ['a declaration followed by comments and a processing instruction', `<?xml version="1.0"?>\n<!-- c -->\n<?tool x?>\n${minimal}`],
    ['leading whitespace', `\n\n  \t${minimal}`],
  ])('accepts %s', (_name, xml) => {
    const s = must(xml);
    expect(s.defs).toHaveLength(1); expect(s.defs[0].symbols.map(symbol => symbol.id)).toEqual(['R1:G$1']);
  });
  it('accepts a UTF-8 BOM, a UTF-16 BOM and a declared Latin-1 encoding', () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(minimal)]);
    expect(parseEagleSch({ name: 'b.sch', data: bom })?.defs[0].symbols).toHaveLength(1);
    const utf16 = new Uint8Array(2 + minimal.length * 2); utf16.set([0xff, 0xfe]);
    for (let i = 0; i < minimal.length; i++) { utf16[2 + 2 * i] = minimal.charCodeAt(i) & 0xff; utf16[3 + 2 * i] = minimal.charCodeAt(i) >> 8; }
    expect(parseEagleSch({ name: 'u.sch', data: utf16 })?.defs[0].symbols).toHaveLength(1);
    const doc = (value: string) => document({ parts: part('R1', 'R', '0805', ` value="${value}"`), sheets: sheet(inst('R1', 'G$1', 0, 0)) });
    const latin = Uint8Array.from(`<?xml version="1.0" encoding="ISO-8859-1"?>${doc('caf\u00e9 10\u00b5F')}`, c => c.charCodeAt(0));
    expect(parseEagleSch({ name: 'l.sch', data: latin })?.defs[0].symbols[0].value).toBe('caf\u00e9 10\u00b5F');
    expect(parseEagleSch({ name: 'l.sch', data: bytes(`<?xml version="1.0" encoding="utf-8"?>${doc('caf\u00e9')}`) })?.defs[0].symbols[0].value).toBe('caf\u00e9');
  });
  it('returns null for everything that is not an EAGLE schematic', () => {
    const board = `<?xml version="1.0"?><!DOCTYPE eagle SYSTEM "eagle.dtd"><eagle version="9.6.2"><drawing><layers/><board><plain/><libraries/><elements/><signals/></board></drawing></eagle>`;
    const library = `<?xml version="1.0"?><eagle version="9.6.2"><drawing><layers/><library name="x"><packages/><symbols/><devicesets/></library></drawing></eagle>`;
    for (const xml of [board, library, '<svg xmlns="http://www.w3.org/2000/svg"><schematic/></svg>', '<root><schematic/></root>', '<kicad_sch/>', 'plain text with <schematic> in it', '', '   ',
      '<eagle><drawing><!-- <schematic> --><board/></drawing></eagle>']) expect(parse(xml)).toBeNull();
    expect(parseEagleSch({ name: 'x.sch', data: Uint8Array.from([0, 1, 2, 3, 255, 254, 0, 60]) })).toBeNull();
    expect(parseEagleSch({ name: 'x.sch', data: new Uint8Array() })).toBeNull();
  });
});

describe('malformed and hostile input', () => {
  const valid = document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 10, 10), net('N1', wire(0, 0, 1, 1))) });
  it('rejects truncated and mismatched XML with INVALID_FORMAT', () => {
    for (const cut of [valid.length - 30, valid.length >> 1, valid.indexOf('<schematic') + 40]) {
      const error = thrown(() => parse(valid.slice(0, cut))); expect(error.code).toBe('INVALID_FORMAT'); expect(error.format).toBe('eagle-sch');
    }
    expect(thrown(() => parse(valid.replace('</sheets>', '</parts>'))).code).toBe('INVALID_FORMAT');
    expect(thrown(() => parse(valid.replace('</eagle>', ''))).code).toBe('INVALID_FORMAT');
  });
  it('rejects non-finite, malformed or absurd numbers and bad rotations', () => {
    for (const [from, to] of [['x="10" y="10"', 'x="abc" y="10"'], ['x="10" y="10"', 'x="1e999" y="10"'], ['x="10" y="10"', 'x="" y="10"'], ['x="10" y="10"', 'x="NaN" y="10"'],
      ['x="10" y="10"', `x="${SCHEMATIC_LIMITS.maxCoordinateMm * 2}" y="10"`], ['x1="0"', 'x1="Infinity"'], ['x="10" y="10"', 'x="10" y="10" rot="R45"'], ['x="10" y="10"', 'x="10" y="10" rot="XR0"'],
      ['x="10" y="10"', 'y="10"'], ['name="R1" library', 'name=" " library']]) {
      const error = thrown(() => parse(valid.replace(from, to))); expect(error.code, `${from} -> ${to}`).toBe('INVALID_FORMAT');
    }
  });
  it('never expands DOCTYPE entities (billion-laughs style) and rejects the declaration', () => {
    const lol = Array.from({ length: 9 }, (_, i) => `<!ENTITY l${i + 1} "${i ? Array.from({ length: 10 }, () => `&amp;l${i};`).join('') : 'lol'}">`).join('\n');
    const bomb = `<?xml version="1.0"?>\n<!DOCTYPE eagle [\n${lol}\n]>\n${valid.replace('<attributes/>', '<attributes><attribute name="A" value="&l9;"/></attributes>')}`;
    const started = Date.now(), error = thrown(() => parse(bomb));
    expect(error.code).toBe('INVALID_FORMAT'); expect(error.message).toMatch(/entit/i); expect(Date.now() - started).toBeLessThan(2000);
    expect(thrown(() => parse(`<!DOCTYPE eagle [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>${valid}`)).code).toBe('INVALID_FORMAT');
    // a non-EAGLE document with an entity is simply not ours
    expect(parse('<!DOCTYPE note [ <!ENTITY a "b"> ]><note>&a;</note>')).toBeNull();
  });
  it('decodes only the predefined entities and character references, leaving unknown references untouched', () => {
    const s = must(document({ parts: part('R1', 'R', '0805', ' value="4k7 &amp; &#x3A9; &#955; &lol;"'), sheets: sheet(inst('R1', 'G$1', 0, 0)) }));
    expect(symbolOf(s, 'R1:G$1').value).toBe('4k7 & Ω λ &lol;');
  });
  it('enforces SCHEMATIC_LIMITS with LIMIT_EXCEEDED before building anything', () => {
    const wrap = (body: string) => `<eagle version="9"><drawing><schematic><libraries/><parts/><sheets>${body}</sheets></schematic></drawing></eagle>`;
    expect(thrown(() => parse(wrap(`<sheet><instances>${'<instance part="R" gate="G" x="0" y="0"/>'.repeat(SCHEMATIC_LIMITS.maxSymbolsPerDef + 1)}</instances></sheet>`))).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(() => parse(wrap('<sheet><instances/></sheet>'.repeat(SCHEMATIC_LIMITS.maxSheetDefs + 1)))).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(() => parse(wrap(`<sheet><nets><net name="N"><segment>${'<wire x1="0" y1="0" x2="1" y2="1"/>'.repeat(SCHEMATIC_LIMITS.maxWiresPerDef + 1)}</segment></net></nets></sheet>`))).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(() => parse(wrap(`<sheet>${'<a/>'.repeat(SCHEMATIC_LIMITS.maxExpression + 1)}</sheet>`))).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(() => parse(wrap(`<sheet>${'<a>'.repeat(SCHEMATIC_LIMITS.maxNestingDepth + 1)}${'</a>'.repeat(SCHEMATIC_LIMITS.maxNestingDepth + 1)}</sheet>`))).code).toBe('LIMIT_EXCEEDED');
  }, 30_000);
  it('bounds the expanded output of a symbol that is placed many times', () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `<wire x1="${i}" y1="0" x2="${i}" y2="1" width="0.1" layer="94"/>`).join('');
    const lib = `<library name="big"><symbols><symbol name="S">${body}<pin name="1" x="0" y="0" length="point"/></symbol></symbols><devicesets><deviceset name="D"><gates><gate name="G$1" symbol="S" x="0" y="0"/></gates><devices><device name="" package="P">${connects(['G$1', '1', '1'])}</device></devices></deviceset></devicesets></library>`;
    const names = Array.from({ length: SCHEMATIC_LIMITS.maxWiresPerDef / 50_000 + 1 }, (_, i) => `X${i}`);
    const xml = (count: number) => document({ libraries: lib, parts: names.slice(0, count).map(n => part(n, 'D', '', '', 'big')).join(''), sheets: sheet(names.slice(0, count).map(n => inst(n, 'G$1', 0, 0)).join('')) });
    expect(must(xml(names.length - 1)).defs[0].symbols).toHaveLength(names.length - 1);
    expect(thrown(() => parse(xml(names.length))).code).toBe('LIMIT_EXCEEDED');
  }, 120_000);
  it('requires at least one sheet', () => {
    expect(thrown(() => parse(`<eagle version="9"><drawing><schematic><libraries/><parts/><sheets/></schematic></drawing></eagle>`)).code).toBe('INVALID_FORMAT');
  });
});

describe('library resolution and pad numbers', () => {
  const xml = document({
    parts: part('U1', 'TL072', 'D', ' value="TL072"') + part('R1', 'R', '0805', ' value="10k"') + part('D1', 'LED', '') + part('R2', 'R', 'SWAPPED', ' value="1k"'),
    sheets: sheet([inst('U1', 'A', 101.6, 76.2), inst('U1', 'B', 101.6, 50.8), inst('R1', 'G$1', 50.8, 76.2), inst('D1', 'G$1', 20.32, 10.16), inst('R2', 'G$1', 60, 60)].join('')),
  });
  const s = must(xml);

  it('creates one symbol per placed gate sharing the part reference, with 1-based units in deviceset order', () => {
    const a = symbolOf(s, 'U1:A'), b = symbolOf(s, 'U1:B');
    expect([a.unit, b.unit, a.unitCount, b.unitCount]).toEqual([1, 2, 3, 3]);
    expect([a.refDefault, b.refDefault]).toEqual(['U1', 'U1']);
    expect(a.instances).toEqual({ '': { ref: 'U1', unit: 1 } }); expect(b.instances['']).toEqual({ ref: 'U1', unit: 2 });
    expect(a.libId).toBe('test:TL072:D'); expect(a.footprint).toBe('SO8'); expect(a.value).toBe('TL072'); expect(a.virtual).toBe(false); expect(a.power).toBeUndefined();
    expect(s.defs[0].symbols.map(symbol => symbol.id)).toEqual(['U1:A', 'U1:B', 'R1:G$1', 'D1:G$1', 'R2:G$1']);
  });
  it('uses the board PAD name from the device connects as the pin number, not the symbol pin name', () => {
    const a = symbolOf(s, 'U1:A'), b = symbolOf(s, 'U1:B');
    expect(a.pins.map(pin => [pin.number, pin.name])).toEqual([['3', 'IN+'], ['2', 'IN-'], ['1', 'OUT']]);
    expect(b.pins.map(pin => [pin.number, pin.name])).toEqual([['5', 'IN+'], ['6', 'IN-'], ['7', 'OUT']]);
    expect(a.pins.map(pin => pin.id)).toEqual(['U1:A#3', 'U1:A#2', 'U1:A#1']);
    expect(a.pins.map(pin => [pin.type, pin.unit])).toEqual([['input', 1], ['input', 1], ['output', 1]]); expect(b.pins.every(pin => pin.unit === 2)).toBe(true);
    // pin names P1/P2 against pads: the SWAPPED device crosses them, the LED maps A -> pad 2 and C -> pad 1
    expect(symbolOf(s, 'R1:G$1').pins.map(pin => [pin.name, pin.number])).toEqual([['P1', '1'], ['P2', '2']]);
    expect(symbolOf(s, 'R2:G$1').pins.map(pin => [pin.name, pin.number])).toEqual([['P1', '2'], ['P2', '1']]);
    expect(symbolOf(s, 'D1:G$1').pins.map(pin => [pin.name, pin.number])).toEqual([['A', '2'], ['C', '1']]);
  });
  it('never emits an empty pin number and keeps pin ids unique per sheet', () => {
    for (const symbol of s.defs.flatMap(def => def.symbols)) for (const pin of symbol.pins) expect(pin.number).not.toBe('');
    const ids = s.defs[0].symbols.flatMap(symbol => symbol.pins.map(pin => pin.id)); expect(new Set(ids).size).toBe(ids.length);
  });
  it('places pins exactly: connection point, body end and Y flip (EAGLE Y-up -> model Y-down)', () => {
    const a = symbolOf(s, 'U1:A'); point(a.at, 101.6, -76.2);
    point(pinOf(a, '3').at, 101.6 - 7.62, -(76.2 + 2.54)); point(pinOf(a, '3').body, 101.6 - 7.62 + 5.08, -(76.2 + 2.54));
    point(pinOf(a, '1').at, 101.6 + 10.16, -76.2); point(pinOf(a, '1').body, 101.6 + 10.16 - 5.08, -76.2);
  });
  it('reports an unplaced power gate as information and keeps the declared nets honest', () => {
    const note = s.diagnostics.find(d => d.code === 'GATE_NOT_PLACED'); expect(note?.severity).toBe('info'); expect(note?.message).toContain('gate P');
  });
  it('is deterministic, structured-clone safe and never produces -0', () => {
    expect(must(xml)).toEqual(s); expect(JSON.parse(JSON.stringify(s))).toEqual(s); expect(structuredClone(s)).toEqual(s);
    const walk = (value: unknown): void => { if (typeof value === 'number') expect(Object.is(value, -0)).toBe(false); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
    walk(s);
  });
});

describe('placement: rotation and mirror', () => {
  const place = (rot: string) => symbolOf(must(document({ parts: part('R1', 'R', '0805', ' value="10k"'), sheets: sheet(inst('R1', 'G$1', 50.8, 76.2, rot)) })), 'R1:G$1');
  const geometry = (rot: string) => { const symbol = place(rot), p1 = pinOf(symbol, '1'), p2 = pinOf(symbol, '2'); return { p1: p1.at, p1b: p1.body, p2: p2.at, p2b: p2.body, rotation: symbol.rotation, mirror: symbol.mirror }; };

  it('R0: pin 1 left, pin 2 right; the stub runs from the connection point towards the body', () => {
    const g = geometry(''); point(g.p1, 45.72, -76.2); point(g.p1b, 48.26, -76.2); point(g.p2, 55.88, -76.2); point(g.p2b, 53.34, -76.2); expect([g.rotation, g.mirror]).toEqual([0, 'none']);
    expect(geometry('R0')).toEqual(g);
  });
  it('R90 turns counter-clockwise: pin 1 ends up below the origin on the page', () => {
    const g = geometry('R90'); point(g.p1, 50.8, -71.12); point(g.p1b, 50.8, -73.66); point(g.p2, 50.8, -81.28); point(g.p2b, 50.8, -78.74); expect([g.rotation, g.mirror]).toEqual([90, 'none']);
  });
  it('R180 and R270', () => {
    const r180 = geometry('R180'); point(r180.p1, 55.88, -76.2); point(r180.p2, 45.72, -76.2);
    const r270 = geometry('R270'); point(r270.p1, 50.8, -81.28); point(r270.p1b, 50.8, -78.74); point(r270.p2, 50.8, -71.12); expect(r270.rotation).toBe(270);
  });
  it('MR0 mirrors about the vertical axis; MR90 mirrors first, then rotates counter-clockwise', () => {
    const m0 = geometry('MR0'); point(m0.p1, 55.88, -76.2); point(m0.p1b, 53.34, -76.2); point(m0.p2, 45.72, -76.2); expect([m0.rotation, m0.mirror]).toEqual([0, 'y']);
    const m90 = geometry('MR90'); point(m90.p1, 50.8, -81.28); point(m90.p1b, 50.8, -78.74); point(m90.p2, 50.8, -71.12); expect([m90.rotation, m90.mirror]).toEqual([90, 'y']);
    const m270 = geometry('MR270'); point(m270.p1, 50.8, -71.12); point(m270.p2, 50.8, -81.28);
  });
  it('spin only affects text: SR90 and SMR270 place pins like R90 and MR270', () => {
    expect(geometry('SR90')).toEqual(geometry('R90')); expect(geometry('SMR270')).toEqual(geometry('MR270'));
  });
  it('keeps pin-to-pin distance and the pin number under every placement', () => {
    for (const rot of ['R0', 'R90', 'R180', 'R270', 'MR0', 'MR90', 'MR180', 'MR270', 'SR90', 'SMR180']) {
      const g = geometry(rot); expect(Math.hypot(g.p1.x - g.p2.x, g.p1.y - g.p2.y)).toBeCloseTo(10.16, 6); expect(Math.hypot(g.p1.x - g.p1b.x, g.p1.y - g.p1b.y)).toBeCloseTo(2.54, 6);
    }
  });
  it('transforms body graphics: rectangles stay rectangles with swapped extents, wires and texts follow the symbol', () => {
    const r0 = place('R0'), r90 = place('R90');
    const rect0 = r0.graphics.find(g => g.kind === 'rect'), rect90 = r90.graphics.find(g => g.kind === 'rect');
    if (rect0?.kind !== 'rect' || rect90?.kind !== 'rect') throw new Error('rect expected');
    point(rect0.min, 49.8, -76.7); point(rect0.max, 51.8, -75.7); point(rect90.min, 50.3, -77.2); point(rect90.max, 51.3, -75.2);
    const line0 = r0.graphics.find(g => g.kind === 'poly'); if (line0?.kind !== 'poly') throw new Error('poly expected');
    point(line0.points[0], 48.26, -77.216); point(line0.points[1], 53.34, -77.216);
    close(r0.bounds.minX, 45.72); close(r0.bounds.maxX, 55.88); close(r0.bounds.minY, -78.74); close(r0.bounds.maxY, -71.882);
  });
  it('keeps text readable: upside-down text is turned and its alignment mirrored unless the instance spins', () => {
    const names = (rot: string) => place(rot).graphics.filter((g): g is Extract<typeof g, { kind: 'text' }> => g.kind === 'text');
    const [n0, v0] = names('R0'); expect([n0.text, n0.angle, n0.anchor, n0.size]).toEqual(['R1', 0, 'middle', 1.778]); point(n0.at, 50.8, -78.74);
    expect(v0.text).toBe('10k'); point(v0.at, 50.8, -(76.2 - 2.54) + 1.778); // top-aligned: the baseline sits one text height below the anchor
    const [n180] = names('R180'); expect([n180.angle, n180.anchor]).toEqual([0, 'middle']); point(n180.at, 50.8, -73.66 + 1.778);
    const [n180s] = names('SR180'); expect(n180s.angle).toBe(180); point(n180s.at, 50.8, -73.66);
    const [n90] = names('R90'); expect(n90.angle).toBe(90); point(n90.at, 48.26, -76.2);
    const [n270] = names('R270'); expect(n270.angle).toBe(90); point(n270.at, 53.34 + 1.778, -76.2);
    const [nm] = names('MR0'); expect(nm.angle).toBe(0);
  });
});

describe('supply symbols', () => {
  const s = must(document({
    parts: part('GND1', 'GND', '', '', 'supply1') + part('P+1', 'VCC', '', '', 'supply1') + part('R1', 'R', '0805', ' value="10k"'),
    sheets: sheet([inst('GND1', '1', 25.4, 12.7), inst('P+1', '1', 25.4, 50.8, 'R180'), inst('R1', 'G$1', 25.4, 30)].join(''), net('GND', wire(25.4, 12.7, 25.4, 25), pinref('GND1', '1', 'GND') + pinref('R1', 'G$1', 'P2'))),
  }));
  it('turns a supply gate into a virtual power symbol whose global net is the pin name', () => {
    const gnd = symbolOf(s, 'GND1:1'); expect(gnd.power).toEqual({ net: 'GND' }); expect(gnd.virtual).toBe(true); expect(gnd.refDefault).toBe('GND1'); expect(gnd.footprint).toBe('');
    expect(gnd.pins).toHaveLength(1); expect(gnd.pins[0]).toMatchObject({ id: 'GND1:1#GND', number: 'GND', name: 'GND', type: 'power_in', hidden: false });
    point(gnd.pins[0].at, 25.4, -12.7); point(gnd.pins[0].body, 25.4, -12.7);
    expect(symbolOf(s, 'P+1:1').power).toEqual({ net: 'VCC' });
    const r = symbolOf(s, 'R1:G$1'); expect(r.power).toBeUndefined(); expect(r.virtual).toBe(false);
    expect(s.diagnostics.filter(d => d.severity !== 'info' && d.code !== 'PIN_NO_PAD')).toEqual([]);
  });
  it('declares the supply pin in its net like any other pin', () => {
    expect(s.declaredNets).toEqual([{ name: 'GND', pins: [
      { instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'GND1:1', pinId: 'GND1:1#GND' }, { instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'R1:G$1', pinId: 'R1:G$1#2' }],
      wires: [{ instancePath: 'sheet:1', defId: 'sheet:1', wireId: 'w1' }] }]);
  });
  it('treats other package-less symbols as virtual and names their pins after the pin (test points, flags)', () => {
    const t = symbolOf(must(document({ parts: part('TP1', 'TP', ''), sheets: sheet(inst('TP1', 'G$1', 0, 0)) })), 'TP1:G$1');
    expect(t.virtual).toBe(true); expect(t.power).toBeUndefined(); expect(t.pins.map(pin => [pin.number, pin.type])).toEqual([['X', 'no_connect'], ['Y', 'tri_state']]);
  });
});

describe('sheets and declared nets', () => {
  const s = must(document({
    parts: part('R1', 'R', '0805', ' value="10k"') + part('R2', 'R', '0805', ' value="22k"') + part('GND1', 'GND', '', '', 'supply1') + part('GND2', 'GND', '', '', 'supply1'),
    sheets: sheet([inst('R1', 'G$1', 10, 10), inst('GND1', '1', 15.08, 10)].join(''), net('GND', wire(15.08, 10, 15.08, 12) + pinref('R1', 'G$1', 'P2') + pinref('GND1', '1', 'GND') + pinref('R1', 'G$1', 'P2'))
      + net('SIG', pinref('R1', 'G$1', 'P1')), '<description language="en">Power &amp; input</description>')
      + sheet([inst('R2', 'G$1', 30, 10), inst('GND2', '1', 35.08, 10)].join(''), net('GND', pinref('R2', 'G$1', 'P2') + pinref('GND2', '1', 'GND')) + net('SIG', pinref('R2', 'G$1', 'P1'))),
  }));
  it('emits one root-level definition and instance per sheet, all siblings', () => {
    expect(s.defs.map(d => [d.id, d.name, d.title])).toEqual([['sheet:1', 'Power & input', 'Power & input'], ['sheet:2', 'Sheet 2', '']]);
    expect(s.rootDefId).toBe('sheet:1');
    expect(s.instances).toEqual([
      { path: 'sheet:1', defId: 'sheet:1', name: 'Power & input', page: '1', parentPath: null, sheetRefId: null, childPaths: [], depth: 0 },
      { path: 'sheet:2', defId: 'sheet:2', name: 'Sheet 2', page: '2', parentPath: null, sheetRefId: null, childPaths: [], depth: 0 }]);
    expect(s.defs.every(d => d.file === 'test.sch' && d.sheetRefs.length === 0)).toBe(true);
  });
  it('merges a net name that appears on several sheets into one declared net, without duplicate pins', () => {
    expect(s.declaredNets?.map(n => n.name)).toEqual(['GND', 'SIG']);
    const gnd = s.declaredNets?.find(n => n.name === 'GND');
    expect(gnd?.pins).toEqual([
      { instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'R1:G$1', pinId: 'R1:G$1#2' }, { instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'GND1:1', pinId: 'GND1:1#GND' },
      { instancePath: 'sheet:2', defId: 'sheet:2', symbolId: 'R2:G$1', pinId: 'R2:G$1#2' }, { instancePath: 'sheet:2', defId: 'sheet:2', symbolId: 'GND2:1', pinId: 'GND2:1#GND' }]);
    expect(s.declaredNets?.find(n => n.name === 'SIG')?.pins.map(p => p.pinId)).toEqual(['R1:G$1#1', 'R2:G$1#1']);
  });
  it('resolves pinrefs by symbol pin NAME to the pad-numbered pin', () => {
    const swapped = must(document({ parts: part('R9', 'R', 'SWAPPED'), sheets: sheet(inst('R9', 'G$1', 0, 0), net('N', pinref('R9', 'G$1', 'P1'))) }));
    expect(swapped.declaredNets).toEqual([{ name: 'N', pins: [{ instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'R9:G$1', pinId: 'R9:G$1#2' }], wires: [] }]);
    expect(pinOf(symbolOf(swapped, 'R9:G$1'), '2').name).toBe('P1');
  });
  it('reports unknown pinrefs and skips them instead of guessing', () => {
    const bad = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('N', pinref('R1', 'G$1', 'P1') + pinref('R1', 'G$1', 'NOPE') + pinref('R7', 'G$1', 'P1') + pinref('R1', 'G$9', 'P1'))) }));
    expect(bad.declaredNets?.[0].pins).toHaveLength(1); expect(codes(bad).filter(c => c === 'PINREF_UNRESOLVED')).toHaveLength(3);
    expect(bad.diagnostics.find(d => d.code === 'PINREF_UNRESOLVED')).toMatchObject({ severity: 'warning', defId: 'sheet:1' });
    // the net is still declared by the file: it stays, with no pin invented for the unresolved reference
    expect(must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('ONLY', pinref('R7', 'G$1', 'P1'))) })).declaredNets).toEqual([{ name: 'ONLY', pins: [], wires: [] }]);
  });
  describe('declared wire membership (B37)', () => {
    // two sheets: SIG has a pin-connected segment and a disconnected one on sheet 1 and a pin-connected one on sheet 2; ONLY_WIRE is labelled and pinless
    const lib = `<library name="tiny"><symbols><symbol name="POINT"><pin name="P" x="0" y="0" length="point" direction="pas"/></symbol></symbols><devicesets><deviceset name="DUAL"><gates><gate name="A" symbol="POINT" x="0" y="0"/><gate name="B" symbol="POINT" x="0" y="0"/></gates><devices><device name="" package="TWO">${connects(['A', 'P', '1'], ['B', 'P', '2'])}</device></devices></deviceset></devicesets></library>`;
    const w = (x1: number, y1: number, x2: number, y2: number) => `<wire x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" width="0.15" layer="91"/>`;
    const s = must(document({
      libraries: lib, parts: '<part name="U1" library="tiny" deviceset="DUAL" device="" value="DUAL"/>',
      sheets: sheet(inst('U1', 'A', 10, 20), net('SIG', pinref('U1', 'A', 'P') + w(10, 20, 15, 20), w(30, 20, 35, 20)))
        + sheet(inst('U1', 'B', 40, 20), net('SIG', pinref('U1', 'B', 'P') + w(40, 20, 45, 20)) + net('ONLY_WIRE', w(60, 20, 65, 20) + '<label x="60" y="20" size="1" layer="95"/>')),
    }));
    const ref = (def: string, wireId: string) => ({ instancePath: def, defId: def, wireId });
    it('lists every wire of every segment of the net, including segments without a pinref', () => {
      expect(s.declaredNets).toEqual([
        { name: 'SIG', pins: [{ instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'U1:A', pinId: 'U1:A#1' }, { instancePath: 'sheet:2', defId: 'sheet:2', symbolId: 'U1:B', pinId: 'U1:B#2' }],
          wires: [ref('sheet:1', 'w1'), ref('sheet:1', 'w2'), ref('sheet:2', 'w1')] },
        { name: 'ONLY_WIRE', pins: [], wires: [ref('sheet:2', 'w2')] },
      ]);
    });
    it('keeps the zero-pin net, with its wire and label present on the sheet, and invents no pin', () => {
      const only = s.declaredNets?.find(n => n.name === 'ONLY_WIRE');
      expect(only?.pins).toEqual([]); expect(s.defs[1].labels.map(l => l.text)).toEqual(['ONLY_WIRE']);
      expect(s.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
    });
    it('references wires that exist on the named sheet, each wire in exactly one net', () => {
      const all = s.declaredNets?.flatMap(n => n.wires ?? []) ?? [];
      expect(new Set(all.map(r => `${r.defId}/${r.wireId}`)).size).toBe(all.length);
      for (const r of all) expect(s.defs.find(d => d.id === r.defId)?.wires.some(wire => wire.id === r.wireId), `${r.defId}/${r.wireId}`).toBe(true);
      expect(all).toHaveLength(s.defs.reduce((sum, d) => sum + d.wires.length, 0));
      const disconnected = s.defs[0].wires.find(x => x.id === 'w2'); point(disconnected!.a, 30, -20); point(disconnected!.b, 35, -20);
    });
    it('merges nets of the same name across sheets and lists every sampled piece of a curved wire', () => {
      expect(s.declaredNets?.filter(n => n.name === 'SIG')).toHaveLength(1);
      const curved = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('C', wire(0, 0, 10, 0, ' curve="90"'))) }));
      expect(curved.declaredNets?.[0].wires).toHaveLength(curved.defs[0].wires.length); expect(curved.defs[0].wires.length).toBeGreaterThan(1);
    });
    it('keeps label-only and junction-only nets, but not a net element without segments', () => {
      const x = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('LBL', '<label x="1" y="1" size="1" layer="95"/>') + net('JCT', '<junction x="2" y="2"/>') + '<net name="EMPTY" class="0"/>') }));
      expect(x.declaredNets).toEqual([{ name: 'LBL', pins: [], wires: [] }, { name: 'JCT', pins: [], wires: [] }]);
    });
  });
  it('declares nets in source order and keeps bus wires out of the nets', () => {
    const x = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('B', wire(0, 0, 1, 0)) + net('A', wire(2, 0, 3, 0))).replace('<busses/>', `<busses><bus name="D[0..1]"><segment>${wire(0, 9, 9, 9)}</segment></bus></busses>`) }));
    expect(x.declaredNets?.map(n => n.name)).toEqual(['B', 'A']); expect(x.declaredNets?.flatMap(n => n.wires ?? [])).toHaveLength(2); expect(x.defs[0].buses).toHaveLength(1);
  });
  it('flags a pin declared in two different nets', () => {
    const two = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('A', pinref('R1', 'G$1', 'P1')) + net('B', pinref('R1', 'G$1', 'P1'))) }));
    expect(codes(two)).toContain('PIN_MULTI_NET'); expect(two.declaredNets?.map(n => n.name)).toEqual(['A', 'B']);
  });
  it('emits wires, junctions, labels and buses for drawing, flipped to Y-down', () => {
    const d = must(document({
      parts: part('R1', 'R', '0805'),
      sheets: sheet(inst('R1', 'G$1', 0, 0), net('N1', wire(5, 2, 10, 2) + wire(10, 2, 10, 8) + `<junction x="10" y="2"/><label x="10" y="8" size="1.778" layer="95" rot="R90" xref="yes"/><label x="5" y="2" size="1.778" layer="95" rot="MR0"/>` + pinref('R1', 'G$1', 'P1')))
        .replace('<busses/>', `<busses><bus name="A[0..3]"><segment>${wire(0, 20, 30, 20)}<label x="0" y="20" size="1.778" layer="95"/></segment></bus></busses>`),
    })).defs[0];
    expect(d.wires.map(w => w.id)).toEqual(['w1', 'w2']); point(d.wires[0].a, 5, -2); point(d.wires[0].b, 10, -2); point(d.wires[1].b, 10, -8);
    expect(d.junctions).toHaveLength(1); point(d.junctions[0].at, 10, -2);
    expect(d.labels.map(l => [l.kind, l.text, l.angle])).toEqual([['local', 'A[0..3]', 0], ['local', 'N1', 90], ['local', 'N1', 180]]);
    expect(d.buses).toHaveLength(1); point(d.buses[0].a, 0, -20); point(d.buses[0].b, 30, -20); expect(d.busEntries).toEqual([]);
    expect(d.bounds.maxX).toBeGreaterThanOrEqual(30); expect(d.bounds.minY).toBeLessThanOrEqual(-20);
  });
  it('samples curved wires into chained segments with exact end points (positive curve = counter-clockwise)', () => {
    const wires = (curve: number) => must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('N', wire(0, 0, 10, 0, ` curve="${curve}"`))) })).defs[0].wires;
    const up = wires(180);
    expect(up.length).toBeGreaterThan(8); point(up[0].a, 0, 0); point(up[up.length - 1].b, 10, 0);
    for (let i = 0; i < up.length; i++) { close(Math.hypot(up[i].b.x - 5, up[i].b.y), 5); if (i) expect(up[i].a).toEqual(up[i - 1].b); }
    expect(up.some(w => w.b.y > 4)).toBe(true); // counter-clockwise from (0,0) to (10,0) bulges to -y in EAGLE = +y in the model
    expect(wires(-180).some(w => w.b.y < -4)).toBe(true);
    expect(wires(90)).not.toHaveLength(1);
  });
  it('draws degenerate arcs straight and says so', () => {
    const d = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('N', wire(3, 3, 3, 3, ' curve="90"'))) }));
    expect(d.defs[0].wires).toHaveLength(1); expect(codes(d)).toContain('ARC_DEGENERATE');
  });
  it('keeps the unit of the coordinates as millimetres whatever the grid display unit is', () => {
    const mil = must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 10, 20)) }).replace('unitdist="inch" unit="inch"', 'unitdist="mil" unit="mil"'));
    expect(mil.sourceUnit).toBe('mm'); point(symbolOf(mil, 'R1:G$1').at, 10, -20);
  });
});

describe('multi-pad pins', () => {
  const s = must(document({ parts: part('U2', 'EPIC', 'QFN'), sheets: sheet(inst('U2', 'G$1', 0, 0), net('GND', pinref('U2', 'G$1', 'GND')) + net('VIN', pinref('U2', 'G$1', 'VIN'))) }));
  it('emits one pin per pad at the same position and reports it explicitly', () => {
    const u = symbolOf(s, 'U2:G$1');
    expect(u.pins.map(p => [p.number, p.name, p.hidden])).toEqual([['1', 'VIN', false], ['2', 'GND', false], ['EP', 'GND', true], ['9', 'GND', true]]);
    expect(pinOf(u, 'EP').at).toEqual(pinOf(u, '2').at); expect(u.pins.map(p => p.id)).toEqual(['U2:G$1#1', 'U2:G$1#2', 'U2:G$1#EP', 'U2:G$1#9']);
    expect(s.diagnostics.find(d => d.code === 'PIN_MULTI_PAD')?.message).toContain('2, EP, 9');
  });
  it('declares every pad of the pin in its net', () => {
    expect(s.declaredNets?.find(n => n.name === 'GND')?.pins.map(p => p.pinId)).toEqual(['U2:G$1#2', 'U2:G$1#EP', 'U2:G$1#9']);
  });
  it('deduplicates identical connect rows with a diagnostic so pin ids stay unique (B38)', () => {
    const rows = (...items: Array<[string, string, string]>) => TEST_LIB.replace(connects(['G$1', 'P1', '1'], ['G$1', 'P2', '2']), connects(...items));
    const run = (library: string) => must(document({ libraries: library + SUPPLY_LIB, parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('N', pinref('R1', 'G$1', 'P1'))) }));
    const control = run(rows(['G$1', 'P1', '1'], ['G$1', 'P2', '2']));
    const dup = run(rows(['G$1', 'P1', '1'], ['G$1', 'P1', '1'], ['G$1', 'P2', '2']));
    expect(dup.defs[0].symbols[0].pins.map(p => p.id)).toEqual(['R1:G$1#1', 'R1:G$1#2']); expect(dup.declaredNets).toEqual(control.declaredNets);
    expect(codes(dup).filter(c => c === 'CONNECT_DUPLICATE')).toHaveLength(1); expect(codes(control)).not.toContain('CONNECT_DUPLICATE');
    // a pad repeated inside one row is the same duplicate
    expect(run(rows(['G$1', 'P1', '1 1'], ['G$1', 'P2', '2'])).defs[0].symbols[0].pins.map(p => p.id)).toEqual(['R1:G$1#1', 'R1:G$1#2']);
    // the same pin listed in several rows with different pads is disclosed and merged, still one pin per pad
    const split = run(rows(['G$1', 'P1', '1'], ['G$1', 'P1', '3'], ['G$1', 'P2', '2']));
    expect(split.defs[0].symbols[0].pins.map(p => [p.id, p.hidden])).toEqual([['R1:G$1#1', false], ['R1:G$1#3', true], ['R1:G$1#2', false]]);
    expect(codes(split)).toContain('CONNECT_REPEATED_PIN'); expect(split.declaredNets?.[0].pins.map(p => p.pinId)).toEqual(['R1:G$1#1', 'R1:G$1#3']);
    // conflicting: the same pad on two different pins keeps the first
    const clash = run(rows(['G$1', 'P1', '1'], ['G$1', 'P2', '1']));
    expect(codes(clash)).toContain('PAD_DUPLICATE'); expect(clash.defs[0].symbols[0].pins.map(p => p.id)).toEqual(['R1:G$1#1']);
    for (const result of [dup, split, clash]) { const ids = result.defs[0].symbols[0].pins.map(p => p.id); expect(new Set(ids).size).toBe(ids.length); }
  });
  it('ignores a later claim on an already connected pad instead of guessing', () => {
    const clash = TEST_LIB.replace(connects(['G$1', 'VIN', '1'], ['G$1', 'GND', '2 EP 9']), connects(['G$1', 'VIN', '1'], ['G$1', 'GND', '2 EP 1']));
    const c = must(document({ libraries: clash + SUPPLY_LIB, parts: part('U2', 'EPIC', 'QFN'), sheets: sheet(inst('U2', 'G$1', 0, 0)) }));
    expect(codes(c)).toContain('PAD_DUPLICATE'); expect(symbolOf(c, 'U2:G$1').pins.map(p => p.number)).toEqual(['1', '2', 'EP']);
  });
});

describe('dangling references and duplicates', () => {
  const lib = (name: string) => part('Q1', 'R', '0805', '', name);
  it('keeps a pin-less symbol and reports each dangling library reference once', () => {
    const s = must(document({
      parts: [part('A1', 'R', '0805', '', 'nolib'), part('A2', 'R', '0805', '', 'nolib'), part('B1', 'NODS', ''), part('C1', 'R', 'NODEVICE'), part('D1', 'NOSYM', ''), part('E1', 'R', '0805')].join(''),
      sheets: sheet([inst('A1', 'G$1', 0, 0), inst('A2', 'G$1', 0, 5), inst('B1', 'G$1', 5, 0), inst('C1', 'G$1', 10, 0), inst('D1', 'G$1', 15, 0), inst('E1', 'G$9', 20, 0)].join(''), net('N', pinref('A1', 'G$1', 'P1') + pinref('E1', 'G$1', 'P1'))),
    }));
    expect(s.defs[0].symbols.map(x => [x.id, x.pins.length])).toEqual([['A1:G$1', 0], ['A2:G$1', 0], ['B1:G$1', 0], ['C1:G$1', 0], ['D1:G$1', 0], ['E1:G$9', 0]]);
    expect(codes(s).filter(c => c === 'LIBRARY_MISSING')).toHaveLength(1);
    for (const code of ['DEVICESET_MISSING', 'DEVICE_MISSING', 'SYMBOL_MISSING', 'GATE_MISSING']) expect(codes(s), code).toContain(code);
    expect(s.diagnostics.filter(d => d.code.endsWith('_MISSING')).every(d => d.severity === 'error')).toBe(true);
    for (const x of s.defs[0].symbols) expect(x.bounds).toEqual({ minX: x.at.x, minY: x.at.y, maxX: x.at.x, maxY: x.at.y });
    expect(s.declaredNets).toEqual([{ name: 'N', pins: [], wires: [] }]); expect(codes(s).filter(c => c === 'PINREF_UNRESOLVED')).toHaveLength(2);
  });
  it('omits a pin that has no pad in the device connects and reports PIN_NO_PAD', () => {
    const s = must(document({ parts: part('R1', 'R', 'HALF'), sheets: sheet(inst('R1', 'G$1', 0, 0), net('N', pinref('R1', 'G$1', 'P1') + pinref('R1', 'G$1', 'P2'))) }));
    expect(symbolOf(s, 'R1:G$1').pins.map(p => [p.number, p.name])).toEqual([['1', 'P1']]);
    const note = s.diagnostics.find(d => d.code === 'PIN_NO_PAD'); expect(note).toMatchObject({ severity: 'warning' }); expect(note?.message).toContain('G$1.P2');
    expect(codes(s)).toContain('PINREF_UNRESOLVED'); expect(s.declaredNets?.[0].pins).toHaveLength(1);
  });
  it('reports each PIN_NO_PAD once per device, not once per placement', () => {
    const s = must(document({ parts: part('R1', 'R', 'HALF') + part('R2', 'R', 'HALF'), sheets: sheet(inst('R1', 'G$1', 0, 0) + inst('R2', 'G$1', 9, 0)) }));
    expect(codes(s).filter(c => c === 'PIN_NO_PAD')).toHaveLength(1);
  });
  it('reports duplicate parts, duplicate placements and instances of undeclared parts', () => {
    const s = must(document({ parts: part('R1', 'R', '0805', ' value="first"') + part('R1', 'R', '0805', ' value="second"'), sheets: sheet(inst('R1', 'G$1', 0, 0) + inst('R1', 'G$1', 9, 9) + inst('R5', 'G$1', 3, 3)) }));
    expect(codes(s)).toEqual(expect.arrayContaining(['PART_DUPLICATE', 'INSTANCE_DUPLICATE', 'INSTANCE_UNKNOWN_PART']));
    expect(s.defs[0].symbols).toHaveLength(1); expect(s.defs[0].symbols[0].value).toBe('first'); point(s.defs[0].symbols[0].at, 0, 0);
    expect(codes(must(document({ parts: lib('test'), sheets: sheet('') })))).toContain('PART_NOT_PLACED');
  });
  it('flags unknown connect targets', () => {
    const odd = TEST_LIB.replace(connects(['G$1', 'P1', '1'], ['G$1', 'P2', '2']), connects(['G$1', 'P1', '1'], ['G$1', 'P2', '2'], ['G$7', 'P1', '3'], ['G$1', 'P9', '4']));
    const s = must(document({ libraries: odd + SUPPLY_LIB, parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0)) }));
    expect(codes(s)).toEqual(expect.arrayContaining(['CONNECT_UNKNOWN_GATE', 'CONNECT_UNKNOWN_PIN'])); expect(symbolOf(s, 'R1:G$1').pins.map(p => p.number)).toEqual(['1', '2']);
  });
  it('lets an unused or unreadable library item not fail the import', () => {
    const broken = TEST_LIB.replace('</symbols>', '<symbol name="UNUSED"><pin name="X" x="oops" y="0"/></symbol></symbols>');
    expect(must(document({ libraries: broken + SUPPLY_LIB, parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0)) })).defs[0].symbols).toHaveLength(1);
    const used = TEST_LIB.replace('<pin name="P1" x="-5.08"', '<pin name="P1" x="oops"');
    expect(thrown(() => parse(document({ libraries: used + SUPPLY_LIB, parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0)) }))).code).toBe('INVALID_FORMAT');
  });
});

describe('modules, variants, versions and attributes', () => {
  it('does not support modules: warns, keeps the sheet, invents no connectivity', () => {
    const s = must(document({
      parts: part('R1', 'R', '0805'),
      extra: `<modules><module name="PSU" prefix="PSU_" dx="30" dy="20"><ports><port name="VIN" side="left" coord="5" direction="in"/></ports><parts/><sheets><sheet><instances/><nets/></sheet></sheets></module></modules>`,
      sheets: sheet(inst('R1', 'G$1', 10, 10), net('N', pinref('R1', 'G$1', 'P1') + `<portref moduleinst="X" port="VIN"/>`), '<moduleinsts><moduleinst name="X" module="PSU" x="40" y="40"/></moduleinsts>'),
    }));
    expect(codes(s).filter(c => c === 'UNSUPPORTED_MODULES')).toHaveLength(2); expect(s.diagnostics.filter(d => d.code === 'UNSUPPORTED_MODULES').every(d => d.severity === 'warning')).toBe(true);
    expect(s.defs).toHaveLength(1); expect(s.defs[0].symbols).toHaveLength(1); expect(s.instances).toHaveLength(1); expect(s.declaredNets?.[0].pins).toHaveLength(1);
  });
  it('applies the current assembly variant (populate="no" -> dnp, value override)', () => {
    const variants = '<variantdefs><variantdef name="LITE" current="yes"/><variantdef name="FULL"/></variantdefs>';
    const s = must(document({
      parts: `<part name="R1" library="test" deviceset="R" device="0805" value="10k"><variant name="LITE" populate="no"/></part><part name="R2" library="test" deviceset="R" device="0805" value="10k"><variant name="LITE" value="22k"/><variant name="FULL" populate="no"/></part>`,
      sheets: sheet(inst('R1', 'G$1', 0, 0) + inst('R2', 'G$1', 9, 0)),
    }).replace('<variantdefs/>', variants));
    expect([symbolOf(s, 'R1:G$1').dnp, symbolOf(s, 'R1:G$1').value]).toEqual([true, '10k']); expect([symbolOf(s, 'R2:G$1').dnp, symbolOf(s, 'R2:G$1').value]).toEqual([false, '22k']);
    expect(must(document({ parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0)) })).defs[0].symbols[0].dnp).toBe(false);
  });
  it('notes the file version and parses the supported EAGLE XML generations the same way', () => {
    const base = { parts: part('R1', 'R', '0805', ' value="10k"'), sheets: sheet(inst('R1', 'G$1', 5, 5), net('N', pinref('R1', 'G$1', 'P1'))) };
    const reference = must(document({ ...base, version: '9.6.2' }));
    for (const version of ['6.5.0', '7.7.0', '8.3.2', '9.7.0']) {
      const s = must(document({ ...base, version })); expect(s.formatLabel).toBe(`EAGLE schematic (version ${version})`);
      expect({ ...s, formatLabel: '' }).toEqual({ ...reference, formatLabel: '' });
    }
    expect(codes(reference)).not.toContain('VERSION_UNKNOWN');
    expect(codes(must(document({ ...base, version: '5.12.0' })))).toContain('VERSION_UNKNOWN');
    expect(must(document({ ...base }).replace(' version="9.6.2"', '')).formatLabel).toBe('EAGLE schematic'); expect(codes(must(document({ ...base }).replace(' version="9.6.2"', '')))).toContain('VERSION_MISSING');
  });
  it('keeps part attributes, technology and the library urn disambiguation', () => {
    const s = must(document({
      parts: `<part name="R1" library="test" deviceset="R" device="0805" technology="LF" value="10k"><attribute name="MPN" value="RC0805" display="off"/><attribute name="TOL" value="1%" display="value"/></part>`,
      sheets: sheet(inst('R1', 'G$1', 0, 0)),
    }));
    expect(symbolOf(s, 'R1:G$1').fields).toEqual([{ name: 'Reference', value: 'R1', hidden: false }, { name: 'Value', value: '10k', hidden: false }, { name: 'Technology', value: 'LF', hidden: true },
      { name: 'MPN', value: 'RC0805', hidden: true }, { name: 'TOL', value: '1%', hidden: false }]);
    const twin = `<library name="test" urn="urn:x:two"><symbols/><devicesets/></library>`;
    const t = must(document({ libraries: twin + TEST_LIB, parts: part('R1', 'R', '0805'), sheets: sheet(inst('R1', 'G$1', 0, 0)) }));
    expect(codes(t)).toContain('LIBRARY_AMBIGUOUS');
  });
  it('selects between same-named libraries by library_urn without guessing', () => {
    const urnA = 'urn:test:library:a', urnB = 'urn:test:library:b';
    const libraries = `<library name="test" urn="${urnA}"><symbols/><devicesets/></library>` + TEST_LIB.replace('<library name="test">', `<library name="test" urn="${urnB}">`);
    const ok = must(document({ libraries, parts: part('R1', 'R', '0805', ` library_urn="${urnB}"`), sheets: sheet(inst('R1', 'G$1', 0, 0)) }));
    expect(codes(ok)).not.toContain('LIBRARY_AMBIGUOUS'); expect(symbolOf(ok, 'R1:G$1').pins.map(p => p.number)).toEqual(['1', '2']);
    const wrong = must(document({ libraries, parts: part('R1', 'R', '0805', ` library_urn="${urnA}"`), sheets: sheet(inst('R1', 'G$1', 0, 0)) }));
    expect(codes(wrong)).toContain('DEVICESET_MISSING'); expect(symbolOf(wrong, 'R1:G$1').pins).toEqual([]);
  });
  it('caps the diagnostics list and says so', () => {
    const many = must(document({ sheets: sheet(Array.from({ length: 2500 }, (_, i) => inst(`Z${i}`, 'G$1', 0, 0)).join('')) }));
    expect(many.diagnostics.length).toBeLessThanOrEqual(2001); expect(many.diagnostics.at(-1)?.code).toBe('DIAGNOSTICS_TRUNCATED');
  });
});

describe('graphics and text', () => {
  it('places smashed NAME/VALUE texts at their own absolute positions and honours display="off"', () => {
    const attrs = `<attribute name="NAME" x="60" y="80" size="1.27" layer="95" rot="R90"/><attribute name="VALUE" x="60" y="70" size="1.27" layer="96" display="off"/><attribute name="MPN" x="61" y="71" size="1.0" layer="96" display="both"/>`;
    const s = must(document({
      parts: `<part name="R1" library="test" deviceset="R" device="0805" value="10k"><attribute name="MPN" value="RC0805"/></part>`,
      sheets: `<sheet><instances><instance part="R1" gate="G$1" x="50.8" y="76.2" smashed="yes">${attrs}</instance></instances></sheet>`,
    }));
    const texts = symbolOf(s, 'R1:G$1').graphics.filter((g): g is Extract<typeof g, { kind: 'text' }> => g.kind === 'text');
    expect(texts.map(t => t.text)).toEqual(['R1', 'MPN: RC0805']); point(texts[0].at, 60, -80); expect(texts[0].angle).toBe(90); point(texts[1].at, 61, -71);
  });
  it('converts circles, polygons (with curved edges), rotated rectangles, frames and sheet texts', () => {
    const lib = `<library name="g"><symbols><symbol name="S"><circle x="0" y="0" radius="2" width="0.254" layer="94"/><circle x="1" y="1" radius="0.5" width="0" layer="94"/>
<polygon width="0.1" layer="94"><vertex x="0" y="0"/><vertex x="4" y="0" curve="90"/><vertex x="4" y="4"/></polygon><rectangle x1="0" y1="0" x2="4" y2="2" layer="94" rot="R45"/>
<frame x1="-10" y1="-5" x2="10" y2="5" columns="4" rows="3" layer="94"/><pin name="1" x="0" y="0" length="point" direction="pas"/></symbol></symbols>
<devicesets><deviceset name="D"><gates><gate name="G$1" symbol="S" x="0" y="0"/></gates><devices><device name="" package="P">${connects(['G$1', '1', '1'])}</device></devices></deviceset></devicesets></library>`;
    const plain = `<plain><wire x1="0" y1="0" x2="5" y2="0" width="0.1" layer="97"/><text x="1" y="2" size="1.778" layer="97">Note &amp; more</text><text x="0" y="0" size="1.778" layer="94">&gt;DRAWING_NAME</text><text x="0" y="1" size="1" layer="94">&gt;SHEET</text><text x="0" y="2" size="1" layer="94">&gt;LAST_DATE_TIME</text></plain>`;
    const s = must(document({ libraries: lib, parts: part('X1', 'D', '', '', 'g'), sheets: sheet(inst('X1', 'G$1', 10, 10, 'R90'), '', plain) }));
    const kinds = symbolOf(s, 'X1:G$1').graphics.map(g => g.kind); expect(kinds).toEqual(['poly', 'circle', 'circle', 'poly', 'rect']); // rectangle, circles, polygon, frame
    const [rotated, ring, disc, poly] = symbolOf(s, 'X1:G$1').graphics;
    expect(ring).toMatchObject({ kind: 'circle', radius: 2, fill: 'none', width: 0.254 }); expect(disc).toMatchObject({ kind: 'circle', fill: 'outline' }); point((disc as { center: { x: number; y: number } }).center, 9, -11);
    if (poly.kind !== 'poly' || rotated.kind !== 'poly') throw new Error('poly expected');
    expect(poly.filled).toBe(true); expect(poly.points.length).toBeGreaterThan(4); point(poly.points[0], 10, -10); expect(rotated.filled).toBe(true); expect(rotated.points).toHaveLength(5);
    const frame = symbolOf(s, 'X1:G$1').graphics[4]; expect(frame).toMatchObject({ kind: 'rect', fill: 'none' });
    if (frame.kind === 'rect') { point(frame.min, 5, -20); point(frame.max, 15, 0); }
    expect(s.defs[0].graphics.map(g => g.kind === 'text' ? g.text : g.kind)).toEqual(['poly', 'Note & more', 'test', '1/1']);
  });
});

describe('minimal regression fixtures (B37/B38 reproductions)', () => {
  const twoSheets = `<?xml version="1.0" encoding="utf-8"?><eagle version="9.6.2"><drawing><schematic><libraries><library name="tiny"><symbols><symbol name="POINT"><pin name="P" x="0" y="0" length="point" direction="pas"/></symbol></symbols><devicesets><deviceset name="DUAL"><gates><gate name="A" symbol="POINT" x="0" y="0"/><gate name="B" symbol="POINT" x="0" y="0"/></gates><devices><device name="" package="TWO"><connects><connect gate="A" pin="P" pad="1"/><connect gate="B" pin="P" pad="2"/></connects></device></devices></deviceset></devicesets></library></libraries><parts><part name="U1" library="tiny" deviceset="DUAL" device="" value="DUAL"/></parts><sheets><sheet><instances><instance part="U1" gate="A" x="10" y="20"/></instances><nets><net name="SIG" class="0"><segment><pinref part="U1" gate="A" pin="P"/><wire x1="10" y1="20" x2="15" y2="20" width="0.15" layer="91"/></segment><segment><wire x1="30" y1="20" x2="35" y2="20" width="0.15" layer="91"/></segment></net></nets></sheet><sheet><instances><instance part="U1" gate="B" x="40" y="20"/></instances><nets><net name="SIG" class="0"><segment><pinref part="U1" gate="B" pin="P"/><wire x1="40" y1="20" x2="45" y2="20" width="0.15" layer="91"/></segment></net><net name="ONLY_WIRE" class="0"><segment><wire x1="60" y1="20" x2="65" y2="20" width="0.15" layer="91"/><label x="60" y="20" size="1" layer="95"/></segment></net></nets></sheet></sheets></schematic></drawing></eagle>`;
  const duplicateRow = `<?xml version="1.0" encoding="utf-8"?><eagle version="9.6.2"><drawing><schematic><libraries><library name="tiny"><symbols><symbol name="POINT"><pin name="P" x="0" y="0" length="point" direction="pas"/></symbol></symbols><devicesets><deviceset name="DUAL"><gates><gate name="A" symbol="POINT" x="0" y="0"/><gate name="B" symbol="POINT" x="0" y="0"/></gates><devices><device name="" package="TWO"><connects><connect gate="A" pin="P" pad="1"/><connect gate="A" pin="P" pad="1"/><connect gate="B" pin="P" pad="2"/></connects></device></devices></deviceset></devicesets></library></libraries><parts><part name="U1" library="tiny" deviceset="DUAL" device="" value="DUAL"/></parts><sheets><sheet><instances><instance part="U1" gate="A" x="0" y="0"/></instances><nets><net name="N" class="0"><segment><pinref part="U1" gate="A" pin="P"/></segment></net></nets></sheet></sheets></schematic></drawing></eagle>`;
  it('B37: keeps the disconnected SIG segment and the pinless labelled ONLY_WIRE net', () => {
    const s = must(twoSheets);
    expect(s.declaredNets?.map(n => [n.name, n.pins.map(p => p.pinId), n.wires?.map(w => `${w.defId}/${w.wireId}`)])).toEqual([
      ['SIG', ['U1:A#1', 'U1:B#2'], ['sheet:1/w1', 'sheet:1/w2', 'sheet:2/w1']], ['ONLY_WIRE', [], ['sheet:2/w2']]]);
    expect(s.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
  });
  it('B38: two identical connect rows give one pin id and a diagnostic', () => {
    const s = must(duplicateRow);
    expect(s.defs[0].symbols[0].pins.map(p => p.id)).toEqual(['U1:A#1']); expect(codes(s)).toContain('CONNECT_DUPLICATE');
    expect(s.declaredNets).toEqual([{ name: 'N', pins: [{ instancePath: 'sheet:1', defId: 'sheet:1', symbolId: 'U1:A', pinId: 'U1:A#1' }], wires: [] }]);
  });
});
