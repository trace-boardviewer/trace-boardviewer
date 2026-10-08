import { describe, expect, it } from 'vitest';
import { ALTIUM_SCH_FORMAT } from './altium-sch';
import { decodeAsciiDocument, decodeBinaryStream, parseProject, schDocStream, sniffSchDoc } from './altium-sch-records';
import {
  ASCII_HEADER, close, codes, concat, connect, container, def, enc, framed, HEADER, LIBRARY_HEADER, MM, mmX, mmY, must, netOf, parse, pinOf, pinsOf, project, Sheet, symbolOf, thrown, divider,
} from './altium-sch-fixtures';

// All fixtures are original synthetic SchDoc files written for these tests (see altium-sch-fixtures.ts); no vendor or third-party data.

describe('recognition and container', () => {
  const doc = divider();

  it('reads a binary SchDoc: format, label, unit and name', () => {
    const s = must(doc.file(), 'Divider.SchDoc');
    expect(ALTIUM_SCH_FORMAT).toBe('altium-sch');
    expect(s.format).toBe('altium-sch');
    expect(s.formatLabel).toBe('Altium schematic (SchDoc, version 5.0)');
    expect(s.sourceUnit).toBe('mil');
    expect(s.name).toBe('Divider');
    expect(s.defs).toHaveLength(1);
    expect(s.rootDefId).toBe('divider.schdoc');
    expect(s.instances).toEqual([expect.objectContaining({ path: '', defId: 'divider.schdoc', name: 'Divider', parentPath: null, sheetRefId: null, depth: 0, childPaths: [] })]);
  });

  it('gives a document without a file name a sheet id of its own, and connectivity works on it', () => {
    for (const name of ['', '/', 'dir/', 'C:/']) {
      const s = must(doc.file(), name);
      expect(s.defs.map(d => d.id), JSON.stringify(name)).toEqual(['schematic']);
      expect(s.rootDefId).toBe('schematic');
      expect(s.instances.map(i => i.defId)).toEqual(['schematic']);
      expect(connect(s).nets.map(n => n.name).sort()).toEqual(connect(must(doc.file())).nets.map(n => n.name).sort());
    }
  });

  it('reads the line-based export of the same records to the same model', () => {
    const binary = must(doc.file()), ascii = must(doc.ascii());
    expect(ascii.formatLabel).toBe('Altium schematic (SchDoc, ASCII, version 5.0)');
    expect(JSON.stringify(ascii.defs)).toBe(JSON.stringify(binary.defs));
    const unix = must(doc.ascii('\n')), bom = must(concat([0xef, 0xbb, 0xbf], doc.ascii()));
    expect(JSON.stringify(unix.defs)).toBe(JSON.stringify(binary.defs));
    expect(JSON.stringify(bom.defs)).toBe(JSON.stringify(binary.defs));
  });

  it('skips the storage section that closes the line-based export and says so', () => {
    const tail = ['|HEADER=Icon storage|WEIGHT=2', '|BINARY=208|NAME=logo.bmp|DATA_LEN=40|DATA=789CED5D3D92E43A72AE8D50C4E01863EA04B219F2758756AD55D|>', '577E8A0A133C81E4321A3595EB3CC25692B626FA050F|>', '4BFFFFEE2168735DF7F7FDDF3570FA87499586578F8CDE854F2E', ASCII_HEADER].join('\r\n') + '\r\n';
    const s = must(doc.ascii('\r\n', tail));
    expect(JSON.stringify(s.defs)).toBe(JSON.stringify(must(doc.file()).defs));
    expect(s.diagnostics.find(d => d.code === 'STORAGE_SKIPPED')?.severity).toBe('info');
  });

  it('reads decimal commas written by a comma locale in the line-based export', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.add(12, { 'Location.X': 100, 'Location.Y': 100, Radius: 10, StartAngle: '5,595', EndAngle: '90,5', OwnerPartId: -1 });
    const g = def(must(s.ascii())).graphics;
    expect(g).toHaveLength(1);
    const point = (p: { x: number; y: number }) => [p.x, p.y];
    const dotted = new Sheet({ SheetStyle: 0 });
    dotted.add(12, { 'Location.X': 100, 'Location.Y': 100, Radius: 10, StartAngle: '5.595', EndAngle: '90.5', OwnerPartId: -1 });
    expect(JSON.stringify(def(must(dotted.file())).graphics)).toBe(JSON.stringify(g));
    expect(g[0].kind === 'poly' && point(g[0].points[0])).toEqual([expect.any(Number), expect.any(Number)]);
    const strict = new Sheet({ SheetStyle: 0 });
    strict.add(12, { 'Location.X': 100, 'Location.Y': 100, Radius: 10, StartAngle: '1,2,3', EndAngle: 90 });
    thrown(() => parse(strict.ascii()), 'INVALID_FORMAT');
  });

  it('returns null for bytes that are not a SchDoc, so the other readers can try', () => {
    expect(parse(new Uint8Array(0))).toBeNull();
    expect(parse(enc.encode('short'))).toBeNull();
    expect(parse(enc.encode('(kicad_sch (version 20231120) (generator "eeschema"))'))).toBeNull();
    expect(parse(enc.encode('<?xml version="1.0"?><eagle version="9.6.2"><drawing/></eagle>'))).toBeNull();
    expect(parse(enc.encode('|HEADER=Protel for Windows - Printed Circuit Board Capture Ascii File Version 5.0\r\n|RECORD=1|'))).toBeNull();
    expect(parse(new Uint8Array(4096).fill(0x41))).toBeNull();
    // an OLE container that is a PcbDoc (its FileHeader stream is a plain version string), or has no FileHeader at all
    expect(parse(container({ FileHeader: framed('PCB 6.0 Binary Library File'), Board6: new Uint8Array(8) }))).toBeNull();
    expect(parse(container({ Other: new Uint8Array(8) }))).toBeNull();
    expect(parse(container({ FileHeader: new Uint8Array(0) }))).toBeNull();
  });

  it('refuses a symbol library with a clear reason instead of a blank sheet', () => {
    const lib = new Sheet(null); lib.header = LIBRARY_HEADER;
    expect(thrown(() => parse(lib.file(), 'Parts.SchLib'), 'UNSUPPORTED_VARIANT').message).toMatch(/SchLib/);
    expect(thrown(() => parse(lib.ascii(), 'Parts.SchLib'), 'UNSUPPORTED_VARIANT').message).toMatch(/symbol library/);
  });

  it('ignores extra streams and warns once about a version it has not seen', () => {
    const extra = must(doc.file({ Storage: enc.encode('|HEADER=Icon storage|Weight=0\0'), '1': new Uint8Array(100) }));
    expect(JSON.stringify(extra.defs)).toBe(JSON.stringify(must(doc.file()).defs));
    const odd = new Sheet({ SheetStyle: 0 }); odd.header = HEADER.replace('5.0', '7.1');
    const s = must(odd.file());
    expect(s.formatLabel).toBe('Altium schematic (SchDoc, version 7.1)');
    expect(s.diagnostics.filter(d => d.code === 'VERSION_UNTESTED')).toHaveLength(1);
    expect(codes(must(doc.file()))).not.toContain('VERSION_UNTESTED');
  });

  it('is deterministic and plain data', () => {
    const a = must(doc.file()), b = must(doc.file());
    expect(b).toEqual(a);
    expect(structuredClone(a)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(connect(b)).toEqual(connect(a));
  });

  it('exposes the record layer pieces it is built from', () => {
    expect(sniffSchDoc(doc.ascii())).toBe('ascii');
    expect(sniffSchDoc(enc.encode('|HEADER=Protel for Windows - Schematic Library Editor Ascii File Version 5.0\r\n'))).toBe('library');
    expect(sniffSchDoc(doc.file())).toBeNull();
    const found = schDocStream(doc.file());
    expect(found?.kind).toBe('binary');
    const records = decodeBinaryStream(found!.stream);
    expect(records.count).toBe(doc.count);
    expect(records.kind[0]).toBe(31);
    expect(decodeAsciiDocument(doc.ascii()).count).toBe(doc.count);
    expect(parseProject(project(['A.SchDoc', 'Sub\\B.SchDoc', 'Board.PcbDoc'], 3))).toEqual({ hierarchyMode: 3, documents: ['A.SchDoc', 'Sub\\B.SchDoc', 'Board.PcbDoc'] });
  });
});

