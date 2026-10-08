import { describe, expect, it } from 'vitest';
import { expectScaling } from '../../test-support/timing';
import { BoardFormatError } from './common';
import {
  arcPoints, eachLine, FID, fields, parseCadNetlist, parseComponents, parseEdaData, parseKeyValues, parseMatrix, parseSurfaces, type LayerKind,
} from './odbpp-records';

const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};

describe('line and field scanning', () => {
  it('splits LF, CRLF and CR-less last lines and blank-separated fields', () => {
    const seen: Array<[string, number]> = [];
    eachLine('a\r\nb\n\nc', (line, no) => seen.push([line, no]));
    expect(seen).toEqual([['a', 1], ['b', 2], ['', 3], ['c', 4]]);
    expect(fields('  CMP\t0  1.5 -2 ')).toEqual(['CMP', '0', '1.5', '-2']);
    expect(fields('')).toEqual([]);
  });
});

describe('matrix, misc/info and stephdr', () => {
  it('reads steps and layers in column and row order, lower-cases names and skips illegal ones', () => {
    const matrix = parseMatrix([
      'STEP {', '  COL=2', '  NAME=PANEL', '}', 'STEP {', 'COL=1', 'NAME=PCB', '}',
      'LAYER {', 'ROW=2', 'TYPE=signal', 'NAME=TOP', 'CONTEXT=BOARD', '}', 'LAYER {', 'ROW=1', 'TYPE=COMPONENT', 'NAME=COMP_+_TOP', 'POLARITY=POSITIVE', '}',
      'LAYER {', 'ROW=3', 'TYPE=DRILL', 'NAME=DRILL', 'START_NAME=TOP', 'END_NAME=BOTTOM', '}',
      'LAYER {', 'ROW=4', 'TYPE=DOCUMENT', 'NAME=has space', '}', 'STEP {', 'NAME=../evil', '}', 'UNKNOWN {', 'X=1', '}', 'stray line',
    ].join('\n'));
    expect(matrix.steps.map(step => step.name)).toEqual(['pcb', 'panel']);
    expect(matrix.layers.map(layer => [layer.row, layer.name, layer.type])).toEqual([[1, 'comp_+_top', 'COMPONENT'], [2, 'top', 'SIGNAL'], [3, 'drill', 'DRILL']]);
    expect(matrix.layers[2]).toMatchObject({ startName: 'top', endName: 'bottom', polarity: 'POSITIVE' });
    expect(matrix.illegalNames).toEqual({ count: 2, examples: ['has space', '../evil'] });
    expect(matrix.ignored).toBe(2); // the UNKNOWN block and the stray line
  });

  it('rejects unbalanced blocks with the line number', () => {
    expect(failure(() => parseKeyValues('STEP {\nNAME=A\n', 'matrix/matrix')).message).toMatch(/matrix\/matrix line 1: block STEP is not closed/);
    expect(failure(() => parseKeyValues('STEP {\nLAYER {\n}\n}', 'matrix/matrix')).message).toMatch(/line 2: a block opens inside another block/);
    expect(failure(() => parseKeyValues('}\n', 'misc/info')).message).toMatch(/closing brace has no block/);
    expect(parseKeyValues('# comment\nUNITS = mm \nJOB_NAME=x=y\n', 'misc/info').values).toEqual(new Map([['UNITS', 'mm'], ['JOB_NAME', 'x=y']]));
  });
});

