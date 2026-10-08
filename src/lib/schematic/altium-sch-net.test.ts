import { describe, expect, it } from 'vitest';
import { buildBoardIndex, buildSchematicIndex, linkBoardSchematic, mapSchematicSelectionToBoard } from '../crossprobe';
import type { Board } from '../types';
import {
  close, codes, connect, def, divider, lower, mmX, mmY, must, netName, netOf, pinOf, pinsOf, project, sameNet, Sheet, symbolOf, container, framed, enc,
} from './altium-sch-fixtures';
import { pinKey, symbolKey } from './model';

// Connectivity of synthetic SchDoc fixtures, computed by the shared engine (connectivity.ts) and read back by designator and pin number.

describe('wires, junctions, labels and power ports', () => {
  it('connects the reference design by geometry and names the nets by label and power port', () => {
    const r = must(divider().file());
    const c = connect(r);
    expect(c.nets.map(n => [n.name, pinsOf(n)]).sort()).toEqual([['GND', ['R2.2']], ['MID', ['R1.2', 'R2.1']], ['VCC', ['R1.1']]]);
    expect(netOf(c, 'R1.2')?.scope).toBe('global');
    expect(c.floatingPins).toEqual([]);
    expect(c.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
    expect(r.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
  });

  it('turns a power port into a global, virtual symbol with one hidden pin at its connection point', () => {
    const d = def(must(divider().file()));
    const vcc = d.symbols.find(s => s.power?.net === 'VCC')!;
    expect(vcc).toMatchObject({ virtual: true, libId: 'power:VCC', unit: 1, unitCount: 1 });
    expect(vcc.pins).toHaveLength(1);
    expect(vcc.pins[0]).toMatchObject({ number: '1', name: 'VCC', hidden: true, type: 'power_in' });
    close(vcc.pins[0].at.x, mmX(180)); close(vcc.pins[0].at.y, mmY(540));
    expect(vcc.graphics.length).toBeGreaterThan(1);
    expect(vcc.graphics.some(g => g.kind === 'text' && g.text === 'VCC')).toBe(true);
    expect(def(must(divider().file())).symbols.filter(s => !s.power).map(s => s.refDefault)).toEqual(['R1', 'R2']);
  });

  it('draws every power port style and hides the net name when the file says so', () => {
    const s = new Sheet({ SheetStyle: 0 });
    [0, 1, 2, 3, 4, 5, 6, 7].forEach((style, k) => s.power(`P${style}`, 100 + 40 * k, 100, { style, orientation: k & 3, showName: style !== 2 }));
    const d = def(must(s.file()));
    expect(d.symbols).toHaveLength(8);
    expect(d.symbols.every(x => x.graphics.length >= 1)).toBe(true);
    expect(d.symbols[2].graphics.some(g => g.kind === 'text')).toBe(false);
    expect(d.symbols[2].fields[0].hidden).toBe(true);
  });

  it('does not connect crossing wires without a junction, and does with one', () => {
    const base = (withJunction: boolean) => {
      const s = new Sheet({ SheetStyle: 0 });
      s.res('R1', 100, 500); s.res('R2', 100, 400); s.res('R3', 300, 450, { pins: [{ n: '1', x: 290, y: 450, dir: 2 }, { n: '2', x: 310, y: 450, dir: 0 }] });
      s.wire([80, 500], [60, 500], [60, 300], [200, 300]); // R1.1 up and right
      s.wire([120, 400], [160, 400], [160, 550]); // R2.2 passes right of R1
      s.wire([120, 500], [200, 500]); // R1.2 crosses the vertical at (160,500), which is interior to both wires
      if (withJunction) s.junction(160, 500);
      return s;
    };
    const apart = connect(must(base(false).file()));
    expect(sameNet(apart, 'R1.2', 'R2.2')).toBe(false);
    const joined = connect(must(base(true).file()));
    expect(sameNet(joined, 'R1.2', 'R2.2')).toBe(true);
  });

  it('connects a wire end that lands on another wire (a T) and wire ends that coincide', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 100, 500); s.res('R2', 100, 400); s.res('R3', 100, 300);
    s.wire([120, 500], [150, 500], [200, 500]);
    s.wire([120, 400], [160, 400]); s.wire([160, 400], [160, 500]); // two wires meeting end to end, the second ends on the first's interior
    s.wire([120, 300], [200, 300], [200, 500]); // ends on the first wire's end
    const c = connect(must(s.file()));
    expect(sameNet(c, 'R1.2', 'R2.2')).toBe(true);
    expect(sameNet(c, 'R1.2', 'R3.2')).toBe(true);
    expect(netOf(c, 'R1.1')).toBeUndefined(); // unconnected pins have no net
  });

  it('splits a multi-vertex wire into stable, numbered segments and skips zero-length ones', () => {
    const s = new Sheet({ SheetStyle: 0 });
    const w = s.wire([100, 100], [200, 100], [200, 100], [200, 200]);
    const d = def(must(s.file()));
    expect(d.wires.map(x => x.id)).toEqual([`w${w}`, `w${w}.2`]);
    close(d.wires[1].a.x, mmX(200)); close(d.wires[1].b.y, mmY(200));
  });

  it('warns when LocationCount promises more vertices than the record defines', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.add(27, { LocationCount: 5, X1: 100, Y1: 100, X2: 200, Y2: 100 });
    const r = must(s.file());
    expect(def(r).wires).toHaveLength(1);
    expect(codes(r)).toContain('VERTEX_COUNT_MISMATCH');
  });

  it('attaches a net label anywhere on a wire, on a wire end or on a pin end', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 200, 500); s.res('R2', 400, 500); s.res('R3', 600, 500);
    s.wire([220, 500], [300, 500], [380, 500]);
    s.label('A', 260, 500); // wire interior
    s.label('B', 620, 500); // R3 pin 2 end, no wire
    s.label('B', 180, 500); // R1 pin 1 end, no wire
    const c = connect(must(s.file()));
    expect(netName(c, 'R1.2')).toBe('A');
    expect(sameNet(c, 'R1.2', 'R2.1')).toBe(true);
    expect(netName(c, 'R3.2')).toBe('B');
    expect(sameNet(c, 'R3.2', 'R1.1')).toBe(true);
  });

  it('joins pins that the file leaves a few thousandths of a unit apart from a wire end, and not farther ones', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 100, 500); s.res('R2', 300, 500, { pins: [{ n: '1', x: 290, y: 500, dir: 2 }, { n: '2', x: 310, y: 500, dir: 0 }] });
    s.wire([120, 500], [280, 500]); // exactly at R1.2, 0.07 unit (0.018 mm) off R2.1
    s.items.forEach(item => { if ('rec' in item && item.rec.RECORD === 2 && item.rec.Designator === '1' && item.rec['Location.X'] === 290) item.rec['Location.X_Frac'] = 7000; });
    const near = must(s.file());
    expect(codes(near)).toContain('PIN_SNAPPED');
    expect(sameNet(connect(near), 'R1.2', 'R2.1')).toBe(true);
    const far = new Sheet({ SheetStyle: 0 });
    far.res('R1', 100, 500); far.res('R2', 300, 500, { pins: [{ n: '1', x: 290, y: 500, dir: 2 }, { n: '2', x: 310, y: 500, dir: 0 }] });
    far.wire([120, 500], [280, 500]);
    far.items.forEach(item => { if ('rec' in item && item.rec.RECORD === 2 && item.rec.Designator === '1' && item.rec['Location.X'] === 290) item.rec['Location.X_Frac'] = 50000; }); // 0.5 unit = 0.127 mm
    const result = must(far.file());
    expect(codes(result)).not.toContain('PIN_SNAPPED');
    expect(sameNet(connect(result), 'R1.2', 'R2.1')).toBe(false);
  });

  it('ties a hidden power pin to the global net of its HiddenNetName', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.part({ ref: 'U1', x: 400, y: 500, lib: 'IC', pins: [{ n: '14', name: 'VDD', x: 400, y: 450, hidden: true, hiddenNet: 'VCC', elec: 7 }, { n: '1', x: 380, y: 500, dir: 2 }] });
    s.res('R1', 200, 600);
    s.wire([220, 600], [260, 600]); s.power('VCC', 260, 600, { orientation: 1 });
    const c = connect(must(s.file()));
    expect(sameNet(c, 'U1.14', 'R1.2')).toBe(true);
    expect(netName(c, 'U1.14')).toBe('VCC');
  });

  it('applies no-ERC markers only to unconnected pin ends', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 200, 500); s.res('R2', 400, 500);
    s.noErc(180, 500); // R1.1: nothing else there
    s.noErc(220, 500); // R1.2: wired below
    s.wire([220, 500], [380, 500]);
    s.noErc(100, 100); // nowhere near a pin
    s.noErc(420, 500, false); // an inactive marker
    const r = must(s.file());
    expect(def(r).noConnects).toHaveLength(1);
    close(def(r).noConnects[0].at.x, mmX(180)); close(def(r).noConnects[0].at.y, mmY(500));
    expect(r.diagnostics.find(d => d.code === 'NO_ERC_NOT_NO_CONNECT')?.message).toMatch(/^2 no-ERC/);
    const c = connect(r);
    const r1 = symbolOf(def(r), 'R1');
    expect(c.noConnectPins).toEqual([pinKey('', r1.id, pinOf(r1, '1').id)]);
    const r2 = symbolOf(def(r), 'R2');
    expect(c.floatingPins).toEqual([pinKey('', r2.id, pinOf(r2, '2').id)]); // R2.2 is bare, its marker was inactive
    expect(sameNet(c, 'R1.2', 'R2.1')).toBe(true);
  });

  it('keeps buses and bus entries as drawing, never as connections between pins', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 100, 500); s.res('R2', 100, 400);
    s.bus([200, 600], [200, 300]);
    s.add(37, { 'Location.X': 200, 'Location.Y': 500, 'Corner.X': 210, 'Corner.Y': 510 });
    s.wire([120, 500], [200, 500]); s.wire([120, 400], [200, 400]);
    const r = must(s.file());
    expect(def(r).buses).toHaveLength(1);
    expect(def(r).busEntries).toHaveLength(1);
    expect(sameNet(connect(r), 'R1.2', 'R2.2')).toBe(false);
  });
});

