/**
 * Builders of small boards and schematics from plain specs, for the property tests. Original synthetic data; nothing here is shared
 * with the parsers: a board is made from its components and pins directly, a schematic through the test builders of the
 * schematic module and the real connectivity engine.
 */
import { computeConnectivity } from '../../src/lib/schematic/connectivity';
import type { SchematicDesign } from '../../src/lib/schematic/model';
import { buildSchematic, SheetBuilder } from '../../src/lib/schematic/testing';
import type { Board, BoardSide } from '../../src/lib/types';

export interface BoardPartSpec {
  ref: string;
  /** Pad number, net name (an empty net is no net) and whether the importer made the number up. The same number twice is a split pad. */
  pins: ReadonlyArray<readonly [number: string, net: string, generated?: boolean]>;
  side?: BoardSide;
  value?: string;
  pkg?: string;
  /** Position in millimetres (the default places part i at x = 10 i). */
  at?: { x: number; y: number };
  refGenerated?: boolean;
  /** Distance between neighbouring pads in millimetres (default 1; 0 puts every pad on one spot). */
  pitch?: number;
}

/** A Board with ids `c<i>` / `c<i>.p<j>` (session handles, as an importer would number them), nets collected from the pins. */
export function makeBoard(specs: readonly BoardPartSpec[]): Board {
  const components: Board['components'] = [], pins: Board['pins'] = [];
  const netPins = new Map<string, string[]>();
  specs.forEach((spec, i) => {
    const id = `c${i}`, side = spec.side ?? 'top', at = spec.at ?? { x: i * 10, y: 0 };
    const pinIds: string[] = [];
    spec.pins.forEach(([number, net, generated], j) => {
      const pinId = `${id}.p${j}`;
      pins.push({ id: pinId, componentId: id, number, ...(generated ? { numberGenerated: true as const } : {}), name: '', net, side, radius: 0.2, shape: 'round', x: at.x + j * (spec.pitch ?? 1), y: at.y });
      pinIds.push(pinId);
      if (net) { const list = netPins.get(net); if (list) list.push(pinId); else netPins.set(net, [pinId]); }
    });
    components.push({
      id, ref: spec.ref, ...(spec.refGenerated ? { refGenerated: true as const } : {}), value: spec.value ?? '', package: spec.pkg ?? '', side,
      bounds: { minX: at.x - 1, minY: at.y - 1, maxX: at.x + 1 + spec.pins.length, maxY: at.y + 1 }, position: at, rotation: 0, pinIds, outline: [],
    });
  });
  const nets = [...netPins].map(([name, pinIds], k) => ({ id: `n${k}`, name, pinIds }));
  return { name: 'synthetic', format: 'test', units: 'mm', components, pins, nets, outline: [], bounds: { minX: -1, minY: -1, maxX: specs.length * 10 + 10, maxY: 1 }, warnings: [] };
}

export interface SchPartSpec {
  ref: string;
  /** Pin number and the net a global label attaches to it ('' = unconnected). Numbers must be distinct within one part. */
  pins: ReadonlyArray<readonly [number: string, net: string]>;
  value?: string;
  footprint?: string;
  dnp?: boolean;
}

/** A one-sheet KiCad-style design: parts far apart on one line, every labelled pin carries a global label of that name; connectivity by the real engine. */
export function makeDesign(specs: readonly SchPartSpec[], name = 'synthetic'): SchematicDesign {
  const sheet = new SheetBuilder('root', name);
  specs.forEach((spec, i) => {
    const pins = spec.pins.map(([n], j) => ({ n, x: i * 100 + j * 10, y: 0 }));
    sheet.part(spec.ref, pins, { id: `s${i}`, value: spec.value, dnp: spec.dnp });
    spec.pins.forEach(([, net], j) => { if (net) sheet.global(net, i * 100 + j * 10, 0); });
  });
  const schematic = buildSchematic([sheet], { name });
  return { schematic, connectivity: computeConnectivity(schematic) };
}
