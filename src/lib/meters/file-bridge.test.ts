import { describe, expect, it } from 'vitest';
import { createFileBridge, FILE_BRIDGE_INFO, parseMeterLine, parseUnitToken, parseValueCell, type FileBridge, type FileStat } from './file-bridge';
import { createStabilityDetector } from './stability';
import type { MeterReading } from './types';

const at = 20000;
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A file that grows, shrinks and is replaced; `poll` does what a transport does: stat, plan, read, consume. */
class FakeFile {
  bytes = new Uint8Array(0);
  id = 'a';
  mtimeMs = 1;
  append(text: string | Uint8Array): this { const add = typeof text === 'string' ? enc(text) : text; const next = new Uint8Array(this.bytes.length + add.length); next.set(this.bytes); next.set(add, this.bytes.length); this.bytes = next; this.mtimeMs++; return this; }
  write(text: string, id = this.id): this { this.bytes = enc(text); this.id = id; this.mtimeMs++; return this; }
  stat(): FileStat { return { size: this.bytes.length, mtimeMs: this.mtimeMs, fileId: this.id }; }
  read(offset: number, length: number): Uint8Array { return this.bytes.slice(offset, offset + length); }
}

function poll(bridge: FileBridge, file: FakeFile, time = at): MeterReading[] {
  const plan = bridge.plan(file.stat());
  return plan.kind === 'read' ? bridge.consume(file.read(plan.offset, plan.length), time) : [];
}
/** Poll until the bridge says idle; collects everything. */
function drain(bridge: FileBridge, file: FakeFile, time = at): MeterReading[] {
  const out: MeterReading[] = [];
  for (let i = 0; i < 1000; i++) {
    const plan = bridge.plan(file.stat());
    if (plan.kind === 'idle') return out;
    out.push(...bridge.consume(file.read(plan.offset, plan.length), time));
  }
  throw new Error('the bridge never went idle');
}

describe('units', () => {
  it.each([
    ['V', 'V', 0], ['mV', 'V', -3], ['uV', 'V', -6], ['µV', 'V', -6], ['kV', 'V', 3], ['A', 'A', 0], ['mA', 'A', -3], ['uA', 'A', -6], ['µA', 'A', -6],
    ['Ohm', 'Ω', 0], ['ohm', 'Ω', 0], ['OHMS', 'Ω', 0], ['Ω', 'Ω', 0], ['Ω', 'Ω', 0], ['kOhm', 'Ω', 3], ['kΩ', 'Ω', 3], ['MOhm', 'Ω', 6], ['MΩ', 'Ω', 6], ['mΩ', 'Ω', -3],
    ['F', 'F', 0], ['nF', 'F', -9], ['pF', 'F', -12], ['uF', 'F', -6], ['µF', 'F', -6], ['μF', 'F', -6], ['mF', 'F', -3],
    ['Hz', 'Hz', 0], ['kHz', 'Hz', 3], ['MHz', 'Hz', 6], ['%', '%', 0], ['C', '°C', 0], ['°C', '°C', 0], ['°F', '°F', 0], ['degC', '°C', 0], ['dB', 'dB', 0],
    ['S', 'S', 0], ['mS', 'S', -3], ['s', 's', 0], ['ms', 's', -3], ['V.', 'V', 0],
  ])('reads %s', (token, unit, exp) => {
    expect(parseUnitToken(token)).toMatchObject({ unit, exp });
  });

  it('rejects what is not a unit', () => {
    for (const token of ['', 'x', 'volts', 'DC', 'AUTO', 'kx', 'Q', '12', 'hello']) expect(parseUnitToken(token), token).toBeNull();
  });
});

