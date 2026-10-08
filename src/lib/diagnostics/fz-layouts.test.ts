import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BoardFormatError } from '../formats/common';
import { rc6Feedback } from '../formats/crypto';
import { CAE_DEFAULT_KEY, FZ_DEFAULT_KEY } from '../formats/fz-default-keys';
import { hasFzZlibHeader, parseFz, splitFzContainer } from '../formats/fz';
import { collectDiagnostic } from './collect';

const text = new TextEncoder();
const content = text.encode('UNIT:millimeters\nA!REFDES!\nS!U1!!TEST!NO!0!\nA!NET_NAME!\nS!GND!U1!1!VSS!3.5!4.5!!!\n');
const description = text.encode('PARTNO\tDESCRIPTION\tQTY\tLOCATIONS\n0\tTest part\t1\tU1\n');
const word = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
function container(layout: 6 | 7 | 8): Uint8Array {
  const c = zlibSync(content), d = zlibSync(description);
  const leading = layout === 8 ? 0 : layout === 7 ? new DataView(Uint8Array.of(0x50, 0x43, 0x36, 0x20).buffer).getUint32(0, true) : content.length;
  const between = layout === 8 ? word(0) : [...word(c.length + 8), ...word(layout === 7 ? leading : description.length)];
  return Uint8Array.from([...word(leading), ...c, ...between, ...d, ...word(d.length + 8)]);
}

describe('FZ framing and diagnostic agreement', () => {
  it('does not confuse a coincidental zlib header in ciphertext with a complete plaintext container', async () => {
    const c = zlibSync(content), d = zlibSync(description);
    // An opaque leading word is valid for the footer-framed spelling; 159 makes ciphertext bytes 4/5 = 48/4b.
    const plain = Uint8Array.from([...word(159), ...c, ...d, ...word(d.length + 8)]);
    const data = rc6Feedback(plain, FZ_DEFAULT_KEY, true);
    expect(hasFzZlibHeader(data)).toBe(true); expect(splitFzContainer(data)).toBeUndefined();
    expect(parseFz({ name: 'collision.fz', data })!.pins[0]).toMatchObject({ x: 3.5, y: 4.5, net: 'GND' });
    const report = await collectDiagnostic({ name: 'collision.fz', data }, { os: 'linux' });
    expect(report.detection.outcome).toBe('opened'); expect(report.structure).toMatchObject({ variant: 'fz-rc6', header: { codes: { encrypted: 1 } } });
  });
  it('verifies the compressed outer envelope before decrypting its bounded inner container', async () => {
    const inner = rc6Feedback(container(6), FZ_DEFAULT_KEY, true);
    const data = Uint8Array.from([0x0d, 0x0f, 0x3e, 3, ...word(inner.length), ...zlibSync(inner)]);
    expect(parseFz({ name: 'wrapped.fz', data })!.pins).toHaveLength(1);
    const report = await collectDiagnostic({ name: 'wrapped.fz', data }, { os: 'darwin' });
    expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'fz' }); expect(report.structure?.header.codes.encrypted).toBe(1);
    const wrongSize = data.slice(); wrongSize[4] ^= 1; expect(() => parseFz({ name: 'wrapped.fz', data: wrongSize })).toThrow(BoardFormatError);
    const checksum = data.slice(); checksum[checksum.length - 1] ^= 1; expect(() => parseFz({ name: 'wrapped.fz', data: checksum })).toThrow(BoardFormatError);
    expect(() => parseFz({ name: 'wrapped.fz', data: Uint8Array.from([...data, 0]) })).toThrow(BoardFormatError);
    const nested = Uint8Array.from([0x0d, 0x0f, 0x3e, 3, ...word(data.length), ...zlibSync(data)]); expect(() => parseFz({ name: 'nested.fz', data: nested })).toThrow(/nested/);
  });
  it.each([6, 7, 8] as const)('opens exact layout %i with verified streams, both plain and default-key encrypted', async layout => {
    const plain = container(layout);
    expect(splitFzContainer(plain)?.layout).toBe(layout);
    for (const [name, data] of [
      ['board.fz', plain], ['board.fz', rc6Feedback(plain, FZ_DEFAULT_KEY, true)], ['board.cae', rc6Feedback(plain, CAE_DEFAULT_KEY, true)],
    ] as const) {
      const board = parseFz({ name, data })!;
      expect(board.pins).toHaveLength(1);
      expect(board.components).toHaveLength(1);
      expect(board.pins[0]).toMatchObject({ x: 3.5, y: 4.5, number: '1', net: 'GND' });
      const report = await collectDiagnostic({ name, data }, { os: 'win32' });
      expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'fz' });
      expect(report.structure).toMatchObject({ headerOk: true, header: { codes: { containerLayout: layout, unitCode: 1 } } });
      expect(report.structure?.keywords['S!']).toBeGreaterThan(0);
      expect(report.keys.supplied).toBe(false);
    }
  });

  it.each([6, 7, 8] as const)('retains checksum and delimiter validation for layout %i', layout => {
    const data = container(layout), damaged = data.slice();
    const c = splitFzContainer(data)!.content;
    damaged[4 + c.length - 1] ^= 1;
    expect(() => parseFz({ name: 'board.fz', data: damaged })).toThrow(BoardFormatError);
    const wrongFooter = data.slice(); wrongFooter[wrongFooter.length - 4] ^= 1;
    expect(() => parseFz({ name: 'board.fz', data: wrongFooter })).toThrow(BoardFormatError);
    const wrongDelimiter = data.slice(); wrongDelimiter[4 + c.length] ^= 1;
    expect(() => parseFz({ name: 'board.fz', data: wrongDelimiter })).toThrow(BoardFormatError);
  });

  it('does not suppress a mismatched numeric size or a half-matched PC6 tag', () => {
    for (const layout of [6, 7] as const) {
      const data = container(layout), c = splitFzContainer(data)!.content;
      data[4 + c.length + 4] ^= 1;
      expect(() => parseFz({ name: 'board.fz', data })).toThrow(BoardFormatError);
    }
  });

  it('identifies renamed AppleDouble metadata without asking for an encryption key', async () => {
    const data = new Uint8Array(64); data.set([0, 5, 0x16, 7, 0, 2, 0, 0]);
    try { parseFz({ name: 'board.fz', data }); throw new Error('expected refusal'); }
    catch (error) { expect(error).toMatchObject({ code: 'WRONG_KIND', issue: { key: 'parse.error.appleDoubleMetadata' } }); }
    const report = await collectDiagnostic({ name: 'board.fz', data }, { os: 'win32' });
    expect(report.detection.adapters.find(entry => entry.result === 'error')).toMatchObject({ id: 'fz', code: 'WRONG_KIND', stage: 'header', keyKind: null });
  });
});
