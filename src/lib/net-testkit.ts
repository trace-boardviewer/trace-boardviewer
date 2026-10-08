/**
 * Synthetic boards for the tests of the net tools (net-graph, rail-walk, net-tree, shared-nets, connection-path, probe-points,
 * short-suspects, drop-locator). Test support only: nothing in the application imports it. Boards are built straight into the
 * board model (no parser), so 100k-pin boards take a few milliseconds.
 */
import type { Board, BoardComponent, BoardPin, BoardSide, Bounds } from './types';

export interface KitPin {
  net: string;
  number?: string;
  name?: string;
  x?: number;
  y?: number;
  side?: BoardSide;
  radius?: number;
  width?: number;
  height?: number;
  shape?: BoardPin['shape'];
}
export interface KitPart {
  ref: string;
  value?: string;
  package?: string;
  side?: BoardSide;
  /** Part position; pins without coordinates are placed 1 mm apart from here. */
  x?: number;
  y?: number;
  bounds?: Bounds;
  /** A net name, or a full pin. */
  pins: ReadonlyArray<string | KitPin>;
}

/** A board from part descriptions. Parts without a position are laid out on a 10 mm grid, 100 per row. */
export function kitBoard(parts: readonly KitPart[], name = 'synthetic'): Board {
  const components: BoardComponent[] = [];
  const pins: BoardPin[] = [];
  const nets = new Map<string, string[]>();
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const id = `part:${index}`;
    const px = part.x ?? (index % 100) * 10, py = part.y ?? Math.floor(index / 100) * 10;
    const side = part.side ?? 'top';
    const pinIds: string[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < part.pins.length; k++) {
      const raw = part.pins[k];
      const spec: KitPin = typeof raw === 'string' ? { net: raw } : raw;
      const pinId = `pin:${pins.length}`;
      const x = spec.x ?? px + k, y = spec.y ?? py;
      const pin: BoardPin = {
        id: pinId, componentId: id, number: spec.number ?? String(k + 1), name: spec.name ?? spec.number ?? String(k + 1), net: spec.net,
        side: spec.side ?? side, x, y, radius: spec.radius ?? 0.3, shape: spec.shape ?? 'round',
        ...(spec.width === undefined ? {} : { width: spec.width }), ...(spec.height === undefined ? {} : { height: spec.height }),
      };
      pins.push(pin); pinIds.push(pinId);
      if (x - 0.5 < minX) minX = x - 0.5; if (x + 0.5 > maxX) maxX = x + 0.5; if (y - 0.5 < minY) minY = y - 0.5; if (y + 0.5 > maxY) maxY = y + 0.5;
      if (spec.net) { const list = nets.get(spec.net); if (list) list.push(pinId); else nets.set(spec.net, [pinId]); }
    }
    const bounds = part.bounds ?? (pinIds.length ? { minX, minY, maxX, maxY } : { minX: px - 0.5, minY: py - 0.5, maxX: px + 0.5, maxY: py + 0.5 });
    components.push({
      id, ref: part.ref, value: part.value ?? '', package: part.package ?? '', side, bounds, position: { x: px, y: py }, rotation: 0, pinIds,
      outline: [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }],
    });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pin of pins) { if (pin.x < minX) minX = pin.x; if (pin.x > maxX) maxX = pin.x; if (pin.y < minY) minY = pin.y; if (pin.y > maxY) maxY = pin.y; }
  const bounds = pins.length ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    name, format: 'synthetic', units: 'mm', components, pins,
    nets: [...nets].map(([net, pinIds], index) => ({ id: `net:${index}`, name: net, pinIds })),
    outline: [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }],
    bounds, warnings: [],
  };
}

/** A two-pin part between nets a and b. */
export const two = (ref: string, value: string, a: string, b: string, extra: Partial<KitPart> = {}): KitPart => ({ ref, value, pins: [a, b], ...extra });

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A board of about `pinTarget` pins shaped like a real one: a few big ICs, many decoupling capacitors from rails to GND, signal
 * resistors, and chains of link parts between rails. Used by the timing tests.
 */
export function largeBoard(pinTarget: number, seed = 1): Board {
  const random = seeded(seed);
  const parts: KitPart[] = [];
  const rails = Array.from({ length: 40 }, (_, i) => `PP${(i % 9) + 1}V${i}_S${i % 3}`);
  let pins = 0;
  // Rails chained through links: rail i -> link -> rail i+1 for a few chains.
  for (let i = 0; i + 1 < rails.length; i++) {
    if (i % 5 === 4) continue;
    const kind = i % 4;
    parts.push(kind === 0 ? two(`R${9000 + i}`, '0R', rails[i], rails[i + 1]) : kind === 1 ? two(`FB${i}`, '600R@100MHz', rails[i], rails[i + 1])
      : kind === 2 ? two(`L${i}`, '2.2uH', rails[i], rails[i + 1]) : two(`F${i}`, '2A', rails[i], rails[i + 1]));
    pins += 2;
  }
  // Big ICs with power and ground pins.
  for (let u = 0; u < 20; u++) {
    const count = 400;
    const icPins: KitPin[] = [];
    for (let k = 0; k < count; k++) {
      const net = k % 5 === 0 ? 'GND' : k % 7 === 0 ? rails[(u + k) % rails.length] : `SIG_${u}_${k}`;
      icPins.push({ net, x: 1000 + u * 40 + (k % 20), y: 1000 + Math.floor(k / 20) });
    }
    parts.push({ ref: `U${u + 1}`, value: 'SOC', package: 'BGA-400', pins: icPins, x: 1000 + u * 40, y: 1000 });
    pins += count;
  }
  let c = 1, r = 1;
  while (pins < pinTarget) {
    const roll = random();
    if (roll < 0.6) {
      const rail = rails[Math.floor(random() * rails.length)];
      parts.push(two(`C${c++}`, random() < 0.5 ? '100n' : '10uF', rail, 'GND', { package: random() < 0.5 ? 'C_0402_1005Metric' : 'C_0805_2012Metric' }));
    } else {
      const u = Math.floor(random() * 20), k = Math.floor(random() * 400);
      parts.push(two(`R${r++}`, random() < 0.9 ? '10K' : '0R', `SIG_${u}_${k}`, random() < 0.5 ? rails[Math.floor(random() * rails.length)] : `SIG_${(u + 1) % 20}_${k}`));
    }
    pins += 2;
  }
  return kitBoard(parts, 'large-synthetic');
}
