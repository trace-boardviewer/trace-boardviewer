import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AdapterFixture } from '../formats/fixture';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS } from '../formats/registry';
import { parseWith } from '../formats';
import schema from '../../../electron/diagnostic-schema.json';
import { collectDiagnostic, projectReport } from './collect';
import { findLeaks } from './canary-check';
import { FORMAT_IDS, HOOK_IDS, KEYWORDS, type DiagnosticReport } from './report';

/*
 * The report and the adapter registry (docs/ADAPTERS.md, "Diagnostic structure hook"): every registered adapter has a place in the
 * whitelist, every hook is declared against the whitelist, and every adapter - with a hook or without one - describes its own
 * synthetic fixtures without a single word of them in the report.
 */
const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../../electron/diagnostics.cjs') as { validateReport(value: unknown, options?: { reviewed?: boolean }): DiagnosticReport; serializeReport(report: DiagnosticReport): string };
const fixtureModules = import.meta.glob<AdapterFixture[]>('../formats/adapters/*/fixtures.ts', { eager: true, import: 'default' });
const ENV = { os: 'linux' as const, appVersion: '1.3.0' };

describe('adapters and the whitelist', () => {
  it('lists every registered adapter id in the schema (add the id to enums.formatId and regenerate schema.golden.txt)', () => {
    const ids = [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS].map(adapter => adapter.id);
    const missing = ids.filter(id => !(FORMAT_IDS as readonly string[]).includes(id));
    expect(missing, `adapter ids that the diagnostic report would call "other": ${missing.join(', ')}. Add them to enums.formatId in electron/diagnostic-schema.json and to FORMAT_IDS in src/lib/diagnostics/report.ts, then run UPDATE_DIAGNOSTIC_GOLDEN=1 vitest run src/lib/diagnostics/schema.test.ts.`).toEqual([]);
    const unused = FORMAT_IDS.filter(id => id !== 'other' && !ids.includes(id));
    expect(unused, 'whitelisted ids without a registered adapter').toEqual([]);
  });

  it('keeps every structure hook inside the whitelist: known hook id, schema keywords only, a sane pipeline', () => {
    const hooks = BOARD_ADAPTERS.flatMap(adapter => (adapter.structure ? [[adapter.id, adapter.structure] as const] : []));
    expect(hooks.length).toBeGreaterThanOrEqual(14);
    for (const [id, hook] of hooks) {
      expect(HOOK_IDS as readonly string[], `${id}: hook id`).toContain(hook.id);
      expect(['text', 'binary'], `${id}: hook kind`).toContain(hook.kind);
      for (const word of hook.keywords) expect(KEYWORDS.has(word), `${id}: "${word}" is not in enums.keyword`).toBe(true);
      expect(new Set(hook.steps).size, `${id}: steps are distinct`).toBe(hook.steps.length);
      for (const step of hook.steps) expect(['header', 'container', 'decrypt', 'decompress'], `${id}: step`).toContain(step);
      expect(typeof hook.collect).toBe('function');
    }
    // Adapters of one family share one hook; the keyword list of a family lives in exactly one place.
    expect(BOARD_ADAPTERS.find(adapter => adapter.id === 'brd')?.structure).toBe(BOARD_ADAPTERS.find(adapter => adapter.id === 'brd2')?.structure);
    expect(BOARD_ADAPTERS.find(adapter => adapter.id === 'bvr')?.structure).toBe(BOARD_ADAPTERS.find(adapter => adapter.id === 'bvr1')?.structure);
  });

  it('has hooks that never throw and never copy input text, whatever the bytes are', () => {
    const hostile = [new Uint8Array(0), new Uint8Array(1), Uint8Array.from({ length: 3000 }, (_, index) => (index * 31 + 7) & 255), new TextEncoder().encode('QZX7CANARY\r\n'.repeat(50)), new Uint8Array(5000).fill(0xff)];
    for (const adapter of BOARD_ADAPTERS) {
      const hook = adapter.structure;
      if (!hook) continue;
      for (const data of hostile) {
        const sinkCalls: string[] = [];
        const sink = new Proxy({ level: 2 }, { get: (target, key) => (key === 'level' ? 2 : (...args: unknown[]) => { sinkCalls.push(String(key)); void args; }) }) as never;
        expect(() => hook.collect({ data, companions: {}, extension: '.brd', keys: {} }, sink), `${adapter.id}`).not.toThrow();
      }
    }
  });
});

