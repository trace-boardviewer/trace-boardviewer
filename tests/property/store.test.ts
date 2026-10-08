import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { params } from './support';

// ---------------------------------------------------------------------------------------------------------------
// The native store, driven through an in-memory file system that can be slowed down and made to fail
// ---------------------------------------------------------------------------------------------------------------

interface Store {
  readonly directory: string;
  readonly closing: boolean;
  path(name: string): string;
  read(name: string, options?: { missing?: unknown; maxBytes?: number }): Promise<unknown>;
  write(name: string, value: unknown, options?: { maxBytes?: number }): Promise<void>;
  update(name: string, updater: (current: unknown) => unknown): Promise<unknown>;
  compute(name: string, producer: () => unknown, options?: { commit?: (value: unknown) => void }): Promise<unknown>;
  flush(): Promise<void>;
  beginShutdown(): Promise<void>;
}
interface StoreModule {
  createJsonStore(options: { directory: string; maxBytes?: number; fs?: unknown; renameRetryDelaysMs?: number[]; t?: (key: string) => string }): Store;
  validateName(name: unknown): string[];
}
const native = createRequire(import.meta.url)('../../electron/store.cjs') as StoreModule;

type Fault = 'io' | 'busy' | 'partial';
const codeError = (code: string, message = code) => Object.assign(new Error(message), { code });

class MemoryFs {
  readonly files = new Map<string, string>();
  mutations = 0;
  constructor(private readonly delays: readonly number[], private readonly faults: ReadonlyMap<number, Fault>) {}
  private calls = 0;
  /** Lets other tasks run: a few microtask turns, now and then a whole macrotask. */
  private async tick(): Promise<void> {
    const turns = this.delays[this.calls++ % Math.max(1, this.delays.length)] ?? 0;
    for (let i = 0; i < turns % 4; i++) await Promise.resolve();
    if (turns >= 4) await new Promise<void>(resolve => setImmediate(resolve));
  }
  private fault(kind: 'mkdir' | 'write' | 'rename'): Fault | undefined {
    const found = this.faults.get(this.mutations++);
    if (found === undefined) return undefined;
    if (found === 'busy' && kind !== 'rename') return 'io';
    if (found === 'partial' && kind !== 'write') return 'io';
    return found;
  }
  async open(file: string) {
    await this.tick();
    const text = this.files.get(file);
    if (text === undefined) throw codeError('ENOENT');
    const bytes = Buffer.from(text, 'utf8');
    return {
      stat: async () => ({ size: bytes.length, isFile: () => true }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        await this.tick();
        const count = Math.max(0, Math.min(length, bytes.length - position));
        bytes.copy(buffer, offset, position, position + count);
        return { bytesRead: count };
      },
      close: async () => undefined,
    };
  }
  async mkdir() { await this.tick(); if (this.fault('mkdir')) throw codeError('EIO'); }
  async writeFile(file: string, body: string) {
    await this.tick();
    if (this.files.has(file)) throw codeError('EEXIST');
    const fault = this.fault('write');
    if (fault === 'partial') { this.files.set(file, body.slice(0, Math.floor(body.length / 2))); throw codeError('ENOSPC'); }
    if (fault) throw codeError('EIO');
    this.files.set(file, body);
  }
  async rename(from: string, to: string) {
    await this.tick();
    const fault = this.fault('rename');
    if (fault === 'busy') throw codeError('EBUSY');
    if (fault) throw codeError('EIO');
    const body = this.files.get(from);
    if (body === undefined) throw codeError('ENOENT');
    this.files.delete(from); this.files.set(to, body);
  }
  async unlink(file: string) { await this.tick(); if (!this.files.delete(file)) throw codeError('ENOENT'); }
}

