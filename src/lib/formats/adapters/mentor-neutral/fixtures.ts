import { lines, type AdapterFixture } from '../../fixture';

const MENTOR = ['# file : /synthetic/job/neutral_file.mech', '# date : Monday January 1, 2001; 10:00:00', '# ', 'B_UNITS INCH'];

const fixtures: AdapterFixture[] = [{ label: '# file / # date header', name: 'board.neu', data: lines(MENTOR), expect: 'refused' }];
export default fixtures;
