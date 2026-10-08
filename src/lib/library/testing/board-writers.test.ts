import { describe, expect, it } from 'vitest';
import { boardFingerprint } from '../../board-fingerprint';
import type { Board } from '../../types';
import { parseGenCad } from '../../gencad';
import { parseBvr } from '../../formats/bvr';
import { parseBrd } from '../../formats/brd';
import { parseKicad } from '../../formats/kicad';
import { parseIpc356 } from '../../formats/ipc356';
import { parsePinList } from '../../formats/pinlist-csv';
import { createRng } from './rng';
import { deriveRevision, fingerprintOf, generateBoard, jaccard, pinSetOf, pinSetSize } from './board-model';
import type { BoardMeta } from './board-writers';
import { boardWriters } from './board-writers';

const meta: BoardMeta = { boardNumber: 'LA-Z123P', revision: 'B', title: 'Alder Heron 14 mainboard', vendor: 'Alder', date: '2024-03-01', includeHeader: true, valueStyle: 'plain' };

function parseWith(id: string, data: Uint8Array): Board {
  const input = { name: `synthetic.${id}`, data };
  const text = new TextDecoder().decode(data);
  const board = id === 'gencad' ? parseGenCad(text, 'synthetic.cad')
    : id === 'bvr' ? parseBvr(input)
      : id === 'brd2' ? parseBrd(input)
        : id === 'kicad' ? parseKicad(input)
          : id === 'ipc356' ? parseIpc356(input)
            : parsePinList(input);
  if (!board) throw new Error(`the ${id} file was not recognized`);
  return board;
}

describe('board model', () => {
  const spec = { parts: 150, refScheme: 'gapped', railStyle: 'pp', alphaBga: true } as const;
  it('is deterministic and keeps references unique', () => {
    const a = generateBoard(createRng('m1'), spec), b = generateBoard(createRng('m1'), spec), c = generateBoard(createRng('m2'), spec);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(new Set(a.parts.map(part => part.ref)).size).toBe(a.parts.length);
    expect(a.parts.length).toBeGreaterThan(120);
    expect(a.parts.every(part => part.ref.length <= 6 && part.pins.length >= 1)).toBe(true);
  });
  it('derives a revision that changes a few percent of the parts and keeps most of the pin set', () => {
    const base = generateBoard(createRng('rev'), spec);
    const { board, change } = deriveRevision(base, createRng('rev/1'), 5, 2, spec);
    expect(change.valueChanges + change.removed + change.added).toBeGreaterThan(0);
    expect(change.valueChanges + change.removed + change.added).toBeLessThanOrEqual(Math.ceil(base.parts.length * 0.08) + 2);
    expect(jaccard(pinSetOf(base), pinSetOf(board))).toBeGreaterThan(0.9);
    expect(change.renamedNets).toBeGreaterThan(0);
  });
});

describe.each(boardWriters().map(writer => [writer.id, writer] as const))('%s writer', (id, writer) => {
  const board = generateBoard(createRng('writers'), { parts: 140, refScheme: 'gapped', railStyle: 'plus', alphaBga: true });
  const data = writer.write(board, meta, createRng('w'));
  it('writes bytes that the reader parses with every part and pin', () => {
    const parsed = parseWith(id, data);
    expect(parsed.components.length).toBe(board.parts.length);
    expect(parsed.pins.length).toBe(board.parts.reduce((sum, part) => sum + part.pins.length, 0));
    expect(parsed.warnings.filter(issue => issue.key !== 'parse.warning.formatNote' && issue.key !== 'parse.warning.fallbackPads' && issue.key !== 'parse.warning.approximatedPads' && issue.key !== 'parse.warning.fallbackComponents' && issue.key !== 'parse.warning.missingBoardOutline')).toEqual([]);
  });
  it('gives the reader the fingerprint the generator computed', async () => {
    const parsed = parseWith(id, data);
    expect(await boardFingerprint(parsed)).toBe(fingerprintOf(pinSetOf(board, writer.numbering)));
    expect(pinSetSize(pinSetOf(board, writer.numbering))).toBeGreaterThan(100);
  });
  it('is deterministic', () => {
    expect(Buffer.from(writer.write(board, meta, createRng('w'))).equals(Buffer.from(data))).toBe(true);
  });
});
