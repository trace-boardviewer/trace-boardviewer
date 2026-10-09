import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { parseBoard } from './formats';
import { MODEL_PROTOCOL } from './model-protocol';
import { reportParseProgress, withParseProgress } from './parse-progress';

const enc = (text: string) => new TextEncoder().encode(text);

/** An original GenCAD board with `count` two-pin parts, each on its own net. */
function genCad(count: number): string {
  const parts: string[] = [], signals: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(`COMPONENT R${i + 1}\nPLACE ${i % 100} ${Math.floor(i / 100)}\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D`);
    signals.push(`SIGNAL N${i + 1}\nNODE R${i + 1} 1\nNODE R${i + 1} 2`);
  }
  return `$HEADER\nGENCAD 1.4\nUNITS MM\nORIGIN 0 0\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 200 200\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n`
    + `$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nRECTANGLE -0.4 -0.2 0.8 0.4\nPIN 1 PS -0.2 0 TOP 0 0\nPIN 2 PS 0.2 0 TOP 0 0\n$ENDSHAPES\n`
    + `$COMPONENTS\n${parts.join('\n')}\n$ENDCOMPONENTS\n$DEVICES\nDEVICE D\nVALUE "10k"\nPACKAGE "0402"\n$ENDDEVICES\n$SIGNALS\n${signals.join('\n')}\n$ENDSIGNALS\n`;
}
/** An original KiCad PCB with `count` one-pad footprints. */
function kicadPcb(count: number): string {
  const footprints: string[] = [];
  for (let i = 0; i < count; i++) {
    footprints.push(`(footprint "Test:Pad" (layer "F.Cu") (at ${i % 50} ${Math.floor(i / 50)}) (property "Reference" "TP${i + 1}") (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "GND")))`);
  }
  return `(kicad_pcb (version 20240108) (generator "synthetic") (net 0 "") (net 1 "GND")\n${footprints.join('\n')}\n(gr_rect (start -1 -1) (end 60 60) (layer "Edge.Cuts")))`;
}

