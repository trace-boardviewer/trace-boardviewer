import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyBoardNets, classifyNetName, classifyNets, createGroundMatcher, DEFAULT_GROUND_PATTERNS, expectedVoltageFromName, GROUND_FALLBACK_SHARE, isGroundName, isNoConnectName,
} from '../../src/lib/net-class';
import type { NetClass, NetPinCount } from '../../src/lib/net-class';
import { expectScaling } from '../../src/test-support/timing';
import { makeBoard } from './builders';
import { params, shuffled, shuffleKeys } from './support';

// ---------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------

/** Real-looking names, near misses and the words the classes are built from. */
const POOL = [
  'GND', 'AGND', 'DGND', 'PGND', 'GND_1', 'DIG_GND', 'GNDA', 'VSS', '0V', 'gnd', 'GND1', 'GNDX', 'XGND', '/power/GND', 'sheet/AGND', 'a/b/c/', '/',
  '+5V', '+3V3', '-12V', '3V3', '1V8', '12V', '3P3V', 'V3P3', '5VSB', 'PP3V3_S5', 'PP1V8_S0', 'VCC', 'VDD', 'VBAT', 'VBUS', 'VCC_1V8', 'USBVCC', 'VCC3V3', 'VDD33', 'USB3V3', '5V_EN', 'TMDS_SDA_5V0', '3V3_PG', 'FAN_TACH_5V', '5V0_AUX', '1V05', '0V8', '120V', '0V1',
  'NC', 'N/C', 'nc', 'UNCONNECTED', 'UNCONNECTED12', 'UNCONNECTED<7>', 'unconnected-(R1-Pad2)', 'UNCONNECTEDLY', '',
  'SDA', 'SCL', 'CLK', 'DATA0', 'NET1', 'Net-(U1-Pad3)', 'RESET#', 'EN', 'PWM_5V',
];
const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+-./<>()#*V P'.split('');
const nameFromChars = fc.array(fc.constantFrom(...NAME_CHARS), { maxLength: 24 }).map(chars => chars.join(''));
const joinedWords = fc.array(fc.constantFrom(...POOL, 'V', '_', '-', '+', '/', '3', '3V3', '5V', 'EN', 'PG'), { maxLength: 5 }).map(parts => parts.join(''));
const netName = fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...POOL) }, { weight: 3, arbitrary: nameFromChars }, { weight: 3, arbitrary: joinedWords }, { weight: 1, arbitrary: fc.string({ maxLength: 20 }) });
const asciiName = netName.filter(name => /^[\x00-\x7f]*$/.test(name));

const KINDS = new Set(['ground', 'power', 'no-connect', 'signal']);
const patternList = fc.array(fc.oneof(
  fc.constantFrom('GND', 'gnd', 'GND*', '*GND', '*_GND', 'GND_*', 'A*D', '*', '**', '', ' VSS ', 'V*S*', '0V', '*GND*', 'DGND', 'AG*ND', 'GND#', 'gnd#', '#', '*#', '**#', 'G*#', 'A#B', '#GND', 'GND##', '_GND#'),
  fc.array(fc.constantFrom(...'ABGNDV_*0#1'.split('')), { maxLength: 8 }).map(parts => parts.join('')),
), { maxLength: 8 });

// ---------------------------------------------------------------------------------------------------------------
// One name
// ---------------------------------------------------------------------------------------------------------------

