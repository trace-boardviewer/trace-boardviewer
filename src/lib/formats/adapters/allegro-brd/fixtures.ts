import type { AdapterFixture } from '../../fixture';
import { makeAllegro } from '../../allegro-fixture';

/** A recognized newer layout whose header and object framing are not supported by this reader. */
export function unsupportedAllegro(magic = 0x00150000, writer = 'all'): Uint8Array {
  const data = new Uint8Array(4096);
  const view = new DataView(data.buffer);
  view.setUint32(0, magic, true);
  [3, 1, 3, 9].forEach((value, n) => view.setUint32(4 + n * 4, value, true)); view.setUint32(24, 0x000a0d0a, true);
  data.set(new TextEncoder().encode(writer), 0xf8);
  return data;
}

const fixtures: AdapterFixture[] = [
  { label: 'native 16.6 keyed database', name: 'board.brd', data: makeAllegro().data },
  { label: 'native 17.2 bottom footprint', name: 'board.brd', data: makeAllegro({ version: 172, bottom: true }).data },
  { label: 'Allegro 18 unsupported database header', name: 'board.brd', data: unsupportedAllegro(), expect: 'refused' },
  { label: 'legacy 15 unsupported database layout', name: 'board.brd', data: unsupportedAllegro(0x00120a0a, 'allv15-7'), expect: 'refused' },
  { label: 'alternate 16.2 database identifier', name: 'board.brd', data: (() => { const data = makeAllegro({ version: 162 }).data; new DataView(data.buffer).setUint32(0, 0x00130503, true); return data; })() },
];
export default fixtures;
