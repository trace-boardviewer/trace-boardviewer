import { describe, expect, it } from 'vitest';
import { BoardFormatError, buildBoard, stitchOutline, textInput } from './common';
import { parseKicad } from './kicad';

const encode = (text: string) => textInput(text, 'synthetic-board.kicad_pcb');
const fp = `(footprint "Test:Package" (layer "F.Cu") (at 10 20 90)
 (property "Reference" "U1") (property "Value" "α quoted \\"value\\"")
 (fp_rect (start -3 -2) (end 3 2) (layer "F.Fab"))
 (pad "1" smd rect (at 2 3 90) (size 2 1) (layers "F.Cu") (net 1 "GND") (pinfunction "IN"))
 (pad "2" thru_hole circle (at -2 0 0) (size 1.5 1.5) (drill 0.7) (layers "*.Cu" "*.Mask")))`;
const board = (extra = '', footprint = fp, nets = '(net 0 "") (net 1 "GND")') => `(kicad_pcb (version 20240108) (generator "synthetic-audit") ${nets}
 ${footprint} (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts")) ${extra})`;
const parse = (text: string) => { const result = parseKicad(encode(text)); if (!result) throw new Error('unexpectedly unrecognized'); return result; };
const expectBounds = (actual: Record<string, number>, expected: Record<string, number>) => { for (const [key, value] of Object.entries(expected)) expect(actual[key]).toBeCloseTo(value, 9); };

describe('KiCad PCB adapter (format-geometry-audit port)', () => {
  it('reads modern KiCad: top rotation, Unicode, rectangular dimensions and net membership', () => {
    const b = parse(board());
    expect(b.format).toBe('KiCad PCB'); expect(b.components).toHaveLength(1); expect(b.pins).toHaveLength(2);
    const pin = b.pins[0];
    expect(pin.x).toBeCloseTo(13, 9); expect(pin.y).toBeCloseTo(-18, 9); expect(pin.rotation).toBe(90);
    expect(pin.width).toBe(2); expect(pin.height).toBe(1); expect(pin.name).toBe('IN'); expect(pin.net).toBe('GND'); expect(pin.shape).toBe('rect');
    expect(b.components[0].value).toBe('α quoted "value"'); expect(b.components[0].package).toBe('Test:Package'); expect(b.components[0].rotation).toBe(90);
    expect(b.pins[1].side).toBe('both'); expect(b.pins[1].shape).toBe('round'); expect(b.pins[1].radius).toBe(0.75);
    expect(b.nets).toHaveLength(1); expect(b.nets[0].pinIds).toEqual([pin.id]);
    expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 }); expect(b.outline).toHaveLength(4);
    expect(b.warnings).toEqual([]);
  });
  it('does not reflect bottom (B.Cu) coordinates a second time', () => {
    const b = parse(board('', fp.replace('(layer "F.Cu") (at 10 20 90)', '(layer "B.Cu") (at 20 30 270)').replace('(at 2 3 90)', '(at -2 3 270)').replace('(layers "F.Cu")', '(layers "B.Cu")')));
    expect(b.components[0].side).toBe('bottom'); expect(b.pins[0].side).toBe('bottom');
    expect(b.pins[0].x).toBeCloseTo(17, 9); expect(b.pins[0].y).toBeCloseTo(-28, 9); expect(b.pins[0].rotation).toBe(270);
  });
  it('keeps legacy module/fp_text metadata readable', () => {
    const b = parse(board('', fp.replace('(footprint', '(module').replace('(property "Reference" "U1")', '(fp_text reference "R9")').replace('(property "Value" "α quoted \\"value\\"")', '(fp_text value "10 kΩ")')));
    expect(b.components[0].ref).toBe('R9'); expect(b.components[0].value).toBe('10 kΩ');
  });
  it('returns null for non-KiCad documents', () => {
    expect(parseKicad(encode('$HEADER\nGENCAD 1.4'))).toBeNull();
    expect(parseKicad(encode('(kicad_sch (version 20231120))'))).toBeNull();
    expect(parseKicad(encode(''))).toBeNull();
  });
  it('throws on a recognized unterminated expression', () => expect(() => parse(board().slice(0, -1))).toThrow(/Malformed/));
  it('throws on a recognized nonfinite coordinate', () => expect(() => parse(board().replace('(at 2 3 90)', '(at NaN 3 90)'))).toThrow(/Invalid/));
  it('throws on recognized nonpositive pad dimensions', () => expect(() => parse(board().replace('(size 2 1)', '(size 0 1)'))).toThrow(/non-positive/));
  it('throws on an unknown numeric net ID without inline name', () => expect(() => parse(board().replace('(net 1 "GND") (pinfunction', '(net 99) (pinfunction'))).toThrow(/missing net 99/));
  it('warns about approximated roundrect pads', () => {
    const b = parse(board().replace('smd rect', 'smd roundrect'));
    expect(b.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
  });
  it('forms the closed contour from unordered and reversed board lines', () => {
    const lines = '(gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts")) (gr_line (start 40 30) (end 0 30) (layer "Edge.Cuts")) (gr_line (start 0 0) (end 0 30) (layer "Edge.Cuts")) (gr_line (start 40 30) (end 40 0) (layer "Edge.Cuts"))';
    const b = parse(board().replace('(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))', lines));
    expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 }); expect(b.outline).toHaveLength(4);
    expect(b.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(false);
  });
  it('does not fabricate a polygon from open chains', () => {
    expect(stitchOutline([[{ x: 0, y: 0 }, { x: 2, y: 0 }], [{ x: 2, y: 0 }, { x: 2, y: 2 }]])).toHaveLength(0);
  });
  it('keeps real source pad dimensions through the fallback component bounds path', () => {
    const b = buildBoard(encode(''), { format: 'synthetic', unitsToMm: 1, parts: [{ key: 'p', side: 'top', position: { x: 0, y: 0 } }], pins: [{ part: 'p', number: '1', x: 0, y: 0, width: 20, height: 10, shape: 'rect' }] });
    expect(b.pins[0].width).toBe(20); expect(b.pins[0].height).toBe(10);
    expect(b.warnings.some(w => w.key === 'parse.warning.fallbackComponents')).toBe(true);
  });
});

