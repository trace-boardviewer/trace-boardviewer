import { describe, expect, it } from 'vitest';
import { computeConnectivity, naturalCompare, parseBusLabel } from './connectivity';
import { pinKey, SchematicError } from './model';
import type { SchConnectivity, SchNet, SchSheetInstance } from './model';
import {
  buildSchematic, fixtureBus, fixtureDeclared, fixtureDivider, fixtureRepeatedSheet, fixtureStress, memberLabels, netByName, netOfPin,
  SheetBuilder, summarize,
} from './testing';

/** Two-pin part with its pins at p1 / p2 (pin numbers 1 and 2). */
const R = (b: SheetBuilder, ref: string, p1: [number, number], p2: [number, number]): SheetBuilder =>
  b.part(ref, [{ n: '1', x: p1[0], y: p1[1] }, { n: '2', x: p2[0], y: p2[1] }]);
const flat = (build: (b: SheetBuilder) => void): SchConnectivity => {
  const b = new SheetBuilder('root');
  build(b);
  return computeConnectivity(buildSchematic([b]));
};
const same = (c: SchConnectivity, a: [string, string], b: [string, string]): boolean => {
  const na = netOfPin(c, a[0], a[1]), nb = netOfPin(c, b[0], b[1]);
  return !!na && na === nb;
};
const codes = (c: SchConnectivity): string[] => c.diagnostics.map(d => d.code);
const key = (symbol: string, n: string, path = ''): string => pinKey(path, symbol, `${symbol}#${n}`);

/** Four parts on a plus-shaped pair of wires crossing at (10, 10); second pins parked far away and unwired. */
function cross(b: SheetBuilder): void {
  R(b, 'R1', [0, 10], [0, -50]); R(b, 'R2', [20, 10], [20, -50]); R(b, 'R3', [10, 0], [40, -50]); R(b, 'R4', [10, 20], [60, -50]);
  b.wire(0, 10, 20, 10).wire(10, 0, 10, 20);
}

describe('geometry: wires and pins', () => {
  it('connects pins through coinciding wire ends and names the net automatically', () => {
    const c = flat(b => { R(b, 'R1', [0, 0], [10, 0]); R(b, 'R2', [20, 0], [30, 0]); b.wire(10, 0, 20, 0); });
    expect(c.nets).toHaveLength(1);
    expect(c.nets[0]).toMatchObject({ name: 'Net-(R1-Pad2)', auto: true, id: 'net:auto:1', scope: 'local', scopePath: '', aliases: [] });
    expect(memberLabels(c.nets[0])).toEqual(['R1.2', 'R2.1']);
    expect(c.nets[0].wires).toHaveLength(1);
    expect(c.floatingPins.sort()).toEqual([key('R1', '1'), key('R2', '2')].sort());
  });

  it('does NOT connect wires that cross without a junction', () => {
    const c = flat(cross);
    expect(same(c, ['R1', '1'], ['R2', '1'])).toBe(true);
    expect(same(c, ['R3', '1'], ['R4', '1'])).toBe(true);
    expect(same(c, ['R1', '1'], ['R3', '1'])).toBe(false);
    expect(c.nets).toHaveLength(2);
  });

  it('connects a crossing when a junction sits on it', () => {
    const c = flat(b => { cross(b); b.junction(10, 10); });
    expect(c.nets).toHaveLength(1);
    expect(memberLabels(c.nets[0])).toEqual(['R1.1', 'R2.1', 'R3.1', 'R4.1']);
  });

  it('connects a wire END that lands on another wire interior (T)', () => {
    const c = flat(b => { R(b, 'R1', [0, 10], [0, -50]); R(b, 'R2', [20, 10], [20, -50]); R(b, 'R3', [10, 20], [40, -50]); b.wire(0, 10, 20, 10).wire(10, 10, 10, 20); });
    expect(c.nets).toHaveLength(1);
    expect(memberLabels(c.nets[0])).toEqual(['R1.1', 'R2.1', 'R3.1']);
  });

  it('does NOT connect a pin tip on a wire interior without a junction, and says so', () => {
    const build = (junction: boolean) => flat(b => {
      R(b, 'R1', [0, 10], [0, -50]); R(b, 'R2', [20, 10], [20, -50]); R(b, 'R3', [10, 10], [40, -50]);
      b.wire(0, 10, 20, 10);
      if (junction) b.junction(10, 10);
    });
    const open = build(false);
    expect(same(open, ['R1', '1'], ['R2', '1'])).toBe(true);
    expect(netOfPin(open, 'R3', '1')).toBeUndefined();
    expect(open.floatingPins).toContain(key('R3', '1'));
    expect(codes(open)).toContain('PIN_ON_WIRE_NO_JUNCTION');
    const closed = build(true);
    expect(same(closed, ['R1', '1'], ['R3', '1'])).toBe(true);
    expect(codes(closed)).not.toContain('PIN_ON_WIRE_NO_JUNCTION');
  });

  it('connects collinear overlapping wires (an end of one lies inside the other)', () => {
    const c = flat(b => { R(b, 'R1', [0, 10], [0, -50]); R(b, 'R2', [25, 10], [25, -50]); b.wire(0, 10, 15, 10).wire(10, 10, 25, 10); });
    expect(same(c, ['R1', '1'], ['R2', '1'])).toBe(true);
  });

  it('tolerates 0.4 um of float noise but not a 10 um gap', () => {
    const near = flat(b => { R(b, 'R1', [0, 0], [0, -50]); R(b, 'R2', [10, 0.0004], [10, -50]); b.wire(0, 0, 10, 0); });
    expect(same(near, ['R1', '1'], ['R2', '1'])).toBe(true);
    const far = flat(b => { R(b, 'R1', [0, 0], [0, -50]); R(b, 'R2', [10, 0.01], [10, -50]); b.wire(0, 0, 10, 0); });
    expect(far.nets).toHaveLength(0);
    expect(far.floatingPins).toHaveLength(4);
  });

  it('merges sites that straddle a quantisation cell boundary', () => {
    // 0.0004995 and 0.0005005 round to different 1e-3 cells but are 1e-6 apart.
    const c = flat(b => { R(b, 'R1', [0.0004995, 0], [0, -50]); R(b, 'R2', [0.0005005, 0], [10, -50]); });
    expect(same(c, ['R1', '1'], ['R2', '1'])).toBe(true);
  });

  it('connects pins of different symbols whose tips coincide', () => {
    const c = flat(b => { R(b, 'R1', [0, 0], [10, 0]); R(b, 'R2', [10, 0], [20, 0]); });
    expect(same(c, ['R1', '2'], ['R2', '1'])).toBe(true);
    expect(codes(c)).toContain('PINS_COINCIDE');
  });

  it('attaches a label on a wire interior and on a pin tip', () => {
    const c = flat(b => { R(b, 'R1', [0, 0], [10, 0]); R(b, 'R2', [20, 0], [30, 0]); b.wire(10, 0, 20, 0).local('MID', 15, 0).local('TIP', 30, 0); });
    expect(netByName(c, 'MID')?.members.map(m => m.ref)).toEqual(['R1', 'R2']);
    expect(netByName(c, 'TIP')?.members.map(m => m.ref)).toEqual(['R2']);
  });

  it('refuses to attach a label at a crossing of unconnected wires and reports it', () => {
    const c = flat(b => { cross(b); b.local('X', 10, 10); });
    expect(codes(c)).toContain('LABEL_AMBIGUOUS');
    expect(netByName(c, 'X')).toBeUndefined();
    expect(c.nets).toHaveLength(2);
    expect(same(c, ['R1', '1'], ['R3', '1'])).toBe(false);
  });

  it('reports a label that touches nothing', () => {
    const c = flat(b => { R(b, 'R1', [0, 0], [10, 0]); b.local('LOST', 100, 100); });
    expect(codes(c)).toContain('LABEL_UNATTACHED');
    expect(netByName(c, 'LOST')).toBeUndefined();
  });

  it('ignores elements with invalid coordinates and reports them', () => {
    const c = flat(b => { R(b, 'R1', [0, 0], [10, 0]); R(b, 'R2', [10, 0], [20, 0]); b.wire(Number.NaN, 0, 5, 5).wire(0, 0, 2e6, 0); });
    expect(codes(c)).toContain('COORDINATE_INVALID');
    expect(same(c, ['R1', '2'], ['R2', '1'])).toBe(true);
  });
});