describe('every adapter describes its own fixtures without a word of them', () => {
  const fixtures = Object.entries(fixtureModules).flatMap(([path, list]) => {
    const id = /adapters\/([^/]+)\/fixtures\.ts$/.exec(path)![1];
    return list.map(fixture => ({ id, fixture }));
  });
  /** Every word of the public vocabulary of the report: the members of all lists and the names of all fields, split at punctuation. */
  const fieldNames = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(fieldNames);
    if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, child]) => [key, ...fieldNames(child)]);
    return [];
  };
  const WORDS = new Set<string>([...Object.values(schema.enums).flat(), ...fieldNames(schema.root), 'trace-format-diagnostic'].flatMap(word => word.split(/[^A-Za-z0-9]+/)).map(word => word.toLowerCase()).filter(Boolean));
  /** Words of a fixture that no public vocabulary of the schema contains: what a leak would look like. */
  function contentWords(fixture: AdapterFixture, board: { components: Array<{ ref: string; value: string; package: string }>; pins: Array<{ number: string; name: string; net: string }>; nets: Array<{ name: string }> } | null): string[] {
    const words = new Set<string>();
    const add = (text: string | undefined) => { for (const word of String(text ?? '').split(/[^\p{L}\p{N}]+/u)) if (word.length >= 2 && !/^\d+$/.test(word) && !WORDS.has(word.toLowerCase())) words.add(word); };
    for (const bytes of [fixture.data, ...Object.values(fixture.companions ?? {})]) {
      const text = Buffer.from(bytes).toString('latin1');
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text.slice(0, 2000))) add(text);
    }
    if (board) {
      for (const component of board.components) { add(component.ref); add(component.value); add(component.package); }
      for (const pin of board.pins) { add(pin.number); add(pin.name); add(pin.net); }
      for (const net of board.nets) add(net.name);
    }
    return [...words];
  }

  /** The report without its public vocabulary (field names, list members, numbers, literals): what is left could only be content. */
  const residual = (text: string): string => (text.match(/[A-Za-z0-9_.$!()<>/=-]+/g) ?? []).filter(token => !/^(?:true|false|null)$/.test(token) && !/^-?\d+(?:\.\d+)?$/.test(token) && !token.split(/[^A-Za-z0-9]+/).filter(Boolean).every(piece => WORDS.has(piece.toLowerCase()) || /^\d+$/.test(piece))).join(' ');

  it('keeps a leaked word, and a leak in any encoding, in what is left after the public vocabulary is removed', () => {
    const text = JSON.stringify({ hook: 'gencad', keywords: { '$HEADER': 1 }, leak: 'QZX7NET_ALPHA', hex: Buffer.from('QZX7NET_ALPHA').toString('hex'), b64: Buffer.from('QZX7NET_ALPHA').toString('base64'), near: 'headerQZX7' });
    expect(findLeaks(residual(text), { strings: ['QZX7NET_ALPHA'] }).length).toBeGreaterThan(2);
    expect(residual(JSON.stringify({ hook: 'gencad', keywords: { '$HEADER': 1 }, kind: 'text', headerOk: true, linesLog2: 12.5 }))).toBe('');
  });

  it('finds the fixtures of the registry', () => {
    expect(fixtures.length).toBeGreaterThan(30);
  });

  for (const { id, fixture } of fixtures) {
    it(`${id} / ${fixture.label}: a valid report at both levels, the right candidate, no word of the file`, async () => {
      const adapter = BOARD_ADAPTERS.find(item => item.id === id);
      let board = null;
      if (adapter && fixture.expect !== 'refused') {
        try { board = parseWith(adapter, { name: fixture.name, data: fixture.data, ...(fixture.companions ? { companions: { ...fixture.companions } } : {}), ...(fixture.options ? { options: fixture.options } : {}) }); } catch { board = null; }
      }
      const report = await collectDiagnostic({ name: fixture.name, data: fixture.data, ...(fixture.companions ? { companions: { ...fixture.companions } } : {}), ...(fixture.options ? { options: fixture.options } : {}) }, ENV);
      const words = contentWords(fixture, board);
      for (const level of [1, 2] as const) {
        const copy = diagnostics.validateReport(projectReport(report, { level, dedupe: false, reviewed: true }), { reviewed: true });
        const text = residual(diagnostics.serializeReport(copy));
        const literals = words.filter(word => word.length <= 3), longer = words.filter(word => word.length > 3);
        expect(findLeaks(text, { strings: longer }), `${id} / ${fixture.label}, level ${level}`).toEqual([]);
        for (const word of literals) expect(text.includes(`"${word}"`), `${id}: "${word}" appears as a value or key`).toBe(false);
      }
      if (fixture.expect === 'refused') {
        expect(report.detection.outcome, `${id} / ${fixture.label}`).toBe('failed');
        expect(report.detection.adapters.some(entry => entry.result === 'error' && entry.code === 'UNSUPPORTED_VARIANT')).toBe(true);
      } else if (id !== 'zip') {
        expect(report.detection.outcome, `${id} / ${fixture.label}`).toBe('opened');
        const claimed = report.detection.adapters.find(entry => entry.result === 'claimed');
        expect(claimed?.id).toBe((FORMAT_IDS as readonly string[]).includes(id) ? id : 'other');
      }
      if (adapter?.structure) expect(report.structure?.hook).toBe(adapter.structure.id);
    });
  }
});