describe('ports, sheet symbols and the net identifier scope', () => {
  /** A top sheet with R1 and a port SIG on it; a second sheet with R2 and a port of the same name. */
  const flatPair = (portA = 'SIG', portB = 'SIG') => {
    const a = new Sheet({ SheetStyle: 0 }); a.res('R1', 200, 500); a.wire([220, 500], [260, 500]); a.port({ name: portA, x: 260, y: 500, width: 40 });
    const b = new Sheet({ SheetStyle: 0 }); b.res('R2', 200, 500); b.wire([180, 500], [140, 500]); b.port({ name: portB, x: 100, y: 500, width: 40 });
    return { a, b };
  };

  it('keeps a lone sheet and its ports global (the Automatic rule without sheet symbols)', () => {
    const { a } = flatPair();
    const r = must(a.file());
    const l = def(r).labels;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ kind: 'global', text: 'SIG' });
    close(l[0].at.x, mmX(260)); close(l[0].at.y, mmY(500)); // the end of the port that touches the wire
    expect(netName(connect(r), 'R1.2')).toBe('SIG');
  });

  it('puts the ports of every sheet a project lists on one global scope (HierarchyMode 3, as in flat multi-sheet projects)', () => {
    const { a, b } = flatPair();
    const files = lower({ 'A.SchDoc': a.file(), 'B.SchDoc': b.file(), 'Flat.PrjPcb': project(['A.SchDoc', 'B.SchDoc'], 3) });
    const r = must(a.file(), 'A.SchDoc', files);
    expect(r.defs.map(d => d.id)).toEqual(['a.schdoc', 'b.schdoc']);
    expect(r.instances.map(i => [i.path, i.defId, i.parentPath])).toEqual([['', 'a.schdoc', null], ['sheet:b.schdoc', 'b.schdoc', null]]);
    const c = connect(r);
    expect(sameNet(c, 'R1.2', 'R2.1')).toBe(true); // the two ports of one name are one net across the sheets
    expect(netOf(c, 'R2.2')).toBeUndefined();
    const wired = c.nets.find(n => n.name === 'SIG');
    expect(pinsOf(wired)).toEqual(['R1.2', 'R2.1']);
    expect(wired?.scope).toBe('global');
    const reversed = must(b.file(), 'B.SchDoc', files);
    expect(pinsOf(connect(reversed).nets.find(n => n.name === 'SIG'))).toEqual(['R1.2', 'R2.1']);
    expect(reversed.instances.map(i => i.defId)).toEqual(['b.schdoc', 'a.schdoc']);
  });

  it('makes net labels global too in that scope, and local with HierarchyMode 2', () => {
    const mk = () => {
      const a = new Sheet({ SheetStyle: 0 }); a.res('R1', 200, 500); a.wire([220, 500], [260, 500]); a.label('LOCALNET', 260, 500);
      const b = new Sheet({ SheetStyle: 0 }); b.res('R2', 200, 500); b.wire([220, 500], [260, 500]); b.label('LOCALNET', 260, 500);
      return { a, b };
    };
    const { a, b } = mk();
    const global = connect(must(a.file(), 'A.SchDoc', lower({ 'B.SchDoc': b.file(), 'P.PrjPcb': project(['A.SchDoc', 'B.SchDoc'], 3) })));
    expect(sameNet(global, 'R1.2', 'R2.2')).toBe(true);
    const hier = must(a.file(), 'A.SchDoc', lower({ 'B.SchDoc': b.file(), 'P.PrjPcb': project(['A.SchDoc', 'B.SchDoc'], 2) }));
    expect(def(hier).labels[0].kind).toBe('local');
    expect(sameNet(connect(hier), 'R1.2', 'R2.2')).toBe(false); // hierarchical scope without sheet symbols: the second sheet is not below the first
    expect(codes(hier)).toContain('SHEETS_NOT_REACHED');
  });

  it('reads sheets only from the files it was given: without a project file the opened sheet stands alone', () => {
    const { a, b } = flatPair();
    const r = must(a.file(), 'A.SchDoc', lower({ 'B.SchDoc': b.file() }));
    expect(r.defs).toHaveLength(1);
    expect(r.instances).toHaveLength(1);
    const withOther = must(a.file(), 'A.SchDoc', lower({ 'Other.PrjPcb': project(['X.SchDoc'], 3) }));
    expect(codes(withOther)).toContain('PROJECT_NOT_USED');
  });

  it('finds the sheets a project lists by base name and reports the ones it cannot find', () => {
    const { a, b } = flatPair();
    const files = lower({ 'B.SchDoc': b.file(), 'P.PrjPcb': project(['Schematics\\A.SchDoc', 'Schematics\\B.SchDoc', 'Schematics\\Gone.SchDoc', 'Board.PcbDoc'], 3) });
    const r = must(a.file(), 'A.SchDoc', files);
    expect(r.defs.map(d => d.id)).toEqual(['a.schdoc', 'b.schdoc']);
    const missing = r.diagnostics.filter(d => d.code === 'PROJECT_SHEET_MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('Gone.SchDoc');
  });

  it('follows the Automatic rule when the project says 0, and warns about a scope it does not know', () => {
    const { a, b } = flatPair();
    const auto = must(a.file(), 'A.SchDoc', lower({ 'B.SchDoc': b.file(), 'P.PrjPcb': project(['A.SchDoc', 'B.SchDoc'], 0) }));
    expect(auto.instances).toHaveLength(2);
    expect(def(auto).labels[0].kind).toBe('global');
    const odd = must(a.file(), 'A.SchDoc', lower({ 'B.SchDoc': b.file(), 'P.PrjPcb': project(['A.SchDoc', 'B.SchDoc'], 7) }));
    expect(codes(odd)).toContain('SCOPE_UNKNOWN');
    expect(odd.instances).toHaveLength(2);
  });

  /** Top sheet with a sheet symbol for Child.SchDoc (entries IN on the left, OUT on the right) and the child with matching ports. */
  function hierarchy(entryNames: [string, string] = ['IN', 'OUT'], portNames: [string, string] = ['IN', 'OUT']) {
    const top = new Sheet({ SheetStyle: 0 });
    top.res('R1', 100, 500);
    top.sheetSymbol({ name: 'Stage', file: 'Child.SchDoc', x: 300, y: 600, w: 120, h: 100, entries: [{ name: entryNames[0], side: 0, dist: 40, io: 2 }, { name: entryNames[1], side: 1, dist: 60, io: 1 }] });
    top.wire([120, 500], [200, 500], [200, 560], [300, 560]); // R1.2 to the IN entry at (300, 560)
    top.res('R9', 500, 540);
    top.wire([420, 540], [480, 540]); // the OUT entry at (420, 540) to R9.1
    const child = new Sheet({ SheetStyle: 0 });
    child.res('R2', 300, 500); child.res('R3', 500, 500);
    child.wire([140, 500], [280, 500]); child.port({ name: portNames[0], x: 100, y: 500, width: 40, io: 2 });
    child.wire([320, 500], [480, 500]); child.label('MIDCHILD', 400, 500);
    child.wire([520, 500], [560, 500]); child.port({ name: portNames[1], x: 560, y: 500, width: 40, io: 1 });
    return { top, child };
  }

  it('joins a sheet entry to the port of the same name in the sheet below it (a sheet symbol makes the design hierarchical)', () => {
    const { top, child } = hierarchy();
    const r = must(top.file(), 'Top.SchDoc', lower({ 'Child.SchDoc': child.file() }));
    expect(r.defs.map(d => d.id)).toEqual(['top.schdoc', 'child.schdoc']);
    const ref = def(r).sheetRefs[0];
    expect(ref).toMatchObject({ name: 'Stage', file: 'Child.SchDoc', defId: 'child.schdoc' });
    close(ref.at.x, mmX(300)); close(ref.at.y, mmY(600)); close(ref.size.x, mmX(120)); close(ref.size.y, mmX(100));
    expect(ref.pins.map(p => [p.name, p.shape])).toEqual([['IN', 'input'], ['OUT', 'output']]);
    close(ref.pins[0].at.x, mmX(300)); close(ref.pins[0].at.y, mmY(560));
    close(ref.pins[1].at.x, mmX(420)); close(ref.pins[1].at.y, mmY(540));
    expect(r.instances.map(i => [i.path, i.defId, i.name, i.depth, i.parentPath])).toEqual([['', 'top.schdoc', 'Top', 0, null], [`/${ref.id}`, 'child.schdoc', 'Stage', 1, '']]);
    expect(r.instances[0].childPaths).toEqual([`/${ref.id}`]);
    expect(def(r, 1).labels.map(l => l.kind)).toEqual(['local', 'hierarchical', 'hierarchical']); // net labels first, then the ports (their ends are resolved against the wires)
    const c = connect(r);
    expect(sameNet(c, 'R1.2', 'R2.1')).toBe(true);
    expect(sameNet(c, 'R3.2', 'R9.1')).toBe(true);
    expect(sameNet(c, 'R2.2', 'R3.1')).toBe(true);
    expect(netName(c, 'R2.2')).toBe('MIDCHILD');
    expect(c.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
  });

  it('does not join a sheet entry to a port of another name, and says so', () => {
    const { top, child } = hierarchy(['IN', 'OUT'], ['IN', 'WRONG']);
    const c = connect(must(top.file(), 'Top.SchDoc', lower({ 'Child.SchDoc': child.file() })));
    expect(sameNet(c, 'R3.2', 'R9.1')).toBe(false);
    expect(c.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['SHEET_PIN_UNMATCHED', 'HIER_LABEL_UNMATCHED']));
  });

  it('gives every use of a repeated sheet its own instance, local nets and references', () => {
    const { top, child } = hierarchy();
    top.sheetSymbol({ name: 'Stage2', file: 'child.schdoc', x: 600, y: 300, w: 120, h: 100, entries: [] });
    const r = must(top.file(), 'Top.SchDoc', lower({ 'Child.SchDoc': child.file() }));
    expect(r.defs).toHaveLength(2);
    expect(r.instances.map(i => i.defId)).toEqual(['top.schdoc', 'child.schdoc', 'child.schdoc']);
    expect(new Set(r.instances.map(i => i.path)).size).toBe(3);
    const c = connect(r);
    const mid = c.nets.filter(n => n.name === 'MIDCHILD');
    expect(mid).toHaveLength(2);
    expect(new Set(mid.map(n => n.scopePath)).size).toBe(2);
  });

  it('breaks sheet cycles and a sheet that includes itself', () => {
    const a = new Sheet({ SheetStyle: 0 }), b = new Sheet({ SheetStyle: 0 });
    a.res('R1', 100, 500); a.sheetSymbol({ name: 'ToB', file: 'B.SchDoc', x: 300, y: 600, w: 100, h: 100 }); a.sheetSymbol({ name: 'Self', file: 'A.SchDoc', x: 500, y: 600, w: 100, h: 100 });
    b.res('R2', 100, 500); b.sheetSymbol({ name: 'ToA', file: 'A.SchDoc', x: 300, y: 600, w: 100, h: 100 });
    const r = must(a.file(), 'A.SchDoc', lower({ 'B.SchDoc': b.file() }));
    expect(r.instances.map(i => i.defId)).toEqual(['a.schdoc', 'b.schdoc']);
    expect(r.diagnostics.filter(d => d.code === 'SHEET_CYCLE').length).toBeGreaterThanOrEqual(2);
    expect(() => connect(r)).not.toThrow();
  });

  it('reports a missing child file, an unreadable one and a multi-channel sheet', () => {
    const top = new Sheet({ SheetStyle: 0 });
    top.sheetSymbol({ name: 'Missing', file: 'Nope.SchDoc', x: 100, y: 600, w: 100, h: 100, entries: [{ name: 'X', dist: 20 }] });
    top.sheetSymbol({ name: 'Broken', file: 'Broken.SchDoc', x: 300, y: 600, w: 100, h: 100 });
    top.sheetSymbol({ name: 'Repeat(CH, 1, 4)', file: 'Quad.SchDoc', x: 500, y: 600, w: 100, h: 100 });
    top.sheetSymbol({ name: 'Nameless', file: '', x: 700, y: 600, w: 100, h: 100 });
    const quad = new Sheet({ SheetStyle: 0 }); quad.res('R1', 100, 500);
    const r = must(top.file(), 'Top.SchDoc', lower({ 'Broken.SchDoc': enc.encode('this is not a schematic'), 'Quad.SchDoc': quad.file() }));
    expect(def(r).sheetRefs.map(x => x.defId)).toEqual([null, null, 'quad.schdoc', null]);
    const diag = Object.fromEntries(r.diagnostics.map(d => [d.code, d.severity]));
    expect(diag).toMatchObject({ SHEET_FILE_MISSING: 'warning', SHEET_FILE_INVALID: 'error', REPEAT_SHEET: 'warning', SHEET_SYMBOL_NO_FILE: 'warning' });
    expect(r.instances).toHaveLength(2);
    const c = connect(r);
    expect(c.diagnostics.map(d => d.code)).toContain('SHEET_CHILD_MISSING');
  });

  it('follows the entry side and distance: left, right, top and bottom', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.sheetSymbol({ name: 'Box', file: 'x.SchDoc', x: 300, y: 600, w: 120, h: 100, entries: [{ name: 'L', side: 0, dist: 30 }, { name: 'R', side: 1, dist: 30 }, { name: 'T', side: 2, dist: 40 }, { name: 'B', side: 3, dist: 40 }] });
    const pins = def(must(s.file())).sheetRefs[0].pins;
    const at = (name: string) => pins.find(p => p.name === name)!.at;
    close(at('L').x, mmX(300)); close(at('L').y, mmY(570));
    close(at('R').x, mmX(420)); close(at('R').y, mmY(570));
    close(at('T').x, mmX(340)); close(at('T').y, mmY(600));
    close(at('B').x, mmX(340)); close(at('B').y, mmY(500));
  });

  it('treats an off-sheet connector as a port by its text, and warns about a port that touches nothing', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 200, 500); s.wire([220, 500], [260, 500]);
    s.power('OFF', 260, 500, { offSheet: true });
    s.port({ name: 'LOOSE', x: 600, y: 300, width: 40 });
    const r = must(s.file());
    expect(def(r).symbols.filter(x => x.power)).toHaveLength(0);
    expect(def(r).labels.map(l => [l.text, l.kind])).toEqual([['OFF', 'global'], ['LOOSE', 'global']]);
    expect(codes(r)).toContain('PORT_UNATTACHED');
    expect(netName(connect(r), 'R1.2')).toBe('OFF');
  });

  it('puts the label of a vertical port at its connected end', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 200, 500, { pins: [{ n: '1', x: 190, y: 500, dir: 2 }, { n: '2', x: 210, y: 500, dir: 0 }] });
    s.wire([220, 500], [220, 540]);
    s.port({ name: 'UP', x: 220, y: 540, width: 30, style: 4 }); // vertical: its other end is at y = 570
    const l = def(must(s.file())).labels[0];
    expect(l.angle).toBe(90);
    close(l.at.y, mmY(540));
  });
});