describe('geometry: no-connect flags', () => {
  const stack = (flag: boolean) => flat(b => { R(b, 'R1', [0, 0], [10, -50]); R(b, 'R2', [0, 0], [20, -50]); if (flag) b.noConnect(0, 0); });

  it('stacked pins are one net without a flag (control)', () => {
    expect(same(stack(false), ['R1', '1'], ['R2', '1'])).toBe(true);
  });

  it('a no-connect flag keeps stacked pins on separate nets and out of the floating list', () => {
    const c = stack(true);
    expect(c.nets).toHaveLength(0);
    expect(c.noConnectPins.sort()).toEqual([key('R1', '1'), key('R2', '1')].sort());
    expect(c.floatingPins).not.toContain(key('R1', '1'));
    expect(c.floatingPins).toContain(key('R1', '2'));
    expect(codes(c)).not.toContain('NO_CONNECT_CONFLICT');
  });

  it('a no-connect flag on a wired pin keeps the connection and reports NO_CONNECT_CONFLICT', () => {
    const c = flat(b => { R(b, 'R1', [0, 0], [0, -50]); R(b, 'R2', [10, 0], [10, -50]); b.wire(0, 0, 10, 0).noConnect(0, 0); });
    expect(codes(c)).toContain('NO_CONNECT_CONFLICT');
    expect(same(c, ['R1', '1'], ['R2', '1'])).toBe(true);
    expect(c.noConnectPins).toContain(key('R1', '1'));
  });

  it('an electrical type no_connect pin is isolated from a pin on the same point', () => {
    const c = flat(b => {
      b.part('U1', [{ n: '1', x: 0, y: 0, type: 'no_connect' }]);
      R(b, 'R2', [0, 0], [10, -50]);
    });
    expect(c.noConnectPins).toEqual([key('U1', '1')]);
    expect(c.nets).toHaveLength(0);
    expect(c.floatingPins).toContain(key('R2', '1'));
  });

  it('reports a no-connect flag that is not on a pin', () => {
    expect(codes(flat(b => { R(b, 'R1', [0, 0], [10, 0]); b.noConnect(50, 50); }))).toContain('NO_CONNECT_UNATTACHED');
  });
});

