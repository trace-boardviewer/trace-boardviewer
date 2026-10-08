/**
 * Replays every minimized input the fuzzer has ever saved (tests/fuzz/regressions/*.json): each must be handled cleanly now, by the
 * target that crashed on it, within its time budget. A fixture is added together with the fix of the defect it showed.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRegressions } from './corpus';
import { CI_CONFIG, runCaseConfirmed } from './engine';
import { ALL_TARGETS } from './targets';

const fixtures = loadRegressions(fileURLToPath(new URL('./regressions/', import.meta.url)));
const targets = new Map(ALL_TARGETS().map(target => [target.id, target]));

describe('fuzz regressions', () => {
  it('has only fixtures of targets that exist', () => {
    for (const { file, fixture } of fixtures) expect(targets.has(fixture.target), `${file}: unknown target ${fixture.target}`).toBe(true);
  });
  for (const { file, fixture, input } of fixtures) {
    it(`${file}: ${fixture.note}`, () => {
      const target = targets.get(fixture.target)!;
      const result = runCaseConfirmed(target, input, { ...CI_CONFIG, maxBytes: Math.max(CI_CONFIG.maxBytes, input.data.length) });
      expect(result.finding).toBeUndefined();
    });
  }
});
