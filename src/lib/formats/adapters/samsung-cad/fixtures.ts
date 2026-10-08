import { lines, type AdapterFixture } from '../../fixture';

const SAMSUNG = ['###Panel Added: synthetic sample', 'COMP  U1   PN-100  0  0  1.000  2.000  1  0', 'C_PIN  U1-1    1.000   2.000  0  0  0  X  /VCC'];

const fixtures: AdapterFixture[] = [{ label: 'COMP and C_PIN records', name: 'board.cad', data: lines(SAMSUNG) }];
export default fixtures;
