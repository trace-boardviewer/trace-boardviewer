import type { AdapterFixture } from '../../fixture';
import { makeF2b } from '../../f2b-fixture';
const unsupported = makeF2b().data;
new DataView(unsupported.buffer).setUint32(0, 13, true);
export default [
  { label: 'native archive 6', name: 'synthetic.f2b', data: makeF2b({ version: 6 }).data },
  { label: 'native archive 8', name: 'synthetic.f2b', data: makeF2b({ bottom: true }).data },
  { label: 'newer archive layout', name: 'synthetic.f2b', data: unsupported, expect: 'refused' },
] satisfies AdapterFixture[];
