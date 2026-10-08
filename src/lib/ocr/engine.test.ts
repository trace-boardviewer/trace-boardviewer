import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GrayImage, OcrEngine } from './contract';
import { createWorkerOcrEngineFactory } from './engine';
import type { OcrEngineAssets, OcrWorkerPort } from './engine';
import { MAX_WORKER_PIXELS, parseWorkerReply, parseWorkerRequest } from './protocol';
import type { OcrWorkerReply, OcrWorkerRequest } from './protocol';
import { BLOCKED_WORKER_GLOBALS, blockNetworkAccess } from './sandbox';

const require = createRequire(import.meta.url);
const coreRoot = path.dirname(require.resolve('tesseract.js-core/package.json'));
const realAssets = (): OcrEngineAssets => ({
  simd: true,
  wasm: new Uint8Array(readFileSync(path.join(coreRoot, 'tesseract-core-simd-lstm.wasm'))).buffer,
  data: new Uint8Array(readFileSync(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))).buffer,
});
const tinyAssets = (): OcrEngineAssets => ({ simd: true, wasm: new ArrayBuffer(8), data: new ArrayBuffer(8) });
const gray = (width: number, height: number, value = 255): GrayImage => ({ width, height, data: new Uint8Array(width * height).fill(value) });

describe('worker messages are validated on both sides', () => {
  const pixels = (n: number) => new ArrayBuffer(n);
  it('accepts well-formed requests and refuses everything else', () => {
    expect(parseWorkerRequest({ type: 'init', id: 1, simd: true, wasm: new ArrayBuffer(1), language: 'eng', data: new ArrayBuffer(1) })).not.toBeNull();
    expect(parseWorkerRequest({ type: 'recognize', id: 2, width: 4, height: 2, pixels: pixels(8), dpi: 300, rotations: [0, 1], pageSegmentation: 11 })).not.toBeNull();
    const bad: unknown[] = [
      null, 'init', { type: 'init', id: 0, simd: true, wasm: new ArrayBuffer(1), language: 'eng', data: new ArrayBuffer(1) },
      { type: 'init', id: 1, simd: 'yes', wasm: new ArrayBuffer(1), language: 'eng', data: new ArrayBuffer(1) },
      { type: 'init', id: 1, simd: true, wasm: new ArrayBuffer(1), language: 'deu', data: new ArrayBuffer(1) },
      { type: 'init', id: 1, simd: true, wasm: new Uint8Array(1), language: 'eng', data: new ArrayBuffer(1) },
      { type: 'recognize', id: 2, width: 4, height: 2, pixels: pixels(7), dpi: 300, rotations: [0], pageSegmentation: 11 },
      { type: 'recognize', id: 2, width: 4.5, height: 2, pixels: pixels(9), dpi: 300, rotations: [0], pageSegmentation: 11 },
      { type: 'recognize', id: 2, width: MAX_WORKER_PIXELS, height: 2, pixels: pixels(8), dpi: 300, rotations: [0], pageSegmentation: 11 },
      { type: 'recognize', id: 2, width: 4, height: 2, pixels: pixels(8), dpi: 0, rotations: [0], pageSegmentation: 11 },
      { type: 'recognize', id: 2, width: 4, height: 2, pixels: pixels(8), dpi: 300, rotations: [4], pageSegmentation: 11 },
      { type: 'recognize', id: 2, width: 4, height: 2, pixels: pixels(8), dpi: 300, rotations: [], pageSegmentation: 11 },
      { type: 'recognize', id: 2, width: 4, height: 2, pixels: pixels(8), dpi: 300, rotations: [0], pageSegmentation: 99 },
      { type: 'eval', id: 3, code: '1+1' },
    ];
    for (const message of bad) expect(parseWorkerRequest(message), JSON.stringify(message)).toBeNull();
  });

  it('accepts well-formed replies and refuses malformed ones', () => {
    expect(parseWorkerReply({ type: 'ready', id: 1, version: '5.1.0', blocked: [] })).not.toBeNull();
    expect(parseWorkerReply({ type: 'words', id: 1, ms: 3, words: [{ text: 'R1', x: 1, y: 2, width: 3, height: 4, confidence: 90, rotation: 0 }] })).not.toBeNull();
    expect(parseWorkerReply({ type: 'error', id: 1, code: 'FAILED', message: 'x' })).not.toBeNull();
    for (const message of [
      { type: 'words', id: 1, ms: 3, words: [{ text: 'R1', x: Number.NaN, y: 2, width: 3, height: 4, confidence: 90, rotation: 0 }] },
      { type: 'words', id: 1, ms: 3, words: [{ text: 5, x: 1, y: 2, width: 3, height: 4, confidence: 90, rotation: 0 }] },
      { type: 'words', id: 1, ms: 3, words: [{ text: 'R1', x: 1, y: 2, width: 3, height: 4, confidence: 90, rotation: 7 }] },
      { type: 'error', id: 1, code: 'EVIL', message: 'x' }, { type: 'ready', id: 'one', version: 'x', blocked: [] }, 42,
    ]) expect(parseWorkerReply(message), JSON.stringify(message)).toBeNull();
  });
});