describe('sheet size, frame and title block', () => {
  it('maps the sheet styles to their paper sizes', () => {
    const size = (rec: Record<string, string | number | boolean>) => { const p = def(must(new Sheet(rec).file())).paper!; return [p.width, p.height]; };
    const [w0, h0] = size({ SheetStyle: 0 });
    close(w0, 1150 * MM); close(h0, 760 * MM);
    expect(size({})).toEqual(size({ SheetStyle: 0 }));
    const [w1, h1] = size({ SheetStyle: 4 });
    close(w1, 4460 * MM); close(h1, 3150 * MM);
    const [w2, h2] = size({ SheetStyle: 10 });
    close(w2, 1100 * MM); close(h2, 850 * MM);
    const [w3, h3] = size({ SheetStyle: 17 });
    close(w3, 4280 * MM); close(h3, 3280 * MM);
  });

  it('honours custom sheets, fractions and the portrait orientation', () => {
    const custom = def(must(new Sheet({ UseCustomSheet: true, CustomX: 2000, CustomY: 1000 }).file())).paper!;
    close(custom.width, 508); close(custom.height, 254);
    const frac = def(must(new Sheet({ UseCustomSheet: true, CustomX: 2000, CustomX_Frac: 50000, CustomY: 1000 }).file())).paper!;
    close(frac.width, 2000.5 * MM);
    const portrait = def(must(new Sheet({ SheetStyle: 0, WorkspaceOrientation: 1 }).file())).paper!;
    close(portrait.width, 760 * MM); close(portrait.height, 1150 * MM);
  });

  it('flips Y about the sheet height and keeps X', () => {
    const s = new Sheet({ SheetStyle: 4 });
    s.wire([0, 0], [100, 3150]);
    const w = def(must(s.file())).wires[0];
    close(w.a.x, 0); close(w.a.y, 3150 * MM); close(w.b.x, 100 * MM); close(w.b.y, 0);
  });

  it('warns about an unknown style and a missing sheet record, and assumes A4 in both cases', () => {
    const odd = must(new Sheet({ SheetStyle: 99 }).file());
    expect(codes(odd)).toContain('SHEET_STYLE_UNKNOWN');
    close(def(odd).paper!.width, 1150 * MM);
    const none = must(new Sheet(null).file());
    expect(codes(none)).toContain('SHEET_RECORD_MISSING');
    expect(def(none).paper).toEqual({ width: 292.1, height: 193.04 });
  });

  it('reads the title block from the sheet-level parameters and ignores placeholders', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.param('Title', 'Power stage'); s.param('Revision', 'B'); s.param('DocumentNumber', 'PS-001'); s.param('Author', '*'); s.param('CompanyName', '=Organization'); s.param('Other', 'ignored');
    const d = def(must(s.file()));
    expect(d.title).toBe('Power stage');
    expect(d.titleBlock).toEqual({ title: 'Power stage', rev: 'B', number: 'PS-001' });
  });

  it('rejects an absurd sheet', () => {
    thrown(() => parse(new Sheet({ UseCustomSheet: true, CustomX: 0, CustomY: 0 }).file()), 'INVALID_FORMAT');
    thrown(() => parse(new Sheet({ UseCustomSheet: true, CustomX: 99999999, CustomY: 10 }).file()), 'INVALID_FORMAT');
  });
});

