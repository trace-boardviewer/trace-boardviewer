import { describe, expect, it } from 'vitest';
import {
  captureModeOf, createMeterDecoder, encodeBm86xFrame, encodeEs51922Frame, encodeOwonB35Frame, encodeUt61EplusFrame, METER_FAMILIES, modeCoupling,
  storedReadingModeOf, type DecoderFamilyId, type MeterFamilyId, type MeterMode,
} from './index';

const bytes = (text: string): number[] => Array.from(text, ch => ch.charCodeAt(0));

describe('family registry', () => {
  it('describes every family, and labels the real meters experimental', () => {
    const ids = Object.keys(METER_FAMILIES) as MeterFamilyId[];
    expect(ids.sort()).toEqual(['brymen-bm86x', 'file-bridge', 'fluke-28x', 'owon-b35', 'simulated', 'ut61e', 'ut61eplus']);
    for (const id of ids) expect(METER_FAMILIES[id].id).toBe(id);
    for (const id of ['brymen-bm86x', 'fluke-28x', 'owon-b35', 'ut61e', 'ut61eplus'] as const) {
      const info = METER_FAMILIES[id];
      expect(info.status, id).toBe('experimental');
      expect(info.models.length, id).toBeGreaterThan(0);
      expect(info.documents.length, id).toBeGreaterThan(0);
      expect(['serial', 'hid', 'ble']).toContain(info.link);
    }
    expect(METER_FAMILIES['file-bridge'].status).toBe('tool');
    expect(METER_FAMILIES.simulated.status).toBe('simulated');
  });

  it('makes a decoder for every byte family, and each decodes its own frame', () => {
    const cases: Array<[DecoderFamilyId, number[], string]> = [
      ['ut61e', [...encodeEs51922Frame({ range: 1, count: 12345, func: 0x0b, dc: true })], 'dcVolts'],
      ['ut61eplus', [...encodeUt61EplusFrame({ mode: 2, range: 0, display: ' 4.5120' })], 'dcVolts'],
      ['owon-b35', [...encodeOwonB35Frame({ func: 0, scale: 4, decimals: 3, count: 1234 })], 'dcVolts'],
      ['fluke-28x', bytes('5.2345E+0,VDC,NORMAL,NONE\r'), 'dcVolts'],
      ['brymen-bm86x', [...encodeBm86xFrame({ main: ' 12340', mainPoint: 4, lit: ['3.4', '11.0'] })], 'dcVolts'],
      ['file-bridge', bytes('1.5 V DC\n'), 'dcVolts'],
    ];
    for (const [family, frame, mode] of cases) {
      const decoder = createMeterDecoder(family, () => 42);
      expect(decoder.family).toBe(family);
      const [reading] = decoder.push(frame);
      expect(reading, family).toBeDefined();
      expect(reading.mode, family).toBe(mode);
      expect(reading.family, family).toBe(family);
      expect(reading.at, family).toBe(42);
      expect(decoder.stats.frames, family).toBe(1);
    }
  });

  it('feeds every decoder garbage without throwing', () => {
    const families: DecoderFamilyId[] = ['ut61e', 'ut61eplus', 'owon-b35', 'fluke-28x', 'brymen-bm86x', 'file-bridge'];
    let seed = 2024;
    for (const family of families) {
      const decoder = createMeterDecoder(family);
      for (let round = 0; round < 100; round++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const chunk = Array.from({ length: seed % 70 }, (_, k) => (seed >>> (k % 22)) & 0xff);
        expect(() => decoder.push(chunk, round), family).not.toThrow();
      }
      expect(decoder.stats.bytes, family).toBeGreaterThan(0);
    }
  });
});

describe('mode helpers', () => {
  it('maps meter modes to capture modes and to the stored reading modes of the readings schema', () => {
    const table: Array<[MeterMode, string, string]> = [
      ['dcVolts', 'voltage', 'voltage'], ['acVolts', 'voltage', 'voltage'], ['acdcVolts', 'voltage', 'voltage'],
      ['dcAmps', 'current', 'current'], ['acAmps', 'current', 'current'],
      ['resistance', 'resistance', 'resistance'], ['continuity', 'continuity', 'resistance'], ['diode', 'diode', 'diode'],
      ['capacitance', 'capacitance', 'capacitance'], ['frequency', 'frequency', 'frequency'], ['temperature', 'temperature', 'other'],
      ['duty', 'other', 'other'], ['conductance', 'other', 'other'], ['transistorGain', 'other', 'other'], ['ncv', 'other', 'other'], ['other', 'other', 'other'],
    ];
    for (const [mode, capture, stored] of table) {
      expect(captureModeOf(mode), mode).toBe(capture);
      expect(storedReadingModeOf(mode), mode).toBe(stored);
    }
    expect(modeCoupling('dcVolts')).toBe('dc');
    expect(modeCoupling('acAmps')).toBe('ac');
    expect(modeCoupling('acdcVolts')).toBe('acdc');
    expect(modeCoupling('resistance')).toBeNull();
  });
});
