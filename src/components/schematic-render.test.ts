import { describe, expect, it } from 'vitest';
import type { SchBounds, SchConnectivity, SchLabel, SchPin, SchSheetDef, SchSheetInstance, SchSymbol } from '../lib/schematic/model';
import { pinKey, symbolKey, wireKey } from '../lib/schematic/model';
import {
  BASE_SCALE, MAX_SCALE, MIN_SCALE, SheetCache, buildNavRows, buildNetHighlight, buildPalette, buildSheetData, cameraToView, clampScale, clampView,
  FALLBACK_TOKENS, fitView, hitTest, instanceChain, K, layoutLabel, layoutPinText, normalizeTextOrientation, paperFrame, panBy, parseKey, queryData,
  resolveChildPath, resolveSelection, robustContentBounds, sameCamera, screenToSheet, segmentDistance, sheetToScreen, symbolDetail, symbolGeometry, textCorners, textWidth,
  viewBounds, viewToCamera, withAlpha, zoomAt,
} from './schematic-render';

const P = (x: number, y: number) => ({ x, y });
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const bounds = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

function pin(symbolId: string, number: string, at: [number, number], body: [number, number], extra: Partial<SchPin> = {}): SchPin {
  return { id: `${symbolId}#${number}`, number, name: '', at: P(...at), body: P(...body), type: 'passive', hidden: false, unit: 1, ...extra };
}
/** A 2-pin part: body rectangle 2.5 x 6 mm centred on `at`, pins 2.5 mm long above and below. */
function resistor(id: string, x: number, y: number, extra: Partial<SchSymbol> = {}): SchSymbol {
  return {
    id, libId: 'Device:R', refDefault: 'R?', instances: { '': { ref: id.toUpperCase(), unit: 1 } }, value: '10k', footprint: '', datasheet: '', unit: 1, unitCount: 1,
    at: P(x, y), rotation: 0, mirror: 'none',
    pins: [pin(id, '1', [x, y - 5.54], [x, y - 3]), pin(id, '2', [x, y + 5.54], [x, y + 3])],
    graphics: [{ kind: 'rect', min: P(x - 1.25, y - 3), max: P(x + 1.25, y + 3), width: 0.254, fill: 'background' }],
    fields: [{ name: 'Reference', value: id.toUpperCase(), at: P(x + 3, y - 1), angle: 0, hidden: false }, { name: 'Value', value: '10k', at: P(x + 3, y + 1), angle: 0, hidden: true }],
    virtual: false, dnp: false, bounds: bounds(x - 6, y - 8, x + 6, y + 8), ...extra,
  };
}
function makeDef(over: Partial<SchSheetDef> = {}): SchSheetDef {
  return {
    id: 'root.kicad_sch', name: 'root', file: 'root.kicad_sch', title: 'Root', titleBlock: {}, paper: { width: 297, height: 210 },
    symbols: [], wires: [], buses: [], busEntries: [], junctions: [], noConnects: [], labels: [], sheetRefs: [], graphics: [], bounds: bounds(0, 0, 0, 0), ...over,
  };
}
const label = (id: string, kind: SchLabel['kind'], text: string, x: number, y: number, angle = 0, shape?: SchLabel['shape']): SchLabel => ({ id, kind, text, at: P(x, y), angle, shape });

