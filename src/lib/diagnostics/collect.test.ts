import { createRequire } from 'node:module';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defineBoardAdapter, type BoardAdapter } from '../formats/adapter';
import { BoardFormatError } from '../formats/common';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS } from '../formats/registry';
import { ALL_BUILDERS, asc, fzEncrypted, fzEncryptedWithoutKey, gencad, kicad, xzz, type BuiltFile } from './canary-kit';
import { collectDiagnostic, projectReport, type DiagnosticEnv } from './collect';
import { FORMAT_IDS, reportText, type DiagnosticReport } from './report';

const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../../electron/diagnostics.cjs') as { validateReport(value: unknown, options?: { reviewed?: boolean }): DiagnosticReport; serializeReport(report: DiagnosticReport): string };

const ENV: DiagnosticEnv = { os: 'win32', appVersion: '1.3.0' };
export const collect = (file: BuiltFile, env: DiagnosticEnv = ENV): Promise<DiagnosticReport> => collectDiagnostic({
  name: file.name, data: file.data, ...(file.companions ? { companions: file.companions } : {}), ...(file.options ? { options: file.options } : {}),
}, env);
const level = (report: DiagnosticReport, value: 1 | 2): DiagnosticReport => diagnostics.validateReport(projectReport(report, { level: value, dedupe: false, reviewed: true }), { reviewed: true });

describe('collectDiagnostic on one synthetic file of every format', () => {
  for (const build of ALL_BUILDERS) {
    const file = build();
    it(`describes ${file.label}: detection, structure, result and plausibility, valid at both levels`, async () => {
      const full = await collect(file);
      const report1 = level(full, 1), report2 = level(full, 2);
      expect(report1.privacy.level).toBe(1);
      expect(report2.privacy.level).toBe(2);
      expect(report1.detection).toMatchObject({ outcome: 'opened', format: file.format, selected: file.format, ambiguous: false });
      expect(report1.structure?.hook).toBe(file.hook);
      expect(report1.structure?.headerOk, 'header step completed').toBe(true);
      expect(report1.result).not.toBeNull();
      expect(report1.plausibility).not.toBeNull();
      const claimed = report1.detection.adapters.filter(entry => entry.result === 'claimed');
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(file.format);
      // The dispatcher's order: nothing in front of the claiming candidate but declines, nothing behind it but skips.
      const at = report1.detection.adapters.indexOf(claimed[0]);
      expect(report1.detection.adapters.slice(0, at).every(entry => entry.result === 'declined')).toBe(true);
      expect(report1.detection.adapters.slice(at + 1).every(entry => entry.result === 'skipped')).toBe(true);
    });
  }
});

