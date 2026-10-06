import { describe, expect, it } from 'vitest';
import { viewportBounds } from '../lib/geometry';
import type { Bounds2, ViewTransform } from '../lib/geometry';
import { appendPadPath } from '../lib/render-geometry';
import type { BoardPin } from '../lib/types';
import { boundsCover, buildPadLayers, PAD_BATCH_SIZE, PAD_REGION_SLACK, PAD_VIEW_MARGIN_PX, planPadLayers, samePadPlan } from './board-pad-layers';
import type { PadLayers } from './board-pad-layers';

/** A path that only records the operations appended to it. */
class RecordingPath {
  ops: string[] = [];
  moveTo(x: number, y: number) { this.ops.push(`m${x},${y}`); }
  lineTo(x: number, y: number) { this.ops.push(`l${x},${y}`); }
  arc(x: number, y: number, r: number, a: number, b: number) { this.ops.push(`a${x},${y},${r},${a},${b}`); }
  closePath() { this.ops.push('z'); }
}
function factory() {
  const created: RecordingPath[] = [];
  return { created, create: () => { const path = new RecordingPath(); created.push(path); return path; } };
}
const opsOf = (layers: PadLayers<RecordingPath>) => ({
  ordinary: layers.ordinary.map(path => path.ops), selectedComponent: layers.selectedComponent.map(path => path.ops), net: layers.net.map(path => path.ops),
});

