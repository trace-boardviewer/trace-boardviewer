import { lines, type AdapterFixture } from '../../fixture';

const GERBER = ['%FSLAX24Y24*%', '%MOIN*%', '%ADD10C,0.0100*%', 'G04 synthetic copper layer*', 'D10*', 'X010000Y010000D02*', 'X020000Y010000D01*', 'M02*'];

const fixtures: AdapterFixture[] = [{ label: 'RS-274X layer', name: 'top.gbr', data: lines(GERBER), expect: 'refused' }];
export default fixtures;