describe('KiCad PCB adapter (regression fixes)', () => {
  it('B09: rejects a pad whose inline net name contradicts the declared net table', () => {
    expect(() => parse(board().replace('(net 1 "GND") (pinfunction', '(net 1 "WRONG") (pinfunction'))).toThrow(/net 1 is named "WRONG" but the net table declares "GND"/);
  });
  it('B09: accepts an inline name equal to the declared one, and resolves a bare id through the table', () => {
    expect(parse(board()).pins[0].net).toBe('GND');
    expect(parse(board().replace('(net 1 "GND") (pinfunction', '(net 1) (pinfunction')).pins[0].net).toBe('GND');
  });
  it('B09: a missing net table still accepts inline names', () => {
    const b = parse(board('', fp, ''));
    expect(b.pins[0].net).toBe('GND');
  });
  it('B10: keeps the outer contour and discloses an inner cutout', () => {
    const b = parse(board('(gr_circle (center 20 15) (end 22 15) (layer "Edge.Cuts"))'));
    expect(b.outline).toHaveLength(4); expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 });
    expect(b.warnings.filter(w => w.key === 'parse.warning.boardCutouts')).toHaveLength(1);
  });
  it('B10: an open Edge.Cuts chain is disclosed instead of being closed', () => {
    const b = parse(board().replace('(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))', '(gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts")) (gr_line (start 40 0) (end 40 30) (layer "Edge.Cuts"))'));
    expect(b.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
    expect(b.warnings.some(w => w.key === 'parse.warning.formatNote' && /closed contour/.test(String(w.params?.message)))).toBe(true);
  });
  it('treats KiCad single-pad unconnected-(…) placeholder nets as no-connects', () => {
    const b = parse(board('', fp.replace('(net 1 "GND")', '(net 2 "unconnected-(U1-Pad1)")'), '(net 0 "") (net 1 "GND") (net 2 "unconnected-(U1-Pad1)")'));
    expect(b.pins[0].net).toBe(''); expect(b.nets).toHaveLength(0);
    expect(b.warnings.some(w => w.key === 'parse.warning.formatNote' && /1 KiCad "unconnected-/.test(String(w.params?.message)))).toBe(true);
  });
  it('keeps a user net literally named UNCONNECTED with two members', () => {
    const footprint = fp.replace('(net 1 "GND")', '(net 1 "UNCONNECTED")').replace('(layers "*.Cu" "*.Mask"))', '(layers "*.Cu" "*.Mask") (net 1 "UNCONNECTED"))');
    const b = parse(board('', footprint, '(net 0 "") (net 1 "UNCONNECTED")'));
    expect(b.nets).toHaveLength(1); expect(b.nets[0].name).toBe('UNCONNECTED'); expect(b.nets[0].pinIds).toHaveLength(2);
  });
  it('B16: rejects absurd source coordinates but accepts large real boards', () => {
    expect(() => parse(board().replace('(at 10 20 90)', '(at 1e20 20 90)'))).toThrow(/exceeds the 1000000000 mm limit/);
    expect(parse(board().replace('(at 10 20 90)', '(at 10000 20 90)')).components[0].position.x).toBe(10000);
  });
  it('treats F&B.Cu pads as through-hole and skips mask-only objects', () => {
    const b = parse(board('', fp.replace('(layers "*.Cu" "*.Mask")', '(layers "F&B.Cu")') + '').replace('(pinfunction "IN"))', '(pinfunction "IN")) (pad "" np_thru_hole circle (at 0 0) (size 1 1) (layers "*.Mask"))'));
    expect(b.pins).toHaveLength(2); expect(b.pins[1].side).toBe('both');
  });
});

describe('KiCad PCB adapter (negatives)', () => {
  it('rejects excessive nesting', () => expect(() => parse('(kicad_pcb ' + '('.repeat(130) + ')'.repeat(130) + ')')).toThrow(/nesting/));
  it('rejects unmatched closing parentheses', () => expect(() => parse(board() + ')')).toThrow(/unmatched closing/));
  it('rejects a pad net without an identifier', () => expect(() => parse(board().replace('(net 1 "GND") (pinfunction', '(net) (pinfunction'))).toThrow(/invalid identifier/));
  it('rejects a non-numeric declared net identifier', () => expect(() => parse(board('', fp, '(net 0 "") (net one "GND")'))).toThrow(/invalid identifier/));
  it('rejects duplicate declared net identifiers', () => expect(() => parse(board('', fp, '(net 1 "GND") (net 1 "VCC")'))).toThrow(/duplicate net/));
  it('rejects footprints on non-outer layers', () => expect(() => parse(board('', fp.replace('(layer "F.Cu")', '(layer "In1.Cu")')))).toThrow(/unsupported layer In1\.Cu/));
  it('rejects unterminated strings and escapes', () => {
    expect(() => parse(board().replace('"GND"', '"GND'))).toThrow(BoardFormatError);
    expect(() => parse('(kicad_pcb (net 1 "a\\')).toThrow(/incomplete string escape/);
  });
  it('rejects a pad without a size', () => expect(() => parse(board().replace('(size 2 1)', ''))).toThrow(/Missing pad width/));
});

const outlineLines = (x0: number, y0: number, x1: number, y1: number) => `(gr_line (start ${x0} ${y0}) (end ${x1} ${y0}) (layer "Edge.Cuts")) (gr_line (start ${x1} ${y0}) (end ${x1} ${y1}) (layer "Edge.Cuts")) (gr_line (start ${x1} ${y1}) (end ${x0} ${y1}) (layer "Edge.Cuts")) (gr_line (start ${x0} ${y1}) (end ${x0} ${y0}) (layer "Edge.Cuts"))`;
const withoutOutline = (extra = '', footprint = fp, nets = '(net 0 "") (net 1 "GND")') => `(kicad_pcb (version 20240108) ${nets} ${footprint} ${extra})`;
const warningKeys = (b: { warnings: { key: string }[] }) => b.warnings.map(w => w.key);
const messages = (b: { warnings: { key: string; params?: Record<string, unknown> }[] }) => b.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));

