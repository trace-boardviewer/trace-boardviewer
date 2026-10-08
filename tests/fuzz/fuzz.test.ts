/**
 * Short, deterministic fuzz run of every parser, recognizer and low-level reader (part of the normal test run, a few seconds).
 *
 * Every target gets the same inputs on every machine: its own seeds, each cut at every 1/64 of its length, and a fixed number of
 * mutated, spliced, random and token-soup inputs derived from the seed `ci-1`. A finding fails the test with the iteration to replay:
 *
 *   FUZZ_TARGET=board:kicad FUZZ_ITERATION=57 pnpm test tests/fuzz        (prints the input and the finding)
 *
 * More inputs: FUZZ_ITERATIONS=5000 pnpm test tests/fuzz, another seed: FUZZ_SEED=abc. Hangs and out-of-memory crashes cannot be
 * reported from inside a test; the runner `pnpm fuzz` (scripts/fuzz-parsers.cjs) watches for those, runs the long mode and saves
 * minimized crashing inputs as regression fixtures (docs/FUZZING.md).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BOARD_ADAPTERS } from '../../src/lib/formats';
import type { FuzzInput } from './corpus';
import { buildPool, CI_CONFIG, generate, runCase, runCaseConfirmed, sweepInput, sweepSize } from './engine';
import type { FuzzConfig } from './engine';
import { loadSeeds } from './seeds';
import { ALL_TARGETS } from './targets';

/** The test run allows four times the time budget of the runner: it shares the machine with the rest of the suite, and a hang or a quadratic reader still shows (the runner, at scale 1, is the strict check). */
const TEST_TIME_SCALE = 4;
const config: FuzzConfig = { ...CI_CONFIG, seed: process.env.FUZZ_SEED ?? CI_CONFIG.seed, timeScale: Number(process.env.FUZZ_TIME_SCALE) || TEST_TIME_SCALE };
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 150;
const ONLY = process.env.FUZZ_TARGET;
const REPLAY = process.env.FUZZ_ITERATION === undefined ? undefined : Number(process.env.FUZZ_ITERATION);
vi.setConfig({ testTimeout: Math.max(120_000, ITERATIONS * 40) });

const corpus = loadSeeds(fileURLToPath(new URL('./corpus/', import.meta.url)));
const targets = ALL_TARGETS().filter(target => !ONLY || target.id === ONLY);

const describeFailure = (target: string, how: string, message: string, input: FuzzInput) =>
  `${target} ${how}: ${message} [${input.name}, ${input.data.length} bytes, first bytes ${Buffer.from(input.data.subarray(0, 48)).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}]`;

describe('the corpus', () => {
  it('is made of seeds that their adapter still reads', () => {
    const all = new Map(ALL_TARGETS().map(target => [target.id, target]));
    let read = 0;
    for (const seed of corpus.filter(entry => entry.kind === 'valid')) {
      const target = all.get(`${seed.adapter.endsWith('-sch') ? 'schematic' : 'board'}:${seed.adapter}`);
      if (!target) continue;
      const result = runCase(target, seed.input, config);
      expect(result.finding, `${seed.adapter} ${seed.id}`).toBeUndefined();
      expect(result.outcome, `${seed.adapter} ${seed.id}`).toBe('output');
      read++;
    }
    expect(read).toBeGreaterThan(80);
  });

  it('has seeds for every registered parser, sniff and container, except the formats that are never detected by their bytes', () => {
    const adapters = new Set(corpus.map(seed => seed.adapter));
    const undetected = new Set(BOARD_ADAPTERS.filter(adapter => adapter.detection === 'none').map(adapter => adapter.id));
    for (const target of targets.filter(entry => (entry.family !== 'util' || /^(sniff|container):/.test(entry.id)) && !entry.id.endsWith(':dispatch') && !entry.id.endsWith(':design'))) {
      if (target.seeds.every(adapter => undetected.has(adapter))) continue;
      expect(target.seeds.some(adapter => adapters.has(adapter)), `no seed for ${target.id}: add samples to src/lib/formats/adapters/${target.seeds[0]}/fixtures.ts or a file tests/fuzz/corpus/${target.seeds[0]}.json (docs/FUZZING.md, "Seed corpus")`).toBe(true);
    }
  });
});

describe('parser fuzzing: a fixed, short run per target', () => {
  for (const target of targets) {
    it(target.id, () => {
      const pool = buildPool(target, corpus);
      const found: string[] = [];
      const report = (how: string, input: FuzzInput, message: string) => { if (found.length < 5) found.push(describeFailure(target.id, how, message, input)); };
      if (REPLAY !== undefined) {
        const input = generate(target, pool, config, REPLAY);
        const result = runCase(target, input, config);
        console.log(JSON.stringify({ target: target.id, iteration: REPLAY, outcome: result.outcome, finding: result.finding, name: input.name, bytes: input.data.length, head: Buffer.from(input.data.subarray(0, 200)).toString('latin1') }, null, 1));
        expect(result.finding).toBeUndefined();
        return;
      }
      // The seeds themselves, and each of them cut at every 1/64 of its length (fewer cuts for a target with hundreds of seeds).
      for (let index = 0; index < sweepSize(pool); index++) {
        const { label, input } = sweepInput(pool, index);
        const result = runCaseConfirmed(target, input, config);
        if (result.finding) report(label, input, result.finding.message);
      }
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const input = generate(target, pool, config, iteration);
        const result = runCaseConfirmed(target, input, config);
        if (result.finding) report(`iteration ${iteration} (seed ${String(config.seed)})`, input, `${result.finding.kind}: ${result.finding.message}`);
      }
      expect(found).toEqual([]);
    });
  }
});
