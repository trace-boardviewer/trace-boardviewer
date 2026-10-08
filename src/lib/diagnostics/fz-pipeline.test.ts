import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import fixtures from '../formats/adapters/fz/fixtures';
import { rc6Feedback } from '../formats/crypto';
import { CAE_DEFAULT_KEY, FZ_DEFAULT_KEY } from '../formats/fz-default-keys';
import { fzDecoded, FZ_CANARY_KEY, secretsOf } from './canary-kit';
import { findLeaks } from './canary-check';
import { collectDiagnostic } from './collect';
import { reportText } from './report';

const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
function container(sized: boolean, corruptLength = false) {
  const source = fzDecoded().data, description = new TextEncoder().encode('Synthetic description\nPARTNO\tDESCRIPTION\tQTY\tLOCATIONS\n');
  const c = zlibSync(source), d = zlibSync(description);
  return Uint8Array.from([...u32(sized ? source.length + (corruptLength ? 1 : 0) : 0), ...c,
    ...(sized ? [...u32(c.length + 8), ...u32(description.length)] : []), ...d, ...u32(d.length + 8)]);
}

describe.each(['win32', 'linux', 'darwin'] as const)('FZ diagnostic pipeline with %s report metadata', os => {
  const collect = (name: string, data: Uint8Array, key?: readonly number[]) => collectDiagnostic({ name, data,
    ...(key ? { options: { fzKey: [...key] } } : {}) }, { os, appVersion: '1.3.0' });

  it.each(fixtures)('describes $label through the same framing as the reader', async fixture => {
    const report = await collect(fixture.name, fixture.data);
    expect(report.detection.outcome).toBe('opened');
    expect(report.structure).toMatchObject({ hook: 'fz', headerOk: true });
    expect(report.structure?.sections.length).toBeGreaterThan(0);
    if (fixture.name === 'sized.fz') expect(report.structure?.header.codes.containerLayout).toBe(6);
    if (fixture.name === 'footer.cae') expect(report.structure?.header.codes.containerLayout).toBe(5);
  });

  for (const [extension, key] of [['fz', FZ_DEFAULT_KEY], ['cae', CAE_DEFAULT_KEY]] as const) {
    it.each([false, true])(`uses the ${extension} default key for footer framing (size words: %s), without disclosing content`, async sized => {
      const data = rc6Feedback(container(sized), key, true);
      const report = await collect(`board.${extension}`, data);
      expect(report.detection.outcome).toBe('opened');
      expect(report.structure?.header.codes).toMatchObject({ encrypted: 1, containerLayout: sized ? 6 : 5 });
      expect(report.structure?.header.codes.contentLog2).toBeDefined();
      expect(report.keys.supplied).toBe(false);
      expect(findLeaks(reportText(report), secretsOf(fzDecoded()))).toEqual([]);
    });

    it(`stops at decryption for an explicit wrong ${extension} key instead of falling back to the built-in key`, async () => {
      const report = await collect(`board.${extension}`, rc6Feedback(container(true), key, true), FZ_CANARY_KEY);
      expect(report.detection.outcome).toBe('failed');
      expect(report.detection.adapters.find(entry => entry.result === 'error')).toMatchObject({ code: 'INVALID_KEY', stage: 'decrypt' });
      expect(report.structure?.header.codes.contentLog2).toBeUndefined();
    });

    it(`reports a damaged ${extension} declared size at decompression rather than blaming the key`, async () => {
      const report = await collect(`board.${extension}`, rc6Feedback(container(true, true), key, true));
      expect(report.detection.outcome).toBe('failed');
      expect(report.detection.adapters.find(entry => entry.result === 'error')).toMatchObject({ code: 'INVALID_FORMAT', stage: 'decompress' });
      expect(report.structure?.header.codes.contentLog2).toBeUndefined();
    });
  }
});