describe('KiCad PCB adapter (integration, stitcher contract I01/I02)', () => {
  it('I01/I02: parses a minimal valid board through the {loops, openChains} stitcher result without a runtime TypeError', () => {
    const b = parse(`(kicad_pcb (version 20240108) (net 0 "") (net 1 "GND") (footprint "P" (layer "F.Cu") (at 1 2) (property "Reference" "R1") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND"))) (gr_rect (start 0 0) (end 10 5) (layer "Edge.Cuts")))`);
    expect(b.outline).toHaveLength(4); expectBounds(b.bounds, { minX: 0, minY: -5, maxX: 10, maxY: 0 });
    expect(b.warnings).toEqual([{ key: 'parse.warning.fallbackComponents', params: { count: 1 } }]); // No Fab/CrtYd/SilkS graphics: the extent comes from the pad.
  });
  it('B05: an open spur sharing an Edge.Cuts vertex keeps the closed rectangle and is disclosed, never auto-closed', () => {
    const spur = '(gr_line (start 40 0) (end 55 0) (layer "Edge.Cuts"))';
    for (const lines of [`${spur} ${outlineLines(0, 0, 40, 30)}`, `${outlineLines(0, 0, 40, 30)} ${spur}`, `(gr_line (start -1 0) (end 0 0) (layer "Edge.Cuts")) ${outlineLines(0, 0, 40, 30)}`]) {
      const b = parse(withoutOutline(lines));
      expect(b.outline).toHaveLength(4); expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 });
      expect(warningKeys(b)).not.toContain('parse.warning.missingBoardOutline');
      expect(messages(b).some(message => /open Edge\.Cuts chain/.test(message))).toBe(true);
    }
  });
  it('B05/B20 chord coverage: a diagonal Edge.Cuts chord does not shrink the outline to a triangle in either order', () => {
    const chord = '(gr_line (start 0 0) (end 40 30) (layer "Edge.Cuts"))';
    for (const lines of [`${chord} ${outlineLines(0, 0, 40, 30)}`, `${outlineLines(0, 0, 40, 30)} ${chord}`]) {
      const b = parse(withoutOutline(lines));
      expect(b.outline).toHaveLength(4); expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 });
    }
  });
  it('B10: a rectangular and a footprint-level Edge.Cuts cutout are both disclosed once', () => {
    const slot = fp.replace('(fp_rect (start -3 -2)', '(fp_rect (start 1 1) (end 2 2) (layer "Edge.Cuts")) (fp_rect (start -3 -2)');
    const b = parse(board('(gr_rect (start 5 5) (end 8 8) (layer "Edge.Cuts"))', slot));
    expect(b.outline).toHaveLength(4); expect(b.warnings.filter(w => w.key === 'parse.warning.boardCutouts')).toHaveLength(1);
    const footprintOnly = parse(board('', slot));
    expect(footprintOnly.warnings.filter(w => w.key === 'parse.warning.boardCutouts')).toHaveLength(1); expectBounds(footprintOnly.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 });
  });
});

describe('KiCad PCB adapter (net identity, B09/B24)', () => {
  it('B09: rejects two net identifiers that declare the same name and a pad naming a net the table does not declare', () => {
    expect(() => parse(board('', fp, '(net 0 "") (net 1 "GND") (net 2 "GND")'))).toThrow(/same name/);
    expect(() => parse(board('', fp, '(net 0 "") (net 2 "GND")'))).toThrow(/not declared in the net table/);
    expect(() => parse(board('', fp.replace('(net 1 "GND")', '(net 0 "GND")')))).toThrow(/net 0 is named "GND" but the net table declares ""/);
    expect(() => parse(board('', fp.replace('(net 1 "GND")', '(net 3)'), '(net 0 "") (net 3 "")'))).toThrow(/has no name/);
  });
  it('B09: without a net table the pads must not contradict each other (same id, two names; one name, two ids)', () => {
    const second = (pad: string) => fp.replace('(layers "*.Cu" "*.Mask"))', `(layers "*.Cu" "*.Mask") ${pad})`);
    expect(() => parse(board('', second('(net 1 "VCC")'), ''))).toThrow(/name net 1 both "GND" and "VCC"/);
    expect(() => parse(board('', second('(net 2 "GND")'), ''))).toThrow(/net identifiers 1 and 2 have the same name "GND"/);
    expect(parse(board('', second('(net 1 "GND")'), '')).nets).toEqual([{ id: 'net:0', name: 'GND', pinIds: ['pin:0', 'pin:1'] }]);
  });
  it('B24: a legitimate net named UNCONNECTED / Unconnected keeps its identity and membership (only unconnected-(…) singletons are no-connects)', () => {
    for (const name of ['UNCONNECTED', 'Unconnected', 'UNCONNECTED12']) {
      const footprint = fp.replace('(net 1 "GND")', `(net 1 "${name}")`).replace('(layers "*.Cu" "*.Mask"))', `(layers "*.Cu" "*.Mask") (net 1 "${name}"))`);
      const b = parse(board('', footprint, `(net 0 "") (net 1 "${name}")`));
      expect(b.pins.map(pin => pin.net), name).toEqual([name, name]); expect(b.nets).toEqual([{ id: 'net:0', name, pinIds: ['pin:0', 'pin:1'] }]);
      expect(warningKeys(b)).not.toContain('parse.warning.noNets');
    }
  });
  it('a two-pad unconnected-(…) net is a real net; only single-pad placeholders are dropped', () => {
    const footprint = fp.replace('(net 1 "GND")', '(net 2 "unconnected-(U1-Pad1)")').replace('(layers "*.Cu" "*.Mask"))', '(layers "*.Cu" "*.Mask") (net 2 "unconnected-(U1-Pad1)"))');
    const b = parse(board('', footprint, '(net 0 "") (net 1 "GND") (net 2 "unconnected-(U1-Pad1)")'));
    expect(b.nets).toHaveLength(1); expect(b.nets[0].pinIds).toHaveLength(2);
  });
});