describe('the worker sandbox', () => {
  it('replaces every network and script-loading global with a non-configurable stub that throws', () => {
    const scope: Record<string, unknown> = Object.fromEntries(BLOCKED_WORKER_GLOBALS.map(name => [name, vi.fn()]));
    scope.postMessage = vi.fn();
    const blocked = blockNetworkAccess(scope);
    expect(blocked.sort()).toEqual([...BLOCKED_WORKER_GLOBALS].sort());
    for (const name of BLOCKED_WORKER_GLOBALS) {
      expect(() => (scope[name] as () => void)()).toThrow(/disabled in the text recognition worker/);
      expect(() => { scope[name] = () => 'again'; }).toThrow(TypeError); // frozen in place (strict mode)
      expect(Object.getOwnPropertyDescriptor(scope, name)?.configurable).toBe(false);
    }
    expect(typeof scope.postMessage).toBe('function');
    expect(blockNetworkAccess({})).toEqual([]);
  });
});

/** A fake worker port: the test plays the worker. */
function fakePort() {
  const sent: OcrWorkerRequest[] = [];
  const port: OcrWorkerPort & { sent: OcrWorkerRequest[]; terminated: number; reply(message: unknown): void; crash(): void } = {
    onmessage: null, onerror: null, sent, terminated: 0,
    postMessage(message) { sent.push(message); },
    terminate() { port.terminated++; },
    reply(message) { port.onmessage?.({ data: message }); },
    crash() { port.onerror?.({}); },
  };
  return port;
}
async function startedEngine(port: ReturnType<typeof fakePort>, options: { startTimeoutMs?: number } = {}): Promise<OcrEngine> {
  const factory = createWorkerOcrEngineFactory({ createWorker: () => port, loadAssets: async () => tinyAssets(), startTimeoutMs: options.startTimeoutMs });
  const starting = factory({ language: 'eng' });
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  port.reply({ type: 'ready', id: port.sent[0].id, version: 'test', blocked: ['fetch'] });
  return starting;
}