describe('profile surfaces', () => {
  it('reads islands and holes with arcs and recognizes an all-arc polygon as a circle', () => {
    const surfaces = parseSurfaces([
      'UNITS=INCH', 'F 2', 'S P 0', 'OB 0 0 I', 'OS 2 0', 'OC 2 2 2 1 N', 'OS 0 2', 'OS 0 0', 'OE', 'OB 0.5 0.5 H', 'OS 0.6 0.5', 'OS 0.6 0.6', 'OE', 'SE',
      'S P 0', 'OB 5 0 I', 'OC 5 0 4 0 Y', 'OE', 'SE', 'L 0 0 1 1 0 P 0', 'P 1 1 0 P 0 0',
    ].join('\n'), 'profile');
    expect(surfaces.units).toBe('INCH');
    expect(surfaces.polygons.map(polygon => polygon.hole)).toEqual([false, true, false]);
    expect(surfaces.polygons[2].circle).toEqual({ x: 4, y: 0, r: 1 });
    expect(surfaces.polygons[0].circle).toBeUndefined();
    expect(surfaces.otherFeatures).toBe(2);
    const arc = surfaces.polygons[0].points.filter(p => p.x > 2);
    expect(Math.max(...arc.map(p => p.x))).toBeCloseTo(3, 9); // the counter-clockwise half circle around (2, 1) bulges to x = 3
  });

  it('places arc points on the arc, clockwise or not, and treats start == end as a full circle', () => {
    const cw: { x: number; y: number }[] = [], ccw: { x: number; y: number }[] = [], full: { x: number; y: number }[] = [];
    arcPoints({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 0 }, false, ccw);
    arcPoints({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 0 }, true, cw);
    arcPoints({ x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }, true, full);
    for (const p of [...cw, ...ccw, ...full]) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
    expect(ccw.length).toBeLessThan(cw.length); // a quarter turn one way, three quarters the other
    expect(full).toHaveLength(36);
    expect(cw[cw.length - 1]).toEqual({ x: 0, y: 1 });
  });

  it('rejects broken surfaces with file and line', () => {
    expect(failure(() => parseSurfaces('OB 0 0 I\n', 'profile')).message).toMatch(/profile line 1: OB outside a surface/);
    expect(failure(() => parseSurfaces('S P 0\nOB 0 0 I\nOS 1 0\nSE\n', 'profile')).message).toMatch(/line 4: SE inside an open polygon/);
    expect(failure(() => parseSurfaces('S P 0\nOB 0 0 I\nOS 1 0\nOE\n', 'profile')).message).toMatch(/line 1: the surface is not closed/);
    expect(failure(() => parseSurfaces('S P 0\nOB 0 0 X\n', 'profile')).message).toMatch(/I \(island\) or H \(hole\)/);
    expect(failure(() => parseSurfaces('S P 0\nOB 0 0 I\nOC 1 1 0 0 maybe\n', 'profile')).message).toMatch(/OC direction/);
    expect(failure(() => parseSurfaces('S P 0\nOB 0x10 0 I\n', 'profile')).message).toMatch(/invalid polygon X/);
    expect(failure(() => parseSurfaces('UNITS=MIL\n', 'profile')).message).toMatch(/UNITS must be MM or INCH/);
    expect(failure(() => parseSurfaces('UNITS=MM\nU INCH\n', 'profile')).message).toMatch(/conflicting UNITS/);
    expect(parseSurfaces('U MM\n', 'profile').units).toBe('MM');
  });
});

