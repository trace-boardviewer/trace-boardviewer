import type { AdapterFixture } from '../../fixture';
import type { Point } from '../../../types';

// Original generated records: no vendor file, board name or vendor geometry is embedded.
const join = (...chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let p = 0;
  for (const chunk of chunks) { out.set(chunk, p); p += chunk.length; }
  return out;
};
const words = (...values: number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 4), view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
  return out;
};
const text = (value: string): Uint8Array => join(Uint8Array.of(value.length), new TextEncoder().encode(value));
const localPoints: Point[] = [{ x: -1000, y: -1000 }, { x: 1000, y: -1000 }, { x: 1000, y: 1000 }, { x: -1000, y: 1000 }];

export function syntheticTvw(options: { rotation?: number; oldMetadata?: boolean; extraMetadata?: boolean; ordinals?: number[]; uids?: number[]; testPoint?: boolean; omitMaster?: boolean; conflictingPads?: boolean; oppositeSidePads?: boolean; corruptDcode?: boolean; masterName?: string; masterPoints?: Point[]; classification?: number; padLayerTag?: number; pinKind?: number;
  /** Headers of the full layer list in file order: 'top' and 'bottom' carry pads (the bottom pads have swapped nets), a number is another kind (3 = aux, 4 = silk, ...) with an uninterpreted body. */
  layerList?: Array<'top' | 'bottom' | number>;
  /** The byte after the ProbeDB text (35 by default). */
  closingTag?: number;
  /** Length of the bytes in front of the net table's first count; the default 69 carries the usual marker words, any other length does not. */
  netPrefix?: number;
  /** The second word of every layer-header prefix (3 by default). */
  layerPrefixWord?: number } = {}): Uint8Array {
  const rotation = options.rotation ?? 90, angle = -rotation * Math.PI / 180;
  const points = options.masterPoints ?? localPoints;
  const world = points.map(({ x, y }) => ({ x: Math.round(20000 + x * Math.cos(angle) - y * Math.sin(angle)), y: Math.round(10000 + x * Math.sin(angle) + y * Math.cos(angle)) }));
  const pad = ({ x, y }: Point, net: number): Uint8Array => join(words(net, options.corruptDcode ? 0 : 10, y, x), Uint8Array.of(0, 1, 0, 1), words(-200, -300, 200, 300), Uint8Array.of(0, options.padLayerTag ?? 0));
  const pads = world.map((point, i) => pad(point, i % 2));
  if (options.conflictingPads) pads.push(...[0, 1, 2].map(i => pad(world[i], 1 - i % 2)));
  const prefixWord = options.layerPrefixWord ?? 3;
  const layer = (type: number, records: Uint8Array[]) => join(words(0, prefixWord, 2, 1), text(type === 1 ? 'TOP' : 'BOTTOM'), text('PHYSICAL'), text(''), words(type, 0, 0, 11),
    words(1, 400, 600, 1, 0, 0), words(1, 0, 1), words(records.length, 2), ...records, words(0, 0));
  const kind = options.pinKind ?? (options.masterName?.endsWith('_B') ? 7 : 2), side = kind === 2 ? 1 : 2;
  const otherLayer = (type: number) => join(words(0, prefixWord, 2, 1), text(`LAYER${type}`), text('PHYSICAL'), text(''), words(type, 0, 0, 11), words(0, 0, 0, 0));
  const flipped = world.map((point, i) => pad(point, 1 - i % 2));
  const layers = options.layerList
    ? join(...options.layerList.map(entry => entry === 'top' ? layer(1, pads) : entry === 'bottom' ? layer(2, flipped) : otherLayer(entry)))
    : join(layer(side, pads), ...(options.oppositeSidePads ? [layer(side === 1 ? 2 : 1, flipped)] : []));
  const netHeader = new Uint8Array(options.netPrefix ?? 69);
  if (options.netPrefix === undefined) { netHeader[13] = 7; netHeader[25] = 4; }
  const table = join(netHeader, words(2, 2), text('GND'), text('VCC'), words(0, 0, 4), text('ProbeDB'), Uint8Array.of(options.closingTag ?? 35));
  const metadata = words(5000, 15000, 15000, 25000, options.testPoint ? world[0].y : 10000, options.testPoint ? world[0].x : 20000, rotation, 0, options.testPoint ? 18 : options.classification ?? 0, 0, 0);
  const ordinals = options.ordinals ?? (options.testPoint ? [1] : [3, 4, 7, 8]);
  const pins = ordinals.map((ordinal, i) => join(words(options.uids?.[i] ?? i * 8, 0, ordinal), text(options.testPoint ? '' : `P${i + 1}`), words(0)));
  const bom = options.testPoint ? Uint8Array.of(0) : join(Uint8Array.of(1), text('SYNTHETIC'), ...(options.extraMetadata ? [text('1'), text('1')] : [new Uint8Array(2)]), text('TEST4'), text(''));
  const part = join(text('U1'), metadata, ...(options.oldMetadata ? [words(0)] : []), bom, words(0, pins.length, kind), ...(options.oldMetadata ? [] : [words(0)]), ...pins);
  const master = join(Uint8Array.of(1), text(options.masterName ?? 'TEST4'), words(0, 0x80000001, 0x80000001), new Uint8Array(64), words(4, 2), ...points.map(({ x, y }) => join(words(-1, 10, y, x), new Uint8Array(3))));
  return join(layers, table, new Uint8Array(16), words(1, 12), part, ...(options.omitMaster ? [] : [master]));
}

const fixtures: AdapterFixture[] = [
  { label: 'compact TVW metadata with sparse BGA ordinals', name: 'synthetic.tvw', data: syntheticTvw() },
  { label: 'TVW metadata with height word', name: 'height.tvw', data: syntheticTvw({ oldMetadata: true, rotation: 180 }) },
];
export default fixtures;
