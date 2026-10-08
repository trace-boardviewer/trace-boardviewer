import { describe, expect, it } from 'vitest';
import {
  createFluke28xDecoder, FLUKE_28X_COMMANDS, FLUKE_28X_INFO, FLUKE_28X_SERIAL, parseFlukeIdentity, parseFlukeQdda, parseFlukeQm,
} from './fluke-28x';

const bytes = (text: string): number[] => Array.from(text, ch => ch.charCodeAt(0));
const at = 9000;
const lines = (...rows: string[]): number[] => bytes(rows.map(row => `${row}\r`).join(''));
const decodeText = (text: string) => createFluke28xDecoder().push(bytes(text), at);

// QM: value,unit,state,attribute. QDDA: function,secondary,autorange,unit,range,multiplier,bolt,minmax time,modes,{modes},readings,{9 fields each}.
const QDDA_VDC = 'V_DC,INACTIVE,AUTO,VDC,2,0,OFF,0,1,HOLD,1,PRIMARY,5.2345E+0,VDC,0,4,5,NORMAL,NONE,12345.6789';

describe('Fluke 28x commands and link', () => {
  it('is a 115200 8N1 line with CR terminated commands', () => {
    expect(FLUKE_28X_SERIAL).toEqual({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
    expect([...FLUKE_28X_COMMANDS.qm]).toEqual(bytes('QM\r'));
    expect([...FLUKE_28X_COMMANDS.id]).toEqual(bytes('ID\r'));
    expect([...FLUKE_28X_COMMANDS.qdda]).toEqual(bytes('QDDA\r'));
  });
});

describe('Fluke 28x QM lines', () => {
  it('decodes DC volts, marked ambiguous because QM does not name the function', () => {
    const [reading] = decodeText('5.2345E+0,VDC,NORMAL,NONE\r');
    expect(reading).toMatchObject({ family: 'fluke-28x', mode: 'dcVolts', unit: 'V', value: 5.2345, at, caveat: 'mode-ambiguous' });
    expect(reading.flags).toMatchObject({ ol: false, invalid: false });
  });

  it('decodes negative values and small exponents', () => {
    expect(decodeText('-1.2340E-3,VDC,NORMAL,NONE\r')[0].value).toBe(-0.001234);
    expect(decodeText('-1.2340E-3,VDC,NORMAL,NONE\r')[0].value).toBeCloseTo(-1.234e-3, 15);
    expect(decodeText('0.0000E+0,VDC,NORMAL,NONE\r')[0].value).toBe(0);
  });

  const TABLE: Array<[string, string, string, string, number]> = [
    ['AC volts', '2.3010E+2,VAC,NORMAL,NONE', 'acVolts', 'V', 230.1],
    ['AC+DC volts', '1.0000E+0,VAC_PLUS_DC,NORMAL,NONE', 'acdcVolts', 'V', 1],
    ['DC amps', '1.2500E-2,ADC,NORMAL,NONE', 'dcAmps', 'A', 0.0125],
    ['AC amps', '1.2500E-2,AAC,NORMAL,NONE', 'acAmps', 'A', 0.0125],
    ['AC+DC amps', '2.5000E-1,AAC_PLUS_DC,NORMAL,NONE', 'acdcAmps', 'A', 0.25],
    ['ohm', '4.7000E+3,OHM,NORMAL,NONE', 'resistance', 'Ω', 4700],
    ['conductance', '2.0000E-3,SIE,NORMAL,NONE', 'conductance', 'S', 0.002],
    ['frequency', '1.0000E+3,Hz,NORMAL,POSITIVE_EDGE', 'frequency', 'Hz', 1000],
    ['capacitance', '4.7000E-8,F,NORMAL,NONE', 'capacitance', 'F', 4.7e-8],
    ['celsius', '2.3500E+1,CEL,NORMAL,NONE', 'temperature', '°C', 23.5],
    ['fahrenheit', '7.4300E+1,FAR,NORMAL,NONE', 'temperature', '°F', 74.3],
    ['duty cycle', '5.0000E+1,PCT,NORMAL,NONE', 'duty', '%', 50],
    ['lower case units', '5.0000E+0,vdc,normal,none', 'dcVolts', 'V', 5],
  ];
  it.each(TABLE)('maps %s', (_name, line, mode, unit, value) => {
    const [reading] = decodeText(`${line}\r`);
    expect(reading.mode).toBe(mode);
    expect(reading.unit).toBe(unit);
    expect(reading.value! / (value || 1)).toBeCloseTo(value === 0 ? 0 : 1, 12);
  });

  it('tells a good diode from DC volts and an open or shorted continuity check from resistance', () => {
    const [diode] = decodeText('5.1230E-1,VDC,NORMAL,GOOD_DIODE\r');
    expect(diode).toMatchObject({ mode: 'diode', value: 0.5123 });
    expect(diode.caveat).toBeUndefined();
    expect(decodeText('1.2000E+1,OHM,NORMAL,SHORT_CIRCUIT\r')[0].mode).toBe('continuity');
    expect(decodeText('9.99999999E+37,OHM,OL,OPEN_CIRCUIT\r')[0].mode).toBe('continuity');
  });

  it('reports over-range, negative over-range and invalid states without a value', () => {
    const [ol] = decodeText('9.99999999E+37,OHM,OL,NONE\r');
    expect(ol).toMatchObject({ mode: 'resistance', value: null, display: 'OL' });
    expect(ol.flags.ol).toBe(true);
    const [minus] = decodeText('9.99999999E+37,VDC,OL_MINUS,NONE\r');
    expect(minus).toMatchObject({ value: null, display: '-OL' });
    expect(minus.flags.ol).toBe(true);
    for (const state of ['INVALID', 'BLANK', 'DISCHARGE', 'OPEN_TC', 'SOMETHING_NEW']) {
      const [reading] = decodeText(`9.99999999E+37,VDC,${state},NONE\r`);
      expect(reading.value, state).toBeNull();
      expect(reading.flags.invalid, state).toBe(true);
      expect(reading.flags.ol, state).toBe(false);
    }
  });

  it('parses single lines directly and rejects what is not a QM line', () => {
    expect(parseFlukeQm('5.0,VDC,NORMAL,NONE', 1)?.value).toBe(5);
    expect(parseFlukeQm('5.0,VDC,NORMAL', 1)).toBeNull();
    expect(parseFlukeQm('five,VDC,NORMAL,NONE', 1)).toBeNull();
    expect(parseFlukeQm('5.0,PARSEC,NORMAL,NONE', 1)).toBeNull();
    expect(parseFlukeQm('', 1)).toBeNull();
  });
});

describe('Fluke 28x QDDA lines', () => {
  it('names the function, so there is no ambiguity, and reads hold and resolution', () => {
    const [reading] = decodeText(`${QDDA_VDC}\r`);
    expect(reading).toMatchObject({ mode: 'dcVolts', unit: 'V', value: 5.2345 });
    expect(reading.caveat).toBeUndefined();
    expect(reading.flags).toMatchObject({ auto: true, hold: true, rel: false });
    expect(reading.resolution).toBeCloseTo(1e-4, 14);
  });

  it('reads a secondary display and function changes', () => {
    const line = 'OHMS,V_AC,MANUAL,OHM,3,3,OFF,0,0,2,PRIMARY,4.7000E+0,OHM,3,4,5,NORMAL,NONE,1.5,SECONDARY,1.2000E+0,VAC,0,3,4,NORMAL,NONE,1.6';
    const [reading] = decodeText(`${line}\r`);
    expect(reading).toMatchObject({ mode: 'resistance', unit: 'Ω', value: 4.7 });
    expect(reading.flags.auto).toBe(false);
    expect(reading.resolution).toBeCloseTo(1e-1, 12);
    expect(reading.secondary).toMatchObject({ value: 1.2, unit: 'V' });
    const diode = 'DIODE_TEST,INACTIVE,AUTO,VDC,0,0,OFF,0,0,1,PRIMARY,5.1230E-1,VDC,0,4,5,NORMAL,GOOD_DIODE,2.0';
    expect(decodeText(`${diode}\r`)[0]).toMatchObject({ mode: 'diode', value: 0.5123 });
    const over = 'OHMS,INACTIVE,AUTO,OHM,6,6,OFF,0,0,1,PRIMARY,9.99999999E+37,OHM,6,4,5,OL,NONE,2.0';
    const [ol] = decodeText(`${over}\r`);
    expect(ol.flags.ol).toBe(true);
    expect(ol.value).toBeNull();
    const ac = 'V_AC,INACTIVE,AUTO,VAC,2,0,OFF,0,0,1,PRIMARY,2.3010E+2,VAC,0,2,5,NORMAL,NONE,2.0';
    expect(decodeText(`${ac}\r`)[0]).toMatchObject({ mode: 'acVolts', value: 230.1 });
  });

  it('rejects QDDA lines whose counts do not add up', () => {
    expect(parseFlukeQdda(QDDA_VDC.replace(',1,PRIMARY', ',2,PRIMARY'), 1)).toBeNull();
    expect(parseFlukeQdda(QDDA_VDC.slice(0, QDDA_VDC.lastIndexOf(',')), 1)).toBeNull();
    expect(parseFlukeQdda(QDDA_VDC.replace('V_DC', 'NOT_A_FUNCTION'), 1)).toBeNull();
    expect(parseFlukeQdda(QDDA_VDC.replace(',0,1,HOLD,1,', ',0,99,HOLD,1,'), 1)).toBeNull();
    expect(parseFlukeQdda(QDDA_VDC.replace('PRIMARY', 'TERTIARY'), 1)).toBeNull();
    expect(parseFlukeQdda('', 1)).toBeNull();
  });
});

describe('Fluke 28x stream', () => {
  const STREAM = [
    ...lines('0', 'FLUKE 289,V1.00,95081087'),
    ...lines('0', '5.2345E+0,VDC,NORMAL,NONE'),
    ...lines('0', '9.99999999E+37,OHM,OL,NONE'),
    ...lines('0', QDDA_VDC),
  ];
  const run = (size: number) => {
    const decoder = createFluke28xDecoder();
    const out = [];
    for (let i = 0; i < STREAM.length; i += size) out.push(...decoder.push(STREAM.slice(i, i + size), i));
    return { out: out.map(r => [r.mode, r.value, r.flags.ol]), decoder };
  };

  it('reads acknowledgements, identity and readings in any chunking', () => {
    const whole = run(STREAM.length);
    expect(whole.out).toEqual([['dcVolts', 5.2345, false], ['resistance', null, true], ['dcVolts', 5.2345, false]]);
    expect(whole.decoder.identity).toMatchObject({ model: 'FLUKE 289', version: 'V1.00', serial: '95081087' });
    expect(whole.decoder.lastAck).toBe(0);
    expect(whole.decoder.ackErrors).toBe(0);
    expect(whole.decoder.stats).toMatchObject({ frames: 8, readings: 3, badFrames: 0, skippedBytes: 0 });
    for (const size of [1, 2, 3, 7, 16, 33, 100]) expect(run(size).out, `chunk ${size}`).toEqual(whole.out);
  });

  it('counts error acknowledgements, with or without the command echo of the 189', () => {
    const decoder = createFluke28xDecoder();
    decoder.push(lines('1', 'QM,2', 'QM,0', '5'));
    expect(decoder.lastAck).toBe(5);
    expect(decoder.ackErrors).toBe(3);
    expect(decoder.stats.readings).toBe(0);
  });

  it('accepts CR LF line ends and blank lines', () => {
    const decoder = createFluke28xDecoder();
    const readings = decoder.push(bytes('0\r\n5.2345E+0,VDC,NORMAL,NONE\r\n\r\n\r\n5.2346E+0,VDC,NORMAL,NONE\r\n'));
    expect(readings.map(r => r.value)).toEqual([5.2345, 5.2346]);
  });

  it('skips binary garbage and lines it does not know, and keeps going', () => {
    const decoder = createFluke28xDecoder();
    const stream = [0x00, 0xff, 0x80, ...lines('5.0000E+0,VDC,NORMAL,NONE'), ...bytes('hello world\r'), 0x01, 0x02, ...lines('6.0000E+0,VDC,NORMAL,NONE')];
    expect(decoder.push(stream).map(r => r.value)).toEqual([5, 6]);
    expect(decoder.stats.badFrames).toBeGreaterThanOrEqual(1);
    expect(decoder.stats.resyncs).toBeGreaterThanOrEqual(1);
  });

  it('drops a line cut by garbage in the middle', () => {
    const decoder = createFluke28xDecoder();
    const readings = decoder.push([...bytes('5.2345E+'), 0x00, ...bytes('0,VDC,NORMAL,NONE\r'), ...lines('7.0000E+0,VDC,NORMAL,NONE')]);
    expect(readings.map(r => r.value)).toEqual([7]);
  });

  it('bounds a line that never ends', () => {
    const decoder = createFluke28xDecoder();
    expect(decoder.push(new Array(5000).fill(0x41))).toEqual([]);
    expect(decoder.push(lines('', '7.0000E+0,VDC,NORMAL,NONE')).map(r => r.value)).toEqual([7]);
    expect(decoder.stats.badFrames).toBeGreaterThanOrEqual(1);
  });

  it('reset forgets a half line but keeps the identity', () => {
    const decoder = createFluke28xDecoder();
    decoder.push(lines('FLUKE 287,V2.00,1'));
    decoder.push(bytes('5.2345E+0,VDC'));
    decoder.reset();
    expect(decoder.push(bytes(',NORMAL,NONE\r'))).toEqual([]);
    expect(decoder.identity?.model).toBe('FLUKE 287');
    expect(decoder.push(lines('8.0000E+0,VDC,NORMAL,NONE'))[0].value).toBe(8);
  });

  it('parses identity lines on their own', () => {
    expect(parseFlukeIdentity('FLUKE 287,V1.04,12345678')).toMatchObject({ model: 'FLUKE 287', version: 'V1.04', serial: '12345678' });
    expect(parseFlukeIdentity('ACME 1000,V1,2')).toBeNull();
  });

  it('describes itself as experimental over a serial link', () => {
    expect(FLUKE_28X_INFO).toMatchObject({ id: 'fluke-28x', status: 'experimental', link: 'serial' });
  });
});
