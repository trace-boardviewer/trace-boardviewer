import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import asc from '../formats/adapters/asc/fixtures';
import bdv from '../formats/adapters/bdv/fixtures';
import gencad from '../formats/adapters/gencad/fixtures';
import { collectDiagnostic } from './collect';
const { validateReport } = createRequire(import.meta.url)('../../../electron/diagnostics.cjs');
const env = { os: 'win32' as const, appVersion: '1.3.0' };

describe('diagnostics use the same verified framing and fixed roles as the readers', () => {
  it('describes the declared header inside a complete GenCAD storage wrapper', async () => {
    const fixture = gencad.find(entry => entry.label.includes('storage'))!;
    const report = validateReport(await collectDiagnostic(fixture, env));
    expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'gencad' });
    expect(report.structure).toMatchObject({ hook: 'gencad', headerOk: true, variant: 'gencad-1.4' });
  });
  it('recognizes the encoded nails-first BDV structure without a format section', async () => {
    const fixture = bdv.find(entry => entry.label.includes('nails-first'))!;
    const report = validateReport(await collectDiagnostic(fixture, env));
    expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'bdv' });
    expect(report.structure).toMatchObject({ hook: 'bdv', headerOk: true, variant: 'bdv-encoded' });
  });
  it('describes both entry roles of an alternate ASC outline with ordinary pin companions', async () => {
    const normal = asc.find(entry => entry.name === 'format.asc')!;
    const pins = normal.companions!['pins.asc'], nails = normal.companions!['nails.asc'];
    for (const input of [
      { name: '@format.asc', data: normal.data, companions: { 'pins.asc': pins, 'nails.asc': nails } },
      { name: 'pins.asc', data: pins, companions: { '@format.asc': normal.data, 'nails.asc': nails } },
    ]) {
      const report = validateReport(await collectDiagnostic(input, env));
      expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'asc' });
      expect(report.structure).toMatchObject({ hook: 'asc', headerOk: true, variant: 'asc-trio' });
    }
  });
});
