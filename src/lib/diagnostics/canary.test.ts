import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { findLeaks } from './canary-check';
import {
  ALL_BUILDERS, CANARY_NUMBERS, CANARY_STRINGS, COORDS, FZ_CANARY_KEY, NAMES, XZZ_CANARY_KEY, brdPlain, fzEncrypted, gencad, kicad, secretsOf, xzz, type BuiltFile,
} from './canary-kit';
import { collectDiagnostic, projectReport, type DiagnosticEnv } from './collect';
import type { DiagnosticReport } from './report';

/*
 * The privacy proof (R1 3.4): synthetic files of every format are seeded with canary references, nets, values, titles, coordinates and
 * a canary key. The report - both levels, with and without the dedupe code, for intact and for damaged files - must contain none of
 * them in plain, UTF-16, hexadecimal, base64 or URL-encoded form. The detector is first shown to find every one of those forms.
 */
const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../../electron/diagnostics.cjs') as {
  validateReport(value: unknown, options?: { reviewed?: boolean }): DiagnosticReport;
  serializeReport(report: DiagnosticReport): string;
};
const ENV: DiagnosticEnv = { os: 'linux', appVersion: '1.3.0', dedupe: 'a1b2c3d4e5f60718' };
const run = (file: Pick<BuiltFile, 'name' | 'data' | 'companions' | 'options'>): Promise<DiagnosticReport> => collectDiagnostic({
  name: file.name, data: file.data, ...(file.companions ? { companions: file.companions } : {}), ...(file.options ? { options: file.options } : {}),
}, ENV);
/** The text that would reach the disk for one choice of the user. */
function saved(full: DiagnosticReport, level: 1 | 2, dedupe: boolean): string {
  return diagnostics.serializeReport(diagnostics.validateReport(projectReport(full, { level, dedupe, reviewed: true }), { reviewed: true }));
}

