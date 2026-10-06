import { describe, expect, it } from 'vitest';
import { PdfError } from './document';
import type { PdfHandle, TextItem } from './document';
import {
  buildTextIndex, extractRefCandidates, extractRefCandidatesAsync, extractRefCandidatesBounded, findText, findTextAsync, MAX_CANDIDATE_HITS,
  MAX_CANDIDATE_WORK, MAX_HIT_TOKEN_LENGTH, MAX_TOTAL_CANDIDATE_HITS, normalizeToken,
} from './search';
import type { TextIndex } from './search';

const item = (str: string, page = 1): TextItem => ({ str, x: 10, y: 20, width: Math.max(1, str.length) * 6, height: 10, page });
const indexOf = (items: TextItem[], truncated = false): TextIndex => ({ pageCount: 1, items, pageStarts: [0, items.length], indexedPages: 1, truncated });
const names = (count: number, prefix = 'R') => Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
const failure = async (promise: Promise<unknown>): Promise<PdfError> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(PdfError); return error as PdfError; }
  throw new Error('expected rejection');
};
function thrown(run: () => unknown): PdfError {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(PdfError); return error as PdfError; }
  throw new Error('expected a throw');
}
function random(seed: number): () => number { // mulberry32: deterministic fuzz input
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('normalizeToken fast path', () => {
  const reference = (value: string) => value.normalize('NFKC').trim().replace(/^[\s()[\]{}<>.,;:!?"'`*]+|[\s()[\]{}<>.,;:!?"'`*]+$/g, '').replace(/\s+/g, ' ').toUpperCase();
  it('is identical to the full normalization on ASCII fuzz, edge punctuation, whitespace and Unicode', () => {
    const rand = random(7);
    const alphabet = 'abcXYZ019+-_/#~%&@$.,;:!?"\'`*()[]{}<> \t éＡⅠß';
    for (let n = 0; n < 20_000; n++) {
      const value = Array.from({ length: Math.floor(rand() * 8) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      expect(normalizeToken(value)).toBe(reference(value));
    }
    for (const value of ['', ' ', '...', '(PU301)', 'gnd,', '+3.3V', '~RESET', 'ａｂｃ', 'Ⅳ', 'a  b', 'ß']) expect(normalizeToken(value)).toBe(reference(value));
  });
});

describe('bounded cross-reference scan (B35)', () => {
  // Every item carries every reference once: n items x n refs -> n * n exact hits, none lost, none duplicated.
  const grid = (n: number) => {
    const refs = names(n);
    const line = refs.join(' ');
    return { refs: new Set(refs), index: indexOf(Array.from({ length: n }, () => item(line))) };
  };

  it.each([{ n: 8, hits: 64 }, { n: 32, hits: 1024 }, { n: 128, hits: 16384 }])('keeps the $n x $n control exact: $hits hits, not truncated', ({ n, hits }) => {
    const { refs, index } = grid(n);
    const result = extractRefCandidatesBounded(index, refs, new Set());
    expect(result).toMatchObject({ truncated: false, totalHits: hits, scannedItems: n, limit: null });
    expect(result.candidates.length).toBe(n);
    expect(result.candidates.every(candidate => candidate.hits.length === n)).toBe(true);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.hits.length, 0)).toBe(hits);
    expect(extractRefCandidates(index, refs, new Set())).toEqual(result.candidates); // the old name is a thin wrapper
  });

  it('stops the 2001-item x 5000-reference scenario at the aggregate budget, quickly, with bounded allocation', () => {
    const refs = new Set(names(5000));
    const shared = [...refs].join(' '); // 57.8 M logical characters across 2001 items, one backing string
    const index = indexOf(Array.from({ length: 2001 }, () => item(shared)));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = extractRefCandidatesBounded(index, refs, new Set());
    const elapsed = performance.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe('total-hits');
    expect(result.totalHits).toBe(MAX_TOTAL_CANDIDATE_HITS);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.hits.length, 0)).toBe(MAX_TOTAL_CANDIDATE_HITS);
    expect(result.candidates.every(candidate => candidate.hits.length <= MAX_CANDIDATE_HITS)).toBe(true);
    // Exact within the budget: 10 full items (5000 hits each) were recorded, in item order, and nothing of item 10.
    expect(result.scannedItems).toBe(MAX_TOTAL_CANDIDATE_HITS / 5000);
    expect(result.candidates.every(candidate => candidate.hits.length === 10 && candidate.hits.every((hit, i) => hit.itemIndex === i))).toBe(true);
    expect(elapsed).toBeLessThan(2000); // unbudgeted this plans 10 million hits
    expect(heapGrowth).toBeLessThan(150 * 1024 * 1024); // 10 million hits would be gigabytes
  });

  it('honours custom aggregate budgets, including zero, and records nothing past them', () => {
    const { refs, index } = grid(32);
    const some = extractRefCandidatesBounded(index, refs, new Set(), { maxTotalHits: 100 });
    expect(some).toMatchObject({ truncated: true, totalHits: 100, limit: 'total-hits' });
    expect(some.scannedItems).toBe(3); // 3 full items = 96 hits, the 4th item is cut after 4 hits
    expect(some.candidates.reduce((sum, candidate) => sum + candidate.hits.length, 0)).toBe(100);
    const none = extractRefCandidatesBounded(index, refs, new Set(), { maxTotalHits: 0 });
    expect(none).toMatchObject({ candidates: [], truncated: true, totalHits: 0, scannedItems: 0, limit: 'total-hits' });
    // A budget that is exactly met is not a truncation.
    expect(extractRefCandidatesBounded(index, refs, new Set(), { maxTotalHits: 1024 })).toMatchObject({ truncated: false, totalHits: 1024, limit: null });
    expect(extractRefCandidatesBounded(index, refs, new Set(), { maxTotalHits: 1023 })).toMatchObject({ truncated: true, totalHits: 1023 });
  });

  it('keeps the per-reference cap and now discloses it', () => {
    const index = indexOf(Array.from({ length: MAX_CANDIDATE_HITS + 500 }, () => item('PU301 GND')));
    const result = extractRefCandidatesBounded(index, new Set(['PU301']), new Set(['GND']));
    expect(result.candidates.map(candidate => candidate.hits.length)).toEqual([MAX_CANDIDATE_HITS, MAX_CANDIDATE_HITS]);
    expect(result).toMatchObject({ truncated: true, limit: 'per-reference', totalHits: 2 * MAX_CANDIDATE_HITS, scannedItems: MAX_CANDIDATE_HITS + 500 });
    expect(extractRefCandidatesBounded(index, new Set(['PU301']), new Set(), { maxHitsPerReference: 5 }).candidates[0].hits.length).toBe(5);
  });

  it('stops at the work budget with exact hits for the scanned prefix', () => {
    const items = Array.from({ length: 50_000 }, (_, i) => item(i === 3 ? 'PU301 filler words here' : i === 40_000 ? 'PU301' : 'filler words here'));
    const result = extractRefCandidatesBounded(indexOf(items), new Set(['PU301']), new Set(), { maxWork: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe('work');
    expect(result.scannedItems).toBeLessThan(items.length / 10);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].hits.map(hit => hit.itemIndex)).toEqual([3]); // item 40000 lies beyond the budget and is not guessed
    const full = extractRefCandidatesBounded(indexOf(items), new Set(['PU301']), new Set());
    expect(full.truncated).toBe(false);
    expect(full.candidates[0].hits.map(hit => hit.itemIndex)).toEqual([3, 40_000]);
    expect(MAX_CANDIDATE_WORK).toBeGreaterThan(items.length * 4);
  });

  it('discloses an incomplete index as truncation and reports nothing missing when nothing was asked', () => {
    const index = indexOf([item('PU301')], true);
    expect(extractRefCandidatesBounded(index, new Set(['PU301']), new Set())).toMatchObject({ truncated: true, limit: 'index', totalHits: 1 });
    expect(extractRefCandidatesBounded(index, new Set(), new Set())).toMatchObject({ candidates: [], truncated: false, limit: null });
    expect(extractRefCandidatesBounded(index, new Set(['  ', '...']), new Set())).toMatchObject({ candidates: [], truncated: false });
  });

  it('returns exactly the first N hits of the full scan for every budget N (random corpus, independent reference)', () => {
    const rand = random(42);
    const vocabulary = ['R1', 'R2', 'R12', 'C7', 'GND', 'vcc', '+3V3', '~RST', '(R1)', 'R1.', 'x', 'GND,', '"vcc"', 'U1:5', 'a=b'];
    const separators = [' ', ' ', ', ', '; ', '  ', ' | '];
    const items = Array.from({ length: 300 }, () => item(Array.from({ length: 1 + Math.floor(rand() * 7) }, () => vocabulary[Math.floor(rand() * vocabulary.length)]).join(separators[Math.floor(rand() * separators.length)])));
    const refs = ['R1', 'R2', 'r12', 'C7', 'U1'], nets = ['GND', 'VCC', '+3V3', '~RST', 'R1', 'B'];
    const registration = [...refs.map(name => ['ref', name] as const), ...nets.map(name => ['net', name] as const)];
    const splitter = /([\s,;:()[\]{}<>"'|=]+)/;
    const separatorOnly = /^[\s,;:()[\]{}<>"'|=]+$/;
    const expected: string[] = []; // independent scan: item order, token order, registration order
    items.forEach((entry, i) => {
      let position = 0;
      for (const piece of entry.str.split(splitter)) {
        if (piece && !separatorOnly.test(piece)) {
          const key = normalizeToken(piece);
          registration.forEach(([kind, name], order) => { if (normalizeToken(name) === key) expected.push(`${i}:${position}:${order}:${kind}:${name}`); });
        }
        position += piece.length;
      }
    });
    expect(expected.length).toBeGreaterThan(200);
    const flatten = (result: ReturnType<typeof extractRefCandidatesBounded>) => {
      const rows: { key: string; item: number; x: number; order: number }[] = [];
      for (const candidate of result.candidates) {
        const order = registration.findIndex(([kind, name]) => kind === candidate.kind && name === candidate.name);
        for (const hit of candidate.hits) rows.push({ key: `${candidate.kind}:${candidate.name}`, item: hit.itemIndex, x: hit.x, order });
      }
      return rows.sort((a, b) => a.item - b.item || a.x - b.x || a.order - b.order).map(row => `${row.item}:${row.order}:${row.key}`);
    };
    const project = (rows: string[]) => rows.map(row => { const [i, , order, kind, name] = row.split(':'); return `${i}:${order}:${kind}:${name}`; });
    const full = extractRefCandidatesBounded(indexOf(items), new Set(refs), new Set(nets));
    expect(full.truncated).toBe(false);
    expect(flatten(full)).toEqual(project(expected));
    for (const budget of [0, 1, 2, 5, 17, 100, expected.length - 1, expected.length]) {
      const cut = extractRefCandidatesBounded(indexOf(items), new Set(refs), new Set(nets), { maxTotalHits: budget });
      expect(cut.totalHits).toBe(budget);
      expect(cut.truncated).toBe(budget < expected.length);
      expect(flatten(cut)).toEqual(project(expected).slice(0, budget));
    }
  });

  it('splits slash tokens and matches the parts as well as the whole', () => {
    const result = extractRefCandidatesBounded(indexOf([item('USB D+/D- pair')]), new Set(), new Set(['D+/D-', 'D+', 'D-', 'USB', 'pair']));
    expect(Object.fromEntries(result.candidates.map(candidate => [candidate.name, candidate.hits.length]))).toEqual({ 'D+/D-': 1, 'D+': 1, 'D-': 1, USB: 1, pair: 1 });
    const parts = result.candidates.find(candidate => candidate.name === 'D-')!.hits[0];
    expect(parts.x).toBeGreaterThan(result.candidates.find(candidate => candidate.name === 'D+')!.hits[0].x);
  });

  it('checks the abort signal between items, synchronously and cooperatively', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(thrown(() => extractRefCandidatesBounded(indexOf([item('PU301')]), new Set(['PU301']), new Set(), { signal: aborted.signal })).code).toBe('ABORTED');
    expect((await failure(extractRefCandidatesAsync(indexOf([item('PU301')]), new Set(['PU301']), new Set(), { signal: aborted.signal }))).code).toBe('ABORTED');

    let touched = 0;
    const big = Array.from({ length: 150_000 }, () => item('alpha beta gamma delta PU301'));
    const watched: TextIndex = { ...indexOf(big), items: new Proxy(big, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) touched++; return Reflect.get(target, key, receiver); } }) };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    const started = performance.now();
    expect((await failure(extractRefCandidatesAsync(watched, new Set(['PU301']), new Set(), { signal: controller.signal }))).code).toBe('ABORTED');
    expect(touched).toBeLessThan(big.length); // it stopped early instead of finishing the corpus
    expect(performance.now() - started).toBeLessThan(5000);
  });

  describe('100k punctuation-only items: no token ever matches, so only the work counter and the checkpoints bound the scan', () => {
    const filler = ['( ) , ; : [ ] { } < > " | =', '...', ',,;;::', '(..)', '- ', '= = ='];
    const separatorsOnly = ['( ) , ; : [ ] { } < > " | =', ',,;;::', '(((())))', '| | |', '= = =']; // the tokenizer yields NOTHING for these
    const make = (count: number, plant: Record<number, string> = {}, fillers = filler) => Array.from({ length: count }, (_, i) => item(plant[i] ?? fillers[i % fillers.length]));
    const watch = (items: TextItem[], onTouch?: (touched: number) => void) => {
      const counter = { touched: 0 };
      const proxied = new Proxy(items, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) { counter.touched++; onTouch?.(counter.touched); } return Reflect.get(target, key, receiver); } });
      return { counter, index: { ...indexOf(items), items: proxied } as TextIndex };
    };

    it('still returns exact results for the control that does contain tokens, in both modes', async () => {
      const items = make(100_000, { 1234: 'see PU301 here', 77_777: 'PU301.' });
      const sync = extractRefCandidatesBounded(indexOf(items), new Set(['PU301']), new Set());
      expect(sync).toMatchObject({ truncated: false, totalHits: 2, scannedItems: 100_000, limit: null });
      expect(sync.candidates[0].hits.map(hit => hit.itemIndex)).toEqual([1234, 77_777]);
      expect(await extractRefCandidatesAsync(indexOf(items), new Set(['PU301']), new Set())).toEqual(sync);
    });

    it('counts every item as work: the work budget stops a token-free scan and says so', () => {
      const result = extractRefCandidatesBounded(indexOf(make(100_000, { 99_000: 'PU301' })), new Set(['PU301']), new Set(), { maxWork: 10_000 });
      expect(result).toMatchObject({ candidates: [], truncated: true, limit: 'work', totalHits: 0 });
      expect(result.scannedItems).toBeLessThanOrEqual(10_000);
    });

    it('interrupts a synchronous scan between items and a cooperative scan at its checkpoints', async () => {
      const abortAt = 20_000;
      const syncController = new AbortController();
      const syncWatched = watch(make(100_000), touched => { if (touched === abortAt) syncController.abort(); });
      expect(thrown(() => extractRefCandidatesBounded(syncWatched.index, new Set(['PU301']), new Set(), { signal: syncController.signal })).code).toBe('ABORTED');
      expect(syncWatched.counter.touched).toBeLessThan(abortAt + 10); // checked per item

      const asyncController = new AbortController();
      const asyncWatched = watch(make(100_000), touched => { if (touched === abortAt) asyncController.abort(); });
      expect((await failure(extractRefCandidatesAsync(asyncWatched.index, new Set(['PU301']), new Set(), { signal: asyncController.signal }))).code).toBe('ABORTED');
      expect(asyncWatched.counter.touched).toBeLessThan(abortAt + 4096 + 10);
    });

    it('yields to the event loop so an abort that is only QUEUED while the scan runs takes effect', async () => {
      // 400k items: well above one 8 ms slice on any realistic machine, so the queued abort must be observed mid-scan.
      const watched = watch(make(400_000, {}, separatorsOnly)); // zero tokens: only the per-item work counter can reach a checkpoint
      const controller = new AbortController();
      let abortedAfter = -1;
      setTimeout(() => { abortedAfter = watched.counter.touched; controller.abort(); }, 0);
      expect((await failure(extractRefCandidatesAsync(watched.index, new Set(['PU301']), new Set(), { signal: controller.signal }))).code).toBe('ABORTED');
      expect(abortedAfter).toBeGreaterThan(0); // the timer could only fire because the scan gave the event loop a turn...
      expect(abortedAfter).toBeLessThan(400_000); // ...before it finished, and
      expect(watched.counter.touched).toBeLessThan(abortedAfter + 4096 + 10); // it stopped right after
    });

    it('lets a newer task run between chunks of a long cooperative scan', async () => {
      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(performance.now()), 1);
      await extractRefCandidatesAsync(indexOf(make(400_000, {}, separatorsOnly)), new Set(['PU301']), new Set());
      clearInterval(timer);
      expect(ticks.length).toBeGreaterThan(0); // an interval timer only fires if the scan hands the event loop a turn
    });
  });

  it('keeps interleaved cooperative scans independent of each other', async () => {
    // Every token of every item is a hit, so a scan that lost its place after a yield (shared regex state) loses hits.
    const make = (word: string, other: string) => indexOf(Array.from({ length: 15_000 }, (_, i) => item(`${word} ${other}${i % 5} ${word}, (${word}) ${word}; ${word}`)));
    const [a, b] = [make('PU301', 'xyzzyx'), make('GND', 'qwertzui')];
    const budgets = { maxTotalHits: 1_000_000, maxHitsPerReference: 1_000_000 };
    const refs = new Set(['PU301']), nets = new Set(['GND']);
    const sync = [extractRefCandidatesBounded(a, refs, nets, budgets), extractRefCandidatesBounded(b, refs, nets, budgets)];
    expect(sync.map(result => result.totalHits)).toEqual([75_000, 75_000]);
    const concurrent = await Promise.all([extractRefCandidatesAsync(a, refs, nets, budgets), extractRefCandidatesAsync(b, refs, nets, budgets)]);
    expect(concurrent.map(result => result.totalHits)).toEqual([75_000, 75_000]);
    expect(concurrent).toEqual(sync);
  });
});