describe('names and scopes', () => {
  /** root with one sub-sheet instance "/sub1" of definition "sub". */
  function twoSheets(root: (b: SheetBuilder) => void, sub: (b: SheetBuilder) => void, pins: Array<{ name: string; x: number; y: number }> = []): SchConnectivity {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    root(r); sub(s);
    r.sheet('sub1', 'sub', 'sub', pins);
    return computeConnectivity(buildSchematic([r, s]));
  }
  const tap = (b: SheetBuilder, ref: string, y: number, label?: [string, 'local' | 'global' | 'hierarchical']): void => {
    R(b, ref, [0, y], [0, y - 500]);
    b.wire(0, y, 10, y);
    if (label) b.label(label[1], label[0], 10, y);
  };

  it('keeps local labels scoped to one sheet instance but merges equal names inside it', () => {
    const c = twoSheets(
      b => { tap(b, 'R1', 0, ['X', 'local']); tap(b, 'R2', 100, ['X', 'local']); },
      b => tap(b, 'R3', 0, ['X', 'local']),
    );
    const rootNet = netOfPin(c, 'R1', '1'), subNet = netOfPin(c, 'R3', '1', '/sub1');
    expect(rootNet).toBeDefined();
    expect(netOfPin(c, 'R2', '1')).toBe(rootNet);
    expect(subNet).toBeDefined();
    expect(subNet).not.toBe(rootNet);
    expect(rootNet).toMatchObject({ id: 'net:local::X', scope: 'local', scopePath: '' });
    expect(subNet).toMatchObject({ id: 'net:local:/sub1:X', scope: 'local', scopePath: '/sub1' });
  });

  it('joins global labels across sheets into one design-wide net', () => {
    const c = twoSheets(b => tap(b, 'R1', 0, ['G', 'global']), b => tap(b, 'R3', 0, ['G', 'global']));
    expect(c.nets).toHaveLength(1);
    expect(c.nets[0]).toMatchObject({ id: 'net:global:G', scope: 'global', name: 'G' });
    expect(c.nets[0].scopePath).toBeUndefined();
    expect(c.nets[0].members.map(m => m.instancePath).sort()).toEqual(['', '/sub1']);
  });

  it('connects a local and a global label of equal name on the same sheet, but not on another sheet', () => {
    const c = twoSheets(
      b => { tap(b, 'R1', 0, ['S', 'global']); tap(b, 'R2', 100, ['S', 'local']); },
      b => tap(b, 'R3', 0, ['S', 'local']),
    );
    const g = netOfPin(c, 'R1', '1');
    expect(g?.id).toBe('net:global:S');
    expect(netOfPin(c, 'R2', '1')).toBe(g);
    const other = netOfPin(c, 'R3', '1', '/sub1');
    expect(other?.id).toBe('net:local:/sub1:S');
  });

  it('ties power symbols design-wide by net name without joining a local label of that name', () => {
    const c = twoSheets(
      b => { R(b, 'R1', [0, 0], [30, 0]); b.power('GND', 30, 0); tap(b, 'R5', 100, ['GND', 'local']); },
      b => { R(b, 'R3', [0, 0], [30, 0]); b.power('GND', 30, 0); },
    );
    const gnd = netByName(c, 'GND');
    expect(c.nets.filter(n => n.name === 'GND')).toHaveLength(2);
    const global = c.nets.find(n => n.id === 'net:global:GND')!;
    expect(memberLabels(global)).toEqual(['R1.2', 'R3.2']);
    const local = c.nets.find(n => n.id === 'net:local::GND')!;
    expect(memberLabels(local)).toEqual(['R5.1']);
    expect(gnd).toBeDefined();
    // virtual power symbols are never members, but their pins belong to the net
    expect(global.members.every(m => !m.ref.startsWith('#'))).toBe(true);
    expect(c.pinNet[key('#PWR1', '1')]).toBe('net:global:GND');
    expect(c.floatingPins.some(k => k.includes('#PWR'))).toBe(false);
  });

  it('ties a hidden power-input pin to the global net named by the pin', () => {
    const c = flat(b => {
      b.part('U1', [{ n: '14', x: 0, y: 0, name: 'VCC', type: 'power_in', hidden: true, implicitNet: 'VCC' }, { n: '1', x: 0, y: 40 }]);
      R(b, 'R1', [20, 0], [20, 30]); b.power('VCC', 20, 0);
    });
    const vcc = netByName(c, 'VCC')!;
    expect(memberLabels(vcc)).toEqual(['R1.1', 'U1.14']);
    expect(vcc.id).toBe('net:global:VCC');
  });

  it('prefers the symbol value of a power symbol over a hidden pin name on that symbol', () => {
    const c = flat(b => {
      R(b, 'R1', [20, 0], [20, 30]);
      b.part('#PWR1', [{ n: '1', x: 20, y: 0, name: 'WRONG', type: 'power_in', hidden: true, implicitNet: 'WRONG' }], { power: 'RIGHT', virtual: true });
    });
    expect(netByName(c, 'RIGHT')?.members.map(m => m.ref)).toEqual(['R1']);
    expect(netByName(c, 'WRONG')).toBeUndefined();
  });

  it('applies the documented name priority and keeps every name as an alias', () => {
    const c = flat(b => {
      // global > power > local > alphabetical inside one type
      R(b, 'R1', [0, 0], [0, -900]); R(b, 'R2', [20, 0], [20, -900]); b.wire(0, 0, 20, 0).local('Z', 5, 0).local('A', 10, 0);
      R(b, 'R3', [0, 20], [0, -910]); R(b, 'R4', [20, 20], [20, -910]); b.wire(0, 20, 20, 20).global('G', 5, 20).local('L', 10, 20);
      R(b, 'R5', [0, 40], [0, -920]); R(b, 'R6', [20, 40], [20, -920]); b.wire(0, 40, 20, 40).local('loc', 5, 40).power('P', 20, 40);
      R(b, 'R7', [0, 60], [0, -930]); R(b, 'R8', [20, 60], [20, -930]); b.wire(0, 60, 20, 60).global('B', 5, 60).global('A2', 10, 60);
      R(b, 'R9', [0, 80], [0, -940]); R(b, 'R10', [20, 80], [20, -940]); b.wire(0, 80, 20, 80).global('GG', 5, 80).power('PP', 20, 80);
    });
    expect(netOfPin(c, 'R1', '1')).toMatchObject({ name: 'A', aliases: ['A', 'Z'], scope: 'local' });
    expect(netOfPin(c, 'R3', '1')).toMatchObject({ name: 'G', aliases: ['G', 'L'], scope: 'global', id: 'net:global:G' });
    expect(netOfPin(c, 'R5', '1')).toMatchObject({ name: 'P', aliases: ['P', 'loc'], scope: 'global' });
    expect(netOfPin(c, 'R7', '1')).toMatchObject({ name: 'A2', aliases: ['A2', 'B'], scope: 'global' });
    expect(netOfPin(c, 'R9', '1')).toMatchObject({ name: 'GG', aliases: ['GG', 'PP'] });
  });

  it('reports conflicting names on one net instead of dropping them', () => {
    const c = flat(b => {
      R(b, 'R1', [0, 0], [0, -900]); R(b, 'R2', [20, 0], [20, -900]); b.wire(0, 0, 20, 0).global('A', 5, 0).global('B', 10, 0);
      R(b, 'R3', [0, 20], [0, -910]); R(b, 'R4', [20, 20], [20, -910]); b.wire(0, 20, 20, 20).power('GND', 0, 20).global('VCC', 10, 20);
      R(b, 'R5', [0, 40], [0, -920]); R(b, 'R6', [20, 40], [20, -920]); b.wire(0, 40, 20, 40).local('same', 5, 40).local('same', 10, 40);
    });
    const conflicts = c.diagnostics.filter(d => d.code === 'NET_NAME_CONFLICT');
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].message).toContain('"A"');
    expect(conflicts[0].message).toContain('"B"');
    expect(netOfPin(c, 'R1', '1')?.aliases).toEqual(['A', 'B']);
    expect(netOfPin(c, 'R3', '1')?.aliases).toEqual(['GND', 'VCC']);
    expect(netOfPin(c, 'R5', '1')?.aliases).toEqual(['same']);
  });

  it('names automatically from the first member in natural order', () => {
    const doc = flat(b => { R(b, 'R1', [0, 0], [10, 0]); R(b, 'R2', [20, 0], [30, 0]); b.wire(10, 0, 20, 0); });
    expect(doc.nets[0].name).toBe('Net-(R1-Pad2)');
    const natural = flat(b => { R(b, 'R10', [0, 0], [10, 0]); R(b, 'R2', [20, 0], [30, 0]); b.wire(10, 0, 20, 0); });
    expect(natural.nets[0].name).toBe('Net-(R2-Pad1)');
    expect(natural.nets[0].members.map(m => m.ref)).toEqual(['R2', 'R10']);
  });

  it('numbers automatic nets deterministically', () => {
    const c = flat(b => {
      R(b, 'R1', [0, 0], [10, 0]); R(b, 'R2', [20, 0], [30, 0]); b.wire(10, 0, 20, 0);
      R(b, 'R3', [0, 50], [10, 50]); R(b, 'R4', [20, 50], [30, 50]); b.wire(10, 50, 20, 50);
    });
    expect(c.nets.map(n => n.id)).toEqual(['net:auto:1', 'net:auto:2']);
  });
});