describe('components, designators, parameters and pins', () => {
  it('reads the designator (RECORD=34), value, footprint and library identity', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R7', 200, 500, { lib: 'RES_0805', params: { Comment: '=Value', Value: '22k', Datasheet: 'https://example.invalid/ds.pdf', Tolerance: '1%' }, hiddenParams: { Secret: 'x' },
      footprints: [{ name: 'OLD_FP' }, { name: 'R0805', current: true }, { name: 'MODEL.step', type: 'STEP', current: true }] });
    const d = def(must(s.file()));
    const r = d.symbols[0];
    expect(r.refDefault).toBe('R7');
    expect(r.instances).toEqual({ '': { ref: 'R7', unit: 1 } });
    expect(r.value).toBe('22k');
    expect(r.footprint).toBe('R0805');
    expect(r.datasheet).toBe('https://example.invalid/ds.pdf');
    expect(r.libId).toBe('Synthetic.IntLib:RES_0805');
    expect(r.virtual).toBe(false);
    expect(r.fields.map(f => [f.name, f.value, f.hidden])).toEqual([['Reference', 'R7', false], ['Comment', '=Value', false], ['Value', '22k', false], ['Datasheet', 'https://example.invalid/ds.pdf', false], ['Tolerance', '1%', false], ['Secret', 'x', true]]);
    expect(r.graphics.filter(g => g.kind === 'text').map(g => g.kind === 'text' && g.text)).toContain('R7');
    expect(r.graphics.some(g => g.kind === 'text' && g.text === 'x')).toBe(false); // hidden parameters are fields, never drawn
  });

  it('falls back from Value to Comment to the component description, and takes the first footprint when none is current', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('C1', 200, 500, { params: { Comment: '100n' }, footprints: [{ name: 'C0603' }, { name: 'C0402' }] });
    s.res('C2', 300, 500, { params: {}, extra: { ComponentDescription: 'Ferrite bead' } });
    const d = def(must(s.file()));
    expect(symbolOf(d, 'C1').value).toBe('100n');
    expect(symbolOf(d, 'C1').footprint).toBe('C0603');
    expect(symbolOf(d, 'C2').value).toBe('Ferrite bead');
  });

  it('places pins: the connection point is the pin length away from the body end, in the pin direction', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.part({ ref: 'U1', x: 500, y: 500, lib: 'IC', pins: [
      { n: '1', name: 'RIGHT', x: 500, y: 600, dir: 0, len: 20 }, { n: '2', name: 'UP', x: 500, y: 600, dir: 1, len: 30 },
      { n: '3', name: 'LEFT', x: 500, y: 600, dir: 2, len: 40 }, { n: '4', name: 'DOWN', x: 500, y: 600, dir: 3, len: 50 },
      { n: '5', name: 'FRACTION', x: 500, y: 600, dir: 0, len: 10 },
    ] });
    const u = def(must(s.file())).symbols[0];
    const at = (n: string) => pinOf(u, n);
    close(at('1').at.x, mmX(520)); close(at('1').at.y, mmY(600));
    close(at('2').at.x, mmX(500)); close(at('2').at.y, mmY(630));
    close(at('3').at.x, mmX(460)); close(at('3').at.y, mmY(600));
    close(at('4').at.x, mmX(500)); close(at('4').at.y, mmY(550));
    close(at('1').body.x, mmX(500)); close(at('1').body.y, mmY(600));
    expect(u.pins.map(p => p.name)).toEqual(['RIGHT', 'UP', 'LEFT', 'DOWN', 'FRACTION']);
  });

  it('keeps fractional coordinates (the _Frac suffix, 1/100000 unit)', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.part({ ref: 'J1', x: 500, y: 500, pins: [{ n: '1', x: 500, y: 600, dir: 0, len: 10 }] });
    s.items.forEach(item => { if ('rec' in item && item.rec.RECORD === 2) { item.rec['Location.X_Frac'] = 50000; item.rec.PinLength_Frac = 25000; } });
    const p = def(must(s.file())).symbols[0].pins[0];
    close(p.body.x, mmX(500.5)); close(p.at.x, mmX(510.75));
  });

  it('maps the electrical type, hidden pins and the net a hidden pin ties to', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.part({ ref: 'U2', x: 500, y: 500, lib: 'IC', pins: [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((e, k) => ({ n: String(k + 1), x: 500 + 20 * k, y: 500, elec: e })),
      { n: '20', name: 'VDD', x: 700, y: 500, hidden: true, hiddenNet: 'VCC', elec: 7 }, { n: '21', name: 'NC', x: 720, y: 500, hidden: true },
    ] });
    const u = def(must(s.file())).symbols[0];
    expect(u.pins.slice(0, 9).map(p => p.type)).toEqual(['input', 'bidirectional', 'output', 'open_collector', 'passive', 'tri_state', 'open_emitter', 'power_in', 'unspecified']);
    expect(pinOf(u, '20')).toMatchObject({ hidden: true, implicitNet: 'VCC', type: 'power_in' });
    expect(pinOf(u, '21').hidden).toBe(true);
    expect(pinOf(u, '21').implicitNet).toBeUndefined();
    expect(pinOf(u, '1').hidden).toBe(false);
    expect(codes(must(s.file()))).toContain('HIDDEN_PIN_NO_NET');
  });

  it('numbers pins without a designator with placeholders and separates repeated numbers', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.part({ ref: 'J2', x: 500, y: 500, lib: 'HDR', pins: [{ n: '', name: 'A', x: 500, y: 500 }, { n: '', name: 'B', x: 520, y: 500 }, { n: '3', x: 540, y: 500 }, { n: '3', x: 560, y: 500 }] });
    const r = must(s.file());
    const j = def(r).symbols[0];
    expect(j.pins.map(p => p.number)).toEqual(['#1', '#2', '3', '3']);
    expect(new Set(j.pins.map(p => p.id)).size).toBe(4);
    expect(j.pins.map(p => p.id)).toEqual(['c1##1', 'c1##2', 'c1#3', 'c1#3@2']);
    expect(codes(r)).toContain('PIN_NUMBER_MISSING');
  });

  it('shows only the pins of the placed part and the current display mode, and merges the units of one reference', () => {
    const pins = [
      { n: '1', name: 'IN+', x: 500, y: 500, part: 1, dir: 2 }, { n: '2', name: 'OUT', x: 560, y: 500, part: 1, dir: 0 },
      { n: '5', name: 'IN-', x: 500, y: 400, part: 2, dir: 2 }, { n: '6', name: 'OUT2', x: 560, y: 400, part: 2, dir: 0 },
      { n: '8', name: 'V+', x: 530, y: 560, dir: 1 }, // common to every part
      { n: '9', name: 'ALT', x: 530, y: 440, part: 1, mode: 1 }, // alternate display mode: not shown in mode 0
    ];
    const s = new Sheet({ SheetStyle: 0 });
    s.part({ ref: 'U3', x: 530, y: 500, lib: 'OPAMP', partCount: 2, partId: 1, pins });
    s.part({ ref: 'U3', x: 530, y: 300, lib: 'OPAMP', partCount: 2, partId: 2, pins: pins.map(p => ({ ...p, x: p.x, y: p.y - 200 })) });
    s.label('VP', 530, 570); s.label('VP', 530, 370); // the common pin 8 of both units, tied together by name
    const r = must(s.file());
    const d = def(r);
    const a = d.symbols[0], b = d.symbols[1];
    expect([a.unit, a.unitCount, b.unit, b.unitCount]).toEqual([1, 2, 2, 2]);
    expect(a.pins.map(p => p.number)).toEqual(['1', '2', '8']);
    expect(b.pins.map(p => p.number)).toEqual(['5', '6', '8']);
    expect(pinOf(a, '1').unit).toBe(1); expect(pinOf(a, '8').unit).toBe(0);
    const c = connect(r);
    // one physical pin 8 for the reference although both placed units carry it
    expect(c.nets.flatMap(n => n.members).filter(m => m.ref === 'U3' && m.pinNumber === '8')).toHaveLength(1);
    expect(pinsOf(netOf(c, 'U3.8'))).toEqual(['U3.8']);
    expect(c.nets.find(n => n.name === 'VP')?.members.map(m => m.unit)).toHaveLength(1);
    const mode1 = new Sheet({ SheetStyle: 0 });
    mode1.part({ ref: 'U4', x: 530, y: 500, lib: 'OPAMP', partCount: 2, mode: 1, pins });
    expect(def(must(mode1.file())).symbols[0].pins.map(p => p.number)).toEqual(['9']);
  });

  it('draws the symbol body: rectangles, lines, polylines, polygons, arcs, ellipses, beziers and text', () => {
    const s = new Sheet({ SheetStyle: 0 });
    const u = s.part({ ref: 'U5', x: 500, y: 500, lib: 'IC', pins: [{ n: '1', x: 500, y: 500 }] });
    s.rect(500, 500, 600, 600, u, true);
    s.line(500, 500, 600, 500, u);
    s.add(6, { OwnerPartId: 1, LocationCount: 3, X1: 500, Y1: 500, X2: 520, Y2: 520, X3: 540, Y3: 500 }, u);
    s.add(7, { OwnerPartId: 1, IsSolid: true, LocationCount: 3, X1: 500, Y1: 500, X2: 520, Y2: 520, X3: 540, Y3: 500 }, u);
    s.add(12, { OwnerPartId: 1, 'Location.X': 550, 'Location.Y': 550, Radius: 20, StartAngle: 0, EndAngle: 90 }, u);
    s.add(8, { OwnerPartId: 1, 'Location.X': 550, 'Location.Y': 550, Radius: 10, SecondaryRadius: 10, IsSolid: true }, u);
    s.add(11, { OwnerPartId: 1, 'Location.X': 550, 'Location.Y': 550, Radius: 10, SecondaryRadius: 5, StartAngle: 0, EndAngle: 270 }, u);
    s.add(5, { OwnerPartId: 1, LocationCount: 4, X1: 500, Y1: 500, X2: 510, Y2: 530, X3: 530, Y3: 530, X4: 540, Y4: 500 }, u);
    s.text('body text', 520, 560, u);
    s.add(13, { OwnerPartId: 2, 'Location.X': 1, 'Location.Y': 1, 'Corner.X': 9, 'Corner.Y': 9 }, u); // another part's drawing: not part of this symbol
    const g = def(must(s.file())).symbols[0].graphics;
    expect(g.filter(x => x.kind === 'rect')).toHaveLength(1);
    expect(g.filter(x => x.kind === 'circle')).toHaveLength(1);
    expect(g.filter(x => x.kind === 'poly').length).toBeGreaterThanOrEqual(6);
    expect(g.filter(x => x.kind === 'text').map(x => x.kind === 'text' && x.text)).toEqual(expect.arrayContaining(['body text', 'U5']));
    const rect = g.find(x => x.kind === 'rect');
    expect(rect).toMatchObject({ fill: 'background' });
    if (rect?.kind === 'rect') { close(rect.min.x, mmX(500)); close(rect.max.x, mmX(600)); close(rect.min.y, mmY(600)); close(rect.max.y, mmY(500)); }
    const arc = g.find(x => x.kind === 'poly' && x.points.length > 5 && x.points.length < 15);
    expect(arc).toBeDefined();
    if (arc?.kind === 'poly') { close(arc.points[0].x, mmX(570)); close(arc.points[0].y, mmY(550)); }
  });

  it('reads multi-byte text through the UTF-8 twin of a key', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R9', 200, 500, { params: { Comment: '10 Ohm' } });
    s.items.forEach(item => { if ('rec' in item && item.rec.RECORD === 41) item.rec['%UTF8%Text'] = '10 Ω'; });
    const r = must(s.file()); // the plain key keeps the ANSI rendering, the %UTF8% twin the exact text (the records are written as UTF-8)
    expect(symbolOf(def(r), 'R9').value).toBe('10 Ω');
    expect(symbolOf(def(r), 'R9').fields.find(f => f.name === 'Comment')?.value).toBe('10 Ω');
  });

  it('counts a component without a designator as unannotated and keeps going', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R?', 200, 500);
    s.res('R?', 300, 500);
    const r = must(s.file());
    expect(def(r).symbols).toHaveLength(2);
    const c = connect(r);
    expect(c.diagnostics.some(d => d.code === 'UNANNOTATED_REFERENCE')).toBe(true);
    const bare = new Sheet({ SheetStyle: 0 });
    bare.add(1, { LibReference: 'RES', 'Location.X': 100, 'Location.Y': 100, CurrentPartId: 1, PartCount: 2 });
    expect(codes(must(bare.file()))).toContain('COMPONENT_NO_DESIGNATOR');
  });

  it('keeps orientation and mirroring', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.res('R1', 200, 500, { orientation: 3, mirrored: true });
    const r = def(must(s.file())).symbols[0];
    expect(r.rotation).toBe(270);
    expect(r.mirror).toBe('y');
  });
});