describe('free text lines', () => {
  const one = (line: string, options = {}) => parseMeterLine(line, at, options);

  it('reads a sigrok-style line: channel label, value, unit and flag words', () => {
    const reading = one('P1: 1.2345 V DC AUTO')!;
    expect(reading).toMatchObject({ family: 'file-bridge', mode: 'dcVolts', unit: 'V', value: 1.2345, display: '1.2345', at });
    expect(reading.flags).toMatchObject({ auto: true, hold: false, ol: false });
    expect(reading.caveat).toBeUndefined();
    expect(reading.resolution).toBeUndefined();
    expect(one('P1: -0.0850 V DC HOLD')).toMatchObject({ value: -0.085, mode: 'dcVolts' });
    expect(one('P1: -0.0850 V DC HOLD')!.flags.hold).toBe(true);
    expect(one('P1:2.5 V DC')).toMatchObject({ value: 2.5 });
    expect(one('Channel 2: 5.0 V AC')).toMatchObject({ mode: 'acVolts', value: 5 });
  });

  const TABLE: Array<[string, string, string, number]> = [
    ['4.7 kOhm', 'resistance', 'Ω', 4700],
    ['4.7 kΩ', 'resistance', 'Ω', 4700],
    ['4.7kΩ', 'resistance', 'Ω', 4700],
    ['2.2 MOhm', 'resistance', 'Ω', 2.2e6],
    ['12.5 mV AC', 'acVolts', 'V', 0.0125],
    ['12.5 mV AC+DC', 'acdcVolts', 'V', 0.0125],
    ['0.512 V DIODE', 'diode', 'V', 0.512],
    ['100 nF', 'capacitance', 'F', 1e-7],
    ['2.2 µF', 'capacitance', 'F', 2.2e-6],
    ['2.2 uF', 'capacitance', 'F', 2.2e-6],
    ['50 Hz', 'frequency', 'Hz', 50],
    ['1.2 MHz', 'frequency', 'Hz', 1.2e6],
    ['60.5 %', 'duty', '%', 60.5],
    ['23.5 C', 'temperature', '°C', 23.5],
    ['74.3 °F', 'temperature', '°F', 74.3],
    ['10 mA DC', 'dcAmps', 'A', 0.01],
    ['10 mA AC', 'acAmps', 'A', 0.01],
    ['12 Ohm CONT', 'continuity', 'Ω', 12],
    ['1.5e3 Ω', 'resistance', 'Ω', 1500],
    ['1.5E-3 V DC', 'dcVolts', 'V', 0.0015],
    ['+3.3 V DC', 'dcVolts', 'V', 3.3],
    ['.5 V DC', 'dcVolts', 'V', 0.5],
    ['5. V DC', 'dcVolts', 'V', 5],
    ['-0.085V DC', 'dcVolts', 'V', -0.085],
    ['  4.7   kOhm  ', 'resistance', 'Ω', 4700],
    ['1.5e-7 V DC', 'dcVolts', 'V', 1.5e-7],
  ];
  it.each(TABLE)('maps %j', (line, mode, unit, value) => {
    const reading = one(line)!;
    expect(reading.mode).toBe(mode);
    expect(reading.unit).toBe(unit);
    expect(reading.value! / value).toBeCloseTo(1, 12);
  });

  it('marks a volt or ampere line without DC or AC, and a bare number, as ambiguous', () => {
    expect(one('5 V')).toMatchObject({ mode: 'dcVolts', unit: 'V', value: 5, caveat: 'mode-ambiguous' });
    expect(one('5 mA')).toMatchObject({ mode: 'dcAmps', caveat: 'mode-ambiguous' });
    expect(one('5')).toMatchObject({ mode: 'other', unit: '', value: 5, caveat: 'mode-ambiguous' });
    expect(one('4.7 kOhm')!.caveat).toBeUndefined();
  });

  it('lets the caller say what a file holds, for gaps only', () => {
    const assume = { mode: 'dcVolts' as const, unit: 'V' as const };
    expect(one('5', { assume })).toMatchObject({ mode: 'dcVolts', unit: 'V', value: 5 });
    expect(one('5', { assume })!.caveat).toBeUndefined();
    expect(one('5 V', { assume })!.caveat).toBeUndefined();
    expect(one('5 V AC', { assume })!.mode).toBe('acVolts');
    expect(one('5 kOhm', { assume })).toMatchObject({ mode: 'resistance', value: 5000 });
    expect(one('5 mA', { assume })!.caveat).toBe('mode-ambiguous');
    expect(one('OL', { assume })).toMatchObject({ mode: 'dcVolts', unit: 'V' });
  });

  it('reads over-range in its spellings, and the display value of some meters', () => {
    for (const line of ['OL', 'ol', 'O.L', 'O.L.', '0L', 'OVERLOAD', 'OPEN', 'INF', '-inf', 'Infinity', 'OL V DC', 'P1: OL Ohm', '9.99999999E+37 Ohm', '-9.9E+37 V DC', '1e999 V DC']) {
      const reading = one(line)!;
      expect(reading, line).not.toBeNull();
      expect(reading.flags.ol, line).toBe(true);
      expect(reading.value, line).toBeNull();
      expect(reading.display, line).toBe('OL');
    }
    expect(one('P1: OL Ohm')).toMatchObject({ mode: 'resistance', unit: 'Ω' });
    expect(one('3.3 V DC OL')!.flags.ol).toBe(true);
  });

  it('reads flag words', () => {
    const reading = one('1.5 V DC HOLD REL AUTO MIN MAX LOWBAT')!;
    expect(reading.flags).toMatchObject({ hold: true, rel: true, auto: true, min: true, max: true, lowBattery: true });
    expect(one('1.5 V DC RELATIVE')!.flags.rel).toBe(true);
    expect(one('1.5 V DC AUTORANGE')!.flags.auto).toBe(true);
    expect(one('1.5 V DC, HOLD')!.flags.hold).toBe(true);
  });

  it('never gives a negative zero', () => {
    expect(Object.is(one('-0.000 V DC')!.value, 0)).toBe(true);
    expect(Object.is(one('-0 kOhm')!.value, 0)).toBe(true);
  });

  it('does not take other lines for readings', () => {
    for (const line of ['', '   ', 'hello', 'Open circuit', '3 samples dropped', 'Connected to meter', 'Mode: DC', 'V', 'kOhm', '12:00:01 1.5 V', '2026-10-07 12:00:01',
      '10/07/2026', '1.2.3 V', '--5 V', 'e5', 'one,two,three']) {
      expect(one(line), JSON.stringify(line)).toBeNull();
    }
  });

  it('reads a bare number followed by known words only', () => {
    expect(one('5 DC')).toMatchObject({ value: 5, mode: 'other' });
    expect(one('5 volts')).toBeNull();
    expect(parseValueCell('5 apples', false)).toBeNull();
    expect(parseValueCell('5 V apples', false)).toMatchObject({ mantissa: '5', words: ['apples'] });
  });
});