describe('hierarchy', () => {
  it('gives every instance of a repeated sub-sheet its own nets, pin keys and references', () => {
    const fx = fixtureRepeatedSheet();
    const c = computeConnectivity(fx.schematic);
    expect(summarize(c)).toEqual(fx.expected);
    const in1 = netOfPin(c, 'r', '1', '/amp1')!, in2 = netOfPin(c, 'r', '1', '/amp2')!;
    expect(in1).toMatchObject({ id: 'net:local:/amp1:IN', scope: 'hierarchical', scopePath: '/amp1', aliases: ['IN'] });
    expect(in2).toMatchObject({ id: 'net:local:/amp2:IN', scope: 'hierarchical', scopePath: '/amp2' });
    expect(in1).not.toBe(in2);
    expect(in1.members.find(m => m.symbolId === 'r')).toMatchObject({ instancePath: '/amp1', ref: 'R1', pinNumber: '1', defId: 'amp' });
    expect(in2.members.find(m => m.symbolId === 'r')).toMatchObject({ instancePath: '/amp2', ref: 'R2' });
    expect(Object.keys(c.pinNet).filter(k => k.includes('\u0000r\u0000'))).toHaveLength(4);
    // the child wires are highlighted per instance
    expect(in1.wires.map(w => w.instancePath).sort()).toEqual(['', '/amp1']);
    expect(Object.keys(c.wireNet).some(k => k.startsWith('/amp2\u0000'))).toBe(true);
    expect(c.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
  });

  it('resolves children through instance fields, whatever the path convention', () => {
    const fx = fixtureRepeatedSheet();
    const joined = buildSchematic(fx.schematic.defs, { pathStyle: 'joined' });
    const c = computeConnectivity(joined);
    expect(c.nets.map(n => n.name).sort()).toEqual(['IN', 'IN', 'OUT', 'OUT']);
    expect(c.nets.map(n => n.scopePath).sort()).toEqual(['amp1', 'amp1', 'amp2', 'amp2']);
  });

  it('takes the net name from the highest hierarchy level and keeps the lower names as aliases', () => {
    const build = (label: boolean): SchConnectivity => {
      const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
      R(r, 'R1', [0, 0], [0, -50]); r.wire(0, 0, 10, 0);
      if (label) r.local('TOP', 5, 0);
      r.sheet('sub1', 'sub', 'sub', [{ name: 'IN', x: 10, y: 0 }]);
      s.hier('IN', 0, 0).wire(0, 0, 10, 0); R(s, 'R9', [10, 0], [10, -50]);
      return computeConnectivity(buildSchematic([r, s]));
    };
    const top = build(true).nets.find(n => n.members.some(m => m.ref === 'R1'))!;
    expect(top).toMatchObject({ name: 'TOP', scope: 'hierarchical', scopePath: '', id: 'net:local::TOP', aliases: ['IN', 'TOP'] });
    expect(memberLabels(top)).toEqual(['R1.1', 'R9.1']);
    const bare = build(false).nets.find(n => n.members.some(m => m.ref === 'R1'))!;
    expect(bare).toMatchObject({ name: 'IN', scopePath: '/sub1', id: 'net:local:/sub1:IN' });
  });

  it('leaves the sheet pin dangling when the child sheet is missing, with a diagnostic', () => {
    const r = new SheetBuilder('root');
    R(r, 'R1', [0, 0], [0, -50]); r.wire(0, 0, 10, 0).sheet('ghost', null, 'ghost', [{ name: 'A', x: 10, y: 0 }], { file: 'ghost.kicad_sch' });
    const c = computeConnectivity(buildSchematic([r]));
    expect(codes(c)).toContain('SHEET_CHILD_MISSING');
    expect(netOfPin(c, 'R1', '1')).toMatchObject({ name: 'A', aliases: ['A'] });
  });

  it('does not join a sheet pin and a hierarchical label that differ in name', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    R(r, 'R1', [0, 0], [0, -50]); r.wire(0, 0, 10, 0).sheet('sub1', 'sub', 'sub', [{ name: 'Y', x: 10, y: 0 }]);
    s.hier('X', 0, 0).wire(0, 0, 10, 0); R(s, 'R9', [10, 0], [10, -50]);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(codes(c)).toEqual(expect.arrayContaining(['SHEET_PIN_UNMATCHED', 'HIER_LABEL_UNMATCHED']));
    expect(netOfPin(c, 'R1', '1')).not.toBe(netOfPin(c, 'R9', '1', '/sub1'));
  });

  it('does not let a local label of the child join the parent through a sheet pin without a hierarchical label', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    R(r, 'R1', [0, 0], [0, -50]); r.wire(0, 0, 10, 0).sheet('sub1', 'sub', 'sub', [{ name: 'N', x: 10, y: 0 }]);
    s.local('N', 0, 0).wire(0, 0, 10, 0); R(s, 'R9', [10, 0], [10, -50]);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(netOfPin(c, 'R1', '1')?.scopePath).toBe('');
    expect(netOfPin(c, 'R1', '1')).not.toBe(netOfPin(c, 'R9', '1', '/sub1'));
  });

  it('ignores instances of unknown definitions and duplicate paths with diagnostics', () => {
    const fx = fixtureDivider();
    const s = structuredClone(fx.schematic);
    const extra: SchSheetInstance = { path: '/ghost', defId: 'nope', name: 'g', page: '2', parentPath: '', sheetRefId: 'ghost', childPaths: [], depth: 1 };
    s.instances.push(extra, { ...s.instances[0] });
    const c = computeConnectivity(s);
    expect(codes(c)).toEqual(expect.arrayContaining(['DEF_MISSING', 'INSTANCE_DUPLICATE']));
    expect(summarize(c)).toEqual(fx.expected);
  });

  it('rebuilds the hierarchy when the model lists no instances', () => {
    const fx = fixtureRepeatedSheet();
    const s = { ...fx.schematic, instances: [] };
    const c = computeConnectivity(s);
    expect(codes(c)).toContain('INSTANCES_MISSING');
    expect(c.nets.map(n => n.scopePath).sort()).toEqual(['/amp1', '/amp1', '/amp2', '/amp2']);
  });
});

