import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { CERTAIN, SNIFF_BYTES } from '../../adapter';
import { BoardFormatError } from '../../common';
import { detectFormat, parseBoardAsync, parseBoardDetailed, sniffBoard } from '../../dispatch';
import { utf8 } from '../../fixture';
import { CANONICAL, rawZip, rooted, tarOf, tgzOf, writeJob, zipOf } from '../../odbpp-fixture';
import fixtures from './fixtures';
import adapter from './index';

const job = writeJob();
const folder = rooted(job, 'odb/');
const KICAD = '(kicad_pcb (version 20240108) (generator "synthetic") (net 0 "") (net 1 "GND")\n (footprint "Test:Package" (layer "F.Cu") (at 10 20 90) (property "Reference" "U1") (property "Value" "v")\n  (fp_rect (start -3 -2) (end 3 2) (layer "F.Fab"))\n  (pad "1" smd rect (at 2 3 90) (size 2 1) (layers "F.Cu") (net 1 "GND")))\n (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts")))';
const refs = (input: { name: string; data: Uint8Array }) => parseBoardDetailed(input).board.components.map(component => component.ref).sort();
const EXPECTED = ['E1', 'J1', 'R1', 'R2', 'TP1', 'U1', 'U2'];

describe('the ODB++ adapter in the registry', () => {
  it('is registered as a validated-with-open-tool-files reader of archives', () => {
    expect(adapter).toMatchObject({ id: 'odbpp', kind: 'board', family: 'ECAD design' });
    expect(adapter.capability).toMatchObject({ status: 'open-tool-validated', validation: 'open-tool-files', electrical: 'nets' });
    expect(adapter.capability.openTool?.tool).toMatch(/kicad-cli/);
    expect(adapter.extensions).toEqual(['.tgz', '.gz', '.tar', '.zip', '.z']);
  });

  it.each(fixtures.map(fixture => [fixture.label, fixture] as const))('reads %s through the dispatcher', (_label, fixture) => {
    const result = parseBoardDetailed({ name: fixture.name, data: fixture.data });
    expect(result.adapter).toBe('odbpp');
    expect(result.container).toBeUndefined();
    expect(result.confidence).toBeGreaterThan(60);
    expect(result.board).toMatchObject({ format: 'ODB++', units: 'mm' });
    expect(result.board.components.map(component => component.ref).sort()).toEqual(EXPECTED);
    expect(result.board.nets.map(net => net.name)).toEqual(expect.arrayContaining(['GND', 'VCC']));
  });

  it('identifies a product model by its entries, whatever the file is called', () => {
    for (const name of ['upload.bin', 'job', 'JOB.TGZ', 'C:\\work\\job (2).tar.gz']) expect(refs({ name, data: tgzOf(folder) })).toEqual(EXPECTED);
    expect(refs({ name: 'export', data: zipOf(folder) })).toEqual(EXPECTED);
  });

  it('outranks the ZIP container for a ZIP that holds the product model, and leaves every other ZIP to it', () => {
    const odb = detectFormat({ name: 'job.zip', data: zipOf(folder) });
    expect(odb.map(candidate => candidate.adapter.id).slice(0, 2)).toEqual(['odbpp', 'zip']);
    expect(odb[0].confidence).toBeGreaterThan(odb[1].confidence);
    const board = zipOf({ 'board.kicad_pcb': utf8(KICAD), 'notes.txt': 'x' });
    const other = detectFormat({ name: 'board.zip', data: board });
    expect(other[0].adapter.id).toBe('zip');
    expect(other.find(candidate => candidate.adapter.id === 'odbpp')?.confidence ?? 0).toBeLessThan(other[0].confidence);
    expect(parseBoardDetailed({ name: 'board.zip', data: board })).toMatchObject({ adapter: 'kicad', container: 'zip', entry: 'board.kicad_pcb' });
  });

  it('opens a product model that was zipped as a .tgz through the ZIP container', () => {
    const result = parseBoardDetailed({ name: 'package.zip', data: zipOf({ 'job.tgz': tgzOf(folder), 'readme.txt': 'x' }) });
    expect(result).toMatchObject({ adapter: 'odbpp', container: 'zip', entry: 'job.tgz' });
    expect(result.board.components).toHaveLength(EXPECTED.length);
  });

  it('is never certain, so it cannot make a file ambiguous', () => {
    for (const fixture of fixtures) for (const candidate of detectFormat({ name: fixture.name, data: fixture.data })) if (candidate.adapter.id === 'odbpp') expect(candidate.confidence).toBeLessThan(CERTAIN);
  });

  it('ignores gzip, tar and ZIP files that are not product models', () => {
    const gz = gzipSync(utf8('hello world\n'.repeat(100)));
    expect(detectFormat({ name: 'log.gz', data: gz })).toEqual([]);
    expect(() => parseBoardDetailed({ name: 'log.gz', data: gz })).toThrow(expect.objectContaining({ code: 'UNRECOGNIZED' }));
    const otherTar = tarOf({ 'docs/readme.txt': 'hi' });
    expect(detectFormat({ name: 'docs.tar', data: otherTar })).toEqual([]);
    // A tar.gz of other files may still continue with a product model: the parse looks at all of it and declines.
    const otherTgz = tgzOf({ 'docs/readme.txt': 'hi' });
    expect(detectFormat({ name: 'docs.tgz', data: otherTgz }).map(candidate => candidate.adapter.id)).toEqual(['odbpp']);
    expect(() => parseBoardDetailed({ name: 'docs.tgz', data: otherTgz })).toThrow(expect.objectContaining({ code: 'UNRECOGNIZED' }));
  });

  it('refuses a damaged or hostile product model with a format error, never with a crash', () => {
    const unsafe = tgzOf({ '../odb/matrix/matrix': 'STEP {\n}\n', '/etc/steps/pcb/profile': 'x' });
    const truncated = tgzOf(folder).subarray(0, 900);
    const lies = rawZip(Object.entries(folder).map(([name, data]) => ({ name, data, crcOverride: 0x12345678 })));
    for (const [label, data] of [['unsafe paths', unsafe], ['truncated tgz', truncated], ['ZIP members whose checksum lies', lies]] as const) {
      let caught: unknown;
      try { parseBoardDetailed({ name: 'job.tgz', data }); } catch (error) { caught = error; }
      expect(caught, label).toBeInstanceOf(BoardFormatError);
    }
  });

  it('reads the board step by default and the step named in the import options', () => {
    const coupon = { ...CANONICAL, top: [CANONICAL.top[0]], bottom: [] };
    const data = tgzOf({ ...writeJob(CANONICAL, { step: 'pcb' }), ...writeJob(coupon, { step: 'coupon' }) });
    const chosen = parseBoardDetailed({ name: 'panel.tgz', data });
    expect(chosen.board.components).toHaveLength(EXPECTED.length);
    expect(chosen.board.warnings.some(warning => /2 steps with components \(coupon, pcb\)/.test(String(warning.params?.message)))).toBe(true);
    const other = parseBoardDetailed({ name: 'panel.tgz', data, options: { odbpp: { step: 'coupon' } } });
    expect(other.board.components).toHaveLength(1);
    expect(() => parseBoardDetailed({ name: 'panel.tgz', data, options: { odbpp: { step: 'missing' } } })).toThrow(/step "missing" does not exist/);
  });

  it('describes the archive to listings without unpacking it', () => {
    const data = tgzOf(folder);
    const verdict = sniffBoard(data.subarray(0, SNIFF_BYTES), 'job.tgz', data.length);
    expect(verdict.ambiguous).toBe(false);
    expect(verdict.best).toMatchObject({ id: 'odbpp', kind: 'board', status: 'open-tool-validated', variant: 'tgz', meta: { container: 'tgz' } });
    const zip = zipOf(folder);
    expect(sniffBoard(zip.subarray(0, SNIFF_BYTES), 'job.zip', zip.length).best).toMatchObject({ id: 'odbpp', variant: 'zip' });
  });

  it('stops when the import is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parseBoardAsync({ name: 'job.tgz', data: tgzOf(folder) }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const context = { signal: controller.signal, limits: adapter.limits, progress: () => {}, requestKey: () => Promise.reject(new Error('no key')) };
    expect(() => adapter.parse({ name: 'job.tgz', data: tgzOf(folder) }, context)).toThrow();
  });
});