describe('KiCad PCB adapter (geometry: B16, B19, B27, arcs, curves)', () => {
  it('B16: every coordinate path is capped at 1e9 mm, including pad sizes, Edge.Cuts, footprint graphics and arcs', () => {
    const limit = /exceeds the 1000000000 mm limit/;
    expect(() => parse(board().replace('(size 2 1)', '(size 1e20 1)'))).toThrow(limit);
    expect(() => parse(board().replace('(size 2 1)', '(size 2 -1e10)'))).toThrow(limit);
    expect(() => parse(board('(gr_line (start 0 0) (end 1e20 0) (layer "Edge.Cuts"))'))).toThrow(limit);
    expect(() => parse(board('(gr_circle (center 20 15) (end 1e12 15) (layer "Edge.Cuts"))'))).toThrow(limit);
    expect(() => parse(board('', fp.replace('(start -3 -2)', '(start -3e10 -2)')))).toThrow(limit);
    expect(() => parse(board().replace('(at 2 3 90)', '(at 2 1e11 90)'))).toThrow(limit);
    expect(() => parse(board('(gr_arc (start 0 0) (mid 5e8 1e-4) (end 1e9 0) (layer "Edge.Cuts"))'))).not.toThrow();
    expect(() => parse(board('(gr_arc (start 0 0) (mid 5e8 1e-4) (end 2e9 0) (layer "Edge.Cuts"))'))).toThrow(limit);
    // Footprint origin and pad offset are each within the cap but their sum is not: the canonical cap in buildBoard catches it.
    expect(() => parse(board().replace('(at 10 20 90)', '(at 9e8 20 0)').replace('(at 2 3 90)', '(at 9e8 3 0)'))).toThrow(/exceeds the supported range/);
  });
  it('B16: a nearly collinear three-point arc is drawn as a polyline instead of an astronomically distant circle centre', () => {
    const b = parse(board('(gr_arc (start 0 0) (mid 20 1e-9) (end 40 0) (layer "Edge.Cuts"))'));
    expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 });
    const far = parse(withoutOutline('(gr_arc (start 0 0) (mid 5e8 1e-4) (end 1e9 0) (layer "Edge.Cuts")) (gr_line (start 1e9 0) (end 0 0) (layer "Edge.Cuts"))'));
    expect(far.bounds.maxX).toBeLessThanOrEqual(1e9); expect(Math.abs(far.bounds.minY)).toBeLessThan(1);
  });
  it('B19: without Fab/CrtYd/SilkS graphics and Edge.Cuts the component and board extents enclose the real pad rectangle', () => {
    const bare = (pad: string) => `(kicad_pcb (version 20240108) (net 0 "") (net 1 "GND") (footprint "X" (layer "F.Cu") (at 0 0) (property "Reference" "U1") ${pad}))`;
    const rect = parse(bare('(pad "1" smd rect (at 0 0) (size 20 10) (layers "F.Cu") (net 1 "GND"))'));
    expectBounds(rect.components[0].bounds, { minX: -10, minY: -5, maxX: 10, maxY: 5 }); expectBounds(rect.bounds, { minX: -10, minY: -5, maxX: 10, maxY: 5 });
    expect(warningKeys(rect)).toEqual(expect.arrayContaining(['parse.warning.fallbackComponents', 'parse.warning.missingBoardOutline']));
    const diagonal = parse(bare('(pad "1" smd rect (at 0 0 45) (size 20 10) (layers "F.Cu") (net 1 "GND"))'));
    expectBounds(diagonal.components[0].bounds, { minX: -15 / Math.SQRT2, minY: -15 / Math.SQRT2, maxX: 15 / Math.SQRT2, maxY: 15 / Math.SQRT2 });
    const round = parse(bare('(pad "1" thru_hole circle (at 0 0) (size 10 10) (drill 4) (layers "*.Cu") (net 1 "GND"))'));
    expectBounds(round.bounds, { minX: -5, minY: -5, maxX: 5, maxY: 5 });
  });
  it('B27: a circular pad keeps its radius extent at 45 degrees (no rotated-square inflation)', () => {
    const b = parse(`(kicad_pcb (version 20240108) (net 0 "") (net 1 "GND") (footprint "X" (layer "F.Cu") (at 0 0) (property "Reference" "U1") (pad "1" thru_hole circle (at 20 30 45) (size 4 4) (drill 1) (layers "*.Cu") (net 1 "GND"))))`);
    expect(b.pins[0]).toMatchObject({ shape: 'round', radius: 2, rotation: 45 });
    expectBounds(b.components[0].bounds, { minX: 18, minY: -32, maxX: 22, maxY: -28 }); expectBounds(b.bounds, { minX: 18, minY: -32, maxX: 22, maxY: -28 });
  });
  it('reads KiCad 7+ three-point arcs and KiCad 4/5 centre-and-angle arcs into the outline', () => {
    const modern = parse(withoutOutline('(gr_line (start 0 0) (end 30 0) (layer "Edge.Cuts")) (gr_arc (start 30 0) (mid 45 15) (end 30 30) (layer "Edge.Cuts")) (gr_line (start 30 30) (end 0 30) (layer "Edge.Cuts")) (gr_line (start 0 30) (end 0 0) (layer "Edge.Cuts"))'));
    expectBounds(modern.bounds, { minX: 0, minY: -30, maxX: 45, maxY: 0 }); expect(warningKeys(modern)).not.toContain('parse.warning.missingBoardOutline');
    const legacy = parse(withoutOutline('(gr_arc (start 20 15) (end 35 15) (angle 180) (layer Edge.Cuts) (width 0.15)) (gr_line (start 5 15) (end 35 15) (layer Edge.Cuts) (width 0.15))'));
    expectBounds(legacy.bounds, { minX: 5, minY: -15, maxX: 35, maxY: 0 }); expect(warningKeys(legacy)).not.toContain('parse.warning.missingBoardOutline');
  });
  it('reads cubic Bezier Edge.Cuts curves', () => {
    const b = parse(withoutOutline('(gr_curve (pts (xy 0 0) (xy 10 10) (xy 30 10) (xy 40 0)) (layer "Edge.Cuts")) (gr_line (start 40 0) (end 40 -30) (layer "Edge.Cuts")) (gr_line (start 40 -30) (end 0 -30) (layer "Edge.Cuts")) (gr_line (start 0 -30) (end 0 0) (layer "Edge.Cuts"))'));
    expectBounds(b.bounds, { minX: 0, minY: -7.5, maxX: 40, maxY: 30 }); expect(warningKeys(b)).not.toContain('parse.warning.missingBoardOutline');
  });
});

