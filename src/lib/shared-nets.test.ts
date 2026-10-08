import { describe, expect, it } from 'vitest';
import { buildNetGraph } from './net-graph';
import { expectBoundedWork } from '../test-support/timing';
import { kitBoard, largeBoard, seeded, two, type KitPart } from './net-testkit';
import { MAX_SHARED_PARTS, sharedNets } from './shared-nets';
import type { Board } from './types';

const rows = (list: ReadonlyArray<{ net: string; members: ReadonlyArray<{ ref: string; pins: readonly string[] }> }>) =>
  list.map(row => `${row.net}: ${row.members.map(member => `${member.ref}[${member.pins.join(',')}]`).join(' ')}`);

describe('sharedNets: fixtures', () => {
  const parts: KitPart[] = [
    { ref: 'U1', pins: ['VCC', 'GND', 'SDA', 'SCL', 'INT', 'VCC', 'NC'] },
    { ref: 'U2', pins: ['VCC', 'GND', 'SDA', 'SCL', 'NC'] },
    { ref: 'J1', pins: ['VCC', 'GND', 'SDA', 'SCL', 'INT'] },
    two('R1', '4K7', 'SDA', 'VCC'), two('R2', '4K7', 'SCL', 'VCC'),
    two('C1', '100n', 'VCC', 'GND'),
  ];
  const graph = buildNetGraph(kitBoard(parts));
  const id = (ref: string) => graph.component(parts.findIndex(part => part.ref === ref)).id;

  it('lists the nets common to all parts, then those shared by some, with each part\'s pins', () => {
    const result = sharedNets(graph, [id('U1'), id('U2'), id('J1')]);
    expect(result.parts.map(part => part.ref)).toEqual(['U1', 'U2', 'J1']);
    expect(rows(result.common)).toEqual(['SCL: U1[4] U2[4] J1[4]', 'SDA: U1[3] U2[3] J1[3]', 'VCC: U1[1,6] U2[1] J1[1]']);
    expect(rows(result.pairwise)).toEqual(['INT: U1[5] J1[5]']);
    expect(result.hiddenGround).toEqual(['GND']);
    // Diagonal: listed nets of each part; off-diagonal: listed nets shared.
    expect(result.matrix).toEqual([[4, 3, 4], [3, 3, 3], [4, 3, 4]]);
  });
  it('shows ground on request and never no-connect nets', () => {
    const result = sharedNets(graph, [id('U1'), id('U2')], { includeGround: true });
    expect(result.common.map(row => row.net)).toEqual(['GND', 'SCL', 'SDA', 'VCC']);
    expect(result.common.find(row => row.net === 'GND')!.kind).toBe('ground');
    expect(result.hiddenGround).toEqual([]);
    expect([...result.common, ...result.pairwise].some(row => row.net === 'NC')).toBe(false);
  });
  it('orders pairwise rows by the number of parts sharing them, then by name', () => {
    const result = sharedNets(graph, [id('U1'), id('R1'), id('R2'), id('C1')]);
    expect(result.common.map(row => row.net)).toEqual(['VCC']);
    expect(result.pairwise.map(row => [row.net, row.members.length])).toEqual([['SCL', 2], ['SDA', 2]]);
  });
  it('reports unknown ids and drops duplicates', () => {
    const result = sharedNets(graph, [id('U1'), 'nope', id('U1'), 'nope', id('U2')]);
    expect(result.parts.map(part => part.ref)).toEqual(['U1', 'U2']);
    expect(result.unknown).toEqual(['nope']);
    expect(result.truncated).toBe(false);
  });
  it('reports a long list of repeated unknown ids once each, without comparing every pair', () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `missing:${i % 5000}`);
    const result = sharedNets(graph, [id('U1'), ...ids, id('U2')]);
    expect(result.unknown.length).toBe(5000);
    expect(result.unknown[0]).toBe('missing:0');
    expect(result.parts.map(part => part.ref)).toEqual(['U1', 'U2']);
  });
  it('gives no common nets for a single part, only its listed net count', () => {
    const result = sharedNets(graph, [id('U1')]);
    expect(result.common).toEqual([]);
    expect(result.pairwise).toEqual([]);
    expect(result.matrix).toEqual([[4]]);
    expect(sharedNets(graph, []).parts).toEqual([]);
  });
  it('takes at most 64 parts', () => {
    // GND by name, so the largest-net fallback does not make BUS ground.
    const many: KitPart[] = [...Array.from({ length: 70 }, (_, i) => two(`R${i}`, '1k', 'BUS', `N${i}`)), two('C0', '1u', 'N0', 'GND')];
    const big = buildNetGraph(kitBoard(many));
    const result = sharedNets(big, big.board.components.map(component => component.id));
    expect(result.parts.length).toBe(MAX_SHARED_PARTS);
    expect(result.truncated).toBe(true);
    expect(result.common.map(row => row.net)).toEqual(['BUS']);
  });
});