describe('detection follows the dispatcher', () => {
  const adapter = (id: string, confidence: number, parse: BoardAdapter['parse'] | 'kicad') => {
    const real = BOARD_ADAPTERS.find(item => item.id === 'kicad')!;
    return defineBoardAdapter({
      capability: { ...real.capability, id, name: id, extensions: ['.kicad_pcb'], variants: [], notes: [] }, listOrder: 900, family: 'ECAD design', detection: 'signature',
      sniff: () => ({ confidence, reason: 'test' }), parse: parse === 'kicad' ? real.parse : parse,
    });
  };

  it('lists only the candidates whose sniff matched, strongest first, with their sniff tier', async () => {
    const report = await collect(kicad());
    const ids = report.detection.adapters.map(entry => entry.id);
    expect(ids[0]).toBe('kicad');
    expect(report.detection.adapters[0].sniff).toBe('certain');
    expect(ids.length).toBeLessThan(BOARD_ADAPTERS.length / 2);
    expect(ids.every(id => (FORMAT_IDS as readonly string[]).includes(id))).toBe(true);
  });

  it('marks declined, claimed and skipped candidates in the order the dispatcher would try them', async () => {
    const boards = [adapter('first', 95, () => null), adapter('second', 60, 'kicad'), adapter('third', 30, 'kicad')];
    const report = await collect(kicad(), { ...ENV, boards, containers: [] });
    expect(report.detection.adapters.map(entry => [entry.id, entry.sniff, entry.result])).toEqual([['other', 'certain', 'declined'], ['other', 'likely', 'claimed'], ['other', 'possible', 'skipped']]);
    expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'other', ambiguous: false });
    // An adapter id the schema does not list yet is reported as "other" and never as its own name.
    expect(JSON.stringify(report)).not.toMatch(/first|second|third/);
  });

  it('stops at the first format error like the dispatcher: the candidate behind it is skipped', async () => {
    const boards = [adapter('first', 70, () => { throw new BoardFormatError('duplicate REFDES U12', 'INVALID_FORMAT'); }), adapter('second', 60, 'kicad')];
    const report = await collect(kicad(), { ...ENV, boards, containers: [] });
    expect(report.detection.outcome).toBe('failed');
    expect(report.detection.adapters.map(entry => entry.result)).toEqual(['error', 'skipped']);
    expect(report.detection.adapters[0]).toMatchObject({ code: 'INVALID_FORMAT' });
    expect(report.result).toBeNull();
    expect(JSON.stringify(report)).not.toContain('U12');
  });

  it('refuses a file two readers are certain about, as the dispatcher does, and parses nothing', async () => {
    let parsed = 0;
    const count = (): null => { parsed++; return null; };
    const boards = [adapter('first', 95, count), adapter('second', 92, count), adapter('third', 60, count)];
    const report = await collect(kicad(), { ...ENV, boards, containers: [] });
    expect(parsed).toBe(0);
    expect(report.detection).toMatchObject({ outcome: 'failed', selected: null, format: null, ambiguous: true });
    expect(report.detection.adapters.map(entry => [entry.result, entry.code])).toEqual([['error', 'AMBIGUOUS_FORMAT'], ['error', 'AMBIGUOUS_FORMAT'], ['skipped', null]]);
    expect(report.result).toBeNull();
    expect(diagnostics.validateReport(report)).toBeTruthy();
  });

  it('records an unexpected exception of a reader as INTERNAL, which is a defect of the reader and not of the file', async () => {
    const boards = [adapter('first', 70, () => { throw new TypeError('cannot read properties of undefined'); })];
    const report = await collect(kicad(), { ...ENV, boards, containers: [] });
    expect(report.detection.adapters[0]).toMatchObject({ result: 'error', code: 'INTERNAL' });
    expect(JSON.stringify(report)).not.toContain('cannot read');
  });

  it('opens the one board of an archive: the container is selected, the board inside gives the format and the result facts', async () => {
    const archive = zipSync({ 'project/board.kicad_pcb': kicad().data });
    const report = await collectDiagnostic({ name: 'bundle.zip', data: archive }, ENV);
    expect(report.input).toMatchObject({ extension: '.zip', container: 'zip', magic: 'zip' });
    expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'zip', format: 'kicad' });
    expect(report.result?.parts).toBeGreaterThan(0);
    expect(CONTAINER_ADAPTERS.map(item => item.id)).toContain('zip');
    expect(diagnostics.validateReport(report)).toBeTruthy();
  });

  it('refuses an archive with two boards with a container-stage code and no member name', async () => {
    const archive = zipSync({ 'a/QZX7first.kicad_pcb': kicad().data, 'b/QZX7second.kicad_pcb': kicad().data });
    const report = await collectDiagnostic({ name: 'bundle.zip', data: archive }, ENV);
    expect(report.detection.outcome).toBe('failed');
    expect(report.detection.adapters.find(entry => entry.id === 'zip')).toMatchObject({ result: 'error', code: 'UNSUPPORTED_VARIANT', stage: 'container' });
    expect(JSON.stringify(report)).not.toContain('QZX7');
  });
});

describe('levels', () => {
  it('level 1 carries no shape and no block sequence; level 2 adds them to the same facts', async () => {
    const full = await collect(gencad());
    const one = level(full, 1), two = level(full, 2);
    for (const section of one.structure!.sections) {
      expect(section).not.toHaveProperty('shapes');
      expect(section).not.toHaveProperty('distinctShapes');
    }
    expect(two.structure!.sections.some(section => (section.shapes?.length ?? 0) > 0)).toBe(true);
    expect({ ...two, privacy: one.privacy, structure: null }).toEqual({ ...one, structure: null });
    const binary = level(await collect(xzz()), 2);
    expect(binary.structure!.blocks?.sequence?.length).toBeGreaterThan(0);
    expect(level(await collect(xzz()), 1).structure!.blocks).not.toHaveProperty('sequence');
  });

  it('shows exactly what the main process writes: the review text equals the canonical file text, byte for byte, for every format and choice', async () => {
    for (const build of ALL_BUILDERS) {
      const full = await collect(build(), { ...ENV, dedupe: '0123456789abcdef' });
      for (const [chosen, dedupe] of [[1, false], [1, true], [2, false], [2, true]] as const) {
        const projected = projectReport(full, { level: chosen, dedupe, reviewed: true });
        expect(reportText(projected)).toBe(diagnostics.serializeReport(diagnostics.validateReport(projected, { reviewed: true })));
      }
    }
  });

  it('is deterministic: the same bytes and environment give the same report', async () => {
    for (const build of ALL_BUILDERS) expect(await collect(build())).toEqual(await collect(build()));
  });
});