const DIRECTORY = path.join(os.tmpdir(), 'trace-property-store');
const NAMES = ['a.json', 'b.json', 'notes/c.json', 'x/y/z.json'] as const;
const fileOf = (name: string) => path.join(DIRECTORY, ...name.split('/'));
const make = (fs: MemoryFs, extra: { maxBytes?: number } = {}) => native.createJsonStore({ directory: DIRECTORY, fs, renameRetryDelaysMs: [0, 0, 0], ...extra });

type Op =
  | { kind: 'write'; name: string; value: number }
  | { kind: 'update'; name: string }
  | { kind: 'updateThrows'; name: string }
  | { kind: 'compute'; name: string; value: number }
  | { kind: 'read'; name: string }
  | { kind: 'oversize'; name: string }
  | { kind: 'badName'; name: string }
  | { kind: 'flush' }
  | { kind: 'shutdown' };
const name = fc.constantFrom(...NAMES);
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('write' as const), name, value: fc.integer({ min: 0, max: 1000 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('update' as const), name }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('updateThrows' as const), name }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('compute' as const), name, value: fc.integer({ min: 0, max: 1000 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('read' as const), name }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('oversize' as const), name }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('badName' as const), name: fc.constantFrom('', '..', '../x', 'a//b', '/abs', 'a\\b', 'C:x', '.', 'a/./b', 'x'.repeat(300), 'a b', 'a:b') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('flush' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('shutdown' as const) }) },
);
const faults = fc.array(fc.tuple(fc.nat({ max: 40 }), fc.constantFrom<Fault>('io', 'busy', 'partial', 'busy')), { maxLength: 8 }).map(list => new Map(list));

type Outcome = { ok: true; value: unknown } | { ok: false; error: { code?: string } };
const outcomeOf = (promise: Promise<unknown>): Promise<Outcome> => promise.then(value => ({ ok: true as const, value }), (error: { code?: string }) => ({ ok: false as const, error }));

