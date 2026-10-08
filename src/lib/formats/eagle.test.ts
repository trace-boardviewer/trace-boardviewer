import { describe, expect, it } from 'vitest';
import { BoardFormatError, MAX_IMPORT_BYTES, textInput } from './common';
import { parseEagle } from './eagle';
import { catching, expectScaling } from '../../test-support/timing';

// Original synthetic EAGLE XML written from the public eagle.dtd / Fusion ECAD ULP documentation; no vendor files.
const DECLARATION = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n';
const LAYERS = '<layers><layer number="1" name="Top" color="4" fill="1" visible="yes" active="yes"/><layer number="16" name="Bottom" color="1" fill="1" visible="yes" active="yes"/><layer number="20" name="Dimension" color="15" fill="1" visible="yes" active="yes"/><layer number="21" name="tPlace" color="7" fill="1" visible="yes" active="yes"/></layers>';
const wire = (x1: number, y1: number, x2: number, y2: number, layer = 20, curve?: number) => `<wire x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" width="0" layer="${layer}"${curve === undefined ? '' : ` curve="${curve}"`}/>`;
const dimension = (x0: number, y0: number, x1: number, y1: number) => [wire(x0, y0, x1, y0), wire(x1, y0, x1, y1), wire(x1, y1, x0, y1), wire(x0, y1, x0, y0)].join('');
const smd = (name: string, x: number, y: number, dx: number, dy: number, extra = '') => `<smd name="${name}" x="${x}" y="${y}" dx="${dx}" dy="${dy}" layer="1"${extra ? ` ${extra}` : ''}/>`;
const pad = (name: string, x: number, y: number, extra = 'diameter="1.6"') => `<pad name="${name}" x="${x}" y="${y}" drill="0.8" ${extra}/>`;
const pkg = (name: string, body: string, attrs = '') => `<package name="${name}"${attrs}>${body}</package>`;
const library = (name: string, packages: string, attrs = '') => `<library name="${name}"${attrs}><packages>${packages}</packages></library>`;
const element = (name: string, packageName: string, x: number, y: number, rot = '', extra = 'library="lib"') => `<element name="${name}" ${extra} package="${packageName}" value="10k" x="${x}" y="${y}"${rot ? ` rot="${rot}"` : ''}/>`;
const contactrefs = (...refs: Array<[string, string]>) => refs.map(([e, p]) => `<contactref element="${e}" pad="${p}"/>`).join('');
const signal = (name: string, refs: string) => `<signal name="${name}" class="0">${refs}</signal>`;
const RESISTOR = pkg('R0603', `${smd('1', -1, 0, 1, 1)}${smd('2', 1, 0, 1, 1)}`);
interface Doc { libraries?: string; elements?: string; signals?: string; plain?: string; prolog?: string; drawing?: string }
const doc = ({ libraries = library('lib', RESISTOR), elements = element('R1', 'R0603', 10, 20), signals = '', plain = dimension(0, 0, 40, 30), prolog = DECLARATION, drawing }: Doc = {}) =>
  `${prolog}<eagle version="9.6.2"><drawing><settings><setting alwaysvectorfont="no"/></settings>${LAYERS}${drawing ?? `<board><plain>${plain}</plain><libraries>${libraries}</libraries><elements>${elements}</elements><signals>${signals}</signals></board>`}</drawing></eagle>`;
const parse = (text: string, name = 'synthetic.brd') => { const board = parseEagle(textInput(text, name)); if (!board) throw new Error('unexpectedly unrecognized'); return board; };
const warningKeys = (b: { warnings: { key: string }[] }) => b.warnings.map(w => w.key);
const notes = (b: { warnings: { key: string; params?: Record<string, unknown> }[] }) => b.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
const near = (actual: Record<string, number>, expected: Record<string, number>) => { for (const [key, value] of Object.entries(expected)) expect(actual[key], key).toBeCloseTo(value, 9); };
const codeOf = (action: () => unknown) => { try { action(); } catch (error) { return error instanceof BoardFormatError ? error.code : `other:${String(error)}`; } return 'none'; };

