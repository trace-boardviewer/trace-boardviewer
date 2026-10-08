import { syntheticBv } from '../../bv-fixtures';
import type { AdapterFixture } from '../../fixture';

const fixtures: AdapterFixture[] = [
  { label: 'original Jet4 tables with a named bottom test point', name: 'synthetic.bv', data: syntheticBv() },
  { label: 'original Jet4 compressed Unicode and indirect usage maps', name: 'compressed.bv', data: syntheticBv({ compressedText: true, indirectMap: true }) },
  { label: 'original Jet3 tables without the optional Group column', name: 'jet3.bv', data: syntheticBv({ jet3: true, group: false }) },
];
export default fixtures;
