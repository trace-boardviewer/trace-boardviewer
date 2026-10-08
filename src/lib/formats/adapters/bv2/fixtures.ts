import { syntheticBv2 } from '../../bv2-fixtures';
import { utf8, type AdapterFixture } from '../../fixture';
const fixtures: AdapterFixture[] = [
  { label: 'original CSV Layout, Nail and Pin tables', name: 'synthetic.bv2', data: utf8(syntheticBv2()) },
  { label: 'CRLF, optional Group and quoted pin names', name: 'quoted.bv2', data: utf8(syntheticBv2({ group: false, eol: '\r\n', name: 'A, "1"' })) },
];
export default fixtures;
