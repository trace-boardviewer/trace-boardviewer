import type { AdapterFixture } from '../../fixture';

/** One part with one pin in the CDev/CPad layout (little-endian int16 values). */
function cst(): Uint8Array {
  const data: number[] = [];
  const u16 = (value: number) => data.push(value & 255, value >>> 8 & 255);
  const text = (value: string) => data.push(...new TextEncoder().encode(value));
  u16(1); data.push(0, 0, 0, 0); u16(4); text('CDev');
  data.push(2); text('U1'); data.push(0, 0, 0, 0, 12, 0, 0, 0, 0); u16(1);
  data.push(3); text('GND');
  u16(1); data.push(0, 0, 0, 0); u16(4); text('CPad');
  u16(0); u16(1); u16(0); u16(100); u16(200); u16(0); data.push(0, 0, 0, 0);
  return Uint8Array.from(data);
}

const fixtures: AdapterFixture[] = [{ label: 'CDev/CPad sections', name: 'board.cst', data: cst() }];
export default fixtures;