describe('net class of one name', () => {
  it('is total: any text gives one of four classes, a ground basis only for ground, a hint only for power', () => {
    fc.assert(fc.property(fc.oneof(netName, fc.anything().map(value => value as string)), fc.option(patternList, { nil: undefined }), (name, patterns) => {
      const result: NetClass = classifyNetName(name, patterns === undefined ? {} : { groundPatterns: patterns });
      expect(KINDS.has(result.kind)).toBe(true);
      expect(result.groundBasis !== undefined).toBe(result.kind === 'ground');
      if (result.kind === 'ground') expect(result.groundBasis).toBe('name');
      expect(result.expectedVoltage !== undefined && result.kind !== 'power').toBe(false);
      if (result.expectedVoltage) {
        expect(result.expectedVoltage.source).toBe('net-name');
        expect(Number.isFinite(result.expectedVoltage.volts)).toBe(true);
        expect(Math.abs(result.expectedVoltage.volts)).toBeGreaterThanOrEqual(0.3);
        expect(Math.abs(result.expectedVoltage.volts)).toBeLessThanOrEqual(100);
      }
      expect(classifyNetName(name, patterns === undefined ? {} : { groundPatterns: patterns })).toEqual(result);
    }), params(1000));
  });

  it('the precedence is no-connect, then ground, then power, then signal', () => {
    fc.assert(fc.property(netName, name => {
      const kind = classifyNetName(name).kind;
      if (isNoConnectName(name)) expect(kind).toBe('no-connect');
      else if (isGroundName(name)) expect(kind).toBe('ground');
      else if (expectedVoltageFromName(name)) expect(kind).toBe('power');
      else expect(['power', 'signal']).toContain(kind);
    }), params(800));
  });

  it('does not depend on the case of ASCII text, nor on blanks around the name', () => {
    fc.assert(fc.property(asciiName, name => {
      const reference = classifyNetName(name);
      expect(classifyNetName(name.toUpperCase())).toEqual(reference);
      expect(classifyNetName(name.toLowerCase())).toEqual(reference);
      expect(classifyNetName(`  ${name}\t `)).toEqual(reference);
    }), params(800));
  });

  it('names longer than the cap are never ground, power or hinted (a no-connect placeholder is still one)', () => {
    fc.assert(fc.property(fc.constantFrom('GND', 'VCC', '+5V', 'PP3V3', 'A', '/GND'), fc.integer({ min: 1025, max: 3000 }), fc.constantFrom('_', ' ', 'X'), (word, length, fill) => {
      const name = word + fill.repeat(Math.max(0, length - word.length));
      expect(name.length).toBeGreaterThan(1024);
      expect(isGroundName(name)).toBe(false);
      expect(expectedVoltageFromName(name)).toBeNull();
      expect(['signal', 'no-connect']).toContain(classifyNetName(name).kind);
    }), params(60));
  });

  it('adding a control word at the end turns a power rail into a signal, and a data-line word anywhere does too', () => {
    fc.assert(fc.property(netName, fc.constantFrom('EN', 'PG', 'PGOOD', 'FB', 'SW', 'SNS', 'FAULT'), fc.constantFrom('_', '-', '.', ' '), (name, word, glue) => {
      fc.pre(classifyNetName(name).kind === 'power');
      const control = classifyNetName(`${name}${glue}${word}`);
      expect(control.kind).toBe('signal');
      expect(control.expectedVoltage).toBeUndefined();
    }), params(600));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Ground patterns, against a plain restatement
// ---------------------------------------------------------------------------------------------------------------

/**
 * The documented rule, written as the simplest possible code: upper-case; `*` matches any run of characters; a `#` at the end of a pattern
 * stands for the whole run of digits at the end of a name (one digit or more), after whatever the rest of the pattern matches, so `GND#` is
 * GND1 and GND12 but not GND or GNDX; a bare `*`, a bare `#` and a star with a `#` are no pattern, and a `#` anywhere else stands for itself;
 * a hierarchical name is also tried by its last segment.
 */
function groundOracle(name: string, patterns: readonly string[]): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024) return false;
  const rules = patterns
    .map(pattern => pattern.trim().toUpperCase())
    .filter(pattern => pattern !== '' && pattern.length <= 128)
    .map(pattern => (pattern.endsWith('#') ? { digits: true, stem: pattern.slice(0, -1) } : { digits: false, stem: pattern }))
    .filter(({ stem }) => stem !== '' && !/^\*+$/.test(stem))
    .map(({ digits, stem }) => ({ digits, regex: new RegExp(`^${stem.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^]*')}$`) }));
  const upper = name.trim().toUpperCase();
  const tests = (text: string) => {
    const run = /[0-9]+$/.exec(text);
    return rules.some(rule => (rule.digits ? run !== null && rule.regex.test(text.slice(0, run.index)) : rule.regex.test(text)));
  };
  if (tests(upper)) return true;
  const slash = upper.lastIndexOf('/');
  return slash >= 0 && slash < upper.length - 1 && tests(upper.slice(slash + 1));
}

describe('ground patterns', () => {
  it('match exactly what the documented rule says, for any pattern list and any name', () => {
    fc.assert(fc.property(netName, patternList, (name, patterns) => {
      expect(isGroundName(name, patterns)).toBe(groundOracle(name, patterns));
      expect(createGroundMatcher(patterns)(name)).toBe(groundOracle(name, patterns));
    }), params(1500));
    fc.assert(fc.property(netName, name => {
      expect(isGroundName(name)).toBe(groundOracle(name, DEFAULT_GROUND_PATTERNS));
      expect(isGroundName(name, DEFAULT_GROUND_PATTERNS)).toBe(isGroundName(name));
    }), params(600));
  });

  it('more patterns never remove a match, and the order and repetition of patterns do not matter', () => {
    fc.assert(fc.property(netName, patternList, patternList, shuffleKeys, (name, first, second, keys) => {
      if (isGroundName(name, first)) expect(isGroundName(name, [...first, ...second])).toBe(true);
      expect(isGroundName(name, shuffled([...first, ...second], keys))).toBe(isGroundName(name, [...first, ...second]));
      expect(isGroundName(name, [...first, ...first])).toBe(isGroundName(name, first));
    }), params(600));
  });

  it('a hierarchical name is ground when its last segment is', () => {
    fc.assert(fc.property(fc.constantFrom('GND', 'AGND', 'VSS', 'gnd', 'DIG_GND', '0V'), fc.array(fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/), { minLength: 1, maxLength: 3 }), (leaf, path) => {
      expect(isGroundName(`/${path.join('/')}/${leaf}`)).toBe(true);
      expect(isGroundName(`${path.join('/')}/${leaf}`)).toBe(true);
      expect(isGroundName(`/${path.join('/')}/${leaf}/`)).toBe(false);
    }), params(200));
  });

  it('ignore anything that is not a usable pattern, whatever else is in the list', () => {
    fc.assert(fc.property(netName, fc.array(fc.anything(), { maxLength: 4 }), (name, junk) => {
      const clean = junk.filter((entry): entry is string => typeof entry === 'string');
      expect(isGroundName(name, junk as unknown as string[])).toBe(groundOracle(name, clean));
    }), params(300));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Voltage hints
// ---------------------------------------------------------------------------------------------------------------

const VOLTAGES: ReadonlyArray<readonly [volts: number, spellings: readonly string[]]> = [
  [3.3, ['3V3', '3.3V', '3P3V', 'V3P3']], [1.8, ['1V8', '1.8V', '1P8V']], [5, ['5V', '5V0', '5.0V', '5P0V']], [12, ['12V', '12V0']], [1.05, ['1V05', '1.05V']], [0.9, ['0V9', '0.9V']], [2.5, ['2V5', '2.5V']], [24, ['24V']], [48, ['48V']], [0.6, ['0V6']],
];
const railStyles = ['{v}', '+{v}', 'VCC_{v}', 'VDD{v}', 'PP{v}_S5', 'PP{v}', '{v}_AUX', '{v}_S3', '{v}_A', 'VCC_{v}_IO', 'VIN_{v}', 'VOUT_{v}'];

describe('voltage hints from names', () => {
  it('read the voltage of a rail name in every spelling, and only that voltage', () => {
    fc.assert(fc.property(fc.constantFrom(...VOLTAGES), fc.nat(), fc.constantFrom(...railStyles), ([volts, forms], pick, style) => {
      const form = forms[pick % forms.length];
      const name = style.replace('{v}', form);
      const hint = expectedVoltageFromName(name);
      expect(hint, name).toEqual({ volts, source: 'net-name' });
      expect(classifyNetName(name).kind).toBe('power');
    }), params(500));
  });

  it('a minus sign directly in front gives a negative rail, and the same voltage twice stays one voltage', () => {
    fc.assert(fc.property(fc.constantFrom(5, 12, 15, 3.3, 24), (volts) => {
      expect(expectedVoltageFromName(`-${volts}V`)?.volts).toBe(-volts);
      expect(expectedVoltageFromName(`VEE_-${volts}V`)?.volts).toBe(-volts);
      expect(expectedVoltageFromName(`+${volts}V_${volts}V`)?.volts).toBe(volts);
    }), params(60));
  });

  it('two different voltages in one name give no hint', () => {
    fc.assert(fc.property(fc.constantFrom(...VOLTAGES), fc.constantFrom(...VOLTAGES), fc.constantFrom('_', '-', '/', '.'), ([a, aForms], [b, bForms], glue) => {
      fc.pre(a !== b);
      expect(expectedVoltageFromName(`${aForms[0]}${glue}${bForms[0]}`)).toBeNull();
    }), params(300));
  });

  it('never invents a voltage outside 0.3 V to 100 V, a non-number or a hint without a V', () => {
    fc.assert(fc.property(netName, name => {
      const hint = expectedVoltageFromName(name);
      if (!hint) return;
      expect(Number.isFinite(hint.volts)).toBe(true);
      expect(Math.abs(hint.volts)).toBeGreaterThanOrEqual(0.3);
      expect(Math.abs(hint.volts)).toBeLessThanOrEqual(100);
      expect(/V|P\d/i.test(name)).toBe(true);
      expect(/\d/.test(name)).toBe(true);
    }), params(1000));
    fc.assert(fc.property(fc.integer({ min: 101, max: 999 }), fc.constantFrom(0.1, 0.2, 0.29), (high, low) => {
      expect(expectedVoltageFromName(`${high}V`)).toBeNull();
      expect(expectedVoltageFromName(`${low}V`)).toBeNull();
    }), params(80));
  });

  it('are read in time that grows at most linearly with the name (the cap bounds the work), on any text', () => {
    fc.assert(fc.property(fc.constantFrom('1', '1V', '1.', 'V', 'P', '1P', '3V3', '-', '_', '5V_', 'UNCONNECTED'), shortRepeat => {
      expectScaling(JSON.stringify(shortRepeat), [256, 1024], size => { const name = shortRepeat.repeat(Math.ceil(size / shortRepeat.length)).slice(0, size); return () => classifyNetName(name); });
    }), params(11));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// No-connect
// ---------------------------------------------------------------------------------------------------------------

describe('no-connect names', () => {
  it('the empty name, blanks, NC and N/C in any case and the UNCONNECTED placeholders are no-connect', () => {
    fc.assert(fc.property(fc.constantFrom('', ' ', '\t', 'NC', 'nc', 'Nc', 'N/C', 'n/c', 'UNCONNECTED', 'unconnected', 'UnConnected'), fc.constantFrom('', ' ', '  ', '\t'), fc.constantFrom('', ' '), (name, left, right) => {
      expect(isNoConnectName(`${left}${name}${right}`)).toBe(true);
    }), params(200));
    fc.assert(fc.property(fc.constantFrom('UNCONNECTED', 'unconnected-(R1-Pad2)', 'Unconnected'), fc.constantFrom('', '1', '12', '<7>', '(x)', '_3', '-5'), (name, tail) => {
      const text = name.endsWith(')') ? name : `${name}${tail}`;
      expect(isNoConnectName(text)).toBe(true);
    }), params(100));
  });

  it('a name that merely starts with the placeholder word, or holds NC inside, is a net', () => {
    fc.assert(fc.property(fc.constantFrom('UNCONNECTEDLY', 'UNCONNECTEDX', 'UNCONNECTE', 'NCX', 'XNC', 'N-C', 'NC1', 'N C'), fc.constantFrom('', '_X'), (name, tail) => {
      fc.pre(!/^UNCONNECTED[<(_\-\d]/i.test(`${name}${tail}`));
      expect(isNoConnectName(`${name}${tail}`)).toBe(false);
    }), params(100));
  });

  it('is total and never throws', () => {
    fc.assert(fc.property(fc.anything(), value => { expect(typeof isNoConnectName(value as string)).toBe('boolean'); }), params(300));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A board
// ---------------------------------------------------------------------------------------------------------------

const netCounts = fc.array(fc.record({ name: netName, pinCount: fc.integer({ min: 0, max: 40 }) }), { maxLength: 12 });
const unique = (nets: NetPinCount[]) => nets.filter((net, index) => nets.findIndex(other => other.name === net.name) === index);

describe('classification of a board\'s nets', () => {
  it('the classes of the list are the classes of the names, except for the one net the fallback names ground', () => {
    fc.assert(fc.property(netCounts, fc.integer({ min: 0, max: 600 }), (list, extraPins) => {
      const nets = unique(list), totalPins = nets.reduce((sum, net) => sum + net.pinCount, 0) + extraPins;
      const result = classifyNets(nets, totalPins);
      expect(result.byName.size).toBe(nets.length);
      for (const net of nets) {
        const own = classifyNetName(net.name);
        const got = result.byName.get(net.name)!;
        if (result.groundBasis === 'largest-net' && result.groundNets[0] === net.name) expect(got).toEqual({ kind: 'ground', groundBasis: 'largest-net' });
        else expect(got).toEqual(own);
        expect(result.classOf(net.name)).toEqual(got);
      }
      expect(result.groundNets).toEqual(nets.filter(net => result.byName.get(net.name)!.kind === 'ground').map(net => net.name));
      for (const name of ['', 'GND', 'something-else', '+5V']) if (!result.byName.has(name)) expect(result.classOf(name)).toEqual(classifyNetName(name));
    }), params(600));
  });

  it('the largest net becomes ground only when no name did, it is strictly the largest signal net, and it holds more than the share of all pins', () => {
    fc.assert(fc.property(netCounts, fc.integer({ min: 0, max: 600 }), fc.option(fc.constantFrom(0, 0.05, GROUND_FALLBACK_SHARE, 0.5, 0.99, Infinity), { nil: undefined }), (list, extraPins, share) => {
      const nets = unique(list), totalPins = nets.reduce((sum, net) => sum + net.pinCount, 0) + extraPins;
      const result = classifyNets(nets, totalPins, share === undefined ? {} : { fallbackShare: share });
      const named = nets.filter(net => classifyNetName(net.name).kind === 'ground');
      if (named.length) {
        expect(result.groundBasis).toBe('name');
        expect(result.groundNets).toEqual(named.map(net => net.name));
        return;
      }
      if (result.groundBasis === 'none') { expect(result.groundNets).toEqual([]); return; }
      expect(result.groundBasis).toBe('largest-net');
      const [winner] = result.groundNets;
      expect(result.groundNets).toHaveLength(1);
      const signals = nets.filter(net => classifyNetName(net.name).kind === 'signal');
      const top = signals.find(net => net.name === winner)!;
      expect(top).toBeDefined();
      for (const other of signals) if (other !== top) expect(other.pinCount).toBeLessThan(top.pinCount);
      expect(top.pinCount / totalPins).toBeGreaterThan(share ?? GROUND_FALLBACK_SHARE);
    }), params(800));
  });

  it('the fallback is off for an infinite share, and tied or power-named nets never win it', () => {
    fc.assert(fc.property(netCounts, fc.integer({ min: 1, max: 100 }), (list, totalPins) => {
      const nets = unique(list);
      expect(classifyNets(nets, totalPins, { fallbackShare: Infinity }).groundBasis).toBe(nets.some(net => classifyNetName(net.name).kind === 'ground') ? 'name' : 'none');
    }), params(300));
    fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 30 }), (count, extra) => {
      const tied = classifyNets([{ name: 'A', pinCount: count }, { name: 'B', pinCount: count }, { name: 'C', pinCount: Math.max(0, count - 1) }], count * 3 + extra, { fallbackShare: 0 });
      expect(tied.groundBasis).toBe('none');
      const rail = classifyNets([{ name: '+5V', pinCount: count + 10 }, { name: 'B', pinCount: count }], 2 * count + 10 + extra, { fallbackShare: 0 });
      expect(rail.groundNets).toEqual(['B']);
      expect(rail.byName.get('+5V')!.kind).toBe('power');
    }), params(100));
  });

  it('does not depend on the order of the nets', () => {
    fc.assert(fc.property(netCounts, fc.integer({ min: 0, max: 300 }), shuffleKeys, (list, extraPins, keys) => {
      const nets = unique(list), totalPins = nets.reduce((sum, net) => sum + net.pinCount, 0) + extraPins;
      const a = classifyNets(nets, totalPins), b = classifyNets(shuffled(nets, keys), totalPins);
      expect(b.groundBasis).toBe(a.groundBasis);
      expect([...b.groundNets].sort()).toEqual([...a.groundNets].sort());
      for (const net of nets) expect(b.byName.get(net.name)).toEqual(a.byName.get(net.name));
    }), params(400));
  });

  it('classifyBoardNets counts the pins of each net and takes the share of all pins of the board', () => {
    const spec = fc.array(fc.record({
      ref: fc.constantFrom('R1', 'R2', 'U1', 'C1'),
      pins: fc.array(fc.tuple(fc.constantFrom('1', '2', '3', '4'), fc.constantFrom('GND', '+3V3', 'SDA', 'NET1', 'NET2', '', 'NC')), { maxLength: 6 }),
    }), { minLength: 1, maxLength: 6 });
    fc.assert(fc.property(spec, specs => {
      const board = makeBoard(specs);
      const result = classifyBoardNets(board);
      const direct = classifyNets(board.nets.map(net => ({ name: net.name, pinCount: net.pinIds.length })), board.pins.length);
      expect([...result.byName]).toEqual([...direct.byName]);
      expect(result.groundNets).toEqual(direct.groundNets);
      expect(result.groundBasis).toBe(direct.groundBasis);
      expect(result.classOf('')).toEqual({ kind: 'no-connect' });
    }), params(200));
  });
});
