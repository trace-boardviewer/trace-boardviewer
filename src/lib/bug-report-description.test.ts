import { describe, expect, it } from 'vitest';
import { findSensitiveDescriptionDetails, removeSensitiveDescriptionDetails } from './bug-report-description';

describe('bug report description privacy helper', () => {
  it('finds common full local paths across Windows, UNC, and POSIX forms', () => {
    const text = 'Windows: C:\\Users\\tech name\\Boards\\A123.brd\nUNC: \\\\fileserver\\share\\repair\\boardview.brd\nMac: /Users/tech/Library/Boards/A123.brd\nLinux: /home/tech/projects/A123.kicad_pcb.';
    const details = findSensitiveDescriptionDetails(text);
    expect(details.map(({ kind }) => kind)).toEqual(['path', 'path', 'path', 'path']);
    expect(details.map(({ start, end }) => text.slice(start, end))).toEqual([
      'C:\\Users\\tech name\\Boards\\A123.brd',
      '\\\\fileserver\\share\\repair\\boardview.brd',
      '/Users/tech/Library/Boards/A123.brd',
      '/home/tech/projects/A123.kicad_pcb',
    ]);
  });

  it('finds complete PEM private key blocks and credential assignments without exposing their contents', () => {
    const privateKey = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_CANARY_27\n-----END PRIVATE KEY-----';
    const text = `key:\n${privateKey}\npassword=synthetic-password-canary-123 token: synthetic-token-canary-456`;
    const details = findSensitiveDescriptionDetails(text);
    expect(details.map(({ kind }) => kind)).toEqual(['private-key', 'credential', 'credential']);
    expect(details.map(({ start, end }) => text.slice(start, end))).toEqual([
      privateKey,
      'synthetic-password-canary-123',
      'synthetic-token-canary-456',
    ]);
    const cleaned = removeSensitiveDescriptionDetails(text, '[removed]');
    expect(cleaned).not.toContain('SYNTHETIC_PRIVATE_CANARY_27');
    expect(cleaned).not.toContain('synthetic-password-canary-123');
    expect(cleaned).not.toContain('synthetic-token-canary-456');
    expect(cleaned).toContain('key:\n[removed]');
  });

  it('recognizes standalone GitHub token prefixes and merges overlapping spans deterministically', () => {
    const githubTokens = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_']
      .map((prefix) => `${prefix}abcdefghijklmnopqrstuvwx`);
    const text = `${githubTokens.join(' ')} then /root/tech/private.txt`;
    const details = findSensitiveDescriptionDetails(text);
    expect(details).toHaveLength(githubTokens.length + 1);
    expect(details.map(({ kind }) => kind)).toEqual([...githubTokens.map(() => 'credential'), 'path']);
    expect(details.map(({ start, end }) => text.slice(start, end))).toEqual([
      ...githubTokens, '/root/tech/private.txt',
    ]);

    const overlap = 'password=/Users/tech/customer-data';
    expect(findSensitiveDescriptionDetails(overlap)).toEqual([
      { start: 9, end: overlap.length, kind: 'credential' },
    ]);
    expect(removeSensitiveDescriptionDetails(overlap, 'x')).toBe('password=x');
  });

  it('uses UTF-16 offsets and preserves Unicode and CRLF exactly', () => {
    const text = '🙂 first\r\nsecond /Users/üser/板子.brd\r\nlast';
    const [detail] = findSensitiveDescriptionDetails(text);
    expect(detail.start).toBe(text.indexOf('/Users/'));
    expect(text.slice(detail.start, detail.end)).toBe('/Users/üser/板子.brd');
    expect(removeSensitiveDescriptionDetails(text, '[redacted]')).toBe('🙂 first\r\nsecond [redacted]\r\nlast');
  });

  it('keeps ordinary references, filenames, commands, and informal descriptions unchanged', () => {
    const examples = [
      'The board U123 rev B has no power.',
      'Please inspect boardview.brd and schematic.pdf.',
      'Run npm test, then open the board again.',
      'I tried a password reset and the screen still freezes.',
      'The URL is https://example.test/help?token=short.',
    ];
    for (const text of examples) {
      expect(findSensitiveDescriptionDetails(text)).toEqual([]);
      expect(removeSensitiveDescriptionDetails(text, '[removed]')).toBe(text);
    }
  });

  it('handles empty text and no matches without changing content', () => {
    expect(findSensitiveDescriptionDetails('')).toEqual([]);
    expect(removeSensitiveDescriptionDetails('', '[removed]')).toBe('');
    expect(findSensitiveDescriptionDetails('The board freezes on startup.')).toEqual([]);
  });

  it('rejects text beyond either documented input limit with a fixed content-free error', () => {
    for (const text of ['x'.repeat(2001), 'é'.repeat(4097)]) {
      expect(() => findSensitiveDescriptionDetails(text)).toThrowError('Unsupported description text.');
      expect(() => removeSensitiveDescriptionDetails(text, '[removed]')).toThrowError('Unsupported description text.');
    }
    expect(() => findSensitiveDescriptionDetails('🙂'.repeat(2001))).toThrowError('Unsupported description text.');
    expect(findSensitiveDescriptionDetails('🙂'.repeat(2000))).toEqual([]);
  });

  it('rejects unsupported control characters and unpaired surrogates predictably', () => {
    for (const text of ['nul\u0000byte', 'delete\u007f', 'lone high \ud800', 'lone low \udc00']) {
      expect(() => findSensitiveDescriptionDetails(text)).toThrowError('Unsupported description text.');
    }
    expect(findSensitiveDescriptionDetails('tab\there\r\nnext line')).toEqual([]);
  });

  it('bounds adversarial text before applying the simple scanners', () => {
    const bounded = `${'x'.repeat(1900)}${'C:\\'.repeat(30)}`;
    expect(() => findSensitiveDescriptionDetails(bounded)).not.toThrow();
    expect(() => findSensitiveDescriptionDetails('x'.repeat(8193))).toThrowError('Unsupported description text.');
  });
});
