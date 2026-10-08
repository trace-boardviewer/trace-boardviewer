import type { AdapterFixture } from '../../fixture';

/** The documented Allegro 16.2 magic at offset 0 and "all" at 0xF8; the rest of the database is zeros. */
function allegro(): Uint8Array {
  const data = new Uint8Array(4096);
  new DataView(data.buffer).setUint32(0, 0x00130400, true);
  data.set(new TextEncoder().encode('all'), 0xf8);
  return data;
}

const fixtures: AdapterFixture[] = [{ label: 'Allegro 16.2 database header', name: 'board.brd', data: allegro(), expect: 'refused' }];
export default fixtures;