describe('EAGLE board XML: recognition (bytes, not extension)', () => {
  it('reads a board with declaration and DOCTYPE', () => {
    const b = parse(doc());
    expect(b.format).toBe('EAGLE board (XML)'); expect(b.units).toBe('mm'); expect(b.name).toBe('synthetic');
    expect(b.components).toHaveLength(1); expect(b.pins).toHaveLength(2); expect(b.outline).toHaveLength(4);
    near(b.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 30 });
  });
  it('recognizes a bare <eagle> root without declaration, comment-prefixed, DOCTYPE-prefixed, BOM-prefixed and whitespace-prefixed documents', () => {
    for (const prolog of ['', '  \n', '<!-- exported by a synthetic generator -->\n', '<!-- <svg> -->\n<!-- second -->', '<!DOCTYPE eagle SYSTEM "eagle.dtd">', '<?xml version="1.0"?><!-- c --><!DOCTYPE eagle SYSTEM "eagle.dtd"><?pi data?>\n', '<!DOCTYPE eagle [ <!ELEMENT eagle ANY> ]>', '﻿<?xml version="1.0"?>']) {
      expect(parse(doc({ prolog })).pins, JSON.stringify(prolog)).toHaveLength(2);
    }
    expect(parseEagle({ name: 'utf16.brd', data: Uint8Array.from([0xff, 0xfe, ...[...doc({ prolog: '' })].flatMap(c => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]) })?.pins).toHaveLength(2);
  });
  it('returns null (not this format) for an EAGLE schematic, with or without prolog, without parsing the whole file', () => {
    const schematic = (prolog: string) => `${prolog}<eagle version="9.6.2"><drawing><settings/>${LAYERS}<schematic xreflabel="%F%N/%S.%C%R" xrefpart="/%S.%C%R"><libraries/><attributes/><variantdefs/><classes/><parts/><sheets><sheet><plain/><instances/><busses/><nets/></sheet></sheets></schematic></drawing></eagle>`;
    expect(parseEagle(textInput(schematic(DECLARATION), 'x.sch'))).toBeNull();
    expect(parseEagle(textInput(schematic(''), 'x.brd'))).toBeNull();
    expect(parseEagle(textInput(schematic('<!-- c -->'), 'x.brd'))).toBeNull();
  });
  it('returns null for non-EAGLE XML and non-XML, including an <eagle> mention in a comment, attribute or later element', () => {
    for (const text of ['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><!-- <eagle> --></svg>', '<IPC-2581 revision="C"><Content/></IPC-2581>', '<?xml version="1.0"?><root><eagle version="9"/></root>', '<?xml version="1.0"?><notes title="<eagle>"/>',
      '$HEADER\nGENCAD 1.4', '(kicad_pcb (version 20240108))', '', '   ', '<', '<?xml', '<!-- unterminated', '<!DOCTYPE', '<!DOCTYPE eagle [', 'eagle', '<eagleboard/>', '{"eagle":true}']) {
      expect(parseEagle(textInput(text)), text).toBeNull();
    }
  });
  it('throws a recognized-but-wrong-kind error for an EAGLE library and an error for an <eagle> without a drawing or board', () => {
    expect(() => parse(doc({ drawing: '<library name="x"><packages/></library>' }))).toThrow(expect.objectContaining({ code: 'WRONG_KIND', format: 'EAGLE library' }));
    expect(() => parse(doc({ drawing: '' }))).toThrow(/no <board> element/);
    expect(() => parse('<eagle version="9"></eagle>')).toThrow(/no <drawing> element/);
    expect(() => parse(`${DECLARATION}<eagle>`)).toThrow(expect.objectContaining({ code: 'INVALID_FORMAT' }));
  });
  it('throws on a second <board> or <elements> section instead of silently ignoring one', () => {
    expect(() => parse(doc({ drawing: '<board><plain/><libraries/><elements/></board><board><plain/></board>' }))).toThrow(/more than one <board>/);
    expect(() => parse(doc({ drawing: '<board><plain/><libraries/><elements/><elements/></board>' }))).toThrow(/more than one <elements>/);
  });
});