describe('KiCad PCB adapter (format generations, sides, pad shapes)', () => {
  const legacyBoard = `(kicad_pcb (version 20171130) (host pcbnew 5.1.12)
 (general (thickness 1.6)) (page A4) (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
 (net 0 "") (net 1 GND) (net 2 +3V3)
 (module Resistor_SMD:R_0603 (layer F.Cu) (tedit 5B301BBD) (tstamp 5E123456) (at 10 20 90)
  (fp_text reference R1 (at 0 -1.43 90) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15))))
  (fp_text value 10k (at 0 1.43 90) (layer F.Fab) (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (layer F.CrtYd) (width 0.05)) (fp_line (start 1.5 -0.8) (end 1.5 0.8) (layer F.CrtYd) (width 0.05))
  (fp_line (start 1.5 0.8) (end -1.5 0.8) (layer F.CrtYd) (width 0.05)) (fp_line (start -1.5 0.8) (end -1.5 -0.8) (layer F.CrtYd) (width 0.05))
  (pad 1 smd roundrect (at -0.8 0 90) (size 0.8 0.9) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.25) (net 1 GND))
  (pad 2 smd roundrect (at 0.8 0 90) (size 0.8 0.9) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.25) (net 2 +3V3)))
 (module Connector:Hole (layer B.Cu) (at 30 10)
  (fp_text reference J1 (at 0 0) (layer B.SilkS)) (fp_text value Hole (at 0 1) (layer B.Fab))
  (pad 1 thru_hole oval (at 0 0) (size 2 1) (drill oval 1.2 0.6) (layers *.Cu *.Mask) (net 1 GND)))
 ${outlineLines(0, 0, 40, 30).replace(/"/g, '')})`;
  it('KiCad 4/5 style (module, unquoted layers/net names, fp_text, legacy nets): geometry, sides, nets and approximated pads', () => {
    const b = parse(legacyBoard);
    expect(b.components.map(c => [c.ref, c.value, c.package, c.side])).toEqual([['R1', '10k', 'Resistor_SMD:R_0603', 'top'], ['J1', 'Hole', 'Connector:Hole', 'bottom']]);
    expect(b.pins.map(pin => [pin.net, pin.side, pin.shape])).toEqual([['GND', 'top', 'rect'], ['+3V3', 'top', 'rect'], ['GND', 'both', 'rect']]);
    expect(b.pins[0].x).toBeCloseTo(10, 9); expect(b.pins[0].y).toBeCloseTo(-20.8, 9); expect(b.pins[1].y).toBeCloseTo(-19.2, 9);
    expect(b.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 2], ['+3V3', 1]]);
    expect(b.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 3 } });
    expectBounds(b.bounds, { minX: 0, minY: -30, maxX: 40, maxY: 0 });
    // The CrtYd rectangle (3 x 1.6) is rotated with the footprint: 90 degrees swaps its extents.
    expectBounds(b.components[0].bounds, { minX: 9.2, minY: -21.5, maxX: 10.8, maxY: -18.5 });
  });
  it('KiCad 6 style (footprint with fp_text and a pinfunction) and the property-based 8+ style produce the same component data', () => {
    const six = parse(board('', fp.replace('(property "Reference" "U1") (property "Value" "α quoted \\"value\\"")', '(fp_text reference "U1" (at 0 0) (layer "F.SilkS")) (fp_text value "α quoted \\"value\\"" (at 0 1) (layer "F.Fab"))')));
    const eight = parse(board());
    expect(six.components).toEqual(eight.components); expect(six.pins).toEqual(eight.pins);
  });
  it('B.Cu footprints and mixed pad layers: pad side follows the pad layers, component side the footprint layer', () => {
    const b = parse(board('', fp.replace('(layer "F.Cu") (at 10 20 90)', '(layer "B.Cu") (at 10 20 90)').replace('(layers "F.Cu")', '(layers "B.Cu")')));
    expect(b.components[0].side).toBe('bottom'); expect(b.pins.map(pin => pin.side)).toEqual(['bottom', 'both']);
    const mixed = parse(board('', fp.replace('(layers "F.Cu")', '(layers "B.Cu")')));
    expect(mixed.components[0].side).toBe('top'); expect(mixed.pins[0].side).toBe('bottom');
  });
  it('counts oval, roundrect, trapezoid, custom and non-square circle pads as approximated; rect, square and round are exact', () => {
    const pad = (shape: string, size = '2 1') => `(pad "1" smd ${shape} (at 0 0) (size ${size}) (layers "F.Cu") (net 1 "GND"))`;
    const count = (shape: string, size?: string) => parse(board('', `(footprint "X" (layer "F.Cu") (at 0 0) (property "Reference" "U1") ${pad(shape, size)})`)).warnings.find(w => w.key === 'parse.warning.approximatedPads')?.params?.count ?? 0;
    for (const shape of ['oval', 'roundrect', 'trapezoid', 'custom']) expect(count(shape), shape).toBe(1);
    expect(count('circle', '2 1')).toBe(1);
    for (const [shape, size] of [['rect', '2 1'], ['rect', '1 1'], ['circle', '1 1']] as const) expect(count(shape, size), `${shape} ${size}`).toBe(0);
    const square = parse(board('', `(footprint "X" (layer "F.Cu") (at 0 0) (property "Reference" "U1") ${pad('rect', '1 1')})`));
    expect(square.pins[0].shape).toBe('square');
  });
  it('ignores tracks, vias and zones (no electrical data of their own) and keeps pad nets', () => {
    const b = parse(board('(segment (start 0 0) (end 5 5) (width 0.2) (layer "F.Cu") (net 1)) (via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1)) (zone (net 1) (net_name "GND") (layer "F.Cu"))'));
    expect(b.pins).toHaveLength(2); expect(b.nets[0].pinIds).toHaveLength(1);
  });
});