describe('camera math', () => {
  const view = { x: 100, y: 50, scale: 3 };
  it('round-trips between screen and sheet space', () => {
    const s = sheetToScreen(view, 800, 600, P(120, 70));
    near(s.x, 400 + 20 * 3); near(s.y, 300 + 20 * 3);
    const back = screenToSheet(view, 800, 600, s);
    near(back.x, 120); near(back.y, 70);
  });
  it('viewBounds covers exactly the viewport plus the margin', () => {
    const b = viewBounds(view, 800, 600, 10);
    near(b.minX, 100 - 410 / 3); near(b.maxY, 50 + 310 / 3);
  });
  it('zoomAt keeps the anchored sheet point under the pointer', () => {
    const anchor = P(150, 420), before = screenToSheet(view, 800, 600, anchor);
    for (const next of [0.7, 1.5, 9, 400]) {
      const z = zoomAt(view, anchor, next, 800, 600), after = screenToSheet(z, 800, 600, anchor);
      near(after.x, before.x, 1e-6); near(after.y, before.y, 1e-6);
      expect(z.scale).toBeLessThanOrEqual(MAX_SCALE);
    }
    expect(zoomAt(view, anchor, 1e-9, 800, 600).scale).toBe(MIN_SCALE);
  });
  it('clampScale rejects NaN and clamps both ends', () => {
    expect(clampScale(NaN)).toBe(BASE_SCALE);
    expect(clampScale(Infinity)).toBe(BASE_SCALE);
    expect(clampScale(1e6)).toBe(MAX_SCALE);
    expect(clampScale(-5)).toBe(MIN_SCALE);
  });
  it('panBy moves the sheet with the pointer (dragging right shifts the view centre left)', () => {
    const v = panBy(view, 30, -60);
    near(v.x, 100 - 10); near(v.y, 50 + 20);
  });
  it('fits the page, centred, with padding', () => {
    const v = fitView(bounds(0, 0, 297, 210), 1000, 700, 'page', 20);
    near(v.scale, Math.min(960 / 297, 660 / 210)); near(v.x, 148.5); near(v.y, 105);
    const w = fitView(bounds(0, 0, 297, 210), 600, 400, 'width', 20);
    near(w.scale, 560 / 297);
    near(sheetToScreen(w, 600, 400, P(0, 0)).y, 20); // top edge sits one padding below the viewport top
  });
  it('survives a degenerate viewport and an empty extent', () => {
    const v = fitView(bounds(5, 5, 5, 5), 0, 0, 'page');
    expect(Number.isFinite(v.scale + v.x + v.y)).toBe(true);
  });
  it('clampView keeps part of the extent visible', () => {
    const extent = bounds(0, 0, 300, 200);
    const v = clampView({ x: 5000, y: -5000, scale: 4 }, extent, 800, 600, 100);
    expect(v.x).toBeLessThan(300 + 100 + 1); // viewport left edge stays within the extent right edge + keep
    const left = sheetToScreen(v, 800, 600, P(300, 0)).x;
    expect(left).toBeGreaterThanOrEqual(100 - 1e-6);
    const top = sheetToScreen(v, 800, 600, P(0, 0)).y;
    expect(top).toBeLessThanOrEqual(600 - 100 + 1e-6);
  });
  it('maps views to and from the persisted camera', () => {
    const extent = bounds(0, 0, 297, 210);
    const cam = viewToCamera({ x: 80, y: 40, scale: 8 }, 'none');
    expect(cam).toEqual({ zoom: 2, x: 80, y: 40, fit: 'none' });
    const restored = cameraToView(cam, extent, 1000, 700);
    expect(restored.fit).toBe('none'); near(restored.view.scale, 8); near(restored.view.x, 80);
    const fitted = cameraToView({ fit: 'page' }, extent, 1000, 700);
    expect(fitted.fit).toBe('page'); near(fitted.view.x, 148.5);
  });
  it('degrades invalid persisted cameras to a page fit', () => {
    const extent = bounds(0, 0, 297, 210);
    for (const bad of [{}, { zoom: NaN, x: 1, y: 1 }, { zoom: 0, x: 1, y: 1 }, { zoom: 2, x: Infinity, y: 1 }, { zoom: 1 }]) {
      const r = cameraToView(bad, extent, 1000, 700);
      expect(r.fit).toBe('page');
      expect(Number.isFinite(r.view.scale + r.view.x + r.view.y)).toBe(true);
    }
  });
  it('sameCamera tolerates sub-pixel rounding but not real changes', () => {
    const a = { zoom: 2, x: 80, y: 40, fit: 'none' as const };
    expect(sameCamera(a, { ...a, x: 80.01, zoom: 2.0005 })).toBe(true);
    expect(sameCamera(a, { ...a, x: 81 })).toBe(false);
    expect(sameCamera(a, { ...a, fit: 'page' })).toBe(false);
    expect(sameCamera(a, null)).toBe(false);
    expect(sameCamera(undefined, null)).toBe(false);
    expect(sameCamera({ fit: 'page' }, { fit: 'page' })).toBe(true);
  });
});

