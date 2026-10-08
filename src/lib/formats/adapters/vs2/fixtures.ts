import { lines, type AdapterFixture } from '../../fixture';
const fixtures: AdapterFixture[] = [{ label: 'VS2 assembly header', name: 'synthetic.lst', data: lines(['$VS2 SYNTHETIC', '$ASM SYNTHETIC', '$EC SYNTHETIC', '$A30 SYNTHETIC', '$TT SYNTHETIC', '$ CODE P/N DESCRIPTION PLN NBR LEAD-L1 LEAD-L2 CENTER POS ORI', '$SP']), expect: 'refused' }];
export default fixtures;
