import { lines, type AdapterFixture } from '../../fixture';

const BVR1 = ['BVRAW_FORMAT_1', '<<Layout>>', 'X,Y', '0.000,0.000', '2.000, 0.000', '2.000 1.000', '0.000,1.000', '<<Pin>>', 'PART SIDE ID NAME X Y LAYER NET',
  'U1\t(T)\t1\t1\t0.100\t0.200\t1\tVCC', 'R1 (B) 1 A1 1.500 0.500 2 GND', '<<Nail>>', 'TAG X Y TYPE GRID SIDE NETID NET', 'N1\t0.100 0.200 1 G1 (T) 3 VCC'];

const fixtures: AdapterFixture[] = [{ label: 'BVRAW_FORMAT_1', name: 'board.bvr', data: lines(BVR1) }];
export default fixtures;