describe('text and label layout', () => {
  it('flips upside-down angles and mirrors the anchor so the covered area is unchanged', () => {
    expect(normalizeTextOrientation(180, 'start')).toEqual({ angle: 0, anchor: 'end' });
    expect(normalizeTextOrientation(270, 'end')).toEqual({ angle: 90, anchor: 'start' });
    expect(normalizeTextOrientation(90, 'start')).toEqual({ angle: 90, anchor: 'start' });
    expect(normalizeTextOrientation(-90, 'middle')).toEqual({ angle: 90, anchor: 'middle' }); // -90 is 270: reads upwards
    expect(normalizeTextOrientation(450, 'start')).toEqual({ angle: 90, anchor: 'start' });
    expect(normalizeTextOrientation(NaN, 'start')).toEqual({ angle: 0, anchor: 'start' });
    const flipped = textCorners(P(10, 10), 0, 'end', 6, 1);
    const original = textCorners(P(10, 10), 180, 'start', 6, 1);
    const xs = (c: typeof flipped) => [Math.min(...c.map(p => p.x)), Math.max(...c.map(p => p.x))];
    near(xs(flipped)[0], xs(original)[0]); near(xs(flipped)[1], xs(original)[1]);
  });
  it('lays text boxes along the reading direction', () => {
    const c0 = textCorners(P(0, 0), 0, 'start', 10, 2);
    near(Math.min(...c0.map(p => p.x)), 0); near(Math.max(...c0.map(p => p.x)), 10);
    const c90 = textCorners(P(0, 0), 90, 'start', 10, 2); // reads upwards on screen (Y down)
    near(Math.min(...c90.map(p => p.y)), -10); near(Math.max(...c90.map(p => p.y)), 0);
    const mid = textCorners(P(0, 0), 0, 'middle', 10, 2);
    near(Math.min(...mid.map(p => p.x)), -5);
    expect(textWidth('ABCD', 2)).toBeCloseTo(4 * 2 * 0.6);
  });
  it('local labels are plain text extending in the angle direction', () => {
    const right = layoutLabel(label('l', 'local', 'NET', 10, 10, 0)).bounds, left = layoutLabel(label('l', 'local', 'NET', 10, 10, 180)).bounds;
    const up = layoutLabel(label('l', 'local', 'NET', 10, 10, 90)).bounds, down = layoutLabel(label('l', 'local', 'NET', 10, 10, 270)).bounds;
    expect(layoutLabel(label('l', 'local', 'NET', 0, 0)).polygon).toBeNull();
    expect(right.minX).toBeGreaterThanOrEqual(10); expect(right.maxX).toBeGreaterThan(10 + textWidth('NET', 1.27) - 0.01);
    expect(left.maxX).toBeLessThanOrEqual(10); expect(left.minX).toBeLessThan(10 - textWidth('NET', 1.27) + 0.01);
    expect(up.maxY).toBeLessThanOrEqual(10); expect(up.minY).toBeLessThan(10 - textWidth('NET', 1.27) + 0.01);
    expect(down.minY).toBeGreaterThanOrEqual(10); expect(down.maxY).toBeGreaterThan(10 + textWidth('NET', 1.27) - 0.01);
    // The glyphs of the 180 and 270 variants stay upright (reading angle within +-90).
    expect(layoutLabel(label('l', 'local', 'NET', 0, 0, 180)).text.angle).toBe(0);
    expect(layoutLabel(label('l', 'local', 'NET', 0, 0, 270)).text.angle).toBe(90);
  });
  it('flag labels: tips follow the shape, the anchor is on the outline', () => {
    const base = layoutLabel(label('g', 'global', 'VCC', 5, 5, 0, 'passive'));
    expect(base.polygon).toHaveLength(4);
    const input = layoutLabel(label('g', 'global', 'VCC', 5, 5, 0, 'input')).polygon!;
    const output = layoutLabel(label('g', 'global', 'VCC', 5, 5, 0, 'output')).polygon!;
    const bidi = layoutLabel(label('g', 'global', 'VCC', 5, 5, 0, 'bidirectional')).polygon!;
    expect(input).toHaveLength(5); expect(output).toHaveLength(5); expect(bidi).toHaveLength(6);
    expect(input[0]).toEqual(P(5, 5)); // the pointed end touches the connection point
    near(output[2].y, 5); expect(output[2].x).toBeGreaterThan(5 + textWidth('VCC', 1.27));
    const down = layoutLabel(label('g', 'hierarchical', 'VCC', 5, 5, 270, 'input'));
    near(down.bounds.minX, 5 - 1.27 * 0.9, 1e-6); expect(down.bounds.maxY).toBeGreaterThan(5 + textWidth('VCC', 1.27));
    expect(down.text.angle).toBe(90); expect(down.text.anchor).toBe('end');
  });
  it('places pin numbers beside the pin and names inside the body for every direction', () => {
    const right = layoutPinText(pin('s', '1', [0, 0], [2.54, 0], { name: 'IN' })); // pin enters the body towards +x
    expect(right.number.at).toEqual(P(1.27, 0)); expect(right.number.dy).toBeLessThan(0);
    expect(right.name).toMatchObject({ angle: 0, anchor: 'start' }); expect(right.name!.at.x).toBeGreaterThan(2.54);
    const left = layoutPinText(pin('s', '2', [0, 0], [-2.54, 0], { name: 'OUT' }));
    expect(left.name).toMatchObject({ angle: 0, anchor: 'end' }); expect(left.name!.at.x).toBeLessThan(-2.54);
    const down = layoutPinText(pin('s', '3', [0, 0], [0, 2.54], { name: 'D' }));
    expect(down.name).toMatchObject({ angle: 90, anchor: 'end' }); expect(down.number.angle).toBe(90);
    const up = layoutPinText(pin('s', '4', [0, 0], [0, -2.54], { name: 'U' }));
    expect(up.name).toMatchObject({ angle: 90, anchor: 'start' });
    expect(layoutPinText(pin('s', '5', [0, 0], [2.54, 0], { name: '~' })).name).toBeNull();
    expect(layoutPinText(pin('s', '6', [0, 0], [2.54, 0], { name: '' })).name).toBeNull();
    expect(Number.isFinite(layoutPinText(pin('s', '7', [1, 1], [1, 1])).number.at.x)).toBe(true);
  });
});

describe('symbol geometry', () => {
  it('uses the real body for hit bounds, not the loose parser box, and keeps pins and fields for culling', () => {
    const g = symbolGeometry(resistor('r1', 50, 50));
    expect(g.hit).toEqual(bounds(50 - 1.25 - 0.127, 50 - 3 - 0.127, 50 + 1.25 + 0.127, 50 + 3 + 0.127));
    expect(g.draw.minY).toBeLessThan(50 - 5); // pin end
    expect(g.draw.maxX).toBeGreaterThan(50 + 3 + textWidth('R1', 1.27) - 0.01); // visible reference text
  });
  it('ignores hidden fields and hidden pins when computing what is drawn', () => {
    const s = resistor('r1', 0, 0, { fields: [{ name: 'Reference', value: 'R1', at: P(100, 100), angle: 0, hidden: true }] });
    s.pins[0].hidden = true; s.pins[1].hidden = true;
    const g = symbolGeometry(s);
    expect(g.draw.maxX).toBeLessThan(5); expect(g.draw.maxY).toBeLessThan(5);
  });
  it('falls back to the pins, then the parser box, then the placement point', () => {
    const pinsOnly = resistor('r1', 10, 10, { graphics: [] });
    const g = symbolGeometry(pinsOnly);
    expect(g.hit).toEqual(bounds(10, 10 - 5.54, 10, 10 + 5.54));
    const boxOnly = resistor('r2', 10, 10, { graphics: [], pins: [], fields: [] });
    expect(symbolGeometry(boxOnly).hit).toEqual(boxOnly.bounds);
    const nothing = resistor('r3', 7, 8, { graphics: [], pins: [], fields: [], bounds: bounds(NaN, 0, 0, 0) });
    expect(symbolGeometry(nothing).hit).toEqual(bounds(7, 8, 7, 8));
  });
  it('text graphics extend culling bounds but never the click area', () => {
    const s = resistor('r1', 0, 0, { graphics: [{ kind: 'rect', min: P(-1, -1), max: P(1, 1), width: 0, fill: 'none' }, { kind: 'text', at: P(20, 0), text: 'LONG NOTE', angle: 0, size: 1.27, anchor: 'start' }] });
    const g = symbolGeometry(s);
    expect(g.draw.maxX).toBeGreaterThan(20); expect(g.hit.maxX).toBeLessThan(2);
  });
  it('symbolDetail picks dot, box, full by projected size', () => {
    expect(symbolDetail(1, 1)).toBe(0); expect(symbolDetail(1, 5)).toBe(1); expect(symbolDetail(2.5, 8)).toBe(2);
  });
});

