import { zipSync } from 'fflate';
import project from '../../../../../tests/fixtures/easyeda/pro/project.json?raw';
import pcb from '../../../../../tests/fixtures/easyeda/pro/PCB/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.epcb?raw';
import fp1 from '../../../../../tests/fixtures/easyeda/pro/FOOTPRINT/11111111111111111111111111111111.efoo?raw';
import fp2 from '../../../../../tests/fixtures/easyeda/pro/FOOTPRINT/22222222222222222222222222222222.efoo?raw';
import fp3 from '../../../../../tests/fixtures/easyeda/pro/FOOTPRINT/33333333333333333333333333333333.efoo?raw';
import { utf8 } from '../../fixture';
export default [{ label: 'project archive', name: 'board.epro', data: zipSync({ 'project.json': utf8(project), 'PCB/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.epcb': utf8(pcb), 'FOOTPRINT/11111111111111111111111111111111.efoo': utf8(fp1), 'FOOTPRINT/22222222222222222222222222222222.efoo': utf8(fp2), 'FOOTPRINT/33333333333333333333333333333333.efoo': utf8(fp3) }) }];
