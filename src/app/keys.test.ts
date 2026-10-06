import { describe, expect, it } from 'vitest';
import { validateKeyText } from './keys';

const words = (count: number, value = 'deadbeef') => Array.from({ length: count }, () => value).join(' ');

describe('validateKeyText', () => {
  it('accepts 44 hexadecimal words for FZ with 0x, commas, semicolons and new lines', () => {
    const result = validateKeyText('fz', `0x${'1f '.repeat(10)}\n${words(33, '0xAB')},ff`);
    expect('options' in result && result.options.fzKey?.length).toBe(44);
    expect('options' in result && result.options.fzKey?.[0]).toBe(0x1f);
    expect('options' in result && result.options.fzKey?.[43]).toBe(0xff);
  });
  it('explains FZ mistakes precisely', () => {
    expect(validateKeyText('fz', words(43))).toEqual({ error: 'Enter 44 hexadecimal 32-bit words (43 so far).' });
    expect(validateKeyText('fz', `${words(43)} xyz`)).toEqual({ error: '"xyz" is not a hexadecimal 32-bit word.' });
    expect(validateKeyText('fz', `${words(43)} 123456789`)).toEqual({ error: '"123456789" is not a hexadecimal 32-bit word.' });
  });
  it('accepts exactly 16 hexadecimal digits for XZZ and lower-cases them', () => {
    expect(validateKeyText('xzz', ' 0xAB CD EF 01 23 45 67 89 ')).toEqual({ options: { xzzKey: 'abcdef0123456789' } });
    expect(validateKeyText('xzz', 'abcdef012345678')).toEqual({ error: 'Enter exactly 16 hexadecimal digits (15 so far).' });
    expect(validateKeyText('xzz', 'abcdef01234567zz')).toEqual({ error: 'Only hexadecimal digits (0-9, a-f) are allowed.' });
  });
});
