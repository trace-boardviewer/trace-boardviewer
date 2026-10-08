import { describe, expect, it } from 'vitest';
import padsAdapter from './adapters/pads-binary';
import brdAdapter from './adapters/brd-v1';
import { padsFrame } from './adapters/pads-binary/fixtures';
import brdFixtures from './adapters/brd-v1/fixtures';
import { BoardFormatError } from './common';
import { padsBinaryVersion, parsePadsBinary } from './pads-binary';
import { brdV1Signature, parseBrdV1 } from './brd-v1';
import { detectFormat, parseBoardDetailed } from './dispatch';
import { collectDiagnostic } from '../diagnostics/collect';

const ENV = { os: 'win32' as const, appVersion: '1.3.0' };
function refusal(data: Uint8Array, name = 'renamed.bin'): BoardFormatError {
  try { parseBoardDetailed({ data, name }); } catch (error) {
    expect(error).toBeInstanceOf(BoardFormatError); return error as BoardFormatError;
  }
  throw new Error('Expected refusal');
}
function change(offset: number, value: number, width = 4): Uint8Array {
  const data = padsFrame(), view = new DataView(data.buffer);
  if (width === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true);
  return data;
}

describe('PADS native SDB recognized framing', () => {
  it.each([0x2026, 0x2027])('identifies exact version %i after renaming and explains the conversion path', version => {
    const data = padsFrame(version), input = { name: 'renamed.bin', data };
    expect(padsBinaryVersion(data)).toBe(version);
    expect(detectFormat(input)[0].adapter.id).toBe('pads-binary');
    const error = refusal(data);
    expect(error).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'pads-binary' });
    expect(error.message).toContain('PADS Layout ASCII (.asc) export');
    expect(error.message).toContain('Direct native import failed');
    expect(error.message).toContain('.kicad_pcb');
    expect(error.keyKind).toBeUndefined();
  });
  it('requires magic and one of the established versions, and supports byte-offset views', () => {
    for (const data of [new Uint8Array(0), new Uint8Array([0, 255, 38]), padsFrame(0x2028), padsFrame(0x2017), new TextEncoder().encode('PADS .pcb')]) {
      expect(padsAdapter.sniff({ name: 'board.pcb', head: data, size: data.length }).confidence).toBe(0);
      expect(parsePadsBinary({ name: 'board.pcb', data })).toBeNull();
    }
    const frame = padsFrame(), wrapped = new Uint8Array(frame.length + 7); wrapped.set(frame, 3);
    expect(refusal(wrapped.subarray(3, 3 + frame.length)).code).toBe('UNSUPPORTED_VARIANT');
  });
  it.each([
    ['truncated native header', () => new Uint8Array([0, 255, 38, 32]), 'INVALID_FORMAT'],
    ['absent controller slots', () => change(26, 24), 'INVALID_FORMAT'],
    ['excessive controller slots', () => change(26, 0xffffffff), 'LIMIT_EXCEEDED'],
    ['wrong directory extent', () => change(30, 75), 'INVALID_FORMAT'],
    ['unused controller word', () => change(6, 1), 'INVALID_FORMAT'],
    ['out-of-bounds flat extent', () => change(14 + 22 * 16, 0xffffffff), 'INVALID_FORMAT'],
    ['out-of-bounds container pointer', () => change(padsFrame().length - 4, 0), 'INVALID_FORMAT'],
    ['unknown subversion', () => change(4, 4, 2), 'UNSUPPORTED_VARIANT'],
    ['missing footer', () => padsFrame().subarray(0, padsFrame().length - 1), 'INVALID_FORMAT'],
    ['truncated directory', () => padsFrame().subarray(0, 70), 'INVALID_FORMAT'],
  ] as const)('refuses %s without allocating from hostile counts', (_label, make, code) => {
    expect(refusal(make())).toMatchObject({ code, format: 'pads-binary' });
  });
  it('describes only controller framing, with no file words or invented live-pin count', async () => {
    const original = padsFrame(), start = 6 + 75 * 16, data = new Uint8Array(original.length + 64);
    data.set(original.subarray(0, start)); data.set(original.subarray(start), start + 64);
    const view = new DataView(data.buffer); view.setUint32(14 + 2 * 16, 64, true); view.setUint32(data.length - 4, start + 64, true);
    const canary = 'QZX7PRIVATE_COMPONENT_NET_COORDINATES'; data.set(new TextEncoder().encode(canary), start);
    const report = await collectDiagnostic({ name: 'private-name.pcb', data }, ENV);
    expect(report.detection.adapters.find(row => row.id === 'pads-binary')).toMatchObject({ sniff: 'certain', code: 'UNSUPPORTED_VARIANT', stage: 'records', keyKind: null });
    expect(report.structure).toMatchObject({ hook: 'pads-binary', variant: 'pads-sdb-2026', headerOk: true, header: { codes: { version: 0x2026 }, counts: { sections: 75 } } });
    expect(report.structure?.header.counts).not.toHaveProperty('declaredPins');
    expect(report.structure?.blocks?.sequence).toContainEqual([2, 64]);
    expect(JSON.stringify(report)).not.toContain(canary);
    expect(JSON.stringify(report)).not.toContain('private-name');
  });
  it('locates damaged directory and damaged footer at different diagnostic stages', async () => {
    const cases = [[change(30, 75), 'header'], [padsFrame().subarray(0, padsFrame().length - 1), 'container']] as const;
    for (const [data, stage] of cases) {
      const report = await collectDiagnostic({ name: 'board.pcb', data }, ENV);
      expect(report.detection.adapters.find(row => row.id === 'pads-binary')).toMatchObject({ code: 'INVALID_FORMAT', stage });
    }
  });
});

describe('BRD_V1.0 opaque boardview', () => {
  it('uses the full fixed header and never requests an unrelated key', async () => {
    const data = brdFixtures[0].data.slice(), canary = 'QZX7PRIVATE'; data.set(new TextEncoder().encode(canary), 16);
    expect(brdV1Signature(data)).toBe(true);
    expect(detectFormat({ name: 'renamed.pcb', data })[0].adapter.id).toBe('brd-v1');
    expect(refusal(data, 'board.brd')).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'brd-v1', keyKind: undefined });
    const report = await collectDiagnostic({ name: 'board.brd', data }, ENV);
    expect(report.detection.adapters.find(row => row.id === 'brd-v1')).toMatchObject({ sniff: 'certain', code: 'UNSUPPORTED_VARIANT', stage: 'records', keyKind: null });
    expect(report.structure).toMatchObject({ hook: 'brd-v1', variant: 'brd-v1-opaque', headerOk: true });
    expect(JSON.stringify(report)).not.toContain(canary);
  });
  it('declines truncated or different headers and diagnoses missing payload', () => {
    const good = brdFixtures[0].data;
    for (const data of [good.subarray(0, 15), new TextEncoder().encode('BRD_V1.0junkjunk!'), new TextEncoder().encode('BRD_V2.0\0\0\0\0\0\0\0\0')]) {
      expect(brdAdapter.sniff({ head: data, name: 'board.brd', size: data.length }).confidence).toBe(0);
      expect(parseBrdV1({ name: 'board.brd', data })).toBeNull();
    }
    expect(refusal(good.subarray(0, 16))).toMatchObject({ code: 'INVALID_FORMAT', format: 'brd-v1' });
  });
});