describe('CSV lines', () => {
  const one = (line: string, options = {}) => parseMeterLine(line, at, options);

  it('reads value, unit and flags from comma separated fields, in or beside the value cell', () => {
    expect(one('1.234,V,DC')).toMatchObject({ mode: 'dcVolts', unit: 'V', value: 1.234 });
    expect(one('1.234 V,DC')).toMatchObject({ mode: 'dcVolts', unit: 'V', value: 1.234 });
    expect(one('1.234 V DC,AUTO')!.flags.auto).toBe(true);
    expect(one('4.7,kOhm')).toMatchObject({ mode: 'resistance', value: 4700 });
    expect(one('4.7,kOhm,HOLD')!.flags.hold).toBe(true);
    expect(one('OL,Ohm')).toMatchObject({ mode: 'resistance', value: null });
    expect(one('OL,Ohm')!.flags.ol).toBe(true);
    expect(one('"1.234","V","DC"')).toMatchObject({ mode: 'dcVolts', value: 1.234 });
    expect(one('"1,5 V",DC')).toBeNull();
  });

  it('skips timestamp fields in front of the value', () => {
    expect(one('2026-10-07T12:00:01,1.234,V,DC')).toMatchObject({ value: 1.234, mode: 'dcVolts' });
    expect(one('2026-10-07 12:00:01,1.234,V,DC')).toMatchObject({ value: 1.234 });
    expect(one('12:00:01,1.234,V,DC')).toMatchObject({ value: 1.234 });
    expect(one('first,second,third')).toBeNull();
  });

  it('can pin the value column when a numeric timestamp comes first', () => {
    expect(one('1696672800.5,1.234,V,DC')!.value).toBe(1696672800.5);
    expect(one('1696672800.5,1.234,V,DC', { valueColumn: 1 })).toMatchObject({ value: 1.234, mode: 'dcVolts' });
    expect(one('1696672800.5,abc,V,DC', { valueColumn: 1 })).toBeNull();
  });

  it('reads semicolon and tab separated lines with a decimal comma', () => {
    expect(one('1,234;V;DC')).toMatchObject({ value: 1.234, mode: 'dcVolts' });
    expect(one('4,7;kOhm')).toMatchObject({ value: 4700, mode: 'resistance' });
    expect(one('1,234\tV\tDC')).toMatchObject({ value: 1.234 });
    expect(one('1.234;V;DC')).toMatchObject({ value: 1.234 });
    expect(one('1,234 V DC', { decimal: ',' })).toMatchObject({ value: 1.234, mode: 'dcVolts' });
    // One comma between digits and then a unit is read as a decimal comma by default.
    expect(one('1,234 V DC')).toMatchObject({ value: 1.234, mode: 'dcVolts' });
    expect(one('-12,5 kOhm')).toMatchObject({ value: -12500, mode: 'resistance' });
    // Without a unit it stays a comma separated line.
    expect(one('1,234')).toMatchObject({ value: 1 });
    expect(one('1.234;V;DC', { decimal: ',' })).toMatchObject({ value: 1.234 });
    expect(one('1,234;V;DC', { decimal: '.' })).toBeNull();
  });
});

