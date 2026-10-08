import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBoard } from './formats';
import { MAX_IMPORT_BYTES } from './formats/common';
import { GENCAD_LIMITS } from './gencad';

/** The synthetic board generator behind the performance benchmark (scripts/gen-synthetic-board.cjs, plain Node). */
interface Summary {
  generator: string; version: number; seed: number; requestedPins: number;
  pins: number; components: number; nets: number; connectedPins: number; noConnectPins: number;
  kinds: Record<string, { components: number; pins: number }>;
  sides: { topComponents: number; bottomComponents: number; topPins: number; bottomPins: number; throughHolePins: number };
  netStats: { gndPins: number; gndShare: number; railNets: number; railPins: number; railShare: number; signalNets: number; signalPins: number; largestSignalNet: number; sizeHistogram: Record<string, number>; largestRail: { name: string; pins: number } };
  board: { widthMm: number; heightMm: number; pinsPerMm2: number };
  geometryPoints: number; lines: number; bytes: number; chunks: number; largestChunk: number;
  probe: { gnd: string; rail: string; search: string; component: string; bga: { ref: string; pins: number; side: string; x: number; y: number } | null };
}
interface Generator {
  LIMITS: { components: number; pins: number; geometryPoints: number; lines: number; bytes: number };
  SIZES: Record<string, number>;
  parseSize(text: string): number;
  generateGenCad(options: { pins: number | string; seed?: number }, sink: { write(text: string): void }): Summary;
  writeGenCadFile(file: string, options: { pins: number | string; seed?: number }): Summary;
  ensureBoard(dir: string, options: { pins: number | string; seed?: number }): { file: string; summary: Summary; reused: boolean };
}
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gen-synthetic-board.cjs');
const gen = createRequire(import.meta.url)(SCRIPT) as Generator;

function generate(pins: number | string, seed = 1): { text: string; summary: Summary } {
  const chunks: string[] = [];
  const summary = gen.generateGenCad({ pins, seed }, { write: text => { chunks.push(text); } });
  return { text: chunks.join(''), summary };
}
function digestOf(pins: number | string, seed = 1): string {
  const hash = createHash('sha256');
  gen.generateGenCad({ pins, seed }, { write: text => { hash.update(text); } });
  return hash.digest('hex');
}
const open = (text: string, name = 'synthetic.cad') => parseBoard({ name, data: new TextEncoder().encode(text) });

describe('synthetic board generator: sizes and limits', () => {
  it('names the five benchmark sizes', () => {
    expect(gen.SIZES).toEqual({ '10k': 10_000, '50k': 50_000, '100k': 100_000, '250k': 250_000, '1m': 1_000_000 });
  });

  it('reads pin counts with k and m suffixes and refuses anything else', () => {
    expect(gen.parseSize('10k')).toBe(10_000);
    expect(gen.parseSize('250K')).toBe(250_000);
    expect(gen.parseSize('1m')).toBe(1_000_000);
    expect(gen.parseSize('1.5k')).toBe(1500);
    expect(gen.parseSize('12345')).toBe(12_345);
    for (const bad of ['', 'abc', '1', '-5', '1000001', '2m', '10kk', '0x10']) expect(() => gen.parseSize(bad), bad).toThrow(RangeError);
    expect(() => gen.generateGenCad({ pins: 1 }, { write: () => {} })).toThrow(RangeError);
    expect(() => gen.generateGenCad({ pins: 1_000_001 }, { write: () => {} })).toThrow(RangeError);
  });

  it('keeps its copy of the adapter limits equal to the adapter', () => {
    expect(gen.LIMITS).toEqual({ components: GENCAD_LIMITS.components, pins: GENCAD_LIMITS.pins, geometryPoints: GENCAD_LIMITS.geometryPoints, lines: GENCAD_LIMITS.lines, bytes: MAX_IMPORT_BYTES });
  });
});