describe('buses', () => {
  it('expands vector, group and aliased bus labels per the documentation', () => {
    expect(parseBusLabel('D[0..3]')).toEqual({ kind: 'bus', members: ['D0', 'D1', 'D2', 'D3'] });
    expect(parseBusLabel('D[3..0]')).toEqual({ kind: 'bus', members: ['D3', 'D2', 'D1', 'D0'] });
    expect(parseBusLabel('{SCL SDA}')).toEqual({ kind: 'bus', members: ['SCL', 'SDA'] });
    expect(parseBusLabel('USB1{DP DM}')).toEqual({ kind: 'bus', members: ['USB1.DP', 'USB1.DM'] });
    expect(parseBusLabel('MEMORY{A[1..0] OE}')).toEqual({ kind: 'bus', members: ['MEMORY.A1', 'MEMORY.A0', 'MEMORY.OE'] });
    expect(parseBusLabel('USB2{USB}', { USB: ['DP', 'DM', 'D[0..1]'] })).toEqual({ kind: 'bus', members: ['USB2.DP', 'USB2.DM', 'USB2.D0', 'USB2.D1'] });
    expect(parseBusLabel('{USB}')).toEqual({ kind: 'bus', members: ['USB'] });
    expect(parseBusLabel('{A A B}')).toEqual({ kind: 'bus', members: ['A', 'B'] });
  });

  it('treats overbar notation, plain names and malformed syntax correctly', () => {
    expect(parseBusLabel('~{RESET}')).toEqual({ kind: 'plain' });
    expect(parseBusLabel('CS~{0}')).toEqual({ kind: 'plain' });
    expect(parseBusLabel('D[0..')).toEqual({ kind: 'plain' });
    expect(parseBusLabel('[0..3]')).toEqual({ kind: 'plain' });
    expect(parseBusLabel('A[1]')).toEqual({ kind: 'plain' });
    expect(parseBusLabel('{~{DP} DM}')).toEqual({ kind: 'bus', members: ['~{DP}', 'DM'] });
    expect(parseBusLabel('{A B')).toMatchObject({ kind: 'invalid' });
    expect(parseBusLabel('{}')).toMatchObject({ kind: 'invalid' });
    expect(parseBusLabel('{A {B C}}')).toMatchObject({ kind: 'invalid' });
    expect(parseBusLabel('D[0..99999]')).toMatchObject({ kind: 'invalid' });
    expect(parseBusLabel('{A}', { A: ['{B}'] })).toMatchObject({ kind: 'invalid' });
  });

  it('keeps two wires from entries on one bus apart: an entry shorts nothing', () => {
    const fx = fixtureBus();
    const c = computeConnectivity(fx.schematic);
    expect(summarize(c)).toEqual(fx.expected);
    expect(netOfPin(c, 'R1', '1')).not.toBe(netOfPin(c, 'R2', '1'));
    expect(c.nets.map(n => n.name).sort()).toEqual(['D0', 'D1']);
    // the bus itself is not a net and has no wire in any net
    const wired = c.nets.flatMap(n => n.wires.map(w => w.wireId));
    expect(wired).toHaveLength(2);
    expect(wired).not.toContain(fx.schematic.defs[0].buses[0].id);
  });

  it('does not connect an unlabeled wire to the bus it touches through an entry', () => {
    const c = flat(b => {
      b.bus(0, 0, 40, 0).local('D[0..1]', 30, 0).entry(10, 0, 12.54, 2.54).wire(12.54, 2.54, 12.54, 10);
      R(b, 'R1', [12.54, 10], [12.54, 20]);
      R(b, 'R2', [30, 0], [30, 20]);
    });
    expect(c.nets).toHaveLength(0);
    expect(c.floatingPins).toHaveLength(4);
  });

  it('joins member nets by name only: equal labels merge, different labels do not', () => {
    const c = flat(b => {
      b.bus(0, 0, 40, 0).local('D[0..3]', 20, 0);
      for (const [i, name] of ['D0', 'D0', 'D1'].entries()) {
        const x = 10 + i * 10;
        b.entry(x, 0, x + 2.54, 2.54).wire(x + 2.54, 2.54, x + 2.54, 10).local(name, x + 2.54, 5);
        R(b, `R${i + 1}`, [x + 2.54, 10], [x + 2.54, 40 + i * 5]);
      }
    });
    expect(same(c, ['R1', '1'], ['R2', '1'])).toBe(true);
    expect(same(c, ['R1', '1'], ['R3', '1'])).toBe(false);
  });

  it('attaches bus labels by geometry and connects bus segments end to end', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    // two bus segments; the label sits on the second, the sheet pin on the first
    r.bus(0, 0, 20, 0).bus(20, 0, 40, 0).local('D[0..1]', 35, 0);
    r.sheet('sub1', 'sub', 'sub', [{ name: 'D[0..1]', x: 0, y: 0 }]);
    R(r, 'R1', [0, 20], [0, -50]); r.wire(0, 20, 10, 20).local('D1', 5, 20);
    s.bus(0, 0, 20, 0).hier('D[0..1]', 0, 0); R(s, 'R9', [0, 20], [0, -50]); s.wire(0, 20, 10, 20).local('D1', 5, 20);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(c.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
    expect(memberLabels(netOfPin(c, 'R1', '1')!)).toEqual(['R1.1', 'R9.1']);
  });

  it('carries bus members through a sheet pin and a hierarchical bus label, member by member', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    r.bus(0, 0, 30, 0).local('D[0..1]', 0, 0).sheet('sub1', 'sub', 'sub', [{ name: 'D[0..1]', x: 30, y: 0 }]);
    R(r, 'R1', [0, 20], [0, -50]); r.wire(0, 20, 10, 20).local('D1', 5, 20);
    R(r, 'R2', [0, 40], [0, -60]); r.wire(0, 40, 10, 40).local('D0', 5, 40);
    s.bus(0, 0, 20, 0).hier('D[0..1]', 0, 0);
    R(s, 'R9', [0, 20], [0, -50]); s.wire(0, 20, 10, 20).local('D1', 5, 20);
    const c = computeConnectivity(buildSchematic([r, s]));
    const d1 = netOfPin(c, 'R1', '1')!;
    expect(memberLabels(d1)).toEqual(['R1.1', 'R9.1']);
    expect(d1).toMatchObject({ name: 'D1', scope: 'hierarchical', scopePath: '' });
    expect(netOfPin(c, 'R2', '1')).not.toBe(d1);
  });

  it('maps group buses positionally, so differing prefixes resolve to the parent name', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    r.bus(0, 0, 30, 0).local('USB1{DP DM}', 0, 0).sheet('sub1', 'sub', 'sub', [{ name: 'UA{DP DM}', x: 30, y: 0 }]);
    R(r, 'R1', [0, 20], [0, -50]); r.wire(0, 20, 10, 20).local('USB1.DP', 5, 20);
    s.bus(0, 0, 20, 0).hier('UA{DP DM}', 0, 0);
    R(s, 'R9', [0, 20], [0, -50]); s.wire(0, 20, 10, 20).local('UA.DP', 5, 20);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(netOfPin(c, 'R9', '1', '/sub1')).toBe(netOfPin(c, 'R1', '1'));
    expect(netOfPin(c, 'R1', '1')).toMatchObject({ name: 'USB1.DP', aliases: ['UA.DP', 'USB1.DP'] });
  });

  it('refuses to join bus members when the member counts differ', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    r.bus(0, 0, 30, 0).local('USB1{DP}', 0, 0).sheet('sub1', 'sub', 'sub', [{ name: 'UA{DP DM}', x: 30, y: 0 }]);
    s.bus(0, 0, 20, 0).hier('UA{DP DM}', 0, 0);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(codes(c)).toContain('BUS_MEMBER_MISMATCH');
  });

  it('reports a plain label on a bus and an unnamed bus on a sheet pin', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    r.bus(0, 0, 30, 0).local('PLAIN', 10, 0).sheet('sub1', 'sub', 'sub', [{ name: 'D[0..1]', x: 30, y: 0 }]);
    s.bus(0, 0, 20, 0).hier('D[0..1]', 0, 0);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(codes(c)).toEqual(expect.arrayContaining(['LABEL_UNATTACHED', 'BUS_UNNAMED']));
  });

  it('applies the same junction rules to buses as to wires', () => {
    const build = (junction: boolean) => {
      const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
      r.bus(0, 10, 20, 10).bus(10, 0, 10, 20).local('D[0..1]', 0, 10).sheet('sub1', 'sub', 'sub', [{ name: 'D[0..1]', x: 10, y: 20 }]);
      if (junction) r.junction(10, 10);
      R(r, 'R1', [0, 40], [0, -50]); r.wire(0, 40, 10, 40).local('D1', 5, 40);
      s.bus(0, 0, 20, 0).hier('D[0..1]', 0, 0); R(s, 'R9', [0, 20], [0, -50]); s.wire(0, 20, 10, 20).local('D1', 5, 20);
      return computeConnectivity(buildSchematic([r, s]));
    };
    // without a junction the vertical bus carries no name, with one it shares the horizontal bus' members
    expect(codes(build(false))).toContain('BUS_UNNAMED');
    expect(build(true).nets.some(n => memberLabels(n).join() === 'R1.1,R9.1')).toBe(true);
  });
});

describe('multi-unit symbols and references', () => {
  const unit = (b: SheetBuilder, id: string, unitNo: number, pins: Array<[string, number, number]>, ref = 'U1', libId = 'Test:U'): void => {
    b.part(ref, pins.map(([n, x, y]) => ({ n, x, y })), { id, unit: unitNo, unitCount: 2, libId });
  };

  it('treats pins of one reference with the same number as one member and one net', () => {
    const c = flat(b => {
      unit(b, 'u1a', 1, [['1', 0, 0], ['7', 0, 20]]);
      unit(b, 'u1b', 2, [['2', 40, 0], ['7', 40, 20]]);
      b.power('GND', 0, 40).wire(0, 20, 0, 40);
    });
    const gnd = netByName(c, 'GND')!;
    expect(memberLabels(gnd)).toEqual(['U1.7']);
    expect(c.pinNet[key('u1a', '7')]).toBe(gnd.id);
    expect(c.pinNet[key('u1b', '7')]).toBe(gnd.id);
    expect(codes(c)).not.toContain('MULTI_UNIT_PIN_MISMATCH');
    expect(c.floatingPins.sort()).toEqual([key('u1a', '1'), key('u1b', '2')].sort());
  });

  it('merges the nets of a shared pin and warns when both were already connected elsewhere', () => {
    const c = flat(b => {
      unit(b, 'u1a', 1, [['7', 0, 20]]);
      unit(b, 'u1b', 2, [['7', 40, 20]]);
      b.power('A', 0, 40).wire(0, 20, 0, 40).power('B', 40, 40).wire(40, 20, 40, 40);
    });
    expect(codes(c)).toContain('MULTI_UNIT_PIN_MISMATCH');
    expect(codes(c)).toContain('NET_NAME_CONFLICT');
    expect(c.nets).toHaveLength(1);
    expect(c.nets[0].aliases).toEqual(['A', 'B']);
  });

  it('reports duplicate references instead of merging unrelated parts', () => {
    const c = flat(b => {
      R(b, 'R1', [0, 0], [10, 0]);
      b.part('R1', [{ n: '1', x: 30, y: 0 }, { n: '2', x: 40, y: 0 }], { id: 'other', libId: 'Test:C' });
      R(b, 'R5', [10, 0], [20, 0]); R(b, 'R6', [40, 0], [50, 0]);
    });
    expect(codes(c)).toContain('DUPLICATE_REFERENCE');
    expect(netOfPin(c, 'R1', '2')).toBe(netOfPin(c, 'R5', '1'));
    expect(netOfPin(c, 'other', '2')).toBe(netOfPin(c, 'R6', '1'));
    expect(netOfPin(c, 'R1', '2')).not.toBe(netOfPin(c, 'other', '2'));
  });

  it('flags the same unit placed twice under one reference', () => {
    const c = flat(b => { unit(b, 'a', 1, [['1', 0, 0]]); unit(b, 'b', 1, [['1', 40, 0]]); });
    expect(codes(c)).toContain('DUPLICATE_REFERENCE');
  });

  it('never merges unannotated references', () => {
    const c = flat(b => {
      b.part('R?', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 10, y: 0 }], { id: 'a' });
      b.part('R?', [{ n: '1', x: 30, y: 0 }, { n: '2', x: 40, y: 0 }], { id: 'b' });
      b.power('X', 10, 0).power('Y', 40, 0);
    });
    expect(codes(c)).toContain('UNANNOTATED_REFERENCE');
    expect(codes(c)).not.toContain('DUPLICATE_REFERENCE');
    expect(c.nets.map(n => n.name).sort()).toEqual(['X', 'Y']);
  });

  it('merges identical pin numbers inside one symbol (stacked duplicates)', () => {
    const c = flat(b => {
      b.part('J1', [{ n: '1', x: 0, y: 0 }, { n: '1', x: 0, y: 20 }, { n: '2', x: 0, y: 40 }]);
      b.power('V', 0, 10).wire(0, 10, 0, 20).wire(0, 20, 0, 10);
    });
    expect(netByName(c, 'V')?.members.map(m => m.pinNumber)).toEqual(['1']);
  });
});

