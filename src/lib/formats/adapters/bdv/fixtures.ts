import { lines, type AdapterFixture } from '../../fixture';

const header = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `; ${tag} header ${index + 1}`);
const BDV = ['<<format.asc>>', ...header(8, 'format'), '0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000', '<<pins.asc>>', ...header(8, 'pins'), 'Part U1 (T)', '1  1  0.100 0.200  1  VCC  5', '<<nails.asc>>', ...header(7, 'nails')];
/** The reader's per-line cipher is its own inverse: every byte except CR, LF and NUL becomes (key - byte) mod 256; the key grows with each CR LF. */
function encode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let key = 0xa0;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index];
    if (byte === 13 && data[index + 1] === 10) key++;
    out[index] = byte === 13 || byte === 10 || byte === 0 ? byte : (key - byte) & 0xff;
    if (key > 285) key = 159;
  }
  return out;
}

const fixtures: AdapterFixture[] = [
  { label: 'plain sections', name: 'board.bdv', data: lines(BDV, '\r\n') },
  { label: 'encoded', name: 'board.bdv', data: encode(lines(BDV, '\r\n')) },
  { label: 'encoded nails-first without an outline', name: 'board.bdv', data: encode(lines(['<<nails.asc>>', ...header(7, 'nails'), '<<pins.asc>>', ...header(8, 'pins'), 'Part U1 (T)', '1 1 .1 .2 1 VCC 5'], '\r\n')) },
];
export default fixtures;