describe('EAGLE board XML: XML safety', () => {
  it('rejects DOCTYPE ENTITY declarations with BoardFormatError and never expands them (billion laughs, external, parameter entities)', () => {
    const laughs = '<!DOCTYPE eagle [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>';
    for (const prolog of [laughs, '<!DOCTYPE eagle [<!ENTITY x SYSTEM "file:///etc/passwd">]>', '<!DOCTYPE eagle [<!ENTITY % p "x">]>', `${DECLARATION.replace(/<!DOCTYPE.*>\n/, '')}<!DOCTYPE eagle [ <!ENTITY y "z"> ]>`]) {
      expect(() => parse(doc({ prolog })), prolog).toThrow(BoardFormatError);
      expect(codeOf(() => parse(doc({ prolog })))).toBe('INVALID_FORMAT');
    }
    expect(() => parse(doc({ prolog: laughs }))).toThrow(/entit/i);
    // A non-EAGLE document with entities is not parsed at all.
    expect(parseEagle(textInput('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "x">]><svg>&a;</svg>'))).toBeNull();
  });
  it('decodes only the five predefined entities and numeric references; undeclared names stay literal', () => {
    const b = parse(doc({ elements: element('R1', 'R0603', 10, 20).replace('value="10k"', 'value="&lt;4&gt; &amp;&quot;&apos; &#x41;&#66; &foo; &amp;lt;"') }));
    expect(b.components[0].value).toBe('<4> &"\' AB &foo; &lt;');
  });
  it('bounds nesting depth, tag count and component count before they cost memory', () => {
    const deep = `${'<a>'.repeat(100)}${'</a>'.repeat(100)}`;
    expect(codeOf(() => parse(doc({ drawing: `<board>${deep}</board>` })))).toBe('LIMIT_EXCEEDED');
    expect(codeOf(() => parse(doc({ drawing: `<board><plain>${'<a/>'.repeat(3_000_001)}</plain></board>` })))).toBe('LIMIT_EXCEEDED');
    const many = Array.from({ length: 250_001 }, (_, index) => `<element name="E${index}" library="l" package="p" x="0" y="0"/>`).join('');
    expect(codeOf(() => parse(doc({ drawing: `<board><plain/><libraries/><elements>${many}</elements></board>` })))).toBe('LIMIT_EXCEEDED');
    expect(codeOf(() => parseEagle({ name: 'big.brd', data: { length: MAX_IMPORT_BYTES + 1 } as unknown as Uint8Array }))).toBe('LIMIT_EXCEEDED');
  });
  it('wraps malformed XML in a recognized-format error', () => {
    expect(() => parse(doc().replace('</board>', ''))).toThrow(expect.objectContaining({ code: 'INVALID_FORMAT', format: 'EAGLE board (XML)' }));
    expect(() => parse(doc().replace('<drawing>', '<drawing><wire'))).toThrow(BoardFormatError);
    // A truncated download must not load as a smaller board.
    const whole = doc({ elements: `${element('R1', 'R0603', 0, 0)}${element('R2', 'R0603', 5, 0)}` });
    for (const cut of [whole.indexOf('<element name="R2"') + 20, whole.indexOf('</elements>'), whole.length - 12]) expect(() => parse(whole.slice(0, cut)), String(cut)).toThrow(expect.objectContaining({ code: 'INVALID_FORMAT' }));
  });
});

describe('EAGLE board XML: placement, rotation and mirror', () => {
  const rotatable = pkg('P', `${smd('A', 2, 1, 1, 0.5)}${smd('B', -2, -1, 1, 0.5, 'rot="R30"')}<smd name="C" x="0" y="0" dx="1" dy="1" layer="16"/>`);
  const place = (rot: string) => parse(doc({ libraries: library('lib', rotatable), elements: element('U1', 'P', 10, 20, rot) }));
  it('R0 keeps mm coordinates; positive R angles rotate counter-clockwise about the element origin', () => {
    const b = place('R0'); expect(b.pins[0]).toMatchObject({ x: 12, y: 21, rotation: 0, side: 'top', width: 1, height: 0.5, shape: 'rect' });
    expect(b.pins[1]).toMatchObject({ x: 8, y: 19, rotation: 30 }); expect(b.components[0]).toMatchObject({ side: 'top', rotation: 0, position: { x: 10, y: 20 } });
    const r90 = place('R90'); expect(r90.pins[0].x).toBeCloseTo(9, 9); expect(r90.pins[0].y).toBeCloseTo(22, 9); expect(r90.pins[0].rotation).toBe(90); expect(r90.pins[1].rotation).toBe(120);
    const r180 = place('R180'); expect(r180.pins[0].x).toBeCloseTo(8, 9); expect(r180.pins[0].y).toBeCloseTo(19, 9);
    const negative = place('R-90'); expect(negative.components[0].rotation).toBe(270); expect(negative.pins[0].x).toBeCloseTo(11, 9); expect(negative.pins[0].y).toBeCloseTo(18, 9);
  });
  it('MR0 mirrors about the package Y axis and puts the element on the bottom; layer 1 pads follow, layer 16 pads go to the top', () => {
    const b = place('MR0');
    expect(b.components[0]).toMatchObject({ side: 'bottom', rotation: 0 });
    expect(b.pins[0]).toMatchObject({ x: 8, y: 21, side: 'bottom', rotation: 0 }); expect(b.pins[1]).toMatchObject({ x: 12, y: 19, side: 'bottom', rotation: 330 });
    expect(b.pins[2]).toMatchObject({ x: 10, y: 20, side: 'top' });
  });
  it('MR90 mirrors first and rotates the mirrored element counter-clockwise; S (spin) does not change geometry', () => {
    const b = place('MR90');
    expect(b.pins[0].x).toBeCloseTo(9, 9); expect(b.pins[0].y).toBeCloseTo(18, 9); expect(b.pins[0].rotation).toBe(90); expect(b.pins[1].rotation).toBe(60);
    for (const [rot, side, y] of [['SR90', 'top', 22], ['SMR90', 'bottom', 18], ['MSR90', 'bottom', 18]] as const) {
      const spun = place(rot); expect(spun.components[0].side, rot).toBe(side); expect(spun.pins[0].x, rot).toBeCloseTo(9, 9); expect(spun.pins[0].y, rot).toBeCloseTo(y, 9);
    }
  });
  it('rejects malformed rot attributes and trims surrounding whitespace', () => {
    for (const rot of ['R', 'X90', 'R9o', 'MMR0', 'RM90', '90']) expect(() => place(rot), rot).toThrow(/invalid rot attribute/);
    expect(place('R90 ').components[0].rotation).toBe(90);
  });
  it('mirrored elements keep the physical meaning of SMD layers: layer 1 on a mirrored element is the bottom side', () => {
    const only = (layer: string) => parse(doc({ libraries: library('lib', pkg('P', `<smd name="1" x="0" y="0" dx="1" dy="1" layer="${layer}"/>`)), elements: element('U1', 'P', 0, 0, 'MR0') }));
    expect(only('1').pins[0].side).toBe('bottom'); expect(only('16').pins[0].side).toBe('top');
  });
});

