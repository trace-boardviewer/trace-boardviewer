import { lines, type AdapterFixture } from '../../fixture';

const BVR3 = ['BVRAW_FORMAT_3', 'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 100 100', 'PIN_NUMBER 1', 'PIN_SIDE T', 'PIN_ORIGIN 0 0', 'PIN_RADIUS 5', 'PIN_NET GND', 'PIN_END', 'PART_END'];

const fixtures: AdapterFixture[] = [
  { label: 'BVRAW_FORMAT_3', name: 'board.bvr', data: lines(BVR3, '\r\n') },
  { label: 'BVRAW_FORMAT_3 with a UTF-8 BOM', name: 'board.bvr', data: Uint8Array.from([0xef, 0xbb, 0xbf, ...lines(BVR3)]) },
];
export default fixtures;