describe('header rows', () => {
  it('maps named columns and ignores time and index columns', () => {
    const bridge = createFileBridge({ mode: 'snapshot' });
    const readings = bridge.consume(enc('index,Time,Value,Unit,Mode,Flags\n1,2026-10-07T12:00:01,1.234,V,DC,AUTO\n2,2026-10-07T12:00:02,4.7,kOhm,RES,HOLD\n'), at);
    // A snapshot keeps the last line only.
    expect(readings.length).toBe(1);
    expect(readings[0]).toMatchObject({ mode: 'resistance', value: 4700 });
    expect(readings[0].flags.hold).toBe(true);
  });

  it('reads every row when tailing, and takes a mode column that has the whole story', () => {
    const bridge = createFileBridge();
    const readings = bridge.push(enc('time;reading;function\n12:00:01;12,5;DCV\n12:00:02;1,5;ACV\n12:00:03;OL;OHM\n12:00:04;0,512;Diode\n12:00:05;5,0;cap\n'), at);
    expect(readings.map(r => [r.mode, r.unit, r.value])).toEqual([
      ['dcVolts', 'V', 12.5], ['acVolts', 'V', 1.5], ['resistance', 'Ω', null], ['diode', 'V', 0.512], ['capacitance', 'F', 5],
    ]);
    expect(bridge.detail.ignoredLines).toBe(1);
    expect(bridge.detail.badLines).toBe(0);
    expect(readings.every(r => r.caveat === undefined)).toBe(true);
  });

  it('takes a unit from its own column', () => {
    const bridge = createFileBridge();
    const readings = bridge.push(enc('value,unit\n4.7,kOhm\n3.3,V\n'), at);
    expect(readings.map(r => [r.mode, r.value])).toEqual([['resistance', 4700], ['dcVolts', 3.3]]);
    expect(readings[1].caveat).toBe('mode-ambiguous');
  });

  it('follows a new header when the file starts again', () => {
    const bridge = createFileBridge();
    const first = bridge.push(enc('t,value,unit\n0,1.5,V\n'), at);
    const second = bridge.push(enc('value,unit,t\n2.5,V,1\n'), at);
    expect([...first, ...second].map(r => r.value)).toEqual([1.5, 2.5]);
  });

  it('counts a data row without a value as a bad line', () => {
    const bridge = createFileBridge();
    expect(bridge.push(enc('time,value,unit\n0,,V\n1,abc,V\n2,1.5,V\n'), at).map(r => r.value)).toEqual([1.5]);
    expect(bridge.detail.badLines).toBe(2);
  });
});