describe('the native store', () => {
  it('runs operations in submission order, never loses an accepted write, never accepts one after shutdown, and leaves exactly the committed state', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(op, { minLength: 1, maxLength: 14 }), fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 12 }), fc.array(fc.nat({ max: 5 }), { maxLength: 14 }), faults, fc.boolean(),
      async (ops, delays, gaps, faultPlan, preload) => {
        const fs = new MemoryFs(delays, faultPlan);
        if (preload) fs.files.set(fileOf('a.json'), JSON.stringify({ n: 100 }));
        const store = make(fs, { maxBytes: 4096 });
        const model = new Map<string, unknown>(preload ? [['a.json', { n: 100 }]] : []);
        const results: Promise<Outcome>[] = [], settled: number[] = [], commits: unknown[] = [];
        const boom = new Error('updater failed');
        for (let i = 0; i < ops.length; i++) {
          for (let turn = 0; turn < (gaps[i] ?? 0); turn++) await Promise.resolve();
          const item = ops[i];
          let promise: Promise<unknown>;
          switch (item.kind) {
            case 'write': promise = store.write(item.name, { v: item.value }); break;
            case 'update': promise = store.update(item.name, current => ({ n: ((current as { n?: number } | null)?.n ?? 0) + 1 })); break;
            case 'updateThrows': promise = store.update(item.name, () => { throw boom; }); break;
            case 'compute': promise = store.compute(item.name, () => ({ c: item.value }), { commit: value => { commits.push(value); } }); break;
            case 'read': promise = store.read(item.name); break;
            case 'oversize': promise = store.write(item.name, { text: 'x'.repeat(5000) }); break;
            case 'badName': promise = store.write(item.name, { v: 1 }); break;
            case 'flush': promise = store.flush(); break;
            case 'shutdown': promise = store.beginShutdown(); break;
          }
          const index = i;
          results.push(outcomeOf(promise).then(outcome => { settled.push(index); return outcome; }));
        }
        const outcomes = await Promise.all(results);
        await store.flush();

        // Walk the submissions in order and apply what was observed, checking every rule on the way.
        let closing = false;
        const expectedCommits: unknown[] = [];
        const queueSettled: number[] = [];
        ops.forEach((item, i) => {
          const outcome = outcomes[i];
          const label = `#${i} ${item.kind}`;
          const failedWrite = () => { expect(outcome.ok, label).toBe(false); if (!outcome.ok) expect(outcome.error.code, label).toBe('STORE_WRITE_FAILED'); };
          switch (item.kind) {
            case 'shutdown': closing = true; expect(outcome.ok, label).toBe(true); break;
            case 'flush': expect(outcome.ok, label).toBe(true); break;
            case 'read': expect(outcome, label).toEqual({ ok: true, value: model.has(item.name) ? model.get(item.name) : null }); break;
            case 'oversize': expect(outcome.ok, label).toBe(false); if (!outcome.ok) expect(outcome.error.code, label).toBe('STORE_TOO_LARGE'); break;
            case 'badName': expect(outcome.ok, label).toBe(false); if (!outcome.ok) expect(outcome.error.code, label).toBe('STORE_INVALID_NAME'); break;
            case 'write': case 'update': case 'updateThrows': case 'compute': {
              if (closing) { expect(outcome.ok, label).toBe(false); if (!outcome.ok) expect(outcome.error.code, label).toBe('STORE_CLOSING'); break; }
              queueSettled.push(i);
              if (item.kind === 'updateThrows') { expect(outcome.ok, label).toBe(false); if (!outcome.ok) expect(outcome.error, label).toBe(boom); break; }
              if (!outcome.ok) { failedWrite(); break; }
              if (item.kind === 'write') { model.set(item.name, { v: item.value }); expect(outcome.ok && outcome.value, label).toBeUndefined(); }
              else if (item.kind === 'update') {
                const next = { n: ((model.get(item.name) as { n?: number } | undefined)?.n ?? 0) + 1 };
                expect(outcome.value, label).toEqual(next); model.set(item.name, next);
              } else { model.set(item.name, { c: item.value }); expectedCommits.push({ c: item.value }); expect(outcome.value, label).toEqual({ c: item.value }); }
              break;
            }
          }
        });
        // Operations that were accepted settle in the order they were submitted.
        const acceptedOrder = settled.filter(i => queueSettled.includes(i));
        expect(acceptedOrder).toEqual(queueSettled);
        // The drain: when the shutdown settled, everything accepted before it had settled.
        const shutdownAt = ops.findIndex(item => item.kind === 'shutdown');
        if (shutdownAt >= 0) for (const i of queueSettled.filter(index => index < shutdownAt)) expect(settled.indexOf(i)).toBeLessThan(settled.indexOf(shutdownAt));
        // A commit ran for every successful compute, in order, and for nothing else.
        expect(commits).toEqual(expectedCommits);
        // The disk holds exactly the committed values, no half-written file and no leftover temporary file.
        for (const [file, text] of fs.files) {
          expect(file.endsWith('.tmp'), `leftover ${file}`).toBe(false);
          const key = NAMES.find(candidate => fileOf(candidate) === file);
          expect(key, `unexpected file ${file}`).toBeDefined();
          expect(JSON.parse(text)).toEqual(model.get(key as string));
        }
        for (const [key, value] of model) expect(JSON.parse(fs.files.get(fileOf(key)) ?? 'null'), key).toEqual(value);
      },
    ), params(250));
  });

  it('retries a busy rename a bounded number of times: a short burst never loses the write, a long one fails it cleanly and the queue goes on', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 14 }), fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 4 }), async (burst, values) => {
      // Mutation 0 is mkdir, 1 the temporary file, 2.. the attempts to rename the first write (one try and three retries), then the next write starts over.
      const plan = new Map<number, Fault>(Array.from({ length: burst }, (_, k) => [2 + k, 'busy'] as const));
      const fs = new MemoryFs([0], plan);
      const store = make(fs);
      const outcomes = await Promise.all([-1, ...values].map(value => outcomeOf(store.write('a.json', { v: value }))));
      if (burst < 4) expect(outcomes.every(outcome => outcome.ok)).toBe(true);
      else { expect(outcomes[0].ok).toBe(false); if (!outcomes[0].ok) expect(outcomes[0].error.code).toBe('STORE_WRITE_FAILED'); }
      for (const outcome of outcomes) if (!outcome.ok) expect(outcome.error.code).toBe('STORE_WRITE_FAILED');
      expect([...fs.files.keys()].some(file => file.endsWith('.tmp'))).toBe(false);
      // The file holds the last write that succeeded, whole, or nothing at all.
      const lastGood = [-1, ...values].map((value, i) => (outcomes[i].ok ? value : undefined)).filter(value => value !== undefined).pop();
      expect(await store.read('a.json')).toEqual(lastGood === undefined ? null : { v: lastGood });
    }), params(40));
  });

  it('validates store names: only slash-joined segments of letters, digits, dot, underscore and hyphen are names, and no accepted name leaves the directory', () => {
    const SEGMENT = /^[A-Za-z0-9._-]+$/;
    const text = fc.oneof(fc.string({ maxLength: 40 }), fc.array(fc.constantFrom('a', 'B', '0', '.', '..', '-', '_', '/', '\\', ':', ' ', '%', '\u0000', 'é'), { maxLength: 10 }).map(parts => parts.join('')), fc.constantFrom('config.json', 'notes/abc.json', 'a/b/c/d', 'a/b/c/d/e', '.hidden', 'x..y', '..x', 'x/..'));
    fc.assert(fc.property(text, candidate => {
      const segments = candidate.split('/');
      const valid = candidate.length > 0 && segments.length <= 4 && segments.every(segment => segment.length > 0 && segment.length <= 255 && segment !== '.' && segment !== '..' && SEGMENT.test(segment));
      let accepted: string[] | null = null;
      try { accepted = native.validateName(candidate); } catch (error) { expect((error as { code?: string }).code).toBe('STORE_INVALID_NAME'); }
      expect(accepted !== null).toBe(valid);
      if (accepted) {
        expect(accepted).toEqual(segments);
        const store = make(new MemoryFs([0], new Map()));
        const relative = path.relative(DIRECTORY, store.path(candidate));
        expect(relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)).toBe(false);
        expect(relative.split(path.sep)).toEqual(segments);
      }
    }), params(1500));
    fc.assert(fc.property(fc.anything(), value => {
      if (typeof value === 'string') return;
      expect(() => native.validateName(value)).toThrow(expect.objectContaining({ code: 'STORE_INVALID_NAME' }));
    }), params(100));
  });

  it('reads of missing entries answer the default, or the given one; entries over the bound are refused, not truncated', async () => {
    await fc.assert(fc.asyncProperty(name, fc.option(fc.jsonValue(), { nil: undefined }), fc.integer({ min: 16, max: 400 }), async (entry, fallback, limit) => {
      const fs = new MemoryFs([0], new Map());
      const store = make(fs, { maxBytes: 512 });
      expect(await store.read(entry)).toBeNull();
      expect(await store.read(entry, fallback === undefined ? undefined : { missing: fallback })).toEqual(fallback === undefined ? null : fallback);
      const stored = JSON.stringify({ text: 'y'.repeat(300) });
      fs.files.set(fileOf(entry), stored);
      if (limit < stored.length) await expect(store.read(entry, { maxBytes: limit })).rejects.toMatchObject({ code: 'STORE_TOO_LARGE' });
      else expect(await store.read(entry, { maxBytes: limit })).toEqual({ text: 'y'.repeat(300) });
      fs.files.set(fileOf(entry), '{not json');
      await expect(store.read(entry)).rejects.toMatchObject({ code: 'STORE_INVALID_JSON' });
    }), params(60));
  });
});