describe('sheet data and culling index', () => {
  function randomDef(seed: number, n: number): SchSheetDef {
    let s = seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
    const def = makeDef();
    for (let i = 0; i < n; i++) {
      const x = rnd() * 280, y = rnd() * 200;
      def.wires.push({ id: `w${i}`, a: P(x, y), b: P(x + (rnd() - 0.5) * (i % 17 === 0 ? 250 : 20), y + (rnd() - 0.5) * 20) });
      if (i % 5 === 0) def.symbols.push(resistor(`r${i}`, x, y));
      if (i % 7 === 0) def.junctions.push({ id: `j${i}`, at: P(x, y) });
    }
    return def;
  }
  it('returns exactly the brute-force intersecting set for random queries (including long wires and outside rects)', () => {
    const data = buildSheetData(randomDef(7, 3000));
    let s = 99;
    const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 0x100000000;
    for (let q = 0; q < 200; q++) {
      const x = rnd() * 400 - 50, y = rnd() * 300 - 50, w = rnd() * 80, h = rnd() * 60;
      const got = queryData(data, x, y, x + w, y + h, []).sort((a, b) => a - b);
      const want: number[] = [];
      for (let id = 0; id < data.count; id++) {
        const o = id * 4;
        if (data.boxes[o] <= x + w && data.boxes[o + 2] >= x && data.boxes[o + 1] <= y + h && data.boxes[o + 3] >= y) want.push(id);
      }
      expect(got).toEqual(want);
    }
  });
  it('reports each element once and never returns anything for a rectangle off the sheet', () => {
    const data = buildSheetData(randomDef(3, 500));
    const all = queryData(data, -1e3, -1e3, 1e3, 1e3, []);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(data.count);
    expect(queryData(data, 5000, 5000, 6000, 6000, [])).toEqual([]);
    expect(queryData(data, -6000, -6000, -5000, -5000, [])).toEqual([]);
  });
  it('culls to the viewport: far fewer elements than the sheet when zoomed in', () => {
    const data = buildSheetData(randomDef(5, 20000));
    const zoomed = queryData(data, 100, 100, 130, 120, []);
    expect(zoomed.length).toBeGreaterThan(0);
    expect(zoomed.length).toBeLessThan(data.count / 20);
  });
  it('handles empty sheets, NaN geometry and many repeated queries (epoch counter)', () => {
    const empty = buildSheetData(makeDef({ paper: undefined }));
    expect(empty.count).toBe(0); expect(empty.extent).toEqual(bounds(0, 0, 100, 100));
    expect(queryData(empty, -10, -10, 10, 10, [])).toEqual([]);
    const bad = buildSheetData(makeDef({ wires: [{ id: 'w', a: P(NaN, 0), b: P(1, 1) }, { id: 'ok', a: P(0, 0), b: P(10, 0) }] }));
    expect(queryData(bad, -1, -1, 11, 1, [])).toEqual([bad.offsets[K.wire] + 1]);
    for (let i = 0; i < 50; i++) queryData(bad, -1, -1, 11, 1, []);
    bad.epoch = 0xfffffff5;
    for (let i = 0; i < 30; i++) expect(queryData(bad, -1, -1, 11, 1, [])).toEqual([bad.offsets[K.wire] + 1]);
  });
  it('extent is the union of paper and content, so off-paper content is still reachable', () => {
    const data = buildSheetData(makeDef({ wires: [{ id: 'w', a: P(-40, -20), b: P(500, 300) }] }));
    expect(data.extent.minX).toBeLessThanOrEqual(-40); expect(data.extent.maxX).toBeGreaterThanOrEqual(500);
    expect(data.frame).not.toBeNull();
  });
  it('paperFrame validates the paper and places the title block inside the border', () => {
    expect(paperFrame({ paper: undefined })).toBeNull();
    expect(paperFrame({ paper: { width: 0, height: 100 } })).toBeNull();
    expect(paperFrame({ paper: { width: NaN, height: 100 } })).toBeNull();
    const f = paperFrame({ paper: { width: 297, height: 210 } })!;
    expect(f.inner).toEqual(bounds(10, 10, 287, 200));
    expect(f.title.maxX).toBe(287); expect(f.title.maxY).toBe(200); expect(f.title.minX).toBe(287 - 110);
  });
  describe('fit bounds: the sheet is fitted, not every item', () => {
    const A3 = { width: 420, height: 297 };
    const note = (x: number, y: number, text = 'NOTE'): SchSheetDef['graphics'][number] => ({ kind: 'text', at: P(x, y), text, angle: 0, size: 1.27, anchor: 'start' });
    /** A drawing of `n` resistors with wires, spread over `box` (deterministic); `prefix` keeps ids apart when drawings are merged. */
    function drawing(n: number, box: { x: number; y: number; w: number; h: number }, over: Partial<SchSheetDef> = {}, prefix = ''): SchSheetDef {
      const def = makeDef({ paper: A3, ...over });
      for (let i = 0; i < n; i++) {
        const x = box.x + ((i * 37) % 101) / 101 * box.w, y = box.y + ((i * 53) % 103) / 103 * box.h;
        def.symbols.push(resistor(`${prefix}r${i}`, x, y));
        def.wires.push({ id: `${prefix}w${i}`, a: P(x, y + 5.54), b: P(x + 12, y + 5.54) });
      }
      return def;
    }
    /** Share of the limiting pane side that `shown` fills after a page fit to `fitTo`. */
    function fill(fitTo: SchBounds, shown: SchBounds, width: number, height: number): number {
      const v = fitView(fitTo, width, height, 'page');
      const a = sheetToScreen(v, width, height, P(shown.minX, shown.minY)), z = sheetToScreen(v, width, height, P(shown.maxX, shown.maxY));
      return Math.max((z.x - a.x) / width, (z.y - a.y) / height);
    }
    const PANES: Array<[number, number]> = [[1000, 700], [1280, 800], [700, 500], [400, 300], [500, 900], [1600, 400], [1920, 1000]];

    it('fits the paper frame when stray text lies far off the page, and the page fills at least 85 % of the limiting pane side', () => {
      // Two notes far below an A3 frame, as on a real sheet.
      const data = buildSheetData(drawing(60, { x: 30, y: 30, w: 330, h: 230 }, { graphics: [note(100, 900), note(250, 1100, 'old note')] }));
      expect(data.fitBounds).toEqual(bounds(0, 0, 420, 297));
      expect(data.extent.maxY).toBeGreaterThan(1090);
      const paper = bounds(0, 0, 420, 297);
      for (const [w, h] of PANES) {
        expect(fill(data.fitBounds, paper, w, h), `${w}x${h}`).toBeGreaterThanOrEqual(0.85);
        // What fitting every item did: the page ended up much smaller than it is now.
        expect(fitView(data.extent, w, h, 'page').scale, `${w}x${h}`).toBeLessThan(0.75 * fitView(data.fitBounds, w, h, 'page').scale);
      }
    });
    it('keeps the stray items reachable by panning: the camera still roams over the whole extent', () => {
      const data = buildSheetData(drawing(60, { x: 30, y: 30, w: 330, h: 230 }, { graphics: [note(100, 900)] }));
      const far = clampView({ x: 100, y: 900, scale: 4 }, data.extent, 1000, 700);
      near(far.x, 100); near(far.y, 900);
      expect(clampView({ x: 100, y: 9000, scale: 4 }, data.extent, 1000, 700).y).toBeLessThan(data.extent.maxY + 700 / 8);
      // The note is inside the clamped viewport at that camera.
      const b = viewBounds(far, 1000, 700);
      expect(b.minY).toBeLessThan(900); expect(b.maxY).toBeGreaterThan(900);
    });
    it('a stored page or width fit is re-fitted to the paper; a free camera is only clamped to the extent', () => {
      const data = buildSheetData(drawing(60, { x: 30, y: 30, w: 330, h: 230 }, { graphics: [note(100, 900)] }));
      const page = cameraToView({ fit: 'page' }, data.extent, 1000, 700, data.fitBounds);
      expect(page.fit).toBe('page');
      near(page.view.x, 210); near(page.view.y, 148.5);
      near(page.view.scale, Math.min((1000 - 2 * 28) / 420, (700 - 2 * 28) / 297));
      const width = cameraToView({ fit: 'width' }, data.extent, 1000, 700, data.fitBounds);
      near(width.view.scale, (1000 - 2 * 28) / 420);
      near(sheetToScreen(width.view, 1000, 700, P(0, 0)).y, 28);
      const free = cameraToView({ zoom: 3, x: 100, y: 900, fit: 'none' }, data.extent, 1000, 700, data.fitBounds);
      expect(free.fit).toBe('none'); near(free.view.y, 900); near(free.view.scale, 3 * BASE_SCALE);
      // Without a fit box the extent is used (the previous behaviour).
      near(cameraToView({ fit: 'page' }, data.extent, 1000, 700).view.y, (data.extent.minY + data.extent.maxY) / 2);
    });
    it('without a paper frame the fit drops far outliers but never cuts off the edge of a normal drawing', () => {
      const clean = buildSheetData(drawing(200, { x: 20, y: 20, w: 300, h: 200 }, { paper: undefined }));
      expect(clean.frame).toBeNull();
      expect(clean.fitBounds).toEqual(clean.extent); // nothing is an outlier
      const stray = buildSheetData(drawing(200, { x: 20, y: 20, w: 300, h: 200 }, { paper: undefined, graphics: [note(150, 2000), note(-900, 100)] }));
      expect(stray.extent.maxY).toBeGreaterThan(1990); expect(stray.extent.minX).toBeLessThan(-890);
      expect(stray.fitBounds).toEqual(clean.extent);
      expect(fill(stray.fitBounds, clean.extent, 1000, 700)).toBeGreaterThanOrEqual(0.85);
    });
    it('sparse drawings, clusters and tiny sheets are not trimmed', () => {
      // Fewer than 50 elements: every element counts, a note included.
      const few = buildSheetData(drawing(10, { x: 20, y: 20, w: 100, h: 80 }, { paper: undefined, graphics: [note(50, 3000)] }));
      expect(few.fitBounds).toEqual(few.extent);
      // A second cluster of more than 2 % of the elements is part of the drawing.
      const main = drawing(120, { x: 0, y: 0, w: 100, h: 80 }), far = drawing(20, { x: 900, y: 800, w: 40, h: 40 }, {}, 'far');
      const two = buildSheetData(makeDef({ paper: undefined, symbols: [...main.symbols, ...far.symbols], wires: [...main.wires, ...far.wires] }));
      expect(two.fitBounds.maxX).toBeGreaterThan(900); expect(two.fitBounds.maxY).toBeGreaterThan(800);
      expect(robustContentBounds(new Float64Array(0), 0).minX).toBe(Infinity);
    });
    it('a drawing that mostly lies outside its own page is fitted together with the page', () => {
      const data = buildSheetData(drawing(80, { x: 600, y: 500, w: 400, h: 300 }, { paper: { width: 297, height: 210 } }));
      expect(data.fitBounds.minX).toBe(0); expect(data.fitBounds.minY).toBe(0);
      expect(data.fitBounds.maxX).toBeGreaterThan(990); expect(data.fitBounds.maxY).toBeGreaterThan(790);
      // Half of it on the page keeps the page.
      const half = buildSheetData(drawing(40, { x: 10, y: 10, w: 250, h: 180 }, { paper: { width: 297, height: 210 }, graphics: Array.from({ length: 30 }, (_, i) => note(400 + i, 600)) }));
      expect(half.fitBounds).toEqual(bounds(0, 0, 297, 210));
    });
    it('empty sheets: the paper when there is one, else the default box', () => {
      expect(buildSheetData(makeDef({ paper: A3 })).fitBounds).toEqual(bounds(0, 0, 420, 297));
      expect(buildSheetData(makeDef({ paper: undefined })).fitBounds).toEqual(bounds(0, 0, 100, 100));
    });
    it('the fit box is always finite, has an area and lies inside the extent, whatever the geometry', () => {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        let s = seed * 7919;
        const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
        const def = drawing(Math.floor(rnd() * 300), { x: rnd() * 100, y: rnd() * 100, w: 50 + rnd() * 400, h: 50 + rnd() * 300 }, { paper: seed % 2 ? A3 : undefined });
        for (let k = 0; k < seed % 4; k++) def.graphics.push(note((rnd() - 0.5) * 6000, (rnd() - 0.5) * 6000));
        if (seed === 3) def.wires.push({ id: 'bad', a: P(NaN, 0), b: P(1, 1) });
        const data = buildSheetData(def), f = data.fitBounds, e = data.extent;
        expect(Number.isFinite(f.minX + f.minY + f.maxX + f.maxY)).toBe(true);
        expect(f.maxX > f.minX || f.maxY > f.minY).toBe(true);
        expect(f.minX).toBeGreaterThanOrEqual(e.minX); expect(f.maxX).toBeLessThanOrEqual(e.maxX);
        expect(f.minY).toBeGreaterThanOrEqual(e.minY); expect(f.maxY).toBeLessThanOrEqual(e.maxY);
      }
    });
    it('fitView keeps its padding below 7 % of the shorter side, so a small pane still shows the sheet large', () => {
      const a3 = bounds(0, 0, 420, 297);
      expect(fill(a3, a3, 200, 150)).toBeGreaterThanOrEqual(0.86);
      expect(fill(a3, a3, 1000, 700)).toBeGreaterThanOrEqual(0.9);
      near(fitView(bounds(0, 0, 420, 297), 1000, 700, 'page', 500).scale, (700 - 2 * 49) / 297); // an explicit padding is capped too
    });
  });
  it('SheetCache is a bounded LRU keyed by definition identity', () => {
    const cache = new SheetCache(2);
    const [a, b, c] = [makeDef({ id: 'a' }), makeDef({ id: 'b' }), makeDef({ id: 'c' })];
    const da = cache.get(a);
    expect(cache.get(a)).toBe(da);
    cache.get(b); cache.get(a); cache.get(c);
    expect(cache.size).toBe(2);
    expect(cache.get(a)).toBe(da); // a was used more recently than b, so b was evicted
    cache.clear(); expect(cache.size).toBe(0);
  });
});