describe('cross-probe against a board by designator and pin number', () => {
  const board = (): Board => {
    const comps = [
      { ref: 'R1', pins: [['1', 'VCC'], ['2', 'MID']] }, { ref: 'R2', pins: [['1', 'MID'], ['2', 'GND']] },
    ];
    const components: Board['components'] = [], pins: Board['pins'] = [], netPins = new Map<string, string[]>();
    comps.forEach((spec, i) => {
      const id = `c${i}`, pinIds: string[] = [];
      for (const [number, net] of spec.pins) {
        const pinId = `${id}.${number}`;
        pins.push({ id: pinId, componentId: id, number, name: '', net, side: 'top', radius: 0.2, shape: 'round', x: i, y: 0 });
        pinIds.push(pinId); netPins.set(net, [...(netPins.get(net) ?? []), pinId]);
      }
      components.push({ id, ref: spec.ref, value: '', package: '', side: 'top', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: i, y: 0 }, rotation: 0, pinIds, outline: [] });
    });
    return { name: 'divider', format: 'test', units: 'mm', components, pins, nets: [...netPins].map(([name, pinIds], k) => ({ id: `n${k}`, name, pinIds })), outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] };
  };

  it('links every part and pin of a SchDoc to the board with equal net names', () => {
    const schematic = must(divider().file());
    const design = { schematic, connectivity: connect(schematic) };
    const report = linkBoardSchematic(buildBoardIndex(board()), buildSchematicIndex([design]));
    expect(report.summary.refs).toMatchObject({ unique: 2, ambiguous: 0, boardOnly: 0, schematicOnly: 0 });
    expect(report.summary.pins).toMatchObject({ compared: 4, match: 4, netDiffers: 0, pinMissingOnBoard: 0, pinMissingOnSchematic: 0 });
    expect(report.summary.nets).toMatchObject({ sameName: 3, differs: 0 });
    expect(report.summary.disagreements.total).toBe(0);
  });

  it('maps a schematic pin to the board pin and net through its designator and pin number', () => {
    const schematic = must(divider().file());
    const design = { schematic, connectivity: connect(schematic) };
    const b = buildBoardIndex(board()), s = buildSchematicIndex([design]);
    const r2 = symbolOf(def(schematic), 'R2');
    const mapped = mapSchematicSelectionToBoard(b, s, { instancePath: '', symbolId: r2.id, pinId: pinOf(r2, '1').id });
    expect(mapped.status).toBe('unique');
    expect(mapped.candidates[0]).toMatchObject({ ref: 'R2', pin: { number: '1', net: 'MID', pinIds: ['c1.1'] } });
    // power ports are virtual symbols and never cross-probe to the board
    const vcc = def(schematic).symbols.find(x => x.power)!;
    expect(mapSchematicSelectionToBoard(b, s, { instancePath: '', symbolId: vcc.id }).status).toBe('missing');
    expect(pinKey('', r2.id, pinOf(r2, '1').id)).toBe(`\u0000${r2.id}\u0000${r2.id}#1`);
    expect(symbolKey('', r2.id)).toBe(`\u0000${r2.id}`);
  });

  it('reports a net that differs and a pin the schematic does not have', () => {
    const schematic = must(divider().file());
    const design = { schematic, connectivity: connect(schematic) };
    const changed = board();
    changed.pins.find(p => p.id === 'c1.2')!.net = 'GROUND';
    changed.pins.push({ id: 'c1.3', componentId: 'c1', number: '3', name: '', net: '', side: 'top', radius: 0.2, shape: 'round', x: 1, y: 0 });
    changed.components[1].pinIds.push('c1.3');
    const report = linkBoardSchematic(buildBoardIndex(changed), buildSchematicIndex([design]));
    expect(report.summary.pins.netDiffers).toBe(1);
    expect(report.summary.pins.pinMissingOnSchematic).toBe(1);
  });

  it('keeps one pin of a multi-part reference as one board pin', () => {
    const s = new Sheet({ SheetStyle: 0 });
    const common = { n: '8', name: 'V+', x: 530, y: 560, dir: 1 as const };
    const pinsA = [{ n: '1', x: 500, y: 500, part: 1, dir: 2 as const }, { n: '5', x: 500, y: 400, part: 2, dir: 2 as const }, common];
    s.part({ ref: 'U1', x: 530, y: 500, lib: 'OPAMP', partCount: 2, partId: 1, pins: pinsA });
    s.part({ ref: 'U1', x: 530, y: 300, lib: 'OPAMP', partCount: 2, partId: 2, pins: pinsA.map(p => ({ ...p, y: p.y - 200 })) });
    s.power('VCC', 530, 570, { orientation: 1 }); s.power('VCC', 530, 370, { orientation: 1 });
    const schematic = must(s.file());
    const c = connect(schematic);
    expect(pinsOf(netOf(c, 'U1.8'))).toEqual(['U1.8']);
    expect(netName(c, 'U1.8')).toBe('VCC');
    const index = buildSchematicIndex([{ schematic, connectivity: c }]);
    expect([...index.partsByRef.keys()]).toEqual(['U1']);
    expect(index.partsByRef.get('U1')?.[0].units.map(u => u.unit).sort()).toEqual([1, 2]);
    const empty = container({ FileHeader: framed('|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0') });
    expect(must(empty).defs[0].symbols).toEqual([]);
  });
});
