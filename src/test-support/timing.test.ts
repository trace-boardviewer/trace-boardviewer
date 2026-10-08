import { describe, expect, it } from 'vitest';
import { expectBoundedWork, expectCostAtMost, expectScaling, measureMs } from './timing';

let sink = 0;
/** n units of work. */
const linear = (n: number) => { const data = new Float64Array(n).fill(1); return () => { let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * (i & 3); sink += sum; }; };
/** n * n / 8 units of work: a scan that restarts at every element. */
const quadratic = (n: number) => () => { let sum = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n >> 3; j++) sum += j ^ i; sink += sum; };
const sorted = (n: number) => { const data = Array.from({ length: n }, (_, i) => (i * 2654435761) % 1000003); return () => { sink += data.slice().sort((a, b) => a - b)[0]; }; };
const constant = (_n: number) => () => { let sum = 0; for (let i = 0; i < 2000; i++) sum += i; sink += sum; };

describe('timing checks', () => {
  it('accept linear and n log n operations, and measure every size of the pair they compare', () => {
    const steps = expectScaling('linear', [20_000, 80_000, 320_000], linear);
    expect(steps.map(step => [step.from, step.to])).toEqual([[20_000, 80_000], [80_000, 320_000]]);
    for (const step of steps) { expect(step.fromMs).toBeGreaterThan(0); expect(step.toMs).toBeGreaterThan(0); expect(step.exponent).toBeLessThan(1.5); }
    expectScaling('n log n', [10_000, 40_000, 160_000], sorted);
  });

  it('reject a quadratic operation, name the pair that grows too fast and stop at the first one', () => {
    let built = 0;
    expect(() => expectScaling('scan', [500, 2000, 8000, 32_000], n => { built++; return quadratic(n); })).toThrow(/^scan: the running time grows like size\^(1\.[6-9]\d?|2\.\d+) from 500 to 2000 /);
    expect(built).toBe(2); // the larger inputs are never built, let alone run
  });

  it('reject a quadratic operation that is hidden behind a large constant cost per call', () => {
    const behindSetup = (n: number) => { const scan = quadratic(n), setup = linear(4000); return () => { for (let i = 0; i < 4; i++) setup(); scan(); }; };
    expect(() => expectScaling('constant plus scan', [2000, 8000, 32_000], behindSetup)).toThrow(/grows like size\^/);
  });

  it('take bounded work as bounded and linear work as growing', () => {
    expectBoundedWork('constant', [1000, 100_000, 10_000_000], constant);
    expect(() => expectBoundedWork('linear', [20_000, 80_000, 320_000], linear)).toThrow(/grows like size\^(0\.[6-9]\d?|1\.\d+) /);
  });

  it('validate the sizes', () => {
    expect(() => expectScaling('one size', [10], linear)).toThrow(/at least two ascending/);
    expect(() => expectScaling('descending', [10, 5], linear)).toThrow(/ascending/);
    expect(() => expectScaling('zero', [0, 5], linear)).toThrow(/positive/);
  });

  it('compare an operation with a reference measured next to it', () => {
    const data = linear(200_000), twice = () => { data(); data(); };
    const cheap = expectCostAtMost('twice the reference', twice, data, 4);
    expect(cheap.ratio).toBeGreaterThan(1); expect(cheap.ratio).toBeLessThanOrEqual(4);
    expect(() => expectCostAtMost('ten times the reference', () => { for (let i = 0; i < 10; i++) data(); }, data, 4)).toThrow(/costs (\d+\.\d) times the reference .*at most 4 times/);
  });

  it('measure a very fast and a slower operation in milliseconds per call', () => {
    expect(measureMs(() => { sink += 1; })).toBeGreaterThan(0);
    expect(measureMs(linear(2_000_000))).toBeGreaterThan(measureMs(linear(2000)));
  });
});
