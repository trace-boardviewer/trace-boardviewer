import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kicad } from './diagnostics/canary-kit';
import { findLeaks } from './diagnostics/canary-check';
import { NAMES } from './diagnostics/canary-kit';
import type { DiagnosticReport } from './diagnostics/report';

/*
 * The worker of the format diagnostic report, run in-process with a stand-in for the worker scope: one message in (a file under a neutral name),
 * progress messages and one answer out - the full report, or a failure that carries no text of the file.
 */
interface FakeScope { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null }
let scope: FakeScope;
let posted: Array<Record<string, unknown>>;

async function loadWorker() {
  vi.resetModules();
  posted = [];
  scope = { postMessage: message => { posted.push(message as Record<string, unknown>); }, onmessage: null };
  (globalThis as unknown as { self: FakeScope }).self = scope;
  await import('./diagnostic-worker');
  expect(typeof scope.onmessage).toBe('function');
}
const answer = async (): Promise<Record<string, unknown>> => {
  for (let turn = 0; turn < 500; turn++) {
    const done = posted.find(message => 'report' in message || 'error' in message);
    if (done) return done;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('the worker never answered');
};

beforeEach(loadWorker);
afterEach(() => { delete (globalThis as { self?: unknown }).self; });

describe('diagnostic worker', () => {
  it('answers a file with the full report, announcing its progress first', async () => {
    const file = kicad();
    scope.onmessage!({ data: { name: 'diagnostic.kicad_pcb', data: file.data, os: 'darwin', dedupe: '0123456789abcdef' } });
    const reply = await answer();
    const report = reply.report as DiagnosticReport;
    expect(report.schema).toBe('trace-format-diagnostic/1');
    expect(report).toMatchObject({ app: { os: 'darwin' }, privacy: { level: 2, reviewedByUser: false, dedupe: true }, dedupe: '0123456789abcdef', detection: { outcome: 'opened', format: 'kicad' } });
    const fractions = posted.filter(message => 'progress' in message).map(message => (message.progress as { fraction: number }).fraction);
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    expect(findLeaks(JSON.stringify(reply), { strings: [...NAMES.refs, ...NAMES.nets, NAMES.title] })).toEqual([]);
  });

  it('runs one file per worker: a second message is ignored', async () => {
    const file = kicad();
    scope.onmessage!({ data: { name: 'diagnostic.kicad_pcb', data: file.data, os: 'linux', dedupe: null } });
    scope.onmessage!({ data: { name: 'diagnostic.kicad_pcb', data: file.data, os: 'linux', dedupe: null } });
    await answer();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(posted.filter(message => 'report' in message)).toHaveLength(1);
  });

  it('rejects a malformed request without any detail', async () => {
    const { isRun } = await import('./diagnostic-worker');
    const bads = [null, 'text', {}, { name: 1, data: new Uint8Array(1), os: 'linux', dedupe: null }, { name: 'a', data: [1, 2], os: 'linux', dedupe: null }, { name: 'a', data: new Uint8Array(1), os: 'plan9', dedupe: null }, { name: 'a', data: new Uint8Array(1), os: 'linux', dedupe: 5 }];
    for (const bad of bads) expect(isRun(bad), JSON.stringify(bad)).toBe(false);
    expect(isRun({ name: 'diagnostic.brd', data: new Uint8Array(1), os: 'linux', dedupe: null })).toBe(true);
    scope.onmessage!({ data: bads[3] });
    expect(await answer()).toEqual({ error: 'INVALID_REQUEST' });
  });

  it('answers an input over the size limit with TOO_LARGE and never quotes anything', async () => {
    scope.onmessage!({ data: { name: 'diagnostic.brd', data: new Uint8Array(64 * 1024 * 1024 + 1), os: 'win32', dedupe: null } });
    expect(await answer()).toEqual({ error: 'TOO_LARGE' });
  });

  it('describes a file no reader claims, and an empty file, with a report like any other', async () => {
    for (const data of [new Uint8Array(0), new TextEncoder().encode('QZX7NOTES this is not a board\n1 2 3\n')]) {
      await loadWorker();
      scope.onmessage!({ data: { name: 'diagnostic.txt', data, os: 'linux', dedupe: null } });
      const reply = await answer();
      expect((reply.report as DiagnosticReport).detection.outcome).toBe('unrecognized');
      expect(JSON.stringify(reply)).not.toContain('QZX7NOTES');
    }
  });
});