describe('hit-testing', () => {
  const def = makeDef({
    symbols: [resistor('r1', 50, 50), resistor('r2', 100, 50, { graphics: [] })],
    wires: [{ id: 'w1', a: P(50, 55.54), b: P(50, 80) }, { id: 'w2', a: P(50, 80), b: P(100, 80) }],
    buses: [{ id: 'b1', a: P(10, 120), b: P(90, 120) }],
    labels: [label('l1', 'global', 'CLK', 120, 80, 0, 'output')],
    sheetRefs: [{ id: 's1', name: 'Sub', file: 'sub.kicad_sch', defId: 'sub', at: P(150, 100), size: P(40, 30), pins: [{ id: 'sp1', name: 'IN', at: P(150, 110), shape: 'input' }] }],
  });
  const data = buildSheetData(def);
  const at = (x: number, y: number, scale = 8, opts = {}) => hitTest(data, P(x, y), scale, opts);

  it('picks a pin by distance in SCREEN pixels, independent of zoom', () => {
    // The pin line runs from (50, 44.46) to (50, 47). Probe 5 px to the side at two zoom levels.
    expect(at(50 + 5 / 8, 45.5, 8)).toEqual({ kind: 'pin', symbol: 0, pin: 0 });
    expect(at(50 + 5 / 20, 45.5, 20)).toEqual({ kind: 'pin', symbol: 0, pin: 0 });
    expect(at(50 + 9 / 8, 45.5, 8)?.kind).not.toBe('pin'); // 9 px away: outside the 6 px tolerance
    expect(at(50 + 9 / 8, 45.5, 8, { pinTolPx: 10 })).toEqual({ kind: 'pin', symbol: 0, pin: 0 });
  });
  it('prefers a pin over the symbol and the symbol over a wire', () => {
    expect(at(50, 46.9, 8)?.kind).toBe('pin');
    expect(at(50, 50, 8)).toEqual({ kind: 'symbol', symbol: 0 });
    expect(at(50, 79.99, 8)).toEqual({ kind: 'wire', wire: 0 });
  });
  it('uses the real body for symbol hits: nothing is hit in the loose parser box outside the body', () => {
    expect(at(50 + 4, 50, 8)).toBeNull(); // inside the loose box (+-6) but far from the 2.5 mm body
    expect(at(50 + 1.25 + 1 / 8, 50, 8)).toEqual({ kind: 'symbol', symbol: 0 }); // 1 px outside the edge: tolerance
  });
  it('falls back to the pin extents when a symbol has no graphics, and does not expose pins when zoomed far out', () => {
    expect(at(100, 50, 8)?.kind).toBe('symbol');
    expect(at(100, 46, 8)?.kind).toBe('pin');
    expect(at(100, 46.5, 0.5)?.kind).toBe('symbol'); // pins are not drawn at this zoom, so they cannot be clicked
  });
  it('hits wires within 5 px and chooses the nearest', () => {
    expect(at(75, 80 + 4 / 8, 8)).toEqual({ kind: 'wire', wire: 1 });
    expect(at(75, 80 + 7 / 8, 8)).toBeNull();
  });
  it('hits labels, buses, sheet pins and sheet symbols', () => {
    expect(at(122, 80, 8)).toEqual({ kind: 'label', label: 0 });
    expect(at(50, 120, 8)).toEqual({ kind: 'bus', bus: 0 });
    expect(at(150.2, 110, 8)).toEqual({ kind: 'sheetPin', ref: 0, pin: 0 });
    expect(at(170, 120, 8)).toEqual({ kind: 'sheet', ref: 0 });
    expect(at(300, 300, 8)).toBeNull();
  });
  it('picks the smaller of two overlapping symbols', () => {
    const big = resistor('big', 0, 0, { graphics: [{ kind: 'rect', min: P(-20, -20), max: P(20, 20), width: 0, fill: 'none' }], pins: [] });
    const small = resistor('small', 0, 0, { pins: [] });
    const d = buildSheetData(makeDef({ symbols: [big, small] }));
    expect(hitTest(d, P(0, 0), 8)).toEqual({ kind: 'symbol', symbol: 1 });
    expect(hitTest(d, P(10, 10), 8)).toEqual({ kind: 'symbol', symbol: 0 });
  });
  it('segmentDistance handles zero-length segments', () => {
    near(segmentDistance(P(3, 4), P(0, 0), P(0, 0)), 5);
    near(segmentDistance(P(5, 1), P(0, 0), P(10, 0)), 1);
    near(segmentDistance(P(-3, 4), P(0, 0), P(10, 0)), 5);
  });
});

