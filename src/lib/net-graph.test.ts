import { describe, expect, it } from 'vitest';
import { buildNetGraph, padArea, valueHintFor, wordsOfText } from './net-graph';
import { expectScaling } from '../test-support/timing';
import { kitBoard, largeBoard, two } from './net-testkit';
import type { Board } from './types';

const nets = (graph: ReturnType<typeof buildNetGraph>, part: number) => [...graph.partNets(part)].map(net => graph.netName(net));

describe('buildNetGraph: connectivity arrays', () => {
  const board = kitBoard([
    { ref: 'U1', value: 'MCU', pins: ['VCC', 'GND', 'SDA', 'SCL', 'VCC', 'GND', ''] },
    two('C1', '100n', 'VCC', 'GND'),
    two('R1', '4K7', 'SDA', 'VCC'),
    two('R2', '4K7', 'SCL', 'VCC'),
    { ref: 'TP1', pins: ['SDA'] },
  ]);
  const graph = buildNetGraph(board);

  it('indexes nets, parts and pins by name and id', () => {
    expect(graph.netCount).toBe(4);
    expect(graph.partCount).toBe(5);
    expect(graph.pinCount).toBe(14);
    expect(graph.netIndex('VCC')).toBeGreaterThanOrEqual(0);
    expect(graph.netIndex('missing')).toBe(-1);
    expect(graph.netIndex('')).toBe(-1);
    expect(graph.partIndex('part:2')).toBe(2);
    expect(graph.partIndex('nope')).toBe(-1);
    expect(graph.pinIndex('pin:3')).toBe(3);
    expect(graph.netName(-1)).toBe('');
  });
  it('lists the distinct nets of a part with the pin count on each, in first-pin order', () => {
    expect(nets(graph, 0)).toEqual(['VCC', 'GND', 'SDA', 'SCL']);
    expect([...graph.partNetPinCounts(0)]).toEqual([2, 2, 1, 1]);
    expect(nets(graph, 4)).toEqual(['SDA']);
  });
  it('lists the distinct parts of a net in part order and its pins in pin order', () => {
    const vcc = graph.netIndex('VCC');
    expect([...graph.netParts(vcc)]).toEqual([0, 1, 2, 3]);
    expect(graph.netPinCount(vcc)).toBe(5);
    expect([...graph.netPins(vcc)]).toEqual([...graph.netPins(vcc)].sort((a, b) => a - b));
    expect(graph.netPins(-1).length).toBe(0);
    expect(graph.netParts(99).length).toBe(0);
  });
  it('treats an empty net name as no net', () => {
    const pin = graph.partPins(0)[6];
    expect(graph.pinNet[pin]).toBe(-1);
    expect(graph.isNoConnect(-1)).toBe(true);
  });
  it('classifies nets once for the whole board', () => {
    expect(graph.netKind(graph.netIndex('GND'))).toBe('ground');
    expect(graph.isGround(graph.netIndex('GND'))).toBe(true);
    expect(graph.netKind(graph.netIndex('VCC'))).toBe('power');
    expect(graph.netKind(graph.netIndex('SDA'))).toBe('signal');
    expect(graph.classification.groundNets).toEqual(['GND']);
  });
  it('classifies parts and values lazily and keeps the result', () => {
    expect(graph.kindOf(1).kind).toBe('capacitor');
    expect(graph.kindOf(1)).toBe(graph.kindOf(1));
    expect(graph.valueOf(1)).toMatchObject({ quantity: 'capacitance', si: 1e-7 });
    expect(graph.valueOf(1)).toBe(graph.valueOf(1));
    expect(graph.kindOf(4).kind).toBe('testpoint');
  });
  it('passes ground patterns and the fallback share to the net classes', () => {
    const custom = buildNetGraph(board, { groundPatterns: ['SCL'] });
    expect(custom.netKind(custom.netIndex('SCL'))).toBe('ground');
    expect(custom.netKind(custom.netIndex('GND'))).not.toBe('ground');
  });
  it('says whether a part is fitted: listed by the caller first, then a marker in the value', () => {
    const marked = kitBoard([two('R1', '0R', 'A', 'B'), two('R2', '10K DNP', 'A', 'C'), two('C1', '1u', 'A', 'GND')]);
    const plain = buildNetGraph(marked);
    expect([0, 1, 2].map(part => plain.notFittedBy(part))).toEqual([null, 'value', null]);
    const listed = buildNetGraph(marked, { notFitted: new Set(['part:0', 'part:1']) });
    expect([0, 1, 2].map(part => listed.notFittedBy(part))).toEqual(['listed', 'listed', null]);
    expect(listed.notFittedBy(-1)).toBeNull();
  });
  it('uses a unique schematic library id first', () => {
    const withLib = buildNetGraph(board, { libIds: new Map([['part:2', 'Device:Ferrite_Bead']]) });
    expect(withLib.kindOf(2).kind).toBe('ferrite');
  });
});