/** Reference: scans every pin of the board for every chosen part and net. */
function referenceShared(board: Board, ids: readonly string[], kindOf: (net: string) => string, includeGround: boolean) {
  const netsOf = (id: string) => new Set(board.pins.filter(pin => pin.componentId === id && pin.net !== '' && kindOf(pin.net) !== 'no-connect').map(pin => pin.net));
  const sets = ids.map(netsOf);
  const names = new Set(sets.flatMap(set => [...set]));
  const common: string[] = [], pairwise: string[] = [], hidden: string[] = [];
  for (const net of names) {
    const holders = sets.filter(set => set.has(net)).length;
    if (kindOf(net) === 'ground' && !includeGround) { if (holders >= 2) hidden.push(net); continue; }
    if (holders < 2) continue;
    (holders === ids.length ? common : pairwise).push(net);
  }
  const listed = (net: string) => includeGround || kindOf(net) !== 'ground';
  const matrix = sets.map(a => sets.map(b => [...a].filter(net => b.has(net) && listed(net)).length));
  return { common: common.sort(), pairwise: pairwise.sort(), hidden: hidden.sort(), matrix };
}

describe('sharedNets: equals a brute-force reference on 300 random boards', () => {
  it('gives the same common, pairwise and hidden ground nets, pin lists and matrix', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      const nets = ['GND', 'NC', 'VCC', ...Array.from({ length: 3 + Math.floor(random() * 8) }, (_, i) => `S${i}`)];
      const parts: KitPart[] = Array.from({ length: 3 + Math.floor(random() * 10) }, (_, i) => ({
        ref: `U${i}`, pins: Array.from({ length: 1 + Math.floor(random() * 6) }, () => nets[Math.floor(random() * nets.length)]),
      }));
      const board = kitBoard(parts);
      const graph = buildNetGraph(board);
      const chosen = board.components.filter(() => random() < 0.6).map(component => component.id);
      const includeGround = random() < 0.3;
      const result = sharedNets(graph, chosen, { includeGround });
      const reference = referenceShared(board, chosen, net => graph.netKind(graph.netIndex(net)), includeGround);
      const message = `seed ${seed}`;
      expect(result.common.map(row => row.net).sort(), message).toEqual(chosen.length >= 2 ? reference.common : []);
      expect(result.pairwise.map(row => row.net).sort(), message).toEqual(reference.pairwise);
      expect(result.hiddenGround, message).toEqual(reference.hidden);
      expect(result.matrix, message).toEqual(reference.matrix);
      for (const row of [...result.common, ...result.pairwise]) {
        for (const member of row.members) {
          const pins = board.pins.filter(pin => pin.componentId === member.componentId && pin.net === row.net).map(pin => pin.number);
          expect(member.pins, message).toEqual([...new Set(pins)].sort((a, b) => Number(a) - Number(b)));
        }
      }
    }
  });
});

describe('sharedNets: cost', () => {
  /** The 20 400-pin ICs and 44 two-pin parts of a large synthetic board. */
  const sixtyFour = (board: Board) => board.components.filter(component => component.pinIds.length > 2).map(component => component.id).concat(board.components.slice(100, 144).map(component => component.id));
  it('answers for 64 parts of a 100k-pin board', () => {
    const board = largeBoard(100_000);
    const result = sharedNets(buildNetGraph(board), sixtyFour(board));
    expect(result.parts.length).toBe(64);
    expect(result.hiddenGround).toEqual(['GND']);
  });
  it('costs the same whatever the size of the board: only the chosen parts are read', () => {
    expectBoundedWork('sharedNets, 64 parts', [12_500, 50_000, 200_000], size => {
      const board = largeBoard(size), graph = buildNetGraph(board), ids = sixtyFour(board);
      return () => sharedNets(graph, ids);
    });
  }, 60_000);
});