describe('parse progress reports', () => {
  it('is a no-op without a listener and never throws on odd input', () => {
    expect(() => { reportParseProgress(5, 10); reportParseProgress(Number.NaN, 10); reportParseProgress(1, 0); }).not.toThrow();
  });

  it('delivers clamped fractions that never decrease, and only inside the run', () => {
    const seen: number[] = [];
    const result = withParseProgress(fraction => seen.push(fraction), () => {
      reportParseProgress(1, 4); reportParseProgress(1, 4); reportParseProgress(0, 4); reportParseProgress(3, 4);
      reportParseProgress(9, 4); reportParseProgress(Number.POSITIVE_INFINITY, 4); reportParseProgress(2, 0);
      return 'parsed';
    });
    expect(result).toBe('parsed');
    expect(seen).toEqual([0.25, 0.75, 1]);
    reportParseProgress(1, 2);
    expect(seen).toEqual([0.25, 0.75, 1]);
  });

  it('restores the outer listener after a nested run and after a parser failure', () => {
    const outer: number[] = [], inner: number[] = [];
    withParseProgress(fraction => outer.push(fraction), () => {
      reportParseProgress(1, 10);
      withParseProgress(fraction => inner.push(fraction), () => reportParseProgress(5, 10));
      expect(() => withParseProgress(() => {}, () => { throw new Error('bad file'); })).toThrow('bad file');
      reportParseProgress(2, 10);
    });
    expect(outer).toEqual([0.1, 0.2]);
    expect(inner).toEqual([0.5]);
  });

  it('GenCAD reports its position through both halves of the parse', () => {
    const seen: number[] = [];
    const board = withParseProgress(fraction => seen.push(fraction), () => parseBoard({ name: 'big.cad', data: enc(genCad(3000)) }));
    expect(board.components).toHaveLength(3000);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.some(fraction => fraction < 0.5)).toBe(true);
    expect(seen.some(fraction => fraction > 0.5)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('KiCad reports its position while scanning the top-level elements', () => {
    const seen: number[] = [];
    const board = withParseProgress(fraction => seen.push(fraction), () => parseBoard({ name: 'big.kicad_pcb', data: enc(kicadPcb(400)) }));
    expect(board.components).toHaveLength(400);
    expect(seen.length).toBeGreaterThan(100);
    expect(seen.at(-1)!).toBeGreaterThan(0.9);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe('board worker: progress while parsing, then the board model on the same worker', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  async function startWorker() {
    const posted: Array<Record<string, unknown>> = [];
    const scope: { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null } = { postMessage: message => posted.push(message as Record<string, unknown>), onmessage: null };
    vi.stubGlobal('self', scope);
    await import('./board-worker');
    return { posted, send: (data: unknown) => scope.onmessage!({ data }) };
  }

  it('posts throttled progress, then the board with the protocol version, then answers model requests', async () => {
    const { posted, send } = await startWorker();
    send({ name: 'big.cad', data: enc(genCad(3000)) });
    const progress = posted.filter(message => 'progress' in message).map(message => (message.progress as { fraction: number }).fraction);
    const final = posted.find(message => 'board' in message)!;
    expect(final.model).toBe(MODEL_PROTOCOL);
    expect(final.reportContext).toEqual({ stage: 'done', formatId: 'gencad' });
    expect((final.board as { components: unknown[] }).components).toHaveLength(3000);
    expect(posted.indexOf(final)).toBe(posted.length - 1);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThanOrEqual(101); // at most one per percent
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    for (let i = 1; i < progress.length; i++) expect(progress[i] - progress[i - 1] >= 0.01 || progress[i] === 1).toBe(true);
    send({ type: 'search', id: 1, query: 'R2999' });
    send({ type: 'index', id: 2 });
    await vi.waitFor(() => expect(posted.filter(message => message.type !== undefined)).toHaveLength(2));
    const [search, index] = posted.filter(message => message.type !== undefined);
    expect(search).toMatchObject({ type: 'search', id: 1 });
    expect((search.result as { groups: Array<{ rows: Array<{ ref: string }> }> }).groups[0].rows[0].ref).toBe('R2999');
    expect(index).toMatchObject({ type: 'index', id: 2, result: { stats: { components: 3000, pins: 6000, nets: 3000 } } });
  });

  it('reports a parse failure structured and does not become a model worker', async () => {
    const { posted, send } = await startWorker();
    send({ name: 'broken.cad', data: enc('$HEADER\nGENCAD 1.4\n$ENDHEADER\n$COMPONENTS\nCOMPONENT R1\n$ENDCOMPONENTS\n') });
    const failure = posted.find(message => 'issue' in message || 'formatError' in message || 'error' in message);
    expect(failure).toBeDefined();
    const contexts = posted.filter(message => 'reportContext' in message).map(message => message.reportContext as { stage: string });
    expect(contexts.map(context => context.stage)).toEqual(['detect', 'parse']);
    expect(contexts.every(context => Object.keys(context).every(key => key === 'stage'))).toBe(true);
    send({ name: 'invalid' });
    expect(posted.at(-1)).toEqual({ error: 'Invalid import message.' });
  });

  it('reports only safe stage values for unknown formats and keeps archive member names out of context', async () => {
    const unknownWorker = await startWorker();
    unknownWorker.send({ name: 'unknown.cad', data: enc('not a board file') });
    const unknownFailure = unknownWorker.posted.find(message => 'formatError' in message)!;
    expect(unknownFailure).toBeDefined();
    expect(unknownWorker.posted.filter(message => 'reportContext' in message).map(message => message.reportContext)).toEqual([{ stage: 'detect' }]);

    unknownWorker.send({ name: 'package.zip', data: zipSync({ 'private-folder/board.cad': enc(genCad(1)) }) });
    const final = unknownWorker.posted.find(message => 'board' in message)!;
    expect(final.reportContext).toEqual({ stage: 'done', formatId: 'gencad' });
    expect(JSON.stringify(unknownWorker.posted.filter(message => 'reportContext' in message).map(message => message.reportContext))).not.toMatch(/private-folder|board\.cad|package\.zip|entry|container/i);
  });
});