describe('literal hit tokens', () => {
  it('records the token exactly as written, so case-only variants can be told apart', () => {
    const index = indexOf([item('r1 R1 (r1) R12 ~RST'), item('Gnd, GND gnd')]);
    const result = extractRefCandidatesBounded(index, new Set(['R1']), new Set(['gnd', '~rst']));
    const tokens = Object.fromEntries(result.candidates.map(candidate => [candidate.name, candidate.hits.map(hit => hit.token)]));
    expect(tokens).toEqual({ R1: ['r1', 'R1', 'r1'], gnd: ['Gnd', 'GND', 'gnd'], '~rst': ['~RST'] });
    expect(result.candidates.flatMap(candidate => candidate.hits).every(hit => hit.context.includes(hit.token!))).toBe(true);
  });

  it('records the slash-split part for parts and the whole token for the whole', () => {
    const result = extractRefCandidatesBounded(indexOf([item('usb d+/d- pair')]), new Set(), new Set(['D+/D-', 'D+', 'D-']));
    expect(Object.fromEntries(result.candidates.map(candidate => [candidate.name, candidate.hits[0].token]))).toEqual({ 'D+/D-': 'd+/d-', 'D+': 'd+', 'D-': 'd-' });
  });

  it('caps the literal token length', () => {
    const long = `X${'Y'.repeat(300)}`;
    const hit = extractRefCandidatesBounded(indexOf([item(`see ${long}`)]), new Set([long]), new Set()).candidates[0].hits[0];
    expect(hit.token).toBe(long.slice(0, MAX_HIT_TOKEN_LENGTH));
    expect(findText(indexOf([item(long)]), long)[0].token).toBe(long.slice(0, MAX_HIT_TOKEN_LENGTH));
  });

  it('gives search hits the literal matched substring and omits it when upper-casing moved the offsets', () => {
    const index = indexOf([item('see PU301 and pu301.'), item('Straße')]);
    expect(findText(index, 'pu301').map(hit => hit.token)).toEqual(['PU301', 'pu301']);
    expect(findText(index, 'PU301', { caseSensitive: true }).map(hit => hit.token)).toEqual(['PU301']);
    expect(findText(index, 'pu301', { wholeWord: true }).map(hit => hit.token)).toEqual(['PU301', 'pu301']);
    const folded = findText(index, 'ss');
    expect(folded.length).toBe(1);
    expect('token' in folded[0]).toBe(false); // "STRASSE" is one character longer than "Straße": no reliable literal
  });
});

