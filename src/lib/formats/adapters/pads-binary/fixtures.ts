import type { AdapterFixture } from '../../fixture';

/** Original framing-only fixture; deliberately contains no source-board records. */
export function padsFrame(version = 0x2026): Uint8Array {
  const count = 75, start = 6 + count * 16, data = new Uint8Array(start + 46), view = new DataView(data.buffer);
  data.set([0, 0xff]); view.setUint16(2, version, true);
  view.setUint32(26, count, true); view.setUint32(30, count * 16, true);
  data.set(new TextEncoder().encode('{2FE18320-6448-11d1-A412-000000000000}'), start + 4);
  view.setUint32(data.length - 4, start, true);
  return data;
}
const fixtures: AdapterFixture[] = [0x2026, 0x2027].map(version => ({ label: `native version 0x${version.toString(16)} framing only`, name: 'synthetic.pcb', data: padsFrame(version), expect: 'refused' }));
export default fixtures;
