import { lines, type AdapterFixture } from '../../fixture';

const header = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `; ${tag} header ${index + 1}`);
const TRIO: Readonly<Record<string, Uint8Array>> = {
  'format.asc': lines([...header(8, 'format'), '0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000']),
  'pins.asc': lines([...header(8, 'pins'), 'Part U1 (T)', '1  1  0.100 0.200  1  VCC  5']),
  'nails.asc': lines(header(7, 'nails')),
};
const others = (entry: string) => Object.fromEntries(Object.entries(TRIO).filter(([name]) => name !== entry));

const fixtures: AdapterFixture[] = Object.keys(TRIO).map(entry => ({ label: `the trio opened through ${entry}`, name: entry, data: TRIO[entry], companions: others(entry) }));
export default fixtures;