describe('eda/data', () => {
  const kinds: Record<string, LayerKind> = { top: 'top', bottom: 'bottom', gnd: 'inner', smt: 'other' };
  const EDA = [
    'HDR Some CAD 1.0', 'UNITS=MM', 'LYR top gnd bottom smt notinmatrix',
    "PRP DRILL_ORIGIN 'a multi", 'line value', "'", '@0 .critical_net', '&0 x',
    'NET $NONE$', 'SNT TOP T 0 2', 'FID C 3 0', 'NET GND;;ID=7', 'SNT TOP T 0 0', 'FID C 0 1', 'FID C 3 1', 'SNT TRC', 'FID C 0 9', 'SNT TOP B 1 0', 'FID C 2 4', 'FID C 1 5',
    'NET /Sheet 1/A B ;0;ID=8', 'SNT VIA', 'FID H 1 3', 'SNT TOP T 0 1', 'FID C 4 2', 'FID C 99 3', 'FID C x 3', 'SNT TOP T 2 0',
    '# PKG 0', 'PKG R0603 1.6 -1.5 -0.8 1.5 0.8;;ID=1', 'RC -1.5 -0.8 3 1.6', 'PRP HEIGHT \'1\'', 'PIN 1 S -0.8 0 0 E S ID=2', 'RC -1.2 -0.45 0.8 0.9', 'PIN 2 T 0.8 0 0 M H', 'CR 0.8 0 0.3',
    'PKG CUSTOM 1 -1 -1 1 1', 'CT', 'OB -1 -1 I', 'OS 1 -1', 'OS 1 1', 'OS -1 1', 'OE', 'OB -0.2 -0.2 H', 'OS 0.2 -0.2', 'OS 0.2 0.2', 'OE', 'CE', 'PIN A S 0 0 0', 'SQ 0 0 0.25',
    'PKG NOBOX', 'FGR TEXT', "PRP string 'x'", 'FID C 0 77', 'XYZ unknown record',
  ].join('\n');

  it('reads nets, toeprint subnets with their FID layer masks, packages, pins and outlines', () => {
    const eda = parseEdaData(EDA, 'eda/data', name => kinds[name]);
    expect(eda).toMatchObject({ units: 'MM', source: 'Some CAD 1.0', netNames: ['$NONE$', 'GND', '/Sheet 1/A B'], layers: ['top', 'gnd', 'bottom', 'smt', 'notinmatrix'], ignored: 1 });
    const records = Array.from({ length: eda.toeprintNets.length / 5 }, (_, index) => Array.from(eda.toeprintNets.subarray(5 * index, 5 * index + 5)));
    expect(records).toEqual([
      [0, 0, 0, 2, FID.OTHER],
      [1, 0, 0, 0, FID.TOP | FID.OTHER], // the trace FID after SNT TRC belongs to no toeprint
      [1, 1, 1, 0, FID.BOTTOM | FID.INNER],
      [2, 0, 0, 1, FID.UNKNOWN], // a layer outside the matrix, a layer number past LYR and a non-number
      [2, 0, 2, 0, 0],
    ]);
    expect(eda.packages.map(pkg => [pkg.name, pkg.pitch, pkg.bbox, pkg.outlines.length, pkg.pins.length])).toEqual([
      ['R0603', 1.6, { minX: -1.5, minY: -0.8, maxX: 1.5, maxY: 0.8 }, 1, 2], ['CUSTOM', 1, { minX: -1, minY: -1, maxX: 1, maxY: 1 }, 1, 1], ['NOBOX', 0, null, 0, 0],
    ]);
    expect(eda.packages[0].pins[1]).toMatchObject({ name: '2', type: 'T', x: 0.8, y: 0, etype: 'M', mtype: 'H', outlines: [{ kind: 'circle', x: 0.8, y: 0, r: 0.3 }] });
    expect(eda.packages[1].pins[0]).toMatchObject({ etype: 'U', mtype: 'U', outlines: [{ kind: 'square', half: 0.25 }] });
    const contour = eda.packages[1].outlines[0];
    expect(contour.kind === 'contour' && contour.polygons.map(polygon => [polygon.hole, polygon.points.length])).toEqual([[false, 4], [true, 3]]);
    // Without a classifier every FID is unknown.
    expect(parseEdaData(EDA, 'eda/data').toeprintNets[4]).toBe(FID.UNKNOWN);
  });

  it('rejects structural errors with file and line', () => {
    const cases: Array<[string, RegExp]> = [
      ['SNT TOP T 0 0', /line 1: SNT appears outside a net/], ['NET A\nSNT TOP X 0 0', /SNT TOP side must be T or B/], ['NET A\nSNT TOP T -1 0', /negative SNT/],
      ['NET A\nSNT TOP T a 0', /invalid SNT component number/], ['PIN 1 S 0 0', /PIN appears outside a package/], ['PKG', /PKG needs a name/],
      ['PKG A 1 0 0 1 1\nPIN 1 S 0', /PIN needs a name, type and centre/], ['RC 0 0 1 1', /outside a package or pin/], ['PKG A 1 0 0 1 1\nRC 0 0 -1 1', /negative RC size/],
      ['PKG A 1 0 0 1 1\nCR 0 0 -1', /negative CR radius/], ['PKG A 1 0 0 1 1\nCT\nOB 0 0 I\nOS 1 0\nOE', /line 2: a contour \(CT\) is not closed/],
      ['PKG A 1 0 0 1 1\nCT\nCE', /an empty contour/], ['PKG A 1 0 0 1 1\nCT\nOB 0 0 I\nCE', /CE inside an open polygon/], ['OS 0 0', /OS appears outside a contour/],
      ['PKG A 1 0 0 1 1\nCT\nOB 0 0 I\nPIN 1 S 0 0', /a contour \(CT\) is not closed/], ['PKG A 1 0 0 1 1\nRC 0 0 1 Infinity', /invalid RC height/],
    ];
    for (const [text, pattern] of cases) expect(failure(() => parseEdaData(text, 'eda/data')).message, text).toMatch(pattern);
  });

  it('scans hostile line shapes in linear time', () => {
    const shapes: Array<(count: number) => string> = [
      count => 'NET A\n' + 'SNT TOP T 0 0\nFID C 0 0\n'.repeat(count), // many subnets and features
      count => ' '.repeat(count * 16), // one long blank line
      count => '#\n'.repeat(count * 4), // comment flood
      count => 'PKG A 1 0 0 1 1\nCT\nOB 0 0 I\n' + 'OS 1 0\nOS 0 0\n'.repeat(count) + 'OE\nCE\n', // a huge contour
      count => `PRP X '${'a'.repeat(count * 8)}\n` + 'z\n'.repeat(count), // an unterminated multi-line value (64-line budget)
    ];
    shapes.forEach((shape, index) => expectScaling(`shape ${index}`, [6_000, 24_000, 96_000], count => { const text = shape(count); return () => parseEdaData(text, 'eda/data'); }));
  });
});