describe('the leak detector finds a secret in every encoding it claims to cover', () => {
  const secret = 'QZX7NET_ALPHA';
  const bytes = Buffer.from(secret, 'utf8');
  const forms: Array<[string, string]> = [
    ['plain', secret], ['lower case', secret.toLowerCase()], ['hex', bytes.toString('hex')], ['HEX', bytes.toString('hex').toUpperCase()],
    ['utf-16le text', Buffer.from(secret, 'utf16le').toString('latin1')], ['utf-16 hex', Buffer.from(secret, 'utf16le').toString('hex')],
    ['base64', bytes.toString('base64')], ['base64 shifted by 1', Buffer.concat([Buffer.from('a'), bytes]).toString('base64')],
    ['base64 shifted by 2', Buffer.concat([Buffer.from('ab'), bytes]).toString('base64')], ['base64url', bytes.toString('base64url')],
    ['percent encoded', [...bytes].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('')], ['PERCENT encoded', [...bytes].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')],
    ['URL component', encodeURIComponent(`${secret} x`)], ['reversed', [...secret].reverse().join('')],
  ];
  for (const [name, form] of forms) {
    it(`finds it as ${name}`, () => {
      // The UTF-16 text form is tested as raw characters (JSON would escape its NUL characters); every other form inside a JSON string.
      const haystack = name === 'utf-16le text' ? `before ${form} after` : JSON.stringify({ unrelated: 1, text: `before ${form} after` });
      expect(findLeaks(haystack, { strings: [secret] }).length, name).toBeGreaterThan(0);
    });
  }
  it('finds a UTF-16 report and a number in decimal, hexadecimal and byte form, and a key blob', () => {
    const utf16 = Buffer.from(`{"x":"${secret}"}`, 'utf16le').toString('latin1');
    expect(findLeaks(utf16, { strings: [secret] }).length).toBeGreaterThan(0);
    expect(findLeaks('{"n":"71.3917"}', { numbers: ['71.3917'] }).length).toBeGreaterThan(0);
    expect(findLeaks('{"n":73914417}', { integers: [73914417] }).length).toBeGreaterThan(0);
    expect(findLeaks(`{"n":"${(73914417).toString(16).padStart(8, '0')}"}`, { integers: [73914417] }).length).toBeGreaterThan(0);
    const word = Buffer.alloc(4); word.writeUInt32LE(73914417);
    expect(findLeaks(`{"n":"${word.toString('hex')}"}`, { integers: [73914417] }).length).toBeGreaterThan(0);
    const blob = Buffer.from(Array.from({ length: 24 }, (_, index) => (index * 37 + 5) & 255));
    expect(findLeaks(`{"k":"${blob.toString('base64')}"}`, { blobs: [blob] }).length).toBeGreaterThan(0);
    expect(findLeaks(`{"k":"${blob.toString('hex')}"}`, { blobs: [blob] }).length).toBeGreaterThan(0);
  });
  it('stays quiet for a report without the secret', () => {
    expect(findLeaks('{"hook":"gencad","keywords":{"$HEADER":1}}', { strings: CANARY_STRINGS, numbers: CANARY_NUMBERS, integers: [73914417] })).toEqual([]);
  });
});

describe('seeded files of every format', () => {
  it('seeds every canary into the files it claims to', () => {
    // The kit is only a proof when the canaries are really in the bytes the readers see.
    for (const build of ALL_BUILDERS) {
      const file = build();
      const haystack = Buffer.concat([Buffer.from(file.data), ...Object.values(file.companions ?? {}).map(bytes => Buffer.from(bytes))]);
      const latin = haystack.toString('latin1');
      const seeded = ['QZX7R101', 'QZX7NET_ALPHA'].some(text => latin.includes(text));
      const encoded = file.label.includes('encoded') || file.label.includes('RC6') || file.label.includes('container') || file.label.includes('XZZ PCB obfuscated');
      if (!encoded) expect(seeded, `${file.label} carries visible canaries`).toBe(true);
    }
  });

  for (const build of ALL_BUILDERS) {
    const file = build();
    it(`${file.label}: no canary in the level-1 or level-2 report, with or without the dedupe code`, async () => {
      const full = await run(file);
      expect(full.detection.outcome, file.label).toBe('opened');
      const secrets = secretsOf(file);
      for (const [level, dedupe] of [[1, false], [1, true], [2, false], [2, true]] as const) {
        const text = saved(full, level, dedupe);
        expect(findLeaks(text, secrets), `${file.label} level ${level} dedupe ${dedupe}`).toEqual([]);
        expect(text.includes('a1b2c3d4e5f60718')).toBe(dedupe);
      }
    });
  }

  it('hides the key material of an encrypted file and of a supplied XZZ key, while saying that a key was supplied', async () => {
    const encrypted = fzEncrypted();
    const full = await run(encrypted);
    const text = saved(full, 2, true);
    expect(JSON.parse(text).keys).toEqual({ supplied: true, parity: 'valid' });
    expect(findLeaks(text, { strings: [XZZ_CANARY_KEY, ...FZ_CANARY_KEY.map(word => String(word)), ...FZ_CANARY_KEY.map(word => word.toString(16).padStart(8, '0'))], blobs: [Buffer.from(Uint32Array.from(FZ_CANARY_KEY).buffer)] })).toEqual([]);
    const plain = await run({ ...xzz(), options: { xzzKey: XZZ_CANARY_KEY } });
    expect(plain.keys.supplied).toBe(true);
    expect(findLeaks(saved(plain, 2, false), { strings: [XZZ_CANARY_KEY, XZZ_CANARY_KEY.toLowerCase(), `0x${XZZ_CANARY_KEY}`] })).toEqual([]);
  });

  it('drops the file name, the directory and the user name: only the extension class survives', async () => {
    const file = kicad();
    const report = await collectDiagnostic({ name: 'C:\\Users\\Alice Wonderland\\Customer QZX7 Board Rev9.kicad_pcb', data: file.data }, ENV);
    const text = saved(report, 2, false);
    expect(JSON.parse(text).input.extension).toBe('.kicad_pcb');
    expect(findLeaks(text, { strings: ['Alice', 'Wonderland', 'Customer', 'QZX7', 'Users', 'Rev9', 'Board Rev9'] })).toEqual([]);
    const odd = await collectDiagnostic({ name: '/home/bob/secret-project.weirdext', data: file.data }, ENV);
    expect(JSON.parse(saved(odd, 1, false)).input.extension).toBe('other');
    expect(findLeaks(saved(odd, 1, false), { strings: ['bob', 'secret-project', 'weirdext', 'home'] })).toEqual([]);
  });

  it('keeps coordinates, dimensions and counts to orders of magnitude and two significant digits', async () => {
    const report = JSON.parse(saved(await run(gencad()), 2, false)) as DiagnosticReport;
    for (const value of Object.values(report.structure!.keywords)) expect(value).toBe(Number(value.toPrecision(2)));
    expect(report.result!.parts).toBeLessThanOrEqual(2);
    expect(JSON.stringify(report)).not.toContain(COORDS.mm[0]);
    const digits = JSON.stringify(report).match(/(?<![\w.])\d+\.\d{3,}/g) ?? [];
    expect(digits, 'no decimal number with three or more places other than the entropy profile and shares').toEqual([]);
  });
});

describe('damaged files: error text and partial parses reveal nothing either', () => {
  /** Deterministic damage that makes a reader fail in many places: truncation, byte flips, dropped, duplicated and shuffled lines, a long name. */
  function damages(file: BuiltFile): Array<{ label: string; data: Uint8Array }> {
    const data = file.data, out: Array<{ label: string; data: Uint8Array }> = [];
    for (const share of [0.15, 0.4, 0.7, 0.95]) out.push({ label: `truncated at ${share}`, data: data.slice(0, Math.floor(data.length * share)) });
    for (const seed of [1, 2, 3]) {
      const copy = data.slice();
      let state = seed * 2654435761 >>> 0;
      for (let flips = 0; flips < Math.max(3, copy.length >> 6); flips++) { state = Math.imul(state, 1664525) + 1013904223 >>> 0; copy[state % copy.length] ^= 1 << (state >>> 29); }
      out.push({ label: `bit flips ${seed}`, data: copy });
    }
    const text = Buffer.from(data).toString('latin1');
    if (/\n/.test(text) && !file.label.includes('encoded') && !file.label.includes('RC6')) {
      const rows = text.split('\n');
      const join = (list: string[]) => Uint8Array.from(Buffer.from(list.join('\n'), 'latin1'));
      out.push({ label: 'dropped lines', data: join(rows.filter((_, index) => index % 3 !== 1)) });
      out.push({ label: 'duplicated lines (duplicate references and nets)', data: join(rows.flatMap((row, index) => index % 2 ? [row, row] : [row])) });
      out.push({ label: 'reversed lines', data: join([...rows].reverse()) });
      out.push({ label: 'a 3 KiB token', data: join([...rows.slice(0, 3), `${NAMES.refs[0]}${'Q'.repeat(3000)} 1 2 3`, ...rows.slice(3)]) });
    }
    return out;
  }
  for (const build of ALL_BUILDERS) {
    const file = build();
    it(`${file.label}: every damaged variant still validates and leaks nothing`, async () => {
      const secrets = secretsOf(file);
      for (const damaged of damages(file)) {
        const full = await run({ ...file, data: damaged.data });
        for (const level of [1, 2] as const) {
          const text = saved(full, level, true);
          expect(findLeaks(text, secrets), `${file.label}, ${damaged.label}, level ${level}`).toEqual([]);
        }
      }
    });
  }

  it('turns a reader error that quotes content into a code and a stage', async () => {
    // A BRD whose second part repeats the first one's reference: the reader's message names it, the report must not.
    const file = brdPlain();
    const text = Buffer.from(file.data).toString('latin1').replace(`${NAMES.refs[1]} 2 3`, `${NAMES.refs[0]} 2 3`);
    const report = await run({ ...file, data: Uint8Array.from(Buffer.from(text, 'latin1')) });
    expect(findLeaks(saved(report, 2, false), secretsOf(file))).toEqual([]);
    const entry = report.detection.adapters.find(item => item.id === 'brd');
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(['code', 'format', 'id', 'keyKind', 'result', 'sniff', 'stage']);
  });
});

describe('the report path has no way out of the machine', () => {
  const diagnosticsDirectory = new URL('./', import.meta.url);
  const sources = readdirSync(diagnosticsDirectory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !['canary-kit.ts', 'canary-check.ts'].includes(name));
  const native = readFileSync(new URL('../../../electron/diagnostics.cjs', import.meta.url), 'utf8');
  const stage = readFileSync(new URL('../formats/stage.ts', import.meta.url), 'utf8');
  const FORBIDDEN = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|navigator\.clipboard|document\.execCommand|localStorage|sessionStorage|indexedDB|importScripts|eval|Function)\s*\(|\bnew\s+(?:Worker|SharedWorker|Function|WebSocket|XMLHttpRequest|EventSource)\b|\bimport\s*\(|\bnode:(?:net|http|https|http2|dgram|tls|dns|child_process|worker_threads|vm)\b|require\(\s*['"](?:electron|net|http|https|http2|dgram|tls|dns|child_process|vm)['"]\s*\)/;
  it('has diagnostic modules that call no network, clipboard, storage, process or dynamic-code API', () => {
    expect(sources.length).toBeGreaterThan(8);
    for (const name of sources) expect(readFileSync(new URL(name, diagnosticsDirectory), 'utf8'), name).not.toMatch(FORBIDDEN);
    expect(native).not.toMatch(FORBIDDEN);
    expect(stage).not.toMatch(FORBIDDEN);
  });
  it('reads only the report, the secret and the schema in the validator module: no file system, no clock, no host information', () => {
    expect(native).not.toMatch(/require\(\s*['"](?:node:)?(?:fs|os|path|process)['"]\s*\)|process\.env|os\.hostname|userInfo|Date\.now|new Date\b|Intl\./);
  });
});
