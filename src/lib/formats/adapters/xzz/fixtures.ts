import type { AdapterFixture } from '../../fixture';

const encode = (text: string) => [...new TextEncoder().encode(text)];
const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
const zeros = (count: number) => Array<number>(count).fill(0);
const block = (type: number, payload: number[]) => [type, ...u32(payload.length), ...payload];
function pin(name: string, x: number, y: number, net: number): number[] {
  const body = [...zeros(4), ...u32(x), ...u32(y), ...zeros(8), ...u32(name.length), ...encode(name), ...zeros(32), ...u32(net)];
  return [0x09, ...u32(body.length), ...body];
}
function part(name: string, group: string, pins: number[][]): number[] {
  const label = [0x06, ...u32(26 + 4 + name.length), ...zeros(26), ...u32(name.length), ...encode(name)];
  const body = [...zeros(18), ...u32(group.length), ...encode(group), ...label, ...pins.flat()];
  return [...u32(body.length), ...body];
}
const line = (x1: number, y1: number, x2: number, y2: number) => block(0x05, [...u32(28), ...u32(x1), ...u32(y1), ...u32(x2), ...u32(y2), ...u32(10000), ...u32(0)]);
/** A plain (or XOR-obfuscated) XZZPCB file with an outline on layer 28 and one part of two pins. */
function xzz(xor = 0): Uint8Array {
  const main = [
    line(0, 0, 40_000_000, 0), line(40_000_000, 0, 40_000_000, 30_000_000), line(40_000_000, 30_000_000, 0, 30_000_000), line(0, 30_000_000, 0, 0),
    block(0x07, part('U1', 'IC', [pin('1', 1_000_000, 2_000_000, 1), pin('2', 1_500_000, 2_000_000, 2)])),
  ].flat();
  const nets: Array<[number, string]> = [[1, 'GND'], [2, 'VCC']];
  const net = nets.flatMap(([index, name]) => [...u32(8 + name.length), ...u32(index), ...encode(name)]);
  const mainStart = 0x30, netStart = mainStart + 4 + main.length;
  const header = [...encode('XZZPCB'), ...zeros(mainStart - 6)];
  header.splice(0x20, 4, ...u32(mainStart - 0x20)); header.splice(0x28, 4, ...u32(netStart - 0x20));
  const trailer = [...encode('v6v6555v6v6'), 1, 2, 3];
  const data = Uint8Array.from([...header, ...u32(main.length), ...main, ...u32(net.length), ...net, ...trailer]);
  if (xor) for (let index = 0; index < data.length - trailer.length; index++) data[index] ^= xor;
  return data;
}

const fixtures: AdapterFixture[] = [
  { label: 'plain XZZPCB header', name: 'board.pcb', data: xzz() },
  { label: 'XOR-obfuscated header', name: 'board.pcb', data: xzz(0x5a) },
];
export default fixtures;