describe('sheet-level drawing, junctions and notes', () => {
  it('keeps free drawing and notes as graphics that carry no connectivity', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.rect(100, 100, 200, 160);
    s.line(100, 100, 300, 300);
    s.text('Free text', 120, 120);
    s.add(209, { 'Location.X': 400, 'Location.Y': 300, 'Corner.X': 500, 'Corner.Y': 400, Text: 'Line one~1Line two', OwnerPartId: -1 });
    s.add(28, { 'Location.X': 400, 'Location.Y': 200, 'Corner.X': 500, 'Corner.Y': 250, Text: 'Frame', OwnerPartId: -1 });
    s.add(4, { 'Location.X': 1, 'Location.Y': 1, Text: 'hidden label', IsHidden: true });
    const d = def(must(s.file()));
    expect(d.graphics.map(g => g.kind)).toEqual(['rect', 'poly', 'text', 'text', 'text']);
    const notes = d.graphics.filter(g => g.kind === 'text').map(g => g.kind === 'text' && g.text);
    expect(notes).toEqual(['Free text', 'Line one\nLine two', 'Frame']);
    expect(d.symbols).toEqual([]);
    expect(d.wires).toEqual([]);
  });

  it('keeps junctions at their points', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.junction(150, 250);
    const j = def(must(s.file())).junctions;
    expect(j).toHaveLength(1);
    close(j[0].at.x, mmX(150)); close(j[0].at.y, mmY(250));
  });

  it('bounds the sheet by what it contains, or by the paper when it is empty', () => {
    const empty = def(must(new Sheet({ SheetStyle: 0 }).file()));
    expect(empty.bounds).toEqual({ minX: 0, minY: 0, maxX: empty.paper!.width, maxY: empty.paper!.height });
    const s = new Sheet({ SheetStyle: 0 });
    s.wire([100, 100], [200, 300]);
    const b = def(must(s.file())).bounds;
    close(b.minX, mmX(100)); close(b.maxX, mmX(200)); close(b.minY, mmY(300)); close(b.maxY, mmY(100));
  });
});