describe('component layers', () => {
  const COMPONENTS = [
    'UNITS=INCH', '@0 .comp_mount_type', '@1 .desc1', '&0 a description',
    'CMP 0 1 2 90.0 N R1 RES-10K ;0=1,1=0;ID=5', "PRP Value '10k'", "PRP Note 'it's here' 1 2", "PRP Description 'first line", 'second line', "'",
    'TOP 0 0.9 2 90 N 3 0 1', 'TOP 1 1.1 2 90 N4 1 2', 'TOP 2 1.1 2 90 M12 1 A', '# BOM DATA', 'CPN C-1', 'MPN 0 1 PART-1', 'VND ACME', 'CHS 1',
    'CMP 1 3 4 0 M U7', 'TOP 0 3 4 0 M -1 0', 'EOF',
  ].join('\n');

  it('reads CMP, PRP (multi-line values too), TOP (glued mirror and net fields too), BOM records and attribute tables', () => {
    const parsed = parseComponents(COMPONENTS, 'comp_+_top/components');
    expect(parsed.units).toBe('INCH');
    expect(parsed.attributeNames).toEqual(new Map([[0, '.comp_mount_type'], [1, '.desc1']]));
    expect(parsed.attributeTexts).toEqual(new Map([[0, 'a description']]));
    const [r1, u7] = parsed.components;
    expect(r1).toMatchObject({ pkgRef: 0, x: 1, y: 2, rot: 90, mirror: false, name: 'R1', partName: 'RES-10K', attributes: '0=1,1=0' });
    expect(r1.properties).toEqual([['Value', '10k'], ['Note', "it's here"], ['Description', 'first line\nsecond line']]);
    expect(r1.toeprints.map(t => [t.pin, t.x, t.mirror, t.net, t.subnet, t.name])).toEqual([[0, 0.9, false, 3, 0, '1'], [1, 1.1, false, 4, 1, '2'], [2, 1.1, true, 12, 1, 'A']]);
    expect(r1.bom).toEqual([['CPN', 'C-1'], ['MPN', '0 1 PART-1'], ['VND', 'ACME'], ['CHS', '1']]);
    expect(u7).toMatchObject({ name: 'U7', partName: '', mirror: true, toeprints: [{ net: -1, name: '' }] });
    expect(parsed.ignored).toBe(1); // EOF
  });

  it('never lets an unterminated value swallow the following records', () => {
    const parsed = parseComponents("CMP 0 0 0 0 N R1 X\nPRP Value 'open\nTOP 0 0 0 0 N 0 0 1\nCMP 0 1 1 0 N R2 Y\n", 'components');
    expect(parsed.components.map(component => [component.name, component.toeprints.length, component.properties])).toEqual([['R1', 1, [['Value', 'open']]], ['R2', 0, []]]);
  });

  it('rejects malformed records with file and line', () => {
    const cases: Array<[string, RegExp]> = [
      ['TOP 0 0 0 0 N 0 0', /line 1: TOP appears before any CMP/], ['CMP 0 0 0 0 N', /CMP needs/], ['CMP 0 0 0 0 X R1', /mirror must be N or M/],
      ['CMP 0.5 0 0 0 N R1', /invalid package reference/], ['CMP 0 0 0 NaN N R1', /invalid component rotation/], ['CMP 0 0 0 0 N R1\nTOP 0 0 0 0 N 0', /TOP needs/],
      ['CMP 0 0 0 0 N R1\nTOP 0 0 0 0 Q 0 0', /mirror must be N or M/], ['CMP 0 0 0 0 N R1\nTOP 0 1e999 0 0 N 0 0', /invalid toeprint X/],
    ];
    for (const [text, pattern] of cases) expect(failure(() => parseComponents(text, 'components')).message, text).toMatch(pattern);
  });

  it('parses many components in linear time', () => {
    const build = (count: number) => Array.from({ length: count }, (_, index) => `CMP 0 ${index} 0 0 N R${index} P ;0=1\nPRP Value '${index}'\nTOP 0 ${index} 0 0 N 1 0 1\nTOP 1 ${index} 1 0 N 2 0 2`).join('\n');
    expectScaling('components', [5_000, 20_000, 80_000], count => { const text = build(count); return () => parseComponents(text, 'c'); });
  });
});

describe('cadnet netlist', () => {
  it('reads net names and points with their side and skips the header', () => {
    const netlist = parseCadNetlist('UNITS=MM\nH optimize n staggered n\n$0 GND\n$1 VCC 3V3\n0 0.4 1.5 2 B e e staggered 0 0 0\n1 0.002 3 -4 D e e\n1 0.1 5 6 T\nnote\n', 'netlist');
    expect(netlist.units).toBe('MM');
    expect(netlist.names).toEqual(new Map([[0, 'GND'], [1, 'VCC 3V3']]));
    expect(Array.from(netlist.nets)).toEqual([0, 1, 1]);
    expect(Array.from(netlist.points)).toEqual([1.5, 2, 2, 3, -4, 1, 5, 6, 0]);
    expect(netlist.ignored).toBe(1);
    expect(failure(() => parseCadNetlist('0 0.1 1 2 X\n', 'netlist')).message).toMatch(/side must be T, D or B/);
    expect(failure(() => parseCadNetlist('$x GND\n', 'netlist')).message).toMatch(/invalid net serial/);
    expect(failure(() => parseCadNetlist('0 r 1 2 T\n', 'netlist')).message).toMatch(/invalid net point radius/);
  });
});
