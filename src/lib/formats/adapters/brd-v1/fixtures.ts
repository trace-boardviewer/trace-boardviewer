import type { AdapterFixture } from '../../fixture';
const data = new Uint8Array(32);
data.set(new TextEncoder().encode('BRD_V1.0'));
data.fill(0xa5, 16);
const fixtures: AdapterFixture[] = [{ label: 'original opaque framing', name: 'synthetic.brd', data, expect: 'refused' }];
export default fixtures;
