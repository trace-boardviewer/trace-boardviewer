import { lines, type AdapterFixture } from '../../fixture';

const BRD2 = ['BRDOUT: 4 1000 1000', '0 0', '1000 0', '1000 1000', '0 1000', 'NETS: 2', '1 GND', '2 VCC', 'PARTS: 1', 'U1 100 100 300 200 0 1', 'PINS: 2', '150 150 1 1', '250 150 2 1', 'NAILS: 0'];

const fixtures: AdapterFixture[] = [{ label: 'TOPTEST BRD2', name: 'board.brd', data: lines(BRD2) }];
export default fixtures;