describe('declared connectivity (EAGLE)', () => {
  it('builds nets from the declared pins, one per name across sheets, never from geometry', () => {
    const fx = fixtureDeclared();
    const c = computeConnectivity(fx.schematic);
    expect(summarize(c)).toEqual(fx.expected);
    const gnd = netByName(c, 'GND')!;
    expect(gnd).toMatchObject({ id: 'net:global:GND', scope: 'global', aliases: ['GND'], auto: false });
    expect(gnd.members.map(m => m.instancePath).sort()).toEqual(['', '', 'sheet:2']);
    // R1/C1 pins coincide and are wired together geometrically, yet the declaration keeps two nets
    expect(netOfPin(c, 'R1', '1')).not.toBe(netOfPin(c, 'R1', '2'));
    expect(netByName(c, 'N$1')?.auto).toBe(true);
    expect(c.nets.every(n => n.wires.length === 0)).toBe(true);
    expect(codes(c)).toContain('DECLARED_WIRE_AMBIGUOUS');
  });

  it('attributes wires only when pins or labels agree on one net', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    const sheet1 = s.defs[0];
    sheet1.wires = [];
    // R1.2 -> a wire to a free end labelled "SIG", and an unrelated wire without any evidence
    sheet1.wires.push({ id: 'w1', a: { x: 10, y: 0 }, b: { x: 10, y: 30 } }, { id: 'w2', a: { x: 100, y: 100 }, b: { x: 110, y: 100 } }, { id: 'w3', a: { x: 50, y: 50 }, b: { x: 60, y: 50 } });
    sheet1.labels.push({ id: 'l1', kind: 'local', text: 'GND', at: { x: 55, y: 50 }, angle: 0 });
    // moving the coincident pins apart keeps w1 on the pins of N$1 only
    sheet1.symbols[0].pins[1].at = { x: 10, y: 0 }; sheet1.symbols[1].pins[0].at = { x: 10, y: 0 };
    const c = computeConnectivity(s);
    expect(c.wireNet[`\u0000w1`]).toBe('net:global:N$1');
    expect(c.wireNet[`\u0000w2`]).toBeUndefined();
    expect(c.wireNet[`\u0000w3`]).toBe('net:global:GND');
    expect(netByName(c, 'N$1')?.wires).toEqual([{ instancePath: '', wireId: 'w1' }]);
  });

  it('uses a power / supply tie only for pins that no declared net lists', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    s.defs[1].symbols[0].pins[1].implicitNet = 'VCC';
    const c = computeConnectivity(s);
    expect(netByName(c, 'VCC')?.members.map(m => `${m.ref}.${m.pinNumber}`)).toEqual(['R2.2']);
    expect(netByName(c, 'GND')?.members.map(m => m.ref)).toEqual(['C1', 'R1', 'R2']);
  });

  it('reports unknown declared pins, pins declared twice and no-connect conflicts', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    s.declaredNets!.push({ name: 'BAD', pins: [{ instancePath: '', defId: 'sheet:1', symbolId: 'ghost', pinId: 'ghost#1' }, { instancePath: '', defId: 'sheet:1', symbolId: 'R1', pinId: 'R1#1' }] });
    s.defs[1].noConnects.push({ id: 'nc', at: { x: 0, y: 0 } });
    const c = computeConnectivity(s);
    expect(codes(c)).toEqual(expect.arrayContaining(['DECLARED_PIN_UNKNOWN', 'PIN_IN_MULTIPLE_NETS', 'NO_CONNECT_CONFLICT']));
    expect(netOfPin(c, 'R1', '1')?.name).toBe('GND');
    expect(c.noConnectPins).toEqual([key('R2', '1', 'sheet:2')]);
  });

  it('attributes declared wires directly, including wires of segments without a pin reference', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    // w1 touches R1.1 (GND) and R1.2 (N$1) geometrically; the source says w1 belongs to N$1 and w2 to GND
    s.declaredNets![0].wires = [{ instancePath: '', defId: 'sheet:1', wireId: 'w2' }];
    s.declaredNets![2].wires = [{ instancePath: '', defId: 'sheet:1', wireId: 'w1' }];
    const c = computeConnectivity(s);
    expect(c.wireNet['\u0000w1']).toBe('net:global:N$1');
    expect(c.wireNet['\u0000w2']).toBe('net:global:GND');
    expect(netByName(c, 'N$1')?.wires).toEqual([{ instancePath: '', wireId: 'w1' }]);
    expect(netByName(c, 'GND')?.wires).toEqual([{ instancePath: '', wireId: 'w2' }]);
    expect(codes(c)).not.toContain('DECLARED_WIRE_AMBIGUOUS');
    // pins stay exactly the declared ones
    expect(summarize(c)).toEqual(fx.expected);
  });

  it('emits a zero-pin declared net that has a name and wires, merging the same name across sheets', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    s.defs[0].wires.push({ id: 'stub1', a: { x: 200, y: 0 }, b: { x: 210, y: 0 } });
    s.defs[1].wires.push({ id: 'stub2', a: { x: 200, y: 0 }, b: { x: 210, y: 0 } });
    s.declaredNets!.push(
      { name: 'ONLY_WIRE', pins: [], wires: [{ instancePath: '', defId: 'sheet:1', wireId: 'stub1' }] },
      { name: 'ONLY_WIRE', pins: [], wires: [{ instancePath: 'sheet:2', defId: 'sheet:2', wireId: 'stub2' }] },
      { name: 'EMPTY', pins: [] },
    );
    const c = computeConnectivity(s);
    const stub = netByName(c, 'ONLY_WIRE')!;
    expect(stub).toMatchObject({ id: 'net:global:ONLY_WIRE', scope: 'global', members: [], aliases: ['ONLY_WIRE'] });
    expect(stub.wires).toEqual([{ instancePath: '', wireId: 'stub1' }, { instancePath: 'sheet:2', wireId: 'stub2' }]);
    expect(c.wireNet['sheet:2\u0000stub2']).toBe(stub.id);
    expect(c.nets.filter(n => n.name === 'ONLY_WIRE')).toHaveLength(1);
    // a declared net with neither pins nor wires is nothing to show and is not invented into a net
    expect(netByName(c, 'EMPTY')).toBeUndefined();
  });

  it('keeps the first net when a wire is declared in two nets and says so', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    const w = { instancePath: '', defId: 'sheet:1', wireId: 'w1' };
    s.declaredNets![0].wires = [w];
    s.declaredNets![2].wires = [w];
    const c = computeConnectivity(s);
    expect(c.wireNet['\u0000w1']).toBe('net:global:GND');
    expect(netByName(c, 'N$1')?.wires.map(x => x.wireId)).not.toContain('w1');
    expect(c.diagnostics.find(d => d.code === 'WIRE_IN_MULTIPLE_NETS')?.message).toContain('"GND" and "N$1"');
    expect(JSON.stringify(computeConnectivity(s))).toBe(JSON.stringify(c));
  });

  it('attributes the wires of a disconnected segment to a net that has pins elsewhere', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    s.defs[0].wires.push({ id: 'far1', a: { x: 300, y: 300 }, b: { x: 310, y: 300 } }, { id: 'far2', a: { x: 310, y: 300 }, b: { x: 310, y: 320 } });
    s.declaredNets![0].wires = [{ instancePath: '', defId: 'sheet:1', wireId: 'far1' }, { instancePath: '', defId: 'sheet:1', wireId: 'far2' }];
    const c = computeConnectivity(s);
    expect(c.wireNet['\u0000far1']).toBe('net:global:GND');
    expect(c.wireNet['\u0000far2']).toBe('net:global:GND');
    expect(netByName(c, 'GND')?.members).toHaveLength(3);
    expect(netByName(c, 'GND')?.wires.map(x => x.wireId)).toEqual(['far1', 'far2']);
  });

  it('ignores declared wires that do not exist and still infers only the unlisted wires', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    s.declaredNets![2].wires = [{ instancePath: '', defId: 'sheet:1', wireId: 'w1' }, { instancePath: '', defId: 'sheet:1', wireId: 'ghost' }, { instancePath: 'nope', defId: 'sheet:1', wireId: 'w2' }];
    const c = computeConnectivity(s);
    expect(codes(c)).toContain('DECLARED_WIRE_UNKNOWN');
    expect(c.wireNet['\u0000w1']).toBe('net:global:N$1');
    // w2 is not listed by the source and touches pins of two declared nets: not attributed
    expect(c.wireNet['\u0000w2']).toBeUndefined();
    expect(c.diagnostics.find(d => d.code === 'DECLARED_WIRE_AMBIGUOUS')?.message).toMatch(/^1 wire/);
  });

  it('lists undeclared pins as floating', () => {
    const fx = fixtureDeclared();
    const s = structuredClone(fx.schematic);
    s.defs[1].symbols[0].pins[1].at = { x: 500, y: 500 };
    const c = computeConnectivity(s);
    expect(c.floatingPins).toEqual([key('R2', '2', 'sheet:2')]);
  });

  it('falls back to geometry with a warning for an EAGLE file without declared nets', () => {
    const fx = fixtureDivider();
    const s = { ...fx.schematic, format: 'eagle-sch' as const };
    const c = computeConnectivity(s);
    expect(codes(c)).toContain('DECLARED_NETS_MISSING');
    expect(summarize(c)).toEqual(fx.expected);
  });
});

