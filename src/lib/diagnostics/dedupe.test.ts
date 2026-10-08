import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../../electron/diagnostics.cjs') as {
  parseSecret(stored: unknown): Buffer | null;
  newSecret(randomBytes?: (size: number) => Uint8Array): { version: 1; secret: string };
  dedupeCode(secret: Buffer, entries: Array<{ name: string; data: Uint8Array }>): string;
  parserName(basename: string, isCompanionMember: boolean): string;
  osFamily(platform: string): string;
};

const bytes = (text: string) => new TextEncoder().encode(text);
const secret = (fill: number) => Buffer.alloc(32, fill);

describe('dedupe code: HMAC under a per-install secret', () => {
  const file = [{ name: 'board.brd', data: bytes('CANARY-FILE-CONTENT') }];

  it('is 8 bytes (16 hex digits), stable for one install and different for another', () => {
    const code = diagnostics.dedupeCode(secret(1), file);
    expect(code).toMatch(/^[0-9a-f]{16}$/);
    expect(diagnostics.dedupeCode(secret(1), file)).toBe(code);
    expect(diagnostics.dedupeCode(secret(2), file)).not.toBe(code);
  });

  it('is never an unsalted hash: it differs from every plain digest prefix of the bytes', () => {
    const code = diagnostics.dedupeCode(secret(7), file);
    for (const algorithm of ['sha256', 'sha1', 'md5', 'sha512']) {
      const plain = createHash(algorithm).update(file[0].data).digest('hex');
      expect(plain.startsWith(code), algorithm).toBe(false);
      expect(plain.includes(code), algorithm).toBe(false);
    }
    // And a secret of zero bytes is refused instead of silently turning the code into a public one.
    expect(() => diagnostics.dedupeCode(Buffer.alloc(0), file)).toThrow(/32 bytes/);
    expect(() => diagnostics.dedupeCode(Buffer.alloc(16, 1), file)).toThrow(/32 bytes/);
  });

  it('changes with any byte and any companion, and does not depend on which file of a set was chosen', () => {
    const base = diagnostics.dedupeCode(secret(3), file);
    expect(diagnostics.dedupeCode(secret(3), [{ name: 'board.brd', data: bytes('CANARY-FILE-CONTENT!') }])).not.toBe(base);
    const trio = [
      { name: 'format.asc', data: bytes('a') }, { name: 'pins.asc', data: bytes('b') }, { name: 'nails.asc', data: bytes('c') },
    ];
    const reordered = [trio[2], trio[0], trio[1]];
    expect(diagnostics.dedupeCode(secret(3), trio)).toBe(diagnostics.dedupeCode(secret(3), reordered));
    expect(diagnostics.dedupeCode(secret(3), trio.slice(0, 2))).not.toBe(diagnostics.dedupeCode(secret(3), trio));
    // Entry framing: moving a byte from one file to the next is a different set.
    expect(diagnostics.dedupeCode(secret(3), [{ name: 'a', data: bytes('xy') }, { name: 'b', data: bytes('z') }]))
      .not.toBe(diagnostics.dedupeCode(secret(3), [{ name: 'a', data: bytes('x') }, { name: 'b', data: bytes('yz') }]));
  });

  it('keeps the stored secret well-formed: 32 random bytes as hex, damaged values are rejected', () => {
    const created = diagnostics.newSecret();
    expect(created.version).toBe(1);
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostics.newSecret().secret).not.toBe(created.secret);
    expect(diagnostics.parseSecret(created)?.length).toBe(32);
    expect(diagnostics.newSecret(size => new Uint8Array(size).fill(0xab)).secret).toBe('ab'.repeat(32));
    for (const damaged of [null, undefined, {}, { version: 2, secret: 'a'.repeat(64) }, { version: 1, secret: 'a'.repeat(63) }, { version: 1, secret: 'G'.repeat(64) }, { version: 1, secret: 'A'.repeat(64) }, 'a'.repeat(64), []]) {
      expect(diagnostics.parseSecret(damaged), JSON.stringify(damaged)).toBeNull();
    }
  });
});

describe('what the parsers see of the chosen file name', () => {
  it('keeps only a whitelisted-shape extension, or the fixed role name of a companion-set member', () => {
    expect(diagnostics.parserName('Customer-Board_REV3.BRD', false)).toBe('diagnostic.brd');
    expect(diagnostics.parserName('no extension', false)).toBe('diagnostic');
    expect(diagnostics.parserName('.hidden', false)).toBe('diagnostic.hidden');
    expect(diagnostics.parserName('weird.name.with.a-very-long-extension', false)).toBe('diagnostic');
    expect(diagnostics.parserName('Format.ASC', true)).toBe('format.asc');
    expect(diagnostics.parserName('C:\\Users\\Someone\\board.cad', false)).toBe('diagnostic.cad');
  });

  it('maps the platform to the three families or "other"', () => {
    expect([diagnostics.osFamily('win32'), diagnostics.osFamily('darwin'), diagnostics.osFamily('linux')]).toEqual(['win32', 'darwin', 'linux']);
    expect(diagnostics.osFamily('freebsd')).toBe('other');
    expect(diagnostics.osFamily('other')).toBe('other');
    expect(diagnostics.osFamily(undefined as unknown as string)).toBe('other');
  });
});
