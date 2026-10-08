import { describe, expect, it } from 'vitest';
import { boardFingerprint } from '../../board-fingerprint';
import { parseGenCad } from '../../gencad';
import { createRng } from './rng';
import { BENCH_PARTS_PER_PIN, boardFromBenchGencad, patchBenchGencad } from './bench-boards';
import { deriveRevision, fingerprintOf, pinSetOf } from './board-model';
import { boardWriter } from './board-writers';
import { benchGenCadForTests } from './read-back';

const benchGenCad = benchGenCadForTests();

describe('boards from the benchmark generator', () => {
  const text = benchGenCad(1500, 3);
  const board = boardFromBenchGencad(text, createRng('bench'));

  it('reads every part and pin the generator wrote', async () => {
    const parsed = parseGenCad(text, 'bench.cad');
    expect(board.parts.length).toBe(parsed.components.length);
    expect(board.parts.reduce((sum, part) => sum + part.pins.length, 0)).toBe(parsed.pins.length);
    expect(board.parts.length / 1500).toBeCloseTo(BENCH_PARTS_PER_PIN, 1);
    expect(fingerprintOf(pinSetOf(board))).toBe(await boardFingerprint(parsed));
  });

  it('gives the ICs invented part numbers, one per device, and keeps the nets', () => {
    const ics = board.parts.filter(part => part.mpn);
    expect(ics.length).toBeGreaterThan(5);
    expect(ics.every(part => part.cls === 'U' || part.cls === 'D')).toBe(true);
    expect(new Set(ics.map(part => part.mpn)).size).toBeLessThan(ics.length);
    expect(board.parts.some(part => part.pins.some(pin => pin.net === 'GND'))).toBe(true);
  });

  it('is written back as the generator text with the board number, revision and part numbers patched in', async () => {
    const written = new TextDecoder().decode(boardWriter('gencad').write(board, { boardNumber: 'LA-Z123P', revision: 'B', title: 'x', vendor: 'Alder', date: '2024-01-01', includeHeader: true, valueStyle: 'plain' }, createRng('w')));
    expect(written).toContain('DRAWING "LA-Z123P"');
    expect(written).toContain('REVISION "B"');
    expect(written).not.toContain('synthetic-1500-s3');
    const parsed = parseGenCad(written, 'patched.cad');
    expect(await boardFingerprint(parsed)).toBe(fingerprintOf(pinSetOf(board)));
    const mpn = board.parts.find(part => part.mpn)!.mpn!;
    expect(written).toContain(`VALUE ${mpn}`);
    expect(patchBenchGencad(text, null, {})).toBe(text);
  });

  it('drops the generator text from derived revisions, which are written by the model writer', () => {
    const { board: next } = deriveRevision(board, createRng('r'), 3, 1, { alphaBga: true });
    expect(next.benchText).toBeUndefined();
    const written = new TextDecoder().decode(boardWriter('gencad').write(next, { boardNumber: 'LA-Z123P', revision: 'C', title: 'x', vendor: 'Alder', date: '2024-01-01', includeHeader: true, valueStyle: 'plain' }, createRng('w')));
    expect(written).toContain('SIGNAL ');
    expect(written).toContain('REVISION "C"');
  });
});