describe('selection and net highlighting', () => {
  const r1 = resistor('r1', 50, 50), r2 = resistor('r2', 80, 50);
  const def = makeDef({
    symbols: [r1, r2],
    wires: [{ id: 'w1', a: P(50, 55.54), b: P(50, 70) }, { id: 'w2', a: P(50, 70), b: P(80, 70) }, { id: 'w3', a: P(80, 55.54), b: P(80, 70) }, { id: 'other', a: P(10, 10), b: P(30, 10) }],
    junctions: [{ id: 'j1', at: P(80, 70) }, { id: 'j2', at: P(20, 10) }],
    noConnects: [{ id: 'nc1', at: P(50, 44.46) }],
    labels: [label('lab', 'local', 'SIG', 60, 70), label('far', 'local', 'ELSEWHERE', 20, 10), label('gl', 'global', 'SIG', 200, 200, 0, 'input')],
    sheetRefs: [{ id: 's1', name: 'Sub', file: 'sub', defId: null, at: P(100, 100), size: P(20, 20), pins: [{ id: 'sp', name: 'A', at: P(80, 70), shape: 'input' }] }],
  });
  const data = buildSheetData(def);
  const conn: SchConnectivity = {
    nets: [
      { id: 'net:auto:1', name: 'SIG', auto: false, scope: 'local', scopePath: 'sub1', aliases: ['SIG'], members: [
        { instancePath: 'sub1', defId: 'root.kicad_sch', symbolId: 'r1', pinId: 'r1#2', ref: 'R1', unit: 1, pinNumber: '2', pinName: '' },
        { instancePath: 'sub1', defId: 'root.kicad_sch', symbolId: 'r2', pinId: 'r2#2', ref: 'R2', unit: 1, pinNumber: '2', pinName: '' },
        { instancePath: 'sub2', defId: 'root.kicad_sch', symbolId: 'r1', pinId: 'r1#1', ref: 'R9', unit: 1, pinNumber: '1', pinName: '' },
        { instancePath: 'sub1', defId: 'root.kicad_sch', symbolId: 'missing', pinId: 'x', ref: 'X', unit: 1, pinNumber: '1', pinName: '' },
      ], wires: [{ instancePath: 'sub1', wireId: 'w1' }, { instancePath: 'sub1', wireId: 'w2' }, { instancePath: 'sub1', wireId: 'w3' }, { instancePath: 'sub2', wireId: 'other' }, { instancePath: 'sub1', wireId: 'ghost' }] },
      { id: 'net:global:GND', name: 'GND', auto: false, scope: 'global', aliases: ['GND'], members: [], wires: [] },
    ],
    pinNet: { [pinKey('sub1', 'r1', 'r1#2')]: 'net:auto:1' }, wireNet: { [wireKey('sub1', 'w1')]: 'net:auto:1' }, noConnectPins: [], floatingPins: [], diagnostics: [],
  };

  it('collects only the displayed instance: wires, pins, and attached labels / junctions / sheet pins', () => {
    const hl = buildNetHighlight(data, 'sub1', conn, 'net:auto:1')!;
    expect(hl.name).toBe('SIG');
    expect(hl.wires.sort()).toEqual([0, 1, 2]); // not `other` (instance sub2), not the unknown `ghost`
    expect([...hl.pinsBySymbol.entries()]).toEqual([[0, [1]], [1, [1]]]); // unknown symbol and other instance are skipped
    expect([...hl.labels].sort()).toEqual([0]); // local label on the wire; global label of another scope-name is not attached
    expect([...hl.junctions]).toEqual([0]);
    expect([...hl.noConnects]).toEqual([]);
    expect([...hl.sheetPins]).toEqual(['0:0']);
  });
  it('a different instance sees only its own part of the net', () => {
    const hl = buildNetHighlight(data, 'sub2', conn, 'net:auto:1')!;
    expect(hl.wires).toEqual([3]); expect([...hl.pinsBySymbol.keys()]).toEqual([0]);
    expect([...hl.junctions]).toEqual([1]); // junction j2 sits on wire `other`
    expect([...hl.labels]).toEqual([1]);
  });
  it('global net names reach labels with the same name, and unknown or missing ids give null', () => {
    const g: SchConnectivity = { ...conn, nets: [...conn.nets, { id: 'net:global:SIG', name: 'SIG', auto: false, scope: 'global', aliases: ['SIG'], members: [], wires: [] }] };
    expect([...buildNetHighlight(data, 'sub1', g, 'net:global:SIG')!.labels].sort()).toEqual([2]); // name match: the global label only (the local one belongs to a local net of the same name)
    expect(buildNetHighlight(data, 'sub1', conn, 'net:nope')).toBeNull();
    expect(buildNetHighlight(data, 'sub1', conn, undefined)).toBeNull();
  });
  it('resolves controlled selection keys onto the displayed instance only', () => {
    const sel = { symbolKey: symbolKey('sub1', 'r2'), pinKey: pinKey('sub1', 'r1', 'r1#2') };
    expect(resolveSelection(data, 'sub1', sel)).toEqual({ symbol: 1, pin: { symbol: 0, pin: 1 } });
    expect(resolveSelection(data, 'sub2', sel)).toEqual({ symbol: -1, pin: null });
    expect(resolveSelection(data, 'sub1', { pinKey: pinKey('sub1', 'r1', 'r1#2') }).symbol).toBe(0); // a pin selects its symbol too
    expect(resolveSelection(data, 'sub1', { symbolKey: symbolKey('sub1', 'nope'), pinKey: pinKey('sub1', 'r1', 'nope') })).toEqual({ symbol: -1, pin: null });
    expect(resolveSelection(data, 'sub1', {})).toEqual({ symbol: -1, pin: null });
    expect(parseKey(wireKey('a/b', 'w'))).toEqual(['a/b', 'w']);
    expect(parseKey(undefined)).toEqual([]);
  });
});