describe('engine client (fake worker)', () => {
  it('starts the worker with the engine bytes transferred, then posts a private copy of the pixels', async () => {
    const port = fakePort();
    const engine = await startedEngine(port);
    expect(port.sent[0]).toMatchObject({ type: 'init', language: 'eng', simd: true });
    const image = gray(4, 2, 7);
    const pending = engine.recognize(image, { dpi: 300 });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    const request = port.sent[1] as Extract<OcrWorkerRequest, { type: 'recognize' }>;
    expect(request).toMatchObject({ type: 'recognize', width: 4, height: 2, dpi: 300, rotations: [0, 1], pageSegmentation: 11 });
    expect(request.pixels).not.toBe(image.data.buffer);
    expect([...image.data]).toEqual(Array(8).fill(7));
    port.reply({ type: 'words', id: request.id, ms: 1, words: [{ text: 'R1', x: 0, y: 0, width: 2, height: 1, confidence: 88, rotation: 0 }] } satisfies OcrWorkerReply);
    expect(await pending).toEqual([{ text: 'R1', x: 0, y: 0, width: 2, height: 1, confidence: 88, rotation: 0 }]);
    engine.dispose();
    expect(port.terminated).toBe(1);
    engine.dispose();
    expect(port.terminated).toBe(1);
  });

  it('runs one recognition at a time', async () => {
    const port = fakePort();
    const engine = await startedEngine(port);
    const first = engine.recognize(gray(2, 2), { dpi: 300 });
    const second = engine.recognize(gray(2, 2), { dpi: 300 });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(port.sent).toHaveLength(2); // the second waits for the first
    port.reply({ type: 'words', id: port.sent[1].id, ms: 1, words: [] });
    await first;
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    port.reply({ type: 'words', id: port.sent[2].id, ms: 1, words: [] });
    expect(await second).toEqual([]);
  });

  it('an expired budget rejects with TIMEOUT and terminates the worker; later calls fail fast', async () => {
    const port = fakePort();
    const engine = await startedEngine(port);
    await expect(engine.recognize(gray(2, 2), { dpi: 300, timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(port.terminated).toBe(1);
    expect(engine.disposed).toBe(true);
    await expect(engine.recognize(gray(2, 2), { dpi: 300 })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('cancelling terminates the worker at once', async () => {
    const port = fakePort();
    const engine = await startedEngine(port);
    const controller = new AbortController();
    const pending = engine.recognize(gray(2, 2), { dpi: 300, signal: controller.signal });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(port.terminated).toBe(1);
  });

  it('a malformed reply, an engine error and a crashed worker are reported, never resolved', async () => {
    let port = fakePort();
    let engine = await startedEngine(port);
    let pending = engine.recognize(gray(2, 2), { dpi: 300 });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    port.reply({ type: 'words', id: port.sent[1].id, ms: 1, words: 'all of them' });
    await expect(pending).rejects.toMatchObject({ code: 'FAILED' });
    expect(port.terminated).toBe(1);

    port = fakePort(); engine = await startedEngine(port);
    pending = engine.recognize(gray(2, 2), { dpi: 300 });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    port.reply({ type: 'error', id: port.sent[1].id, code: 'FAILED', message: 'image rejected' });
    await expect(pending).rejects.toMatchObject({ code: 'FAILED', message: 'image rejected' });
    expect(engine.disposed).toBe(false); // an engine error for one input keeps the engine

    pending = engine.recognize(gray(2, 2), { dpi: 300 });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    port.crash();
    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(engine.disposed).toBe(true);
  });

  it('a worker that does not start in time, or reports a start failure, makes the engine UNAVAILABLE', async () => {
    const slow = fakePort();
    await expect(createWorkerOcrEngineFactory({ createWorker: () => slow, loadAssets: async () => tinyAssets(), startTimeoutMs: 20 })({ language: 'eng' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(slow.terminated).toBe(1);
    const failing = fakePort();
    const starting = createWorkerOcrEngineFactory({ createWorker: () => failing, loadAssets: async () => tinyAssets() })({ language: 'eng' });
    await vi.waitFor(() => expect(failing.sent).toHaveLength(1));
    failing.reply({ type: 'error', id: failing.sent[0].id, code: 'UNAVAILABLE', message: 'CompileError: WebAssembly.instantiate(): Refused to compile' });
    await expect(starting).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(createWorkerOcrEngineFactory({ createWorker: () => { throw new Error('no workers'); }, loadAssets: async () => tinyAssets() })({ language: 'eng' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const controller = new AbortController(); controller.abort();
    await expect(createWorkerOcrEngineFactory({ createWorker: () => fakePort(), loadAssets: async () => tinyAssets() })({ language: 'eng', signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

// ------------------------------------------------------------------------------------------------------------------
// The real worker module, run in-process: `self` is a fake worker scope, the engine and data are the bundled files.
type FakeScope = Record<string, unknown> & { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void };
const scope: FakeScope = {
  onmessage: null,
  postMessage: () => {},
  fetch: () => Promise.reject(new Error('real fetch must not be reachable')), XMLHttpRequest: function () {}, WebSocket: function () {}, EventSource: function () {}, importScripts: () => {},
};
let previousSelf: unknown;
beforeAll(async () => {
  previousSelf = (globalThis as { self?: unknown }).self;
  (globalThis as { self?: unknown }).self = scope;
  await import('./ocr.worker');
});
afterAll(() => { (globalThis as { self?: unknown }).self = previousSelf; });

function inProcessWorker(): OcrWorkerPort {
  const port: OcrWorkerPort = {
    onmessage: null, onerror: null,
    postMessage(message) { queueMicrotask(() => scope.onmessage?.({ data: message })); },
    terminate() { port.onmessage = null; },
  };
  scope.postMessage = message => queueMicrotask(() => port.onmessage?.({ data: message }));
  return port;
}

describe('the OCR worker module (in-process)', () => {
  it('blocks the network globals of its scope before the engine runs', () => {
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
      expect(() => (scope[name] as () => void)(), name).toThrow(/disabled in the text recognition worker/);
    }
  });

  it('starts the bundled engine from transferred bytes, recognizes a page and refuses malformed requests', async () => {
    const engine = await createWorkerOcrEngineFactory({ createWorker: inProcessWorker, loadAssets: async () => realAssets() })({ language: 'eng' });
    const blank = gray(300, 200);
    expect(await engine.recognize(blank, { dpi: 300, rotations: [0] })).toEqual([]);
    // a raw malformed message gets a structured INVALID reply
    const replies: unknown[] = [];
    scope.postMessage = message => replies.push(message);
    scope.onmessage?.({ data: { type: 'recognize', id: 99, width: 2, height: 2, pixels: new ArrayBuffer(3), dpi: 300, rotations: [0], pageSegmentation: 11 } });
    expect(replies).toEqual([{ type: 'error', id: 99, code: 'INVALID', message: 'Malformed request.' }]);
    scope.onmessage?.({ data: { type: 'init', id: 100, simd: true, wasm: new ArrayBuffer(8), language: 'eng', data: new ArrayBuffer(8) } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toMatchObject({ type: 'error', id: 100, code: 'INVALID' }); // already initialized
    engine.dispose();
  }, 60_000);
});