describe('tailing', () => {
  it('holds a partial line until its newline arrives', () => {
    const bridge = createFileBridge();
    expect(bridge.consume(enc('1.5 V DC\n2.5 V'), at).map(r => r.value)).toEqual([1.5]);
    expect(bridge.consume(enc(' DC'), at)).toEqual([]);
    expect(bridge.consume(enc('\n3.5 V DC\n'), at).map(r => r.value)).toEqual([2.5, 3.5]);
    expect(bridge.cursor).toBe(enc('1.5 V DC\n2.5 V DC\n3.5 V DC\n').length);
  });

  it('accepts LF, CRLF and CR line ends, blank lines and comments', () => {
    const bridge = createFileBridge();
    const text = '# sigrok-cli output\r\n1.5 V DC\r\n\r\n; another comment\n2.5 V DC\r3.5 V DC\n// done\n';
    expect(bridge.consume(enc(text), at).map(r => r.value)).toEqual([1.5, 2.5, 3.5]);
    expect(bridge.detail).toMatchObject({ ignoredLines: 4, badLines: 0 });
    expect(bridge.stats).toMatchObject({ readings: 3, frames: 3, badFrames: 0 });
  });

  it('counts lines that hold no reading', () => {
    const bridge = createFileBridge();
    expect(bridge.consume(enc('1.5 V DC\nlogger started\n2.5 V DC\n'), at).map(r => r.value)).toEqual([1.5, 2.5]);
    expect(bridge.detail.badLines).toBe(1);
    expect(bridge.stats).toMatchObject({ readings: 2, frames: 2, badFrames: 1 });
  });

  it('gives every reading of a read the same arrival time', () => {
    const bridge = createFileBridge();
    const readings = bridge.consume(enc('1 V DC\n2 V DC\n3 V DC\n'), 777);
    expect(readings.map(r => r.at)).toEqual([777, 777, 777]);
    let clock = 5;
    const timed = createFileBridge({ now: () => clock++ });
    expect(timed.push(enc('1 V DC\n'))[0].at).toBe(5);
  });

  it('decodes UTF-8 characters split across reads, a BOM, and UTF-16 LE written by a Windows shell', () => {
    const bridge = createFileBridge();
    const text = enc('4.7 kΩ\n');
    const split = text.indexOf(0xce) + 1; // between the two bytes of the omega
    expect(bridge.consume(text.slice(0, split), at)).toEqual([]);
    expect(bridge.consume(text.slice(split), at)[0]).toMatchObject({ mode: 'resistance', value: 4700 });

    const withBom = createFileBridge();
    expect(withBom.consume(Uint8Array.of(0xef, 0xbb, 0xbf, ...enc('1.5 V DC\n')), at)[0].value).toBe(1.5);

    const utf16 = (text: string): number[] => [0xff, 0xfe, ...Array.from(text, ch => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8]).flat()];
    const wide = utf16('1.5 V DC\r\n2.5 kΩ\r\n');
    for (const size of [1, 2, 3, 5, 7, wide.length]) {
      const bridgeW = createFileBridge();
      const out: MeterReading[] = [];
      for (let i = 0; i < wide.length; i += size) out.push(...bridgeW.consume(wide.slice(i, i + size), at));
      expect(out.map(r => r.value), `chunk ${size}`).toEqual([1.5, 2500]);
    }
  });

  it('survives binary garbage and overlong lines, and goes on with the next line', () => {
    const bridge = createFileBridge({ maxLine: 200 });
    const garbage = new Uint8Array(500).map((_, i) => (i * 37 + 11) & 0xff);
    const out = [
      ...bridge.consume(garbage, at),
      ...bridge.consume(enc('\n1.5 V DC\n'), at),
      ...bridge.consume(enc('x'.repeat(1000)), at),
      ...bridge.consume(enc('y'.repeat(1000) + '\n2.5 V DC\n'), at),
      ...bridge.consume(enc('3.5 V DC\n'), at),
    ];
    expect(out.map(r => r.value)).toEqual([1.5, 2.5, 3.5]);
    expect(bridge.detail.overlongLines).toBeGreaterThanOrEqual(1);
  });

  it('gives up a line that never got its newline on flush()', () => {
    const bridge = createFileBridge();
    expect(bridge.consume(enc('1.5 V DC\n2.5 V DC'), at).map(r => r.value)).toEqual([1.5]);
    expect(bridge.flush(at + 5)).toEqual([expect.objectContaining({ value: 2.5, at: at + 5 })]);
    expect(bridge.flush()).toEqual([]);
    bridge.consume(enc('just words'), at);
    expect(bridge.flush()).toEqual([]);
    expect(bridge.detail.badLines).toBe(1);
  });

  it('forgets a half line on reset() and keeps its counters', () => {
    const bridge = createFileBridge();
    bridge.consume(enc('1.5 V DC\n2.5 V'), at);
    bridge.reset();
    expect(bridge.consume(enc(' DC\n3.5 V DC\n'), at).map(r => r.value)).toEqual([3.5]);
    expect(bridge.stats.readings).toBe(2);
    expect(bridge.detail.badLines).toBe(1);
  });

  it('reads as a plain byte decoder too', () => {
    const bridge = createFileBridge();
    const out = [...bridge.push(enc('1.5 V'), at), ...bridge.push(enc(' DC\n2.5 V DC\n'), at)];
    expect(out.map(r => r.value)).toEqual([1.5, 2.5]);
  });
});