describe('keys', () => {
  it('reports only whether a key was supplied and whether its parity holds', async () => {
    expect((await collect(fzEncrypted())).keys).toEqual({ supplied: true, parity: 'valid' });
    expect((await collect(fzEncryptedWithoutKey())).keys).toEqual({ supplied: false, parity: 'n/a' });
    const wrong = fzEncrypted();
    wrong.options = { fzKey: wrong.options!.fzKey!.map((word, index) => index === 0 ? (word ^ 1) >>> 0 : word) };
    const report = await collect(wrong);
    expect(report.keys).toEqual({ supplied: true, parity: 'invalid' });
    expect(report.detection.outcome).toBe('failed');
    expect(report.detection.adapters.find(entry => entry.result === 'error')).toMatchObject({ code: 'INVALID_KEY', stage: 'decrypt', keyKind: 'fz' });
  });

  it('names the stage of a key failure: an encrypted file without its key stops at decrypt', async () => {
    const report = await collect(fzEncryptedWithoutKey());
    expect(report.detection.outcome).toBe('failed');
    expect(report.detection.adapters.find(entry => entry.result === 'error')).toMatchObject({ id: 'fz', code: 'KEY_REQUIRED', stage: 'decrypt' });
    expect(report.structure).toMatchObject({ hook: 'fz', variant: 'fz-rc6', headerOk: true });
    expect(report.result).toBeNull();
    expect(report.plausibility).toBeNull();
  });
});

describe('failures and unrecognized files', () => {
  it('reports an unrecognized text file with the generic text hook and without any adapter claim', async () => {
    const data = new TextEncoder().encode('hello world\nthis is not a board\n1 2 3\n');
    const report = await collectDiagnostic({ name: 'notes.txt', data }, ENV);
    expect(report.detection).toMatchObject({ outcome: 'unrecognized', selected: null, format: null, ambiguous: false });
    expect(report.structure).toMatchObject({ hook: 'generic-text', kind: 'text' });
    expect(report.input.extension).toBe('.txt');
    expect(report.result).toBeNull();
    expect(diagnostics.validateReport(report)).toBeTruthy();
  });

  it('reports unrecognized binary data with the generic binary hook', async () => {
    const data = Uint8Array.from({ length: 4096 }, (_, index) => (index * 167 + 13) & 255);
    const report = await collectDiagnostic({ name: 'x.bin', data }, ENV);
    expect(report.detection.outcome).toBe('unrecognized');
    expect(report.structure).toMatchObject({ hook: 'generic-binary', kind: 'binary' });
    expect(report.input).toMatchObject({ textLike: false, encoding: 'binary', lineEndings: 'n/a' });
  });

  it('records the code and stage of a recognized but malformed file, never its message', async () => {
    const file = kicad();
    const broken = file.data.slice(0, file.data.length - 40);
    const report = await collectDiagnostic({ name: 'board.kicad_pcb', data: broken }, ENV);
    expect(report.detection.outcome).toBe('failed');
    const entry = report.detection.adapters.find(item => item.result === 'error')!;
    expect(entry).toMatchObject({ id: 'kicad', code: 'INVALID_FORMAT' });
    expect(entry.stage).toMatch(/^(header|records|build)$/);
    expect(JSON.stringify(report)).not.toMatch(/unbalanced|expected|unexpected|parenthes/i);
  });

  it('an ASC member opened without its companions asks for them (COMPANIONS_REQUIRED at the container stage)', async () => {
    const file = asc();
    const report = await collectDiagnostic({ name: file.name, data: file.data }, ENV);
    expect(report.detection.outcome).toBe('failed');
    expect(report.detection.adapters.find(entry => entry.result === 'error')).toMatchObject({ id: 'asc', code: 'COMPANIONS_REQUIRED', stage: 'container' });
    expect(report.input.companions).toEqual({ count: 0, extensions: [] });
  });

  it('never throws for file content, only for an input that is not one file within the size limit', async () => {
    await expect(collectDiagnostic({ name: 'a.cad', data: new Uint8Array(0) }, ENV)).resolves.toBeTruthy();
    await expect(collectDiagnostic({ name: 'a.cad', data: 'text' as unknown as Uint8Array }, ENV)).rejects.toThrow(RangeError);
  });

  it('stops at once when it is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(gencad(), { ...ENV, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const later = new AbortController();
    await expect(collect(gencad(), { ...ENV, signal: later.signal, progress: () => later.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports progress as a growing fraction that ends at 1', async () => {
    const seen: number[] = [];
    await collect(kicad(), { ...ENV, progress: fraction => seen.push(fraction) });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every(value => value >= 0 && value <= 1)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe('collector input is strictly one file plus its companions', () => {
  it('counts the companions by extension only and ignores everything beyond eight', async () => {
    const base = asc();
    const many: Record<string, Uint8Array> = { ...base.companions };
    for (let index = 0; index < 12; index++) many[`extra${index}.asc`] = new Uint8Array([1, 2, 3]);
    const report = await collectDiagnostic({ name: base.name, data: base.data, companions: many }, ENV);
    expect(report.input.companions.count).toBe(8);
    expect(report.input.companions.extensions).toHaveLength(8);
    expect(diagnostics.validateReport(report)).toBeTruthy();
  });
});
