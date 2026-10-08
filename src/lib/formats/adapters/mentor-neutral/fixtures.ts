import { lines, type AdapterFixture } from '../../fixture';

const MENTOR = ['# file : /synthetic/job/neutral_file.mech', '# date : Monday January 1, 2001; 10:00:00', '# ', 'B_UNITS INCH'];

const fixtures: AdapterFixture[] = [{ label: '# file / # date header', name: 'board.neu', data: lines(MENTOR), expect: 'refused' }];
fixtures.push({ label: 'placed component and absolute pin', name: 'board.cad', data: lines([...MENTOR.slice(0, -1), 'BOARD SYNTHETIC OFFSET x:0 y:0 ORIENTATION 0', 'B_UNITS Inches', 'COMP U1 P IC SHAPE .1 .2 1 0', 'C_PIN U1-1 .1 .2 1 1 0 PAD /NET']) });
export default fixtures;
