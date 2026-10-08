import { zipSync } from 'fflate';
import { utf8, type AdapterFixture } from '../../fixture';
import asc from '../asc/fixtures';
import gencad from '../gencad/fixtures';
import kicad from '../kicad/fixtures';

const fixtures: AdapterFixture[] = [
  { label: 'a GenCAD board in a folder, deflated, next to a text file', name: 'board.zip', data: zipSync({ 'job/board.cad': gencad[0].data, 'job/readme.txt': utf8('notes\n') }) },
  { label: 'a KiCad board stored without compression', name: 'board.zip', data: zipSync({ 'board.kicad_pcb': [kicad[0].data, { level: 0 }] }) },
  { label: 'the ASC trio with its companions', name: 'trio.zip', data: zipSync(Object.fromEntries([asc[0], ...Object.entries(asc[0].companions ?? {}).map(([name, data]) => ({ name, data }))].map(file => [`asc/${file.name}`, file.data]))) },
];
export default fixtures;