describe('synthetic board generator: determinism', () => {
  it('writes identical bytes for the same seed and pin count, whatever the sink', () => {
    const a = generate(10_000, 7), b = generate(10_000, 7);
    expect(a.text).toBe(b.text);
    expect(a.summary).toEqual(b.summary);
    expect(digestOf(10_000, 7)).toBe(createHash('sha256').update(a.text).digest('hex'));
  });

  it('writes different boards for a different seed or a different size', () => {
    const base = digestOf(10_000, 1);
    expect(digestOf(10_000, 2)).not.toBe(base);
    expect(digestOf(10_001, 1)).not.toBe(base);
    expect(digestOf(10_000, 0)).not.toBe(digestOf(10_000, 1));
  });

  // Pinned on purpose: a change of the generator changes every baseline measured with it, so it must be a visible decision.
  // Update the digest together with GENERATOR_VERSION when the generator's output is changed deliberately.
  it('writes the pinned bytes for 2,000 pins, seed 1', () => {
    expect(digestOf(2_000, 1)).toBe('30946f71d0e392757fcce742ddeee3fde28448ffc3cc6e1cf5b208357ab4a02a');
  });

  it('writes the same bytes through the file writer, and ensureBoard reuses a finished board only for its own seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-board-'));
    try {
      const file = join(dir, 'board.cad');
      const summary = gen.writeGenCadFile(file, { pins: 3_000, seed: 3 });
      const expected = generate(3_000, 3);
      expect(readFileSync(file, 'latin1')).toBe(expected.text);
      expect(statSync(file).size).toBe(summary.bytes);
      const first = gen.ensureBoard(dir, { pins: 3_000, seed: 3 });
      expect(first.reused).toBe(false);
      expect(gen.ensureBoard(dir, { pins: 3_000, seed: 3 }).reused).toBe(true);
      expect(gen.ensureBoard(dir, { pins: 3_000, seed: 4 }).reused).toBe(false);
      writeFileSync(first.file, 'damaged');
      expect(gen.ensureBoard(dir, { pins: 3_000, seed: 3 }).reused).toBe(false);
      expect(readFileSync(first.file, 'latin1')).toBe(expected.text);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('runs from the command line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-board-'));
    try {
      const out = join(dir, 'cli.cad');
      const log = execFileSync(process.execPath, [SCRIPT, '--pins=1500', '--seed=5', `--out=${out}`], { encoding: 'utf8' });
      expect(log).toContain('1500 pins');
      expect(readFileSync(out, 'latin1')).toBe(generate(1_500, 5).text);
      expect(() => execFileSync(process.execPath, [SCRIPT, '--pins=7', '--seed=x', `--out=${out}`], { stdio: 'pipe' })).toThrow();
      expect(() => execFileSync(process.execPath, [SCRIPT, '--pins=2m', `--out=${out}`], { stdio: 'pipe' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('synthetic board generator: counts through the real GenCAD adapter', () => {
  const sizes = [2, 3, 5, 17, 64, 100, 999, 1_000, 10_000, 50_000];
  it.each(sizes)('opens a %i pin board with exactly that many pins and the counts of its summary', pins => {
    const { text, summary } = generate(pins);
    const board = open(text);
    expect(board.format).toBe('GENCAD 1.4');
    expect(board.warnings).toEqual([]);
    expect(summary.pins).toBe(pins);
    expect(board.pins).toHaveLength(pins);
    expect(board.components).toHaveLength(summary.components);
    expect(board.nets).toHaveLength(summary.nets);
    expect(board.pins.filter(pin => pin.net).length).toBe(summary.connectedPins);
    expect(board.pins.filter(pin => !pin.net).length).toBe(summary.noConnectPins);
    expect(new Set(board.components.map(component => component.ref)).size).toBe(board.components.length);
    expect(Math.max(...board.nets.map(net => net.pinIds.length))).toBe(Math.max(1, board.nets.find(net => net.name === 'GND')?.pinIds.length ?? 0));
  });

  it('opens the 100,000 pin benchmark board with its summary counts and sides', () => {
    const { text, summary } = generate('100k');
    const board = open(text);
    expect(board.warnings).toEqual([]);
    expect(board.pins).toHaveLength(100_000);
    expect(board.components).toHaveLength(summary.components);
    expect(board.nets).toHaveLength(summary.nets);
    const bySide = (side: string) => board.pins.filter(pin => pin.side === side).length;
    expect(bySide('top')).toBe(summary.sides.topPins);
    expect(bySide('bottom')).toBe(summary.sides.bottomPins);
    expect(bySide('both')).toBe(summary.sides.throughHolePins);
    expect(board.components.filter(component => component.side === 'bottom')).toHaveLength(summary.sides.bottomComponents);
    expect(board.nets.find(net => net.name === summary.probe.gnd)?.pinIds).toHaveLength(summary.netStats.gndPins);
    expect(board.nets.find(net => net.name === summary.probe.rail)?.pinIds).toHaveLength(summary.netStats.largestRail.pins);
    expect(board.components.some(component => component.ref === summary.probe.search)).toBe(true);
    expect(board.components.some(component => component.ref === summary.probe.component)).toBe(true);
    // The benchmark zooms to the largest top-side BGA by its coordinates.
    const bga = board.components.find(component => component.ref === summary.probe.bga?.ref);
    expect(summary.probe.bga).toMatchObject({ side: 'top', pins: 2_500 });
    expect(bga?.side).toBe('top');
    expect(bga?.pinIds).toHaveLength(2_500);
    expect(bga?.position.x).toBeCloseTo(summary.probe.bga!.x, 1);
    expect(bga?.position.y).toBeCloseTo(summary.probe.bga!.y, 1);
    const width = board.bounds.maxX - board.bounds.minX, height = board.bounds.maxY - board.bounds.minY;
    expect(width).toBeCloseTo(summary.board.widthMm, 2);
    expect(height).toBeCloseTo(summary.board.heightMm, 2);
    // Every pad lies on the board.
    expect(board.pins.every(pin => pin.x > 0 && pin.x < width && pin.y > 0 && pin.y < height)).toBe(true);
  });
});

describe('synthetic board generator: a realistic mix', () => {
  it.each([10_000, 50_000, 100_000, 250_000])('has a large ground net, rails, small signal nets and part kinds at %i pins', pins => {
    const { summary } = generate(pins);
    const { netStats: nets } = summary;
    expect(nets.gndShare).toBeGreaterThan(0.26);
    expect(nets.gndShare).toBeLessThan(0.34);
    expect(nets.railShare).toBeGreaterThan(0.08);
    expect(nets.railShare).toBeLessThan(0.22);
    expect(nets.gndPins).toBeGreaterThan(nets.railPins);
    expect(nets.largestRail.pins).toBeGreaterThan(nets.railPins / nets.railNets);
    expect(nets.railNets).toBeGreaterThanOrEqual(10);
    expect(nets.railNets).toBeLessThanOrEqual(80);
    expect(summary.noConnectPins / pins).toBeLessThan(0.06);
    expect(summary.noConnectPins / pins).toBeGreaterThan(0.005);
    // Signal nets: mostly 2 to 5 pins, a few buses, nothing alone.
    const histogram = nets.sizeHistogram;
    const small = histogram['2'] + histogram['3'] + histogram['4'] + histogram['5'];
    expect(small / nets.signalNets).toBeGreaterThan(0.9);
    expect(histogram['2']).toBeGreaterThan(histogram['3']);
    expect(histogram['3']).toBeGreaterThan(histogram['4']);
    expect(nets.largestSignalNet).toBeLessThanOrEqual(16);
    expect(summary.nets).toBe(1 + nets.railNets + nets.signalNets);
    expect(summary.nets).toBeGreaterThan(pins / 10);
    expect(summary.nets).toBeLessThan(pins / 3);
    // Parts: passives dominate the part count, BGAs and connectors exist, both sides are used.
    const { kinds, sides } = summary;
    expect(kinds.passive.components).toBeGreaterThan(0.8 * summary.components);
    expect(kinds.bga.components).toBeGreaterThan(0);
    expect(kinds.bga.pins / pins).toBeGreaterThan(0.3);
    expect(kinds.connector.components).toBeGreaterThan(0);
    expect(kinds.ic.components).toBeGreaterThan(0);
    expect(sides.bottomPins / pins).toBeGreaterThan(0.1);
    expect(sides.topPins / pins).toBeGreaterThan(0.3);
    expect(sides.throughHolePins).toBeGreaterThan(0);
    expect(summary.probe.bga?.pins).toBeGreaterThanOrEqual(pins >= 100_000 ? 2_000 : 64);
    expect(Object.values(kinds).reduce((sum, kind) => sum + kind.pins, 0)).toBe(pins);
  });

  it('keeps every size within what the GenCAD adapter imports', () => {
    for (const pins of [10_000, 250_000]) {
      const { summary } = generate(pins);
      expect(summary.components).toBeLessThanOrEqual(GENCAD_LIMITS.components);
      expect(summary.geometryPoints).toBeLessThanOrEqual(GENCAD_LIMITS.geometryPoints);
      expect(summary.lines).toBeLessThanOrEqual(GENCAD_LIMITS.lines);
      expect(summary.bytes).toBeLessThan(MAX_IMPORT_BYTES);
    }
  });
});

describe('synthetic board generator: one million pins', () => {
  it('streams a board of the adapter limit in bounded chunks and bounded memory', () => {
    const hash = createHash('sha256');
    const chunkSizes: number[] = [];
    let lines = 0, components = 0, nodes = 0, total = 0, last = '';
    const before = process.memoryUsage();
    const baseline = before.heapUsed + before.arrayBuffers + before.external;
    let peak = 0;
    const summary = gen.generateGenCad({ pins: 1_000_000, seed: 1 }, {
      write(text) {
        chunkSizes.push(text.length); total += text.length;
        hash.update(text);
        for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++;
        for (let at = text.indexOf('COMPONENT '); at >= 0; at = text.indexOf('COMPONENT ', at + 1)) if (at === 0 || text[at - 1] === '\n') components++;
        for (let at = text.indexOf('NODE '); at >= 0; at = text.indexOf('NODE ', at + 1)) if (at === 0 || text[at - 1] === '\n') nodes++;
        last = text;
        const usage = process.memoryUsage();
        peak = Math.max(peak, usage.heapUsed + usage.arrayBuffers + usage.external - baseline);
      },
    });
    expect(summary.pins).toBe(1_000_000);
    expect(total).toBe(summary.bytes);
    expect(lines).toBe(summary.lines);
    expect(components).toBe(summary.components);
    expect(nodes).toBe(summary.connectedPins);
    expect(last.endsWith('$ENDSIGNALS\n')).toBe(true);
    // Streaming: dozens of chunks, none above 1 MiB (the whole board is about 38 MiB).
    expect(chunkSizes.length).toBeGreaterThan(30);
    expect(Math.max(...chunkSizes)).toBeLessThan(1 << 20);
    expect(summary.largestChunk).toBe(Math.max(...chunkSizes));
    // Memory: a few typed arrays and one small record per module, not the text and not an object per pin (which alone would be over 300 MiB).
    expect(peak).toBeLessThan(256 * 1024 * 1024);
    // Inside the adapter's limits, so the app opens it.
    expect(summary.components).toBeLessThanOrEqual(GENCAD_LIMITS.components);
    expect(summary.geometryPoints).toBeLessThanOrEqual(GENCAD_LIMITS.geometryPoints);
    expect(summary.lines).toBeLessThanOrEqual(GENCAD_LIMITS.lines);
    expect(summary.bytes).toBeLessThan(MAX_IMPORT_BYTES);
    expect(summary.netStats.gndShare).toBeGreaterThan(0.26);
    expect(summary.netStats.gndShare).toBeLessThan(0.34);
    // The same bytes again.
    const again = createHash('sha256');
    gen.generateGenCad({ pins: 1_000_000, seed: 1 }, { write: text => { again.update(text); } });
    expect(again.digest('hex')).toBe(hash.digest('hex'));
  }, 120_000);
});
