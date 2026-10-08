import { lines, type AdapterFixture } from '../../fixture';

const LANDREX = ['str_length:', '123', 'var_data:', '4 1 2 0', 'Format:', '0 0', '1000 0', '1000 1000', '0 1000', 'Parts:', 'U1 1 2', 'Pins:', '100 100 0 1 GND', '200 100 0 1 VCC', 'Nails:'];
/** Inverse of the reader's decoding (decoded = NOT(rotate left by two)): undo the NOT, then rotate right by two; CR, LF and NUL stay. */
const encode = (data: Uint8Array) => data.map(byte => byte === 0 || byte === 10 || byte === 13 ? byte : ((~byte & 0xff) >>> 2 | (~byte & 0xff) << 6) & 0xff);

const fixtures: AdapterFixture[] = [
  { label: 'plain Landrex text', name: 'board.brd', data: lines(LANDREX) },
  { label: 'rotated-byte encoded', name: 'board.brd', data: encode(lines(LANDREX, '\r\n')) },
];
export default fixtures;