/** The ORIGINAL BoardCanvas `buildPinLayers`, verbatim except for the injected path factory. */
function legacyBuildPinLayers(pins: readonly BoardPin[], scale: number, selectedNet: string | null, selectedComponent: string | null, create: () => RecordingPath) {
  const paths: PadLayers<RecordingPath> = { ordinary: [], selectedComponent: [], net: [] };
  const counts = { ordinary: 0, selectedComponent: 0, net: 0 };
  for (const pin of pins) {
    const linked = !!selectedNet && pin.net === selectedNet;
    const selected = pin.componentId === selectedComponent;
    const layer = linked ? 'net' : selected ? 'selectedComponent' : 'ordinary';
    if (counts[layer] % PAD_BATCH_SIZE === 0) paths[layer].push(create());
    const batches = paths[layer];
    appendPadPath(batches[batches.length - 1], pin, scale, linked ? 2.2 : selected ? 1.8 : 1);
    counts[layer]++;
  }
  return paths;
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function randomPins(count: number, seed: number, extent = 200): BoardPin[] {
  const random = mulberry32(seed);
  const nets = ['GND', 'VCC', 'N1', 'N2', ''];
  return Array.from({ length: count }, (_, i): BoardPin => {
    const kind = Math.floor(random() * 4);
    const base = { id: `P${i}`, componentId: `C${Math.floor(random() * 40)}`, number: String(i), name: String(i), net: nets[Math.floor(random() * nets.length)], side: 'top' as const, x: random() * extent, y: random() * extent * 0.6 };
    if (kind === 0) return { ...base, radius: 0, shape: 'round' };                                 // unknown size: marker only
    if (kind === 1) return { ...base, radius: 0.15 + random() * 0.4, shape: 'round' };
    if (kind === 2) return { ...base, radius: 0.5, shape: 'rect', width: 0.3 + random() * 3, height: 0.2 + random() * 2, rotation: [0, 90, 45, 30][Math.floor(random() * 4)] };
    return { ...base, radius: 0.4, shape: 'square', width: 0.8, rotation: random() * 360 };
  });
}

const everything: Bounds2 = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
const intersects = (a: Bounds2, b: Bounds2) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/** The physical bounds of a pad, computed independently of the production table. */
function physicalBounds(pin: BoardPin): Bounds2 {
  let hw = pin.radius, hh = pin.radius;
  if (pin.shape !== 'round' && (pin.width || pin.height)) {
    const w = (pin.width ?? pin.radius * 2) / 2, h = (pin.height ?? pin.radius * 2) / 2;
    const a = (pin.rotation ?? 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    hw = w * c + h * s; hh = w * s + h * c;
  }
  return { minX: pin.x - hw, minY: pin.y - hh, maxX: pin.x + hw, maxY: pin.y + hh };
}

describe('P04 pad layers are built for the visible region only, batched exactly like the full build', () => {
  const pins = randomPins(700, 7);
  const selections: Array<[string | null, string | null]> = [[null, null], ['GND', null], [null, 'C3'], ['VCC', 'C7'], ['', 'C1']];

  for (const [net, component] of selections) for (const scale of [0.4, 6.8, 40]) {
    it(`equals the original full build (all pads visible) for net=${JSON.stringify(net)} component=${JSON.stringify(component)} at scale ${scale}`, () => {
      const old = factory(), now = factory();
      const expected = legacyBuildPinLayers(pins, scale, net, component, old.create);
      const actual = buildPadLayers(planPadLayers(pins, net, component), everything, scale, now.create);
      expect(opsOf(actual)).toEqual(opsOf(expected));
    });
  }

  it('keeps every batch\'s members when only a region is built: the culled batches are the full batches restricted to the region', () => {
    const net = 'GND', component = 'C3';
    const plan = planPadLayers(pins, net, component);
    const region: Bounds2 = { minX: 40, minY: 20, maxX: 95, maxY: 70 };
    const actual = buildPadLayers(plan, region, 6.8, factory().create);
    // expected, derived independently: rank every pad inside its layer over ALL pads, then keep the ones in the region
    const layerOf = (pin: BoardPin) => pin.net === net ? 'net' : pin.componentId === component ? 'selectedComponent' : 'ordinary';
    const markers = { net: 2.2, selectedComponent: 1.8, ordinary: 1 } as const;
    const rank = { net: 0, selectedComponent: 0, ordinary: 0 };
    const expected: Record<'net' | 'selectedComponent' | 'ordinary', Map<number, string[]>> = { net: new Map(), selectedComponent: new Map(), ordinary: new Map() };
    let visible = 0;
    for (const pin of pins) {
      const layer = layerOf(pin);
      const batch = Math.floor(rank[layer]++ / PAD_BATCH_SIZE);
      if (!intersects(physicalBounds(pin), region)) continue;
      visible++;
      const path = new RecordingPath();
      appendPadPath(path, pin, 6.8, markers[layer]);
      const batchOps = expected[layer].get(batch) ?? [];
      batchOps.push(...path.ops);
      expected[layer].set(batch, batchOps);
    }
    expect(visible).toBeGreaterThan(50);
    expect(visible).toBeLessThan(pins.length);
    for (const layer of ['ordinary', 'selectedComponent', 'net'] as const) {
      const wanted = [...expected[layer].entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
      expect(actual[layer].map(path => path.ops), layer).toEqual(wanted);
    }
  });

  it('contains every pad whose DISPLAY geometry reaches the viewport when the region is the viewport plus its 16 px margin', () => {
    const view: ViewTransform = { center: { x: 70, y: 42 }, scale: 3.5, rotation: 90, mirrored: true };
    const width = 900, height = 600;
    const region = viewportBounds(view, width, height, PAD_VIEW_MARGIN_PX);
    const screen = viewportBounds(view, width, height);
    const layers = buildPadLayers(planPadLayers(pins, null, null), region, view.scale, factory().create);
    const flattened = layers.ordinary.flatMap(path => path.ops).join('|');
    let reaching = 0;
    for (const pin of pins) {
      // display bounds: the physical bounds grown by the marker (at most 2.2 px around the centre)
      const physical = physicalBounds(pin), marker = 1 / view.scale;
      const display = { minX: Math.min(physical.minX, pin.x - marker), minY: Math.min(physical.minY, pin.y - marker), maxX: Math.max(physical.maxX, pin.x + marker), maxY: Math.max(physical.maxY, pin.y + marker) };
      if (!intersects(display, screen)) continue;
      reaching++;
      const path = new RecordingPath();
      appendPadPath(path, pin, view.scale, 1);
      expect(flattened.includes(path.ops.join('|')), `pad ${pin.id}`).toBe(true);
    }
    expect(reaching).toBeGreaterThan(20);
  });

  it('builds nothing for 100k pads that are all outside the region (no path, no operation), at every zoom', () => {
    const many = Array.from({ length: 100_000 }, (_, i): BoardPin => ({
      id: `P${i}`, componentId: `C${i % 500}`, number: '1', name: '1', net: i % 3 === 0 ? 'GND' : `N${i % 97}`, side: 'top',
      x: (i % 400) * 1.0, y: Math.floor(i / 400) * 0.15, radius: 0.1, shape: i % 2 ? 'rect' : 'round', width: 0.4, height: 0.25,
    }));
    expect(Math.max(...many.slice(0, 5000).map(pin => pin.y))).toBeLessThanOrEqual(39.6);
    const view: ViewTransform = { center: { x: 200, y: 100 }, scale: 48.94, rotation: 0, mirrored: false };
    for (const net of [null, 'GND']) {
      const plan = planPadLayers(many, net, null);
      for (const scale of [48.94, 52, 55.5, 60, 66.4]) {
        const f = factory();
        const region = viewportBounds({ ...view, scale }, 1200, 800, PAD_VIEW_MARGIN_PX + 1200 * PAD_REGION_SLACK);
        const layers = buildPadLayers(plan, region, scale, f.create);
        expect(f.created).toHaveLength(0);
        expect(layers.ordinary.length + layers.selectedComponent.length + layers.net.length).toBe(0);
      }
    }
    // the original would have visited every one of them on each zoom step
    const old = factory();
    legacyBuildPinLayers(many.slice(0, 2000), 52, null, null, old.create);
    expect(old.created.reduce((sum, path) => sum + path.ops.length, 0)).toBeGreaterThan(2000);
  });

  it('plans with the selection only, and reports whether a plan still matches', () => {
    const plan = planPadLayers(pins, 'GND', 'C3');
    expect(samePadPlan(plan, pins, 'GND', 'C3')).toBe(true);
    expect(samePadPlan(plan, pins, 'GND', null)).toBe(false);
    expect(samePadPlan(plan, pins, null, 'C3')).toBe(false);
    expect(samePadPlan(plan, [...pins], 'GND', 'C3')).toBe(false);
    expect(samePadPlan(null, pins, 'GND', 'C3')).toBe(false);
    expect(plan.batch.length).toBe(pins.length);
  });

  it('checks region coverage', () => {
    const outer = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(boundsCover(outer, { minX: 1, minY: 1, maxX: 9, maxY: 9 })).toBe(true);
    expect(boundsCover(outer, outer)).toBe(true);
    expect(boundsCover(outer, { minX: -0.1, minY: 1, maxX: 9, maxY: 9 })).toBe(false);
    expect(boundsCover(outer, { minX: 1, minY: 1, maxX: 9, maxY: 10.1 })).toBe(false);
  });
});