describe('text search', () => {
  it('findTextAsync returns what findText returns and honours the signal', async () => {
    const index = indexOf(Array.from({ length: 20_000 }, (_, i) => item(i % 3 ? 'plain words' : 'see PU301 and pu301.')));
    const sync = findText(index, 'pu301', { maxHits: 100_000 });
    expect(sync.length).toBe(2 * Math.ceil(20_000 / 3));
    expect(await findTextAsync(index, 'pu301', { maxHits: 100_000 })).toEqual(sync);
    expect(await findTextAsync(index, 'PU301', { caseSensitive: true, wholeWord: true })).toEqual(findText(index, 'PU301', { caseSensitive: true, wholeWord: true }));
    const aborted = new AbortController();
    aborted.abort();
    expect((await failure(findTextAsync(index, 'pu301', { signal: aborted.signal }))).code).toBe('ABORTED');
    expect(await findTextAsync(index, '   ')).toEqual([]);
  });
});

describe('buildTextIndex', () => {
  const handleOf = (pages: Array<TextItem[] | Error>): PdfHandle => ({
    pageCount: pages.length,
    getPageSize: async () => ({ width: 100, height: 100, rotation: 0 }),
    renderPage: async () => {},
    getTextItems: async page => { const entry = pages[page - 1]; if (entry instanceof Error) throw entry; return entry; },
    getOutline: async () => [],
    destroy: async () => {},
  });

  it('reports running item counts through onProgress', async () => {
    const seen: number[][] = [];
    const index = await buildTextIndex(handleOf([[item('a', 1), item('b', 1)], [], [item('c', 3)]]), { onProgress: (page, count, items) => seen.push([page, count, items]) });
    expect(seen).toEqual([[1, 3, 2], [2, 3, 2], [3, 3, 3]]);
    expect(index).toMatchObject({ pageCount: 3, indexedPages: 3, truncated: false, pageStarts: [0, 2, 2, 3] });
    expect(index.failedPages).toBeUndefined();
  });

  it('skips an unreadable page, keeps the others searchable and discloses the gap', async () => {
    const index = await buildTextIndex(handleOf([[item('first', 1)], new Error('broken page tree'), [item('third', 3)]]));
    expect(index.items.map(entry => entry.str)).toEqual(['first', 'third']);
    expect(index).toMatchObject({ indexedPages: 3, truncated: true, failedPages: 1, pageStarts: [0, 1, 1, 2] });
  });

  it('propagates structured errors (a destroyed handle) and stops at the item bound', async () => {
    expect((await failure(buildTextIndex(handleOf([[item('x')], new PdfError('DESTROYED', 'closed')])))).code).toBe('DESTROYED');
    const index = await buildTextIndex(handleOf([[item('a', 1), item('b', 1)], [item('c', 2), item('d', 2), item('e', 2)], [item('f', 3)]]), { maxItems: 3 });
    expect(index).toMatchObject({ indexedPages: 2, truncated: true, pageStarts: [0, 2, 3, 3] });
    expect(index.items.length).toBe(3);
  });

  it('prefers the abort over a page failure it caused', async () => {
    const controller = new AbortController();
    const handle: PdfHandle = { ...handleOf([[item('a')]]), getTextItems: async () => { controller.abort(); throw new Error('transport destroyed'); } };
    expect((await failure(buildTextIndex(handle, { signal: controller.signal }))).code).toBe('ABORTED');
  });
});