describe('output contract', () => {
  it('computes the flat divider fixture', () => {
    const fx = fixtureDivider();
    const c = computeConnectivity(fx.schematic);
    expect(summarize(c)).toEqual(fx.expected);
    expect(c.nets.map(n => n.name)).toEqual(['GND', 'OUT', 'VCC']);
    expect(netByName(c, 'OUT')).toMatchObject({ id: 'net:local::OUT', scope: 'local', auto: false, aliases: ['OUT'] });
    expect(c.floatingPins).toEqual([]);
    expect(c.noConnectPins).toEqual([]);
    expect(c.diagnostics).toEqual([]);
    expect(c.nets.flatMap(n => n.wires.map(w => w.wireId)).sort()).toEqual(fx.schematic.defs[0].wires.map(w => w.id).sort());
  });

  it('is deterministic and returns plain, structured-clone-safe data', () => {
    for (const fx of [fixtureDivider(), fixtureRepeatedSheet(), fixtureBus(), fixtureDeclared()]) {
      const a = computeConnectivity(fx.schematic), b = computeConnectivity(structuredClone(fx.schematic));
      expect(b).toEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
      expect(structuredClone(a)).toEqual(a);
      const ids = a.nets.map(n => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      const sorted = [...a.nets].sort((x, y) => naturalCompare(x.name, y.name) || (x.id < y.id ? -1 : 1));
      expect(a.nets).toEqual(sorted);
      for (const net of a.nets) expect(net.aliases).toEqual([...net.aliases].sort());
    }
  });

  it('is independent of the order of the input definitions', () => {
    const fx = fixtureRepeatedSheet();
    const swapped = { ...fx.schematic, defs: [...fx.schematic.defs].reverse() };
    expect(summarize(computeConnectivity(swapped))).toEqual(fx.expected);
  });

  it('never mutates its input', () => {
    const fx = fixtureRepeatedSheet();
    const before = JSON.stringify(fx.schematic);
    computeConnectivity(fx.schematic);
    expect(JSON.stringify(fx.schematic)).toBe(before);
  });

  it('keys nets, wires and pins with the model key functions', () => {
    const c = computeConnectivity(fixtureDivider().schematic);
    const net = netByName(c, 'OUT') as SchNet;
    for (const m of net.members) expect(c.pinNet[pinKey(m.instancePath, m.symbolId, m.pinId)]).toBe(net.id);
    for (const w of net.wires) expect(c.wireNet[`${w.instancePath}\u0000${w.wireId}`]).toBe(net.id);
    expect(net.members[0]).toMatchObject({ pinName: '', unit: 1, defId: 'root', instancePath: '' });
  });

  it('sorts references and pin numbers naturally', () => {
    expect(['R10', 'R2', 'R1', 'C3'].sort(naturalCompare)).toEqual(['C3', 'R1', 'R2', 'R10']);
    expect(['A12', 'A2', 'A1', 'B1'].sort(naturalCompare)).toEqual(['A1', 'A2', 'A12', 'B1']);
    expect(naturalCompare('R01', 'R1')).not.toBe(0);
  });

  it('honours an aborted signal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => computeConnectivity(fixtureDivider().schematic, { signal: controller.signal })).toThrow(SchematicError);
    try { computeConnectivity(fixtureDivider().schematic, { signal: controller.signal }); } catch (error) { expect((error as SchematicError).code).toBe('ABORTED'); }
  });

  it('stops in the middle of a large computation when the signal fires', () => {
    const controller = new AbortController();
    const s = fixtureStress({ symbols: 3000 });
    let calls = 0;
    const signal = { get aborted(): boolean { return ++calls > 3; } } as unknown as AbortSignal;
    expect(() => computeConnectivity(s, { signal })).toThrow(/aborted/);
    expect(controller.signal.aborted).toBe(false);
  });

  it('enforces the import budgets', () => {
    const fx = fixtureDivider();
    const many = structuredClone(fx.schematic);
    many.instances = Array.from({ length: 4097 }, (_, i) => ({ ...many.instances[0], path: `/i${i}` }));
    expect(() => computeConnectivity(many)).toThrow(SchematicError);
    const deep = structuredClone(fx.schematic);
    deep.instances[0].depth = 65;
    try { computeConnectivity(deep); expect.unreachable(); } catch (error) { expect((error as SchematicError).code).toBe('LIMIT_EXCEEDED'); }
  });

  it('caps repetitive diagnostics', () => {
    const c = flat(b => { for (let i = 0; i < 250; i++) b.local(`L${i}`, 1000 + i * 3, 1000); });
    expect(c.diagnostics.filter(d => d.code === 'LABEL_UNATTACHED')).toHaveLength(100);
    expect(c.diagnostics.find(d => d.code === 'DIAGNOSTICS_SUPPRESSED')?.message).toContain('150 further LABEL_UNATTACHED');
  });
});