describe('EAGLE board XML: pad and package records', () => {
  it('reads SMD and through-hole pad shapes: real round/square/rect, approximated octagon/long/offset, size-less pads disclosed', () => {
    const body = [pad('1', 0, 0), pad('2', 2, 0, 'diameter="1.6" shape="square"'), pad('3', 4, 0, 'diameter="1.6" shape="octagon"'), pad('4', 6, 0, 'diameter="1.6" shape="long"'), pad('5', 8, 0, 'diameter="1.6" shape="offset"'), pad('6', 10, 0, ''), smd('7', 12, 0, 2, 1)].join('');
    const b = parse(doc({ libraries: library('lib', pkg('P', body)), elements: element('U1', 'P', 0, 0) }));
    expect(b.pins.map(p => [p.number, p.shape, p.side, p.width, p.radius])).toEqual([
      ['7', 'rect', 'top', 2, 0.5], ['1', 'round', 'both', 1.6, 0.8], ['2', 'square', 'both', 1.6, 0.8], ['3', 'rect', 'both', 1.6, 0.8], ['4', 'rect', 'both', 1.6, 0.8], ['5', 'rect', 'both', 1.6, 0.8], ['6', 'round', 'both', undefined, 0],
    ]);
    expect(b.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 3 } });
    expect(b.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 1 } });
  });
  it('rejects bad pad records: unknown shape, missing drill, non-positive SMD size, unsupported SMD layer, duplicate pad names, mirrored package SMD', () => {
    const one = (body: string) => () => parse(doc({ libraries: library('lib', pkg('P', body)), elements: element('U1', 'P', 0, 0) }));
    expect(one(pad('1', 0, 0, 'diameter="1" shape="hexagon"'))).toThrow(/unknown shape/);
    expect(one('<pad name="1" x="0" y="0" diameter="1"/>')).toThrow(/missing its drill/);
    expect(one(pad('1', 0, 0, 'diameter="-1"'))).toThrow(/invalid drill or diameter/);
    expect(one(smd('1', 0, 0, 0, 1))).toThrow(/non-positive dimensions/);
    expect(one('<smd name="1" x="0" y="0" dx="1" dy="1" layer="5"/>')).toThrow(/only Top \(1\) and Bottom \(16\)/);
    expect(one(`${smd('1', 0, 0, 1, 1)}${smd('1', 2, 0, 1, 1)}`)).toThrow(/declares pad "1" twice/);
    expect(one(smd('1', 0, 0, 1, 1, 'rot="MR0"'))).toThrow(/must not be mirrored/);
    expect(one('<smd name="1" x="abc" y="0" dx="1" dy="1" layer="1"/>')).toThrow(/Invalid EAGLE smd 1 x/);
    expect(one('<smd name=" " x="0" y="0" dx="1" dy="1" layer="1"/>')).toThrow(/missing its name/);
  });
  it('B28: a fully rounded non-square SMD (roundness 100, 4 x 2) is no longer a silent exact rectangle: it is disclosed as approximated', () => {
    const roundness = (dx: number, dy: number, value: number) => parse(doc({ libraries: library('lib', pkg('P', smd('1', 0, 0, dx, dy, `roundness="${value}"`))), elements: element('U1', 'P', 0, 0) }));
    const capsule = roundness(4, 2, 100);
    expect(capsule.pins[0]).toMatchObject({ shape: 'rect', width: 4, height: 2 }); // bounding rectangle of the stadium
    expect(capsule.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    expect(roundness(2, 4, 100).warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    // Controls from the audit: 0 exact rectangle, 50 approximated, square 100 is an exact circle.
    expect(warningKeys(roundness(4, 2, 0))).not.toContain('parse.warning.approximatedPads');
    expect(roundness(4, 2, 50).warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    const circle = roundness(2, 2, 100); expect(circle.pins[0].shape).toBe('round'); expect(warningKeys(circle)).not.toContain('parse.warning.approximatedPads');
    expect(roundness(2, 2, 50).warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    expect(() => roundness(2, 2, 101)).toThrow(/roundness/); expect(() => roundness(2, 2, -1)).toThrow(/roundness/);
  });
  it('B29: package-body tPlace arcs contribute their bulge (a +180 degree arc from (-5,0) to (5,0) reaches y = -5; -180 reaches y = +5)', () => {
    const body = (curve: number) => parse(doc({ libraries: library('lib', pkg('P', `${wire(-5, 0, 5, 0, 21, curve)}${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) })).components[0];
    near(body(180).bounds, { minX: -5, minY: -5, maxX: 5, maxY: 0 }); near(body(-180).bounds, { minX: -5, minY: 0, maxX: 5, maxY: 5 });
    const flat = body(0); near(flat.bounds, { minX: -5, minY: 0, maxX: 5, maxY: 0 });
    expect(new Set(body(180).outline.map(p => p.y)).size).toBeGreaterThan(1);
  });
  it('B29: an arc extremum between sample points is exact (arc from (4,3) to (-3,4) around the origin reaches y = 5 and x = -3..4)', () => {
    const c = parse(doc({ libraries: library('lib', pkg('P', `${wire(4, 3, -3, 4, 21, 90)}${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) })).components[0];
    near(c.bounds, { minX: -3, minY: 3, maxX: 4, maxY: 5 });
  });
  it('B29: arcs also bound the body when mirrored and rotated, and polygon vertex curves, rotated rectangles and circles are included', () => {
    const placed = parse(doc({ libraries: library('lib', pkg('P', `${wire(-5, 0, 5, 0, 21, 180)}${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 10, 20, 'MR90') })).components[0];
    // Mirror (x -> -x) keeps the symmetric bowl, the 90 degree turn puts it on the +x side.
    near(placed.bounds, { minX: 10, minY: 15, maxX: 15, maxY: 25 });
    const polygon = parse(doc({ libraries: library('lib', pkg('P', `<polygon width="0.1" layer="21"><vertex x="-5" y="0" curve="180"/><vertex x="5" y="0"/><vertex x="5" y="-6"/></polygon>${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) })).components[0];
    near(polygon.bounds, { minX: -5, minY: -6, maxX: 5, maxY: 0 });
    const rect = parse(doc({ libraries: library('lib', pkg('P', `<rectangle x1="-2" y1="-1" x2="2" y2="1" layer="21" rot="R90"/>${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) })).components[0];
    near(rect.bounds, { minX: -1, minY: -2, maxX: 1, maxY: 2 });
    const circle = parse(doc({ libraries: library('lib', pkg('P', `<circle x="1" y="1" radius="2" width="0.1" layer="21"/>${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) })).components[0];
    near(circle.bounds, { minX: -1, minY: -1, maxX: 3, maxY: 3 });
  });
  it('falls back to tDocu and then pad extents when there is no tPlace outline; bodies on other layers do not count', () => {
    const docu = parse(doc({ libraries: library('lib', pkg('P', `${wire(-3, -2, 3, 2, 51)}${wire(-9, -9, 9, 9, 2)}${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) })).components[0];
    near(docu.bounds, { minX: -3, minY: -2, maxX: 3, maxY: 2 });
    const none = parse(doc({ libraries: library('lib', pkg('P', smd('1', 0, 0, 4, 2))), elements: element('U1', 'P', 0, 0) }));
    near(none.components[0].bounds, { minX: -2, minY: -1, maxX: 2, maxY: 1 }); expect(warningKeys(none)).toContain('parse.warning.fallbackComponents');
  });
  it('rejects arc curves of a full turn or more instead of flattening them silently', () => {
    expect(() => parse(doc({ libraries: library('lib', pkg('P', `${wire(-5, 0, 5, 0, 21, 360)}${smd('1', 0, 0, 1, 1)}`)), elements: element('U1', 'P', 0, 0) }))).toThrow(/curve/);
    expect(() => parse(doc({ plain: wire(0, 0, 5, 0, 20, -400) }))).toThrow(/curve/);
  });
});

describe('EAGLE board XML: signals and contact references', () => {
  const two = doc({ elements: `${element('R1', 'R0603', 10, 20)}${element('R2', 'R0603', 20, 20)}` });
  const withSignals = (signals: string) => parse(two.replace('<signals></signals>', `<signals>${signals}</signals>`));
  it('assigns nets through contactrefs; unreferenced pads stay without a net; signal-only objects are ignored', () => {
    const b = withSignals(`${signal('GND', `${contactrefs(['R1', '1'], ['R2', '1'])}<via x="1" y="1" extent="1-16" drill="0.3"/><wire x1="0" y1="0" x2="1" y2="1" width="0.2" layer="1"/>`)}${signal('N$1', contactrefs(['R1', '2']))}${signal('EMPTY', '')}`);
    expect(b.pins.map(p => p.net)).toEqual(['GND', 'N$1', 'GND', '']);
    expect(b.nets).toEqual([{ id: 'net:0', name: 'GND', pinIds: ['pin:0', 'pin:2'] }, { id: 'net:1', name: 'N$1', pinIds: ['pin:1'] }]);
  });
  it('rejects contactrefs to unknown elements, missing pads and pads listed in two different signals, and unnamed signals', () => {
    expect(() => withSignals(signal('GND', contactrefs(['R9', '1'])))).toThrow(/unknown element "R9"/);
    expect(() => withSignals(signal('GND', contactrefs(['R1', '7'])))).toThrow(/missing pad "7" of element "R1"/);
    expect(() => withSignals(`${signal('GND', contactrefs(['R1', '1']))}${signal('VCC', contactrefs(['R1', '1']))}`)).toThrow(/listed in signals "GND" and "VCC"/);
    expect(() => withSignals('<signal class="0"/>')).toThrow(/missing its name attribute/);
    expect(() => withSignals(`<signal name="GND"><contactref pad="1"/></signal>`)).toThrow(/missing its element attribute/);
    expect(withSignals(`${signal('GND', contactrefs(['R1', '1']))}${signal('GND', contactrefs(['R1', '1'], ['R2', '2']))}`).nets).toEqual([{ id: 'net:0', name: 'GND', pinIds: ['pin:0', 'pin:3'] }]);
  });
  it('B24: a net literally named UNCONNECTED is kept (vendor sentinels are normalized only by vendor adapters)', () => {
    const b = withSignals(signal('UNCONNECTED', contactrefs(['R1', '1'], ['R2', '1'])));
    expect(b.nets).toEqual([{ id: 'net:0', name: 'UNCONNECTED', pinIds: ['pin:0', 'pin:2'] }]); expect(warningKeys(b)).not.toContain('parse.warning.noNets');
  });
  it('warns when the board has no connectivity at all', () => expect(warningKeys(parse(doc()))).toContain('parse.warning.noNets'));
});

describe('EAGLE board XML: libraries, elements and duplicates', () => {
  it('resolves packages per library name and per library_urn; two libraries may define the same package name differently', () => {
    const libs = `${library('lib', pkg('P', smd('1', 0, 0, 1, 1)), ' urn="urn:adsk.eagle:library:1"')}${library('lib', pkg('P', `${smd('1', 0, 0, 1, 1)}${smd('2', 2, 0, 1, 1)}`), ' urn="urn:adsk.eagle:library:2"')}${library('other', pkg('P', smd('A', 0, 0, 3, 3)))}`;
    const b = parse(doc({ libraries: libs, elements: `${element('U1', 'P', 0, 0, '', 'library="lib" library_urn="urn:adsk.eagle:library:2"')}${element('U2', 'P', 10, 0, '', 'library="lib" library_urn="urn:adsk.eagle:library:1"')}${element('U3', 'P', 20, 0, '', 'library="other"')}` }));
    expect(b.components.map(c => c.pinIds.length)).toEqual([2, 1, 1]); expect(b.pins[3]).toMatchObject({ number: 'A', width: 3 });
    expect(() => parse(doc({ libraries: libs, elements: element('U1', 'P', 0, 0, '', 'library="lib" library_urn="urn:adsk.eagle:library:3"') }))).toThrow(/does not define|unknown library/);
  });
  it('library lookup errors name the element, package and library', () => {
    expect(() => parse(doc({ elements: element('R1', 'R0603', 0, 0, '', 'library="nope"') }))).toThrow(/element R1 references unknown library "nope"/);
    expect(() => parse(doc({ elements: element('R1', 'R0805', 0, 0) }))).toThrow(/element R1 uses package "R0805" which library "lib" does not define/);
    expect(() => parse(doc({ libraries: '' }))).toThrow(/unknown library "lib"/);
    expect(codeOf(() => parse(doc({ elements: element('R1', 'R0805', 0, 0) })))).toBe('INVALID_FORMAT');
  });
  it('rejects duplicate element names and elements with missing attributes', () => {
    expect(() => parse(doc({ elements: `${element('R1', 'R0603', 0, 0)}${element('R1', 'R0603', 5, 0)}` }))).toThrow(/declares element "R1" twice/);
    expect(() => parse(doc({ elements: '<element name="R1" library="lib" package="R0603" y="0"/>' }))).toThrow(/element R1 is missing its x attribute/);
    expect(() => parse(doc({ elements: '<element library="lib" package="R0603" x="0" y="0"/>' }))).toThrow(/element is missing its name attribute/);
    expect(() => parse(doc({ elements: element('R1', 'R0603', 0, 0).replace('x="0"', 'x="NaN"') }))).toThrow(/Invalid EAGLE element R1 x/);
  });
  it('requires at least one element; a board of no components is an error', () => expect(() => parse(doc({ elements: '' }))).toThrow(/no components were found/));
  it('keeps value text and element order', () => {
    const b = parse(doc({ elements: `${element('R2', 'R0603', 0, 0)}${element('C1', 'R0603', 5, 0).replace('value="10k"', 'value="100nF"')}` }));
    expect(b.components.map(c => [c.ref, c.value, c.package])).toEqual([['R2', '10k', 'R0603'], ['C1', '100nF', 'R0603']]);
  });
});

describe('EAGLE board XML: Dimension outline (layer 20)', () => {
  it('reads a rectangular outline from four wires and ignores wires on other layers', () => {
    const b = parse(doc({ plain: `${dimension(0, 0, 40, 30)}${wire(-50, -50, 90, 90, 21)}` }));
    expect(b.outline).toHaveLength(4); near(b.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 30 }); expect(warningKeys(b)).not.toContain('parse.warning.missingBoardOutline');
  });
  it('samples rounded corners (curve 90) and keeps the exact extremes; discloses the approximation', () => {
    const rounded = [wire(5, 0, 35, 0), wire(35, 0, 40, 5, 20, 90), wire(40, 5, 40, 25), wire(40, 25, 35, 30, 20, 90), wire(35, 30, 5, 30), wire(5, 30, 0, 25, 20, 90), wire(0, 25, 0, 5), wire(0, 5, 5, 0, 20, 90)].join('');
    const b = parse(doc({ plain: rounded }));
    near(b.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 30 }); expect(b.outline.length).toBeGreaterThan(20);
    expect(notes(b)).toContain('4 EAGLE outline arcs/circles were approximated by straight segments.');
    // The board interior is a rounded rectangle: its corner point is outside the polygon.
    expect(b.outline.some(p => p.x === 0 && p.y === 0)).toBe(false);
  });
  it('a semicircular end (curve 180) and a bulge outside the endpoints widen the bounds', () => {
    const b = parse(doc({ plain: `${wire(0, 0, 30, 0)}${wire(30, 0, 30, 20, 20, 180)}${wire(30, 20, 0, 20)}${wire(0, 20, 0, 0)}` }));
    near(b.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 20 });
  });
  it('a Dimension circle is a round board; a second circle inside a rectangle is a disclosed cutout', () => {
    const round = parse(doc({ plain: '<circle x="10" y="10" radius="5" width="0" layer="20"/>' }));
    near(round.bounds, { minX: 5, minY: 5, maxX: 15, maxY: 15 });
    const cut = parse(doc({ plain: `${dimension(0, 0, 40, 30)}<circle x="20" y="15" radius="3" width="0" layer="20"/>` }));
    near(cut.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 30 }); expect(cut.warnings.filter(w => w.key === 'parse.warning.boardCutouts')).toHaveLength(1);
    const rectCut = parse(doc({ plain: `${dimension(0, 0, 40, 30)}${dimension(10, 10, 12, 12)}` }));
    expect(rectCut.outline).toHaveLength(4); expect(rectCut.warnings.filter(w => w.key === 'parse.warning.boardCutouts')).toHaveLength(1);
  });
  it('B05: an open spur or a diagonal chord never destroys the closed outline, and is disclosed instead of being closed', () => {
    for (const plain of [`${wire(40, 0, 55, 0)}${dimension(0, 0, 40, 30)}`, `${dimension(0, 0, 40, 30)}${wire(40, 0, 55, 0)}`, `${wire(0, 0, 40, 30)}${dimension(0, 0, 40, 30)}`, `${dimension(0, 0, 40, 30)}${wire(0, 0, 40, 30)}`]) {
      const b = parse(doc({ plain }));
      expect(b.outline).toHaveLength(4); near(b.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 30 });
      expect(notes(b).some(message => /open EAGLE Dimension chain/.test(message))).toBe(true); expect(warningKeys(b)).not.toContain('parse.warning.missingBoardOutline');
    }
  });
  it('an open Dimension chain is disclosed with an estimated boundary; a board without Dimension gets the missing-outline warning', () => {
    const open = parse(doc({ plain: `${wire(0, 0, 40, 0)}${wire(40, 0, 40, 30)}` }));
    expect(warningKeys(open)).toContain('parse.warning.missingBoardOutline'); expect(notes(open).some(message => /closed contour/.test(message))).toBe(true);
    const none = parse(doc({ plain: '' }));
    expect(warningKeys(none)).toContain('parse.warning.missingBoardOutline'); expect(notes(none)).toEqual([]);
  });
  it('rejects non-numeric outline coordinates', () => expect(() => parse(doc({ plain: '<wire x1="a" y1="0" x2="1" y2="1" width="0" layer="20"/>' }))).toThrow(/Invalid EAGLE dimension wire x1/));
});

describe('EAGLE board XML: expansion preflight (B22)', () => {
  const grid = (padCount: number, elementCount: number) => doc({
    libraries: library('lib', pkg('P', Array.from({ length: padCount }, (_, index) => smd(String(index + 1), index * 2, 0, 1, 1)).join(''))),
    elements: Array.from({ length: elementCount }, (_, index) => element(`E${index}`, 'P', index * 3, 100)).join(''),
    plain: '',
  });
  it('controls: 8 pads x 8 elements = 64, 32 x 32 = 1024 and 512 x 8 = 4096 pins parse exactly', () => {
    for (const [pads, elements] of [[8, 8], [32, 32], [512, 8]]) {
      const b = parse(grid(pads, elements)); expect(b.pins).toHaveLength(pads * elements); expect(b.components).toHaveLength(elements);
    }
  });
  it('B22: 5000 pads x 201 elements (1,005,000 planned pins, ~300 KB of XML) is rejected with LIMIT_EXCEEDED before any pin is materialized', () => {
    expect(codeOf(() => parse(grid(5000, 201)))).toBe('LIMIT_EXCEEDED');
    expect(() => parse(grid(5000, 201))).toThrow(/1005000 pins/);
    expect(() => parse(grid(1000, 1001))).toThrow(/1001000 pins/);
  });
  it('B22: a plan of 4e8 pins from ~3 MB of XML fails immediately instead of allocating (completing at all proves nothing was materialized)', () => {
    expect(() => parse(grid(20_000, 20_000))).toThrow(/400000000 pins/);
    // The text grows with n and the plan with n squared: refusing the plan takes as long as reading the text. A reader that materialized the pins would need time and memory that grow with n squared.
    expectScaling('refusing a plan of n x n pins', [2500, 5000, 10_000, 20_000], size => { const input = textInput(grid(size, size), 'synthetic.brd'); return catching(() => parseEagle(input)); });
  });
  it('counts each referenced package per element; unreferenced packages and size do not count', () => {
    const libs = library('lib', `${pkg('BIG', Array.from({ length: 2000 }, (_, index) => smd(String(index), index, 0, 1, 1)).join(''))}${pkg('R0603', `${smd('1', 0, 0, 1, 1)}${smd('2', 2, 0, 1, 1)}`)}`);
    const b = parse(doc({ libraries: libs, elements: `${element('R1', 'R0603', 0, 0)}${element('R2', 'R0603', 5, 0)}`, plain: '' }));
    expect(b.pins).toHaveLength(4);
  });
});