describe('project files', () => {
  it('reads the scope and the sheet list, ignoring comments, other sections and other documents', () => {
    const text = '﻿; comment\r\n[Design]\r\nhierarchymode = 2\r\nOther=1\r\n[Document1]\r\nDocumentPath = Sheets\\Top.SchDoc\r\n[Document2]\r\nDocumentPath=Board.PcbDoc\r\n[Other]\r\nDocumentPath=ignored.SchDoc\r\n[DocumentX]\r\nDocumentPath=ignored2.SchDoc\r\n[Document3]\r\nDocumentPath=\r\n';
    expect(parseProject(enc.encode(text))).toEqual({ hierarchyMode: 2, documents: ['Sheets\\Top.SchDoc', 'Board.PcbDoc'] });
    expect(parseProject(enc.encode('[Design]\r\nHierarchyMode=12345\r\n'))).toEqual({ documents: [] });
    expect(parseProject(new Uint8Array([0x5b, 0x44, 0x6f, 0x63, 0x75, 0x6d, 0x65, 0x6e, 0x74, 0x31, 0x5d, 0x0a, 0x44, 0x6f, 0x63, 0x75, 0x6d, 0x65, 0x6e, 0x74, 0x50, 0x61, 0x74, 0x68, 0x3d, 0xe9, 0x2e, 0x53, 0x63, 0x68, 0x44, 0x6f, 0x63]))).toEqual({ documents: ['é.SchDoc'] });
  });

  it('uses the project that lists the opened sheet and ignores one that does not', () => {
    const a = divider(), b = divider();
    const mine = project(['Test.SchDoc', 'Other.SchDoc'], 3), foreign = project(['Elsewhere.SchDoc'], 2);
    const files = { 'a.prjpcb': foreign, 'b.prjpcb': mine, 'other.schdoc': b.file() };
    const r = must(a.file(), 'Test.SchDoc', files);
    expect(r.instances.map(i => i.defId)).toEqual(['test.schdoc', 'other.schdoc']);
  });
});