describe('buildNetGraph: inconsistent boards', () => {
  it('takes nets from the pins when the net list lacks them, and keeps the net-list order first', () => {
    const board = kitBoard([two('R1', '0R', 'A', 'B'), two('R2', '0R', 'B', 'C')]);
    const broken: Board = { ...board, nets: [{ id: 'net:x', name: 'C', pinIds: [] }, { id: 'net:y', name: 'C', pinIds: [] }] };
    const graph = buildNetGraph(broken);
    expect(graph.netNames).toEqual(['C', 'A', 'B']);
    expect(graph.netPinCount(graph.netIndex('B'))).toBe(2);
  });
  it('skips a pin whose component is missing in the part lists but keeps it on its net', () => {
    const board = kitBoard([two('R1', '0R', 'A', 'B')]);
    board.pins.push({ ...board.pins[0], id: 'pin:orphan', componentId: 'part:missing' });
    const graph = buildNetGraph(board);
    expect(graph.pinPart[graph.pinIndex('pin:orphan')]).toBe(-1);
    expect(graph.netPinCount(graph.netIndex('A'))).toBe(2);
    expect([...graph.netParts(graph.netIndex('A'))]).toEqual([0]);
  });
  it('counts a pin that names a part not listing it as that part\'s pin', () => {
    const board = kitBoard([two('R1', '0R', 'A', 'B'), two('R2', '0R', 'C', 'D')]);
    board.components[1].pinIds = [board.components[1].pinIds[0]];
    const graph = buildNetGraph(board);
    expect(graph.partPins(1).length).toBe(2);
    expect(nets(graph, 1)).toEqual(['C', 'D']);
  });
  it('ignores repeated pin ids in a part list', () => {
    const board = kitBoard([two('R1', '0R', 'A', 'B')]);
    board.components[0].pinIds = [...board.components[0].pinIds, board.components[0].pinIds[0]];
    const graph = buildNetGraph(board);
    expect(graph.partPins(0).length).toBe(2);
    expect([...graph.partNetPinCounts(0)]).toEqual([1, 1]);
  });
});

describe('helpers', () => {
  it('gives the value hint of each kind', () => {
    expect(valueHintFor('resistor')).toBe('resistance');
    expect(valueHintFor('resistor-array')).toBe('resistance');
    expect(valueHintFor('capacitor')).toBe('capacitance');
    expect(valueHintFor('inductor')).toBe('inductance');
    expect(valueHintFor('ferrite')).toBeNull();
  });
  it('computes pad areas from the pad geometry', () => {
    expect(padArea({ radius: 0, width: 2, height: 1, shape: 'rect' })).toBe(2);
    expect(padArea({ radius: 0, width: 2, height: 1, shape: 'round' })).toBeCloseTo(Math.PI / 2);
    expect(padArea({ radius: 0.5, shape: 'round' })).toBeCloseTo(Math.PI / 4);
    expect(padArea({ radius: 0, width: 1, shape: 'square' })).toBe(1);
    expect(padArea({ radius: 0, shape: 'round' })).toBeNull();
    expect(padArea({ radius: Number.NaN, shape: 'round' })).toBeNull();
  });
  it('splits text into upper-case words, bounded', () => {
    expect(wordsOfText('C_0402_1005Metric')).toEqual(['C', '0402', '1005METRIC']);
    expect(wordsOfText('')).toEqual([]);
    expect(wordsOfText(undefined)).toEqual([]);
    expect(wordsOfText('a'.repeat(10_000)).join('').length).toBe(160);
  });
});

describe('buildNetGraph: size', () => {
  it('builds the graph of a 100k-pin board in linear time', () => {
    expect(buildNetGraph(largeBoard(100_000)).pinCount).toBeGreaterThanOrEqual(100_000);
    expectScaling('buildNetGraph', [10_000, 40_000, 160_000], size => { const board = largeBoard(size); return () => buildNetGraph(board); });
  }, 60_000);
});