// Real-file findings (S3 Antmicro Jetson Nano baseboard, a 28 MB KiCad 9 board): every construct below is reproduced with a small
// ORIGINAL synthetic generator, never with real bytes.
describe('KiCad PCB adapter (real-file findings: big boards, noisy outline corners)', () => {
  const line = (i: number) => `(fp_line (start 0 ${i}) (end 1 ${i}) (layer "F.SilkS"))`;
  const footprintWithLines = (ref: string, lines: number) => `(footprint "Test:Lines" (layer "F.Cu") (at 10 20) (property "Reference" "${ref}") ${Array.from({ length: lines }, (_, i) => line(i)).join(' ')}
   (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND")))`;
  it('W-open-kicad-01: a board with more than 2 million expressions in footprint graphics parses (every footprint is small)', () => {
    // 200 footprints x 800 lines x 13 expressions = 2.08 million expressions in total; no single element is large.
    const many = Array.from({ length: 200 }, (_, i) => footprintWithLines(`R${i + 1}`, 800)).join('\n');
    const b = parse(withoutOutline(outlineLines(0, 0, 40, 30), many));
    expect(b.components).toHaveLength(200); expect(b.pins).toHaveLength(200); expect(b.nets[0].pinIds).toHaveLength(200);
    expect(b.components[199].ref).toBe('R200');
    expectBounds(b.components[0].bounds, { minX: 10, minY: -819, maxX: 11, maxY: -20 });
  });
  it('W-open-kicad-01: tracks, vias and zones are never built and no longer count toward the expression limit', () => {
    // 110000 segments x 19 expressions = 2.09 million expressions of data the adapter does not read.
    const tracks = Array.from({ length: 110_000 }, (_, i) => `(segment (start 0 ${i}) (end 1 ${i}) (width 0.2) (layer "F.Cu") (net 1))`).join(' ');
    const b = parse(board(tracks));
    expect(b.pins).toHaveLength(2); expect(b.outline).toHaveLength(4);
  });
  it('W-open-kicad-01: one single element with more than 2 million expressions is still refused', () => {
    expect(() => parse(withoutOutline('', footprintWithLines('U1', 160_000)))).toThrow(/expression count exceeds the import limit/);
  });
  it('W-open-kicad-01: skipped elements are still checked for syntax, strings and nesting', () => {
    expect(() => parse(board('(zone (net 1) (polygon (pts (xy 0 0) (xy 1 "unterminated))))'))).toThrow(/unterminated quoted string/);
    expect(() => parse('(kicad_pcb (zone (net_name "a\\')).toThrow(/incomplete string escape/);
    expect(() => parse(board(`(zone ${'('.repeat(130)}${')'.repeat(130)})`))).toThrow(/nesting/);
    expect(() => parse(board().slice(0, -1) + ' (zone (net 1)')).toThrow(/Malformed/);
    expect(() => parse(board('(zone (net 1) (filled_polygon ; a comment with a ) inside\n (pts (xy 0 0))))'))).not.toThrow();
    expect(() => parse(board() + '(extra)')).toThrow(/Malformed/);
  });
  it('W-open-kicad-01: a footprint error is reported after net-table errors and after earlier pads, exactly as before the streaming read', () => {
    const bad = `(footprint "Bad" (layer "In1.Cu") (at 0 0) (property "Reference" "X1"))`;
    expect(() => parse(board('', `${bad} ${fp}`, '(net 0 "") (net one "GND")'))).toThrow(/invalid identifier/); // the net table is checked first
    expect(() => parse(board('', `${fp.replace('(net 1 "GND")', '(net 9 "NOPE")')} ${bad}`))).toThrow(/not declared in the net table/); // an earlier pad's net precedes a later footprint's layer error
    expect(() => parse(board('', `${fp} ${bad}`))).toThrow(/unsupported layer In1\.Cu/);
  });
  it('W-open-kicad-03: the "_1" suffixed placeholder of a second pad with the same number is a no-connect too; a real two-pad net keeps its name', () => {
    const twoFives = `(footprint "Test:Dup" (layer "F.Cu") (at 0 0) (property "Reference" "U1")
     (pad "5" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "unconnected-(U1-Pad5)"))
     (pad "5" smd rect (at 3 0) (size 1 1) (layers "F.Cu") (net 3 "unconnected-(U1-Pad5)_1"))
     (pad "6" smd rect (at 6 0) (size 1 1) (layers "F.Cu") (net 4 "unconnected-(U1-Pad6)_1"))
     (pad "7" smd rect (at 9 0) (size 1 1) (layers "F.Cu") (net 4 "unconnected-(U1-Pad6)_1")))`;
    const b = parse(withoutOutline('', twoFives, '(net 0 "") (net 2 "unconnected-(U1-Pad5)") (net 3 "unconnected-(U1-Pad5)_1") (net 4 "unconnected-(U1-Pad6)_1")'));
    expect(b.pins.map(pin => pin.net)).toEqual(['', '', 'unconnected-(U1-Pad6)_1', 'unconnected-(U1-Pad6)_1']);
    expect(b.nets.map(net => net.name)).toEqual(['unconnected-(U1-Pad6)_1']);
    expect(messages(b).some(message => /^2 KiCad "unconnected-/.test(message))).toBe(true);
  });
  it('W-open-kicad-04: pads without a number never take a number a real pad of the same footprint uses', () => {
    const socket = `(footprint "Test:Socket" (layer "F.Cu") (at 0 0) (property "Reference" "P3")
     (pad "1" thru_hole rect (at 0 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "GND"))
     (pad "" np_thru_hole circle (at 3 0) (size 2 2) (drill 2) (layers "*.Cu" "*.Mask"))
     (pad "2" thru_hole circle (at 6 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "GND"))
     (pad "" smd circle (at 9 0) (size 1 1) (layers "F.Cu") ) (pad "~1" smd circle (at 12 0) (size 1 1) (layers "F.Cu")))`;
    const b = parse(withoutOutline('', socket));
    // before the fix the board model numbered the first unnumbered pad "2" (its position in the board plus one): the same number as a real pad
    expect(b.pins.map(pin => pin.number)).toEqual(['1', '~2', '2', '~3', '~1']);
    expect(new Set(b.pins.map(pin => pin.number)).size).toBe(b.pins.length);
    expect(b.pins.map(pin => pin.name)).toEqual(['1', '', '2', '', '~1']);
    // only the numbers the reader made up are flagged; a pad the file itself calls "~1" keeps a real number
    expect(b.pins.map(pin => pin.numberGenerated)).toEqual([undefined, true, undefined, true, undefined]);
  });
  it('flags a footprint without a Reference property: its FP<n> placeholder is shown but is not an identity', () => {
    const named = '(footprint "Test:R" (layer "F.Cu") (at 0 0) (property "Reference" "R1") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';
    const unnamed = '(footprint "Test:R" (layer "F.Cu") (at 5 0) (pad "1" smd rect (at 5 0) (size 1 1) (layers "F.Cu")))';
    const b = parse(withoutOutline('', `${named} ${unnamed}`));
    expect(b.components.map(component => [component.ref, component.refGenerated])).toEqual([['R1', undefined], ['FP2', true]]);
  });
  it('W-open-kicad-02: end points that differ by 20 nm still close the board-edge contour; a 0.02 mm gap does not', () => {
    const edge = (gap: number) => `(gr_line (start 0 ${30 + gap}) (end 0 0) (layer "Edge.Cuts")) (gr_line (start 0 30) (end 40 30) (layer "Edge.Cuts")) (gr_line (start 40 30) (end 40 0) (layer "Edge.Cuts")) (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts"))`;
    for (const gap of [0.00002, 0.005]) {
      const b = parse(withoutOutline(edge(gap)));
      expect(b.outline, String(gap)).toHaveLength(4); expect(warningKeys(b)).not.toContain('parse.warning.missingBoardOutline'); expect(messages(b).some(m => /closed contour|open Edge/.test(m))).toBe(false);
    }
    const open = parse(withoutOutline(edge(0.02)));
    expect(warningKeys(open)).toContain('parse.warning.missingBoardOutline'); expect(messages(open).some(m => /closed contour/.test(m))).toBe(true);
  });
});

// Real-file findings (ten KiCad 5 demo boards that rename their copper layers; one KiCad 9 demo board whose teardrop settings lack a
// parenthesis): every construct below is reproduced with small ORIGINAL synthetic boards, never with real bytes.
const failure = (run: () => unknown): BoardFormatError => { try { run(); } catch (error) { return error as BoardFormatError; } throw new Error('did not throw'); };
const copperNotes = (b: { warnings: { key: string; params?: Record<string, unknown> }[] }) => messages(b).filter(m => /copper layers/.test(m));

describe('KiCad PCB adapter (real-file findings: copper layers renamed by the design)', () => {
  const userLayers = '(32 B.Adhes user) (33 F.Adhes user) (34 B.Paste user) (35 F.Paste user) (36 B.SilkS user) (37 F.SilkS user) (38 B.Mask user) (39 F.Mask user) (44 Edge.Cuts user)';
  const parts = (front: string, back: string) => `(module Resistor_SMD:R_0603 (layer ${front}) (at 10 20)
   (fp_text reference R1 (at 0 0) (layer F.SilkS)) (fp_text value 10k (at 0 1) (layer F.Fab))
   (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (layer F.CrtYd)) (fp_line (start 1.5 -0.8) (end 1.5 0.8) (layer F.CrtYd))
   (pad 1 smd rect (at -0.8 0) (size 0.8 0.9) (layers ${front} F.Paste F.Mask) (net 1 GND))
   (pad 2 smd rect (at 0.8 0) (size 0.8 0.9) (layers ${front} F.Paste F.Mask) (net 2 +3V3))
   (pad 3 smd rect (at 0 2) (size 0.8 0.9) (layers F.Paste F.Mask)))
  (module Connector:Pin (layer ${back}) (at 30 10)
   (fp_text reference J1 (at 0 0) (layer B.SilkS)) (fp_text value Pin (at 0 1) (layer B.Fab))
   (pad 1 smd rect (at 0 0) (size 1 1) (layers ${back} B.Paste B.Mask) (net 1 GND))
   (pad 2 thru_hole circle (at 3 0) (size 1.4 1.4) (drill 0.8) (layers *.Cu *.Mask) (net 2 +3V3)))`;
  const legacy = (copper: string, front = 'F.Cu', back = 'B.Cu', body = parts(front, back)) => `(kicad_pcb (version 20171130) (host pcbnew 5.1.12) (general (thickness 1.6))
   (layers ${copper} ${userLayers}) (net 0 "") (net 1 GND) (net 2 +3V3) ${body} ${outlineLines(0, 0, 40, 30).replace(/"/g, '')})`;
  const standard = parse(legacy('(0 F.Cu signal) (31 B.Cu signal)'));

  it('reads the front and back layer by number and type, whatever the design calls them: the same board as with the standard names', () => {
    for (const [front, back] of [['top_copper', 'bottom_copper'], ['Dessus', 'Dessous'], ['Top_layer', 'Bottom_layer'], ['top_cu', 'bottom_cu'], ['Épaisseur 1', 'Épaisseur 2']]) {
      const b = parse(legacy(`(0 "${front}" signal) (31 "${back}" signal)`, `"${front}"`, `"${back}"`));
      expect(b.components, front).toEqual(standard.components); expect(b.pins, front).toEqual(standard.pins); expect(b.nets, front).toEqual(standard.nets);
      expect(b.outline, front).toEqual(standard.outline);
      expect(b.components.map(c => c.side)).toEqual(['top', 'bottom']);
      // the surface-mount pads that list only the renamed layer are kept (not taken for mask-only objects); the pad on mask and paste alone is not a pad
      expect(b.pins.map(pin => pin.side)).toEqual(['top', 'top', 'bottom', 'both']); expect(b.nets.map(net => net.pinIds.length)).toEqual([2, 2]);
    }
  });
  it('keeps the design\'s own names as labels and says which names were read by number', () => {
    const b = parse(legacy('(0 top_copper signal) (31 bottom_copper signal)', 'top_copper', 'bottom_copper'));
    expect(copperNotes(b)).toHaveLength(1); expect(copperNotes(b)[0]).toContain('top_copper is the front copper layer (0); bottom_copper is the back copper layer (31).');
    expect(copperNotes(standard)).toEqual([]); expect(standard.warnings).toEqual(standard.warnings.filter(w => w.key === 'parse.warning.fallbackComponents' || w.key === 'parse.warning.approximatedPads'));
  });
  it('takes the number, not the type, as the position: front and back may be power, mixed or jumper layers', () => {
    for (const [front, back] of [['power', 'signal'], ['signal', 'power'], ['mixed', 'jumper']]) {
      const b = parse(legacy(`(0 top_copper ${front}) (31 bottom_copper ${back})`, 'top_copper', 'bottom_copper'));
      expect(b.components.map(c => c.side), `${front}/${back}`).toEqual(['top', 'bottom']); expect(b.pins).toEqual(standard.pins);
    }
  });
  it('renamed inner layers: no footprint sits on one, a pad that lists only one is not an electrical pad, and the note names them with their numbers', () => {
    const inner = '(0 top_copper signal) (1 GND_layer power) (2 VCC_layer power) (31 bottom_copper signal)';
    const withInnerPad = parts('top_copper', 'bottom_copper').replace('(pad 3 smd rect (at 0 2) (size 0.8 0.9) (layers F.Paste F.Mask))', '(pad 3 smd rect (at 0 2) (size 0.8 0.9) (layers GND_layer F.Mask))');
    const b = parse(legacy(inner, 'top_copper', 'bottom_copper', withInnerPad));
    expect(b.pins).toEqual(standard.pins); expect(b.components.map(c => c.side)).toEqual(['top', 'bottom']);
    expect(copperNotes(b)[0]).toContain('GND_layer is the inner copper layer (1); VCC_layer is the inner copper layer (2); bottom_copper is the back copper layer (31)');
    // renamed inner layers alone: the reading does not depend on them, so the board says nothing
    expect(copperNotes(parse(legacy('(0 F.Cu signal) (1 GND_layer power) (2 VCC_layer power) (31 B.Cu signal)')))).toEqual([]);
    const onInner = parts('GND_layer', 'bottom_copper');
    expect(() => parse(legacy(inner, 'GND_layer', 'bottom_copper', onInner))).toThrow(/unsupported layer GND_layer/);
  });
  it('the standard names keep their meaning next to the design\'s own names, as KiCad reads them', () => {
    const b = parse(legacy('(0 top_copper signal) (31 bottom_copper signal)', 'F.Cu', 'B.Cu'));
    expect(b.components).toEqual(standard.components); expect(b.pins).toEqual(standard.pins);
  });
  it('KiCad 9 numbering: the back layer is 2 and the inner layers 4, 6, ...; a user label after the type is not a rename, and a user layer typed "signal" is not copper', () => {
    const nine = '(layers (0 "F.Cu" signal "top_copper") (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal "bottom_copper") (9 "F.Adhes" user "F.Adhesive") (31 "F.CrtYd" user "F.Courtyard") (39 "User.1" signal) (41 "User.2" user)) (net 0 "") (net 1 "GND")';
    const front = parse(board('', fp, nine)), back = parse(board('', fp.replace('(layer "F.Cu") (at 10 20 90)', '(layer "B.Cu") (at 10 20 90)').replace('(layers "F.Cu")', '(layers "B.Cu")'), nine));
    expect(front.components[0].side).toBe('top'); expect(front.warnings).toEqual([]);
    expect(back.components[0].side).toBe('bottom'); expect(back.pins.map(pin => pin.side)).toEqual(['bottom', 'both']); expect(back.warnings).toEqual([]);
    expect(() => parse(board('', fp.replace('(layer "F.Cu")', '(layer "User.1")'), nine))).toThrow(/unsupported layer User\.1/);
    expect(() => parse(board('', fp.replace('(layer "F.Cu")', '(layer "In1.Cu")'), nine))).toThrow(/unsupported layer In1\.Cu/);
    // an inner layer renamed alone changes nothing that is shown (no footprint sits on one), so the board says nothing; a footprint on it is still refused
    const renamedInner = board('', fp, nine.replace('(4 "In1.Cu" signal)', '(4 "GND" signal)'));
    expect(copperNotes(parse(renamedInner))).toEqual([]); expect(parse(renamedInner).warnings).toEqual([]);
    expect(() => parse(board('', fp.replace('(layer "F.Cu")', '(layer "GND")'), nine.replace('(4 "In1.Cu" signal)', '(4 "GND" signal)')))).toThrow(/unsupported layer GND/);
  });
  it('KiCad 6-8 numbering with an inner layer: 31 is the back layer, and number 2 is an inner layer there', () => {
    const six = '(layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" power) (31 "B.Cu" signal) (32 "B.Adhes" user "B.Adhesive") (44 "Edge.Cuts" user)) (net 0 "") (net 1 "GND")';
    const b = parse(board('', fp.replace('(layer "F.Cu") (at 10 20 90)', '(layer "B.Cu") (at 10 20 90)'), six));
    expect(b.components[0].side).toBe('bottom'); expect(b.warnings).toEqual([]);
    expect(() => parse(board('', fp.replace('(layer "F.Cu")', '(layer "In2.Cu")'), six))).toThrow(/unsupported layer In2\.Cu/);
  });
  it('a name from the file cannot break or flood the note: control characters are dropped and the length is bounded', () => {
    const odd = `top\\ncopper ${'x'.repeat(200)}`;
    const b = parse(legacy(`(0 "${odd}" signal) (31 bottom_copper signal)`, `"${odd}"`, 'bottom_copper'));
    const note = copperNotes(b)[0];
    expect(note).not.toMatch(/[\r\n]/); expect(note.length).toBeLessThan(400); expect(note).toContain('top copper xxxx');
    expect(failure(() => parse(legacy('(0 a signal) (31 b signal)', 'a', `"${'q'.repeat(200)}"`))).message).toContain(`unsupported layer ${'q'.repeat(40)}.`);
  });
  it('a layer table that cannot be read is refused: repeated numbers or names, malformed entries, a table beyond the layer limit, or a second table', () => {
    expect(() => parse(legacy('(0 a signal) (0 b signal)'))).toThrow(/layer number 0 twice/);
    expect(() => parse(legacy('(0 a signal) (31 a signal)'))).toThrow(/layer name "a" twice/);
    expect(() => parse(legacy('(0 a)'))).toThrow(/malformed layer entry/);
    expect(() => parse(legacy('(zero a signal)'))).toThrow(/malformed layer entry/);
    expect(() => parse(legacy('(0 "" signal)'))).toThrow(/malformed layer entry/);
    expect(() => parse(legacy('0 a signal'))).toThrow(/not a layer/);
    expect(() => parse(legacy('(0 (a) signal)'))).toThrow(/malformed layer entry/);
    const many = Array.from({ length: 513 }, (_, i) => `(${i} L${i} user)`).join(' ');
    expect(() => parse(board('', fp, `(layers ${Array.from({ length: 512 }, (_, i) => `(${i} L${i} user)`).join(' ')}) (net 0 "") (net 1 "GND")`))).not.toThrow();
    expect(failure(() => parse(board('', fp, `(layers ${many}) (net 0 "") (net 1 "GND")`))).code).toBe('LIMIT_EXCEEDED');
    expect(() => parse(legacy('(0 F.Cu signal)', 'F.Cu', 'B.Cu', '(layers (0 F.Cu signal)) ' + parts('F.Cu', 'B.Cu')))).toThrow(/more than one layer table/);
  });
});

describe('KiCad PCB adapter (real-file findings: teardrop settings without their opening parenthesis)', () => {
  const settings = (curved: string) => `(teardrops (best_length_ratio 0.5) (max_length 1) (best_width_ratio 1) (max_width 2) ${curved} (enabled yes) (allow_two_segments yes) (prefer_zone_connections yes))`;
  const whole = '(curved_edges no) (filter_ratio 0.9)', lost = '(curved_edges no)filter_ratio 0.9)';
  /** The test footprint with `first` in its first pad and `second` in its second one. */
  const withSettings = (first: string, second = '') => fp.replace('(pinfunction "IN")', `(pinfunction "IN") ${first}`).replace('(layers "*.Cu" "*.Mask")', `(layers "*.Cu" "*.Mask") ${second}`);
  const noteOf = (b: { warnings: { key: string; params?: Record<string, unknown> }[] }) => messages(b).filter(m => /teardrop/.test(m));

  it('reads a pad whose settings lack a parenthesis like the well-formed pad, and says how many were read that way', () => {
    const reference = parse(board('', withSettings(settings(whole))));
    expect(reference.warnings).toEqual([]);
    const b = parse(board('', withSettings(settings(lost))));
    expect(b.components).toEqual(reference.components); expect(b.pins).toEqual(reference.pins); expect(b.nets).toEqual(reference.nets); expect(b.outline).toEqual(reference.outline);
    expect(noteOf(b)).toEqual(['1 KiCad teardrop settings lack their opening parenthesis; they were read as KiCad reads them.']);
    const two = parse(board('', withSettings(settings(lost), settings(lost))));
    expect(two.pins).toEqual(reference.pins); expect(noteOf(two)).toEqual(['2 KiCad teardrop settings lack their opening parenthesis; they were read as KiCad reads them.']);
  });
  it('reads the same in elements that are only checked and never built (a via, a zone)', () => {
    const via = (text: string) => `(via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) ${text})`;
    const b = parse(board(via(settings(lost)) + ' ' + via(settings(lost)) + ' ' + via(settings(whole))));
    expect(b.pins).toEqual(parse(board()).pins); expect(noteOf(b)[0]).toMatch(/^2 KiCad teardrop settings/);
    expect(noteOf(parse(board(via(settings(whole)))))).toEqual([]);
    expect(() => parse(board(`(zone (net 1) (net_name "GND") (layer "F.Cu") ${settings(lost)})`))).not.toThrow();
  });
  it('the allowance is for the settings list only: the same text anywhere else is still a malformed document', () => {
    expect(() => parse(board('', withSettings(lost)))).toThrow(/Malformed/);
    expect(() => parse(board(`(via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (curved_edges no)filter_ratio 0.9))`))).toThrow(/Malformed|unmatched closing/);
  });
  it('a missing parenthesis that is not the one of an element still leaves the document unbalanced and is refused', () => {
    expect(() => parse(board('', withSettings('(teardrops filter_ratio 0.9)')))).toThrow(/Malformed/);
    expect(() => parse(board('', withSettings('(teardrops (max_length 1)')))).toThrow(/Malformed/);
  });
  it('the nesting limit counts the element that lost its parenthesis, built or skipped', () => {
    const built = (depth: number) => board('', fp.replace('(pinfunction "IN")', `(pinfunction "IN") ${'(a '.repeat(depth)}(teardrops x))${')'.repeat(depth)}`));
    const skipped = (depth: number) => board(`(via ${'(a '.repeat(depth)}(teardrops x))${')'.repeat(depth)})`);
    for (const [label, make] of [['built', built], ['skipped', skipped]] as const) {
      let deepest = 0;
      for (let depth = 100; depth < 130; depth++) { try { parse(make(depth)); deepest = depth; } catch (error) { expect((error as BoardFormatError).message, label).toMatch(/nesting/); } }
      expect(deepest, label).toBeGreaterThan(100); expect(deepest, label).toBeLessThan(129);
      expect(() => parse(make(deepest + 1)), label).toThrow(/nesting/);
      // the same document with the element written out has the same depth: the limit is the same one
      expect(() => parse(make(deepest).replace('(teardrops x))', '(teardrops (x))')), label).not.toThrow();
      expect(() => parse(make(deepest + 1).replace('(teardrops x))', '(teardrops (x))')), label).toThrow(/nesting/);
    }
  });
});