describe('polling a growing file', () => {
  const lines = (from: number, count: number): string => Array.from({ length: count }, (_, i) => `${(from + i).toFixed(3)} V DC\n`).join('');

  it('reads a small file from the start, then only what was added', () => {
    const file = new FakeFile().append(lines(1, 3));
    const bridge = createFileBridge();
    expect(poll(bridge, file).map(r => r.value)).toEqual([1, 2, 3]);
    expect(poll(bridge, file)).toEqual([]);
    expect(bridge.plan(file.stat())).toEqual({ kind: 'idle' });
    file.append(lines(4, 2));
    expect(poll(bridge, file).map(r => r.value)).toEqual([4, 5]);
    file.append('6.000 V');
    expect(poll(bridge, file)).toEqual([]);
    file.append(' DC\n');
    expect(poll(bridge, file).map(r => r.value)).toEqual([6]);
    expect(bridge.cursor).toBe(file.bytes.length);
  });

  it('plans an empty or unknown file as idle', () => {
    const bridge = createFileBridge();
    expect(bridge.plan({ size: 0 })).toEqual({ kind: 'idle' });
    expect(bridge.plan({ size: Number.NaN })).toEqual({ kind: 'idle' });
    expect(bridge.plan({ size: -5 })).toEqual({ kind: 'idle' });
  });

  it('starts near the end of a big file on a line boundary', () => {
    const file = new FakeFile().append(lines(1, 2000)); // about 14 KB
    const bridge = createFileBridge({ startBacklog: 200 });
    const first = poll(bridge, file);
    expect(first.length).toBeGreaterThan(10);
    expect(first.length).toBeLessThanOrEqual(20);
    // Only whole lines, and the last one is the last line of the file.
    expect(first[first.length - 1].value).toBe(2000);
    expect(first.every(r => Number.isInteger(r.value))).toBe(true);
    expect(bridge.detail.badLines).toBe(0);
    expect(bridge.cursor).toBe(file.bytes.length);
  });

  it('does not lose a line when the start falls exactly on a line boundary', () => {
    const body = lines(1, 40);
    const file = new FakeFile().append(body);
    const lineLength = lines(1, 1).length;
    const bridge = createFileBridge({ startBacklog: 64 });
    // Make the backlog start exactly at the start of a line: size - backlog is a multiple of the line length.
    file.append('');
    const probe = createFileBridge({ startBacklog: 64 });
    const plan = probe.plan({ size: lineLength * 10 + 64 });
    expect(plan).toMatchObject({ kind: 'read', offset: lineLength * 10 - 1 });
    expect(poll(bridge, file).at(-1)?.value).toBe(40);
  });

  it('reads at most maxRead bytes per plan and carries lines across reads', () => {
    const file = new FakeFile().append(lines(1, 30));
    const bridge = createFileBridge({ maxRead: 64, startBacklog: 100000 });
    const plan = bridge.plan(file.stat());
    expect(plan).toMatchObject({ kind: 'read', offset: 0, length: 64 });
    const readings = drain(bridge, file);
    expect(readings.length).toBe(30);
    expect(readings.map(r => r.value)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('starts over when the file was truncated', () => {
    const file = new FakeFile().append(lines(1, 5));
    const bridge = createFileBridge();
    expect(poll(bridge, file).length).toBe(5);
    file.write(lines(100, 2));
    expect(poll(bridge, file).map(r => r.value)).toEqual([100, 101]);
    expect(bridge.detail.resets).toBe(1);
    expect(bridge.stats.resyncs).toBe(1);
  });

  it('drops a half line when the file was truncated in the middle of it', () => {
    const file = new FakeFile().append('1.5 V DC\n2.5 V');
    const bridge = createFileBridge();
    expect(poll(bridge, file).map(r => r.value)).toEqual([1.5]);
    file.write('9.5 V DC\n');
    expect(poll(bridge, file).map(r => r.value)).toEqual([9.5]);
  });

  it('sees a rotated file by its id even when the new file is longer than the old cursor', () => {
    const file = new FakeFile().append(lines(1, 2));
    const bridge = createFileBridge();
    expect(poll(bridge, file).length).toBe(2);
    file.write(lines(10, 6), 'b');
    expect(poll(bridge, file).map(r => r.value)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(bridge.detail.resets).toBe(1);
    // Same id and growth: no reset.
    file.append(lines(16, 1));
    expect(poll(bridge, file).map(r => r.value)).toEqual([16]);
    expect(bridge.detail.resets).toBe(1);
  });

  it('skips ahead when it falls too far behind', () => {
    const file = new FakeFile().append(lines(1, 3));
    const bridge = createFileBridge({ startBacklog: 100, maxRead: 200, maxLag: 400 });
    expect(poll(bridge, file).length).toBe(3);
    file.append(lines(4, 500));
    const readings = drain(bridge, file);
    expect(readings[readings.length - 1].value).toBe(503);
    expect(readings.length).toBeLessThan(30);
    expect(bridge.stats.skippedBytes).toBeGreaterThan(3000);
    expect(bridge.stats.resyncs).toBe(1);
  });

  it('survives a file that keeps being rewritten while it is read', () => {
    const file = new FakeFile();
    const bridge = createFileBridge({ maxRead: 100 });
    let expected = 0;
    const seen: number[] = [];
    for (let round = 0; round < 50; round++) {
      file.append(lines(expected + 1, 1 + (round % 4)));
      expected += 1 + (round % 4);
      if (round % 13 === 12) { file.write(lines(1000 * round, 2)); expected = 0; seen.push(-1); }
      for (const reading of drain(bridge, file)) seen.push(reading.value!);
    }
    expect(bridge.detail.badLines).toBe(0);
    expect(seen.length).toBeGreaterThan(40);
  });
});

describe('snapshot files', () => {
  it('reads the whole file when its size or time changes, and the last line is the value', () => {
    const file = new FakeFile().write('1.234 V DC');
    const bridge = createFileBridge({ mode: 'snapshot' });
    expect(poll(bridge, file).map(r => r.value)).toEqual([1.234]);
    expect(poll(bridge, file)).toEqual([]);
    // Same size, new time: a rewrite with the same number of characters.
    file.write('1.235 V DC');
    expect(poll(bridge, file).map(r => r.value)).toEqual([1.235]);
    file.write('4.7 kOhm\n');
    expect(poll(bridge, file)[0]).toMatchObject({ mode: 'resistance', value: 4700 });
    file.write('# value\n2.5 V DC\r\n');
    expect(poll(bridge, file).map(r => r.value)).toEqual([2.5]);
  });

  it('is idle for an empty file, and for one whose last line is no reading', () => {
    const file = new FakeFile();
    const bridge = createFileBridge({ mode: 'snapshot' });
    expect(poll(bridge, file)).toEqual([]);
    file.write('waiting for meter\n');
    expect(poll(bridge, file)).toEqual([]);
    expect(bridge.detail.badLines).toBe(1);
  });

  it('keeps a header row from a snapshot with one', () => {
    const file = new FakeFile().write('value,unit,mode\n4.7,kOhm,RES\n');
    const bridge = createFileBridge({ mode: 'snapshot' });
    expect(poll(bridge, file)[0]).toMatchObject({ mode: 'resistance', value: 4700 });
  });
});

describe('with the stability detector', () => {
  it('captures a value from a logger file polled four times a second', () => {
    const file = new FakeFile();
    const bridge = createFileBridge();
    const detector = createStabilityDetector({ captureMode: 'diode' });
    let fresh = 0;
    let captured: number | null = null;
    const noise = [0.4821, 0.4822, 0.4821, 0.482, 0.4822, 0.4821, 0.4821, 0.4822];
    for (let i = 0; i < noise.length; i++) {
      // One line per poll, 250 ms apart.
      file.append(`P1: ${noise[i].toFixed(4)} V DIODE AUTO\n`);
      for (const reading of poll(bridge, file, 1000 + i * 250)) {
        const status = detector.push(reading);
        if (status.fresh) { fresh++; captured = status.value; }
      }
    }
    expect(fresh).toBe(1);
    expect(captured).toBeCloseTo(0.4822, 4);
  });

  it('does not capture readings from a file without mode words unless the caller allows them', () => {
    const detector = createStabilityDetector({ captureMode: 'voltage' });
    const bridge = createFileBridge();
    let capturable = false;
    for (let i = 0; i < 8; i++) {
      for (const reading of bridge.push(enc('3.3\n'), 1000 + i * 250)) capturable = detector.push(reading).capturable || capturable;
    }
    expect(capturable).toBe(false);
    expect(detector.status).toMatchObject({ state: 'blocked', block: 'caveat' });

    const declared = createFileBridge({ assume: { mode: 'dcVolts', unit: 'V' } });
    const trusting = createStabilityDetector({ captureMode: 'voltage' });
    let fresh = 0;
    for (let i = 0; i < 8; i++) {
      for (const reading of declared.push(enc('3.3\n'), 1000 + i * 250)) fresh += trusting.push(reading).fresh ? 1 : 0;
    }
    expect(fresh).toBe(1);
  });

  it('describes itself as a tool, not a meter', () => {
    expect(FILE_BRIDGE_INFO).toMatchObject({ id: 'file-bridge', status: 'tool', link: 'file' });
  });
});