describe('performance', () => {
  it('connects >= 100k wires and >= 20k symbols in a few seconds', () => {
    const schematic = fixtureStress({ symbols: 20_000 });
    const wires = schematic.defs[0].wires.length;
    expect(wires).toBeGreaterThanOrEqual(100_000 - 1000);
    const started = performance.now();
    const c = computeConnectivity(schematic);
    const elapsed = performance.now() - started;
    // eslint-disable-next-line no-console
    console.log(`connectivity: ${wires} wires, ${schematic.defs[0].symbols.length} symbols, ${c.nets.length} nets in ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(6000);
    // 99 wired pairs per 100-part row (T stubs join, decoys do not); the first pin of each row and the last pin are floating
    expect(c.nets).toHaveLength(200 * 99);
    expect(c.floatingPins).toHaveLength(200 * 2);
    expect(netOfPin(c, 'R1', '2')).toBe(netOfPin(c, 'R2', '1'));
    expect(netOfPin(c, 'R2', '2')).toBe(netOfPin(c, 'R3', '1'));
    expect(netOfPin(c, 'R1', '2')).not.toBe(netOfPin(c, 'R2', '2'));
    // per pair: the main wire and the T stub; the crossing decoy and the floating chain belong to no net
    expect(netOfPin(c, 'R1', '2')?.wires.length).toBe(2);
    expect(Object.keys(c.wireNet)).toHaveLength(200 * 99 * 2);
  }, 60_000);

  it('expands a deep repeated hierarchy without re-solving the geometry per instance', () => {
    const leaf = new SheetBuilder('leaf');
    leaf.hier('A', 0, 0).wire(0, 0, 10, 0);
    R(leaf, 'R?', [10, 0], [10, 20]);
    const root = new SheetBuilder('root');
    for (let i = 0; i < 400; i++) root.sheet(`s${i}`, 'leaf', `s${i}`, [{ name: 'A', x: 0, y: i * 20 }]);
    const started = performance.now();
    const c = computeConnectivity(buildSchematic([root, leaf]));
    const elapsed = performance.now() - started;
    // eslint-disable-next-line no-console
    console.log(`hierarchy: 400 instances, ${c.nets.length} nets in ${elapsed.toFixed(0)} ms`);
    expect(c.nets).toHaveLength(400);
    expect(new Set(c.nets.map(n => n.id)).size).toBe(400);
    expect(elapsed).toBeLessThan(3000);
  });
});

// Real-file findings (S1 KiCad 9 demo "pic_programmer"); each construct is rebuilt as a small ORIGINAL synthetic fixture.
describe('real-file findings: KiCad escape tokens and virtual power-input symbols', () => {
  it('W-open-sch-02: a KiCad escape token such as {slash} is literal text in a net name, not group syntax', () => {
    for (const text of ['VPP{slash}MCLR', 'A{comma}B', '{slash}X', 'UTILITY{slash}HEAC+', 'a{space}b{dollar}c']) expect(parseBusLabel(text), text).toEqual({ kind: 'plain' });
    expect(parseBusLabel('USB{DP DM}')).toEqual({ kind: 'bus', members: ['USB.DP', 'USB.DM'] });
    expect(parseBusLabel('~{RESET}')).toEqual({ kind: 'plain' });
    expect(parseBusLabel('A{B')).toMatchObject({ kind: 'invalid' });
    expect(parseBusLabel('A{foo}B')).toMatchObject({ kind: 'invalid' }); // an unknown token is not an escape
  });

  it('W-open-sch-02: "{slash}" and "/" are one name: the labels join, nothing is reported, and the text is kept as written', () => {
    const c = flat(b => {
      R(b, 'R1', [0, 0], [0, -900]); R(b, 'R2', [20, 0], [20, -900]); b.wire(0, 0, 20, 0).local('VPP/MCLR', 5, 0).local('VPP{slash}MCLR', 10, 0);
      R(b, 'R3', [0, 20], [0, -910]); R(b, 'R4', [20, 20], [20, -910]); b.wire(0, 20, 20, 20).local('VPP{slash}MCLR', 5, 20);
    });
    expect(c.nets).toHaveLength(1);
    expect(memberLabels(c.nets[0])).toEqual(['R1.1', 'R2.1', 'R3.1', 'R4.1']);
    expect(c.nets[0].aliases).toEqual(['VPP/MCLR', 'VPP{slash}MCLR']);
    expect(codes(c)).not.toContain('NET_NAME_CONFLICT'); expect(codes(c)).not.toContain('BUS_LABEL_INVALID');
  });

  it('W-open-sch-02: a sheet pin and a child hierarchical label join when one is written with {slash} and the other with "/"', () => {
    const r = new SheetBuilder('root'), s = new SheetBuilder('sub');
    R(r, 'R1', [0, 0], [0, -50]); r.wire(0, 0, 10, 0).sheet('sub1', 'sub', 'sub', [{ name: 'MCLR/VPP', x: 10, y: 0 }]);
    s.hier('MCLR{slash}VPP', 0, 0).wire(0, 0, 10, 0); R(s, 'R9', [10, 0], [10, -50]);
    const c = computeConnectivity(buildSchematic([r, s]));
    expect(memberLabels(netOfPin(c, 'R1', '1')!)).toEqual(['R1.1', 'R9.1']);
    expect(codes(c)).not.toContain('SHEET_PIN_UNMATCHED'); expect(codes(c)).not.toContain('HIER_LABEL_UNMATCHED');
  });

  it('W-open-sch-03: a hidden power-input pin names its global net on a VIRTUAL symbol too (KiCad 4/5 "#PWR" symbols without a (power) flag)', () => {
    const c = flat(b => {
      R(b, 'R1', [0, 0], [0, -900]); R(b, 'R2', [40, 0], [40, -900]); b.wire(0, 0, 10, 0).wire(40, 0, 50, 0);
      b.part('#PWR1', [{ n: '1', x: 10, y: 0, name: 'VPP', type: 'power_in', hidden: true, implicitNet: 'VPP' }], { virtual: true });
      b.part('#PWR2', [{ n: '1', x: 50, y: 0, name: 'VPP', type: 'power_in', hidden: true, implicitNet: 'VPP' }], { virtual: true });
    });
    const vpp = netByName(c, 'VPP')!;
    expect(vpp).toMatchObject({ id: 'net:global:VPP', scope: 'global', auto: false });
    expect(memberLabels(vpp)).toEqual(['R1.1', 'R2.1']); // both wires are one net through the shared global name; the virtual symbols are not members
  });
});
