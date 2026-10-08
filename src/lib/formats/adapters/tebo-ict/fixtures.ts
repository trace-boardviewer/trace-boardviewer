import { syntheticTeboIct } from '../../tebo-ict-fixtures';
import { utf8, type AdapterFixture } from '../../fixture';
const a = syntheticTeboIct(), b = syntheticTeboIct('\r\n');
const fixtures: AdapterFixture[] = [
  { label: 'geometry role with its explicit electrical companion', name: 'board_xy.ict', data: utf8(a.geometry), companions: { 'board.ict': utf8(a.program) } },
  { label: 'electrical role with the same geometry companion', name: 'board.ict', data: utf8(b.program), companions: { 'board_xy.ict': utf8(b.geometry) } },
];
export default fixtures;