describe('hierarchy helpers', () => {
  const inst = (path: string, parentPath: string | null, sheetRefId: string | null, depth: number, childPaths: string[]): SchSheetInstance =>
    ({ path, defId: path || 'root', name: path || 'root', page: String(depth + 1), parentPath, sheetRefId, childPaths, depth });
  const instances = [
    inst('', null, null, 0, ['pwr', 'cha', 'chb']),
    inst('pwr', '', 'pwr', 1, []),
    inst('cha', '', 'cha', 1, ['cha/flt']),
    inst('cha/flt', 'cha', 'flt', 2, []),
    inst('chb', '', 'chb', 1, ['chb/flt']),
    inst('chb/flt', 'chb', 'flt', 2, []),
  ];
  it('resolves a sheet symbol to the instance path, distinguishing repeated sub-sheets', () => {
    expect(resolveChildPath({ instances }, '', 'cha')).toBe('cha');
    expect(resolveChildPath({ instances }, 'cha', 'flt')).toBe('cha/flt');
    expect(resolveChildPath({ instances }, 'chb', 'flt')).toBe('chb/flt');
    expect(resolveChildPath({ instances }, 'chb', 'nope')).toBeNull();
    const noRefIds = instances.map(i => ({ ...i, sheetRefId: null, parentPath: null }));
    expect(resolveChildPath({ instances: noRefIds }, 'cha', 'flt')).toBe('cha/flt'); // joined-path fallback
  });
  it('builds tree rows in preorder and skips collapsed subtrees', () => {
    expect(buildNavRows(instances, new Set()).map(r => r.instance.path)).toEqual(['', 'pwr', 'cha', 'cha/flt', 'chb', 'chb/flt']);
    const rows = buildNavRows(instances, new Set(['cha']));
    expect(rows.map(r => r.instance.path)).toEqual(['', 'pwr', 'cha', 'chb', 'chb/flt']);
    expect(rows.find(r => r.instance.path === 'cha')).toMatchObject({ hasChildren: true, collapsed: true });
    expect(rows.find(r => r.instance.path === 'pwr')).toMatchObject({ hasChildren: false, collapsed: false });
    expect(buildNavRows(instances, new Set([''])).map(r => r.instance.path)).toEqual(['']);
    expect(buildNavRows(instances, new Set(['pwr'])).length).toBe(6); // a leaf cannot collapse
    expect(buildNavRows(instances, new Set(['cha'])).find(r => r.instance.path === 'chb')!.index).toBe(4); // index = position in the full list
  });
  it('builds the breadcrumb chain and tolerates unknown paths and cycles', () => {
    expect(instanceChain(instances, 'cha/flt').map(i => i.path)).toEqual(['', 'cha', 'cha/flt']);
    expect(instanceChain(instances, '').map(i => i.path)).toEqual(['']);
    expect(instanceChain(instances, 'nope')).toEqual([]);
    const cyc = [inst('a', 'b', null, 0, []), inst('b', 'a', null, 0, [])];
    expect(instanceChain(cyc, 'a').length).toBeLessThanOrEqual(128);
  });
});

describe('palette', () => {
  it('converts hex colours to rgba and falls back to color-mix for anything else', () => {
    expect(withAlpha('#ff8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)');
    expect(withAlpha(' #f80 ', 0.25)).toBe('rgba(255, 136, 0, 0.25)');
    expect(withAlpha('rgb(1, 2, 3)', 0.4)).toBe('color-mix(in srgb, rgb(1, 2, 3) 40%, transparent)');
  });
  it('keeps the electrical net accent distinct from wires and the calm accent in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const p = buildPalette(FALLBACK_TOKENS[theme], theme);
      expect(p.net).toBe(FALLBACK_TOKENS[theme].net);
      expect(new Set([p.net, p.wire, p.accent, p.bus]).size).toBe(4);
    }
  });
});
