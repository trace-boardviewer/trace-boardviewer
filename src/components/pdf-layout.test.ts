import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedCache, MAX_ZOOM, MIN_ZOOM, TaskQueue, captureAnchor, clampZoom, computeLayout, createThrottle, currentPageIndex, displayRotation, displaySize,
  expandRange, fitZoom, formatZoom, groupByPage, isRectVisible, nearestHitIndex, normalizeRotation, pageIndexAt, pageLeft, pageMatrix, parseZoomInput,
  planRenderScale, renderWindow, resolveAnchor, rotatePoint, rotateRect, stepZoom, unrotatePoint, visibleRange, wrapIndex,
} from './pdf-layout';
import type { ViewerRotation } from './viewer-contracts';

const ROTATIONS: ViewerRotation[] = [0, 90, 180, 270];
const near = (actual: number, expected: number, digits = 9) => expect(actual).toBeCloseTo(expected, digits);

describe('rotation math', () => {
  it('normalizes and combines page /Rotate with the user rotation', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(displayRotation(90, 270)).toBe(0);
    expect(displayRotation(270, 180)).toBe(90);
  });

  it('swaps the displayed size for quarter turns only', () => {
    const box = { width: 612, height: 792, rotation: 0 };
    expect(displaySize(box, 0)).toEqual({ width: 612, height: 792 });
    expect(displaySize(box, 90)).toEqual({ width: 792, height: 612 });
    expect(displaySize({ ...box, rotation: 90 }, 0)).toEqual({ width: 792, height: 612 });
    expect(displaySize({ ...box, rotation: 90 }, 90)).toEqual({ width: 612, height: 792 });
    expect(displaySize(box, 180)).toEqual({ width: 612, height: 792 });
  });

  it('rotates the corners of the page the way pdf.js does (clockwise)', () => {
    const W = 600, H = 800;
    // top-left of the unrotated page lands on the top-right after 90 degrees clockwise, bottom-left after 180, bottom-left... per quarter turn
    expect(rotatePoint(0, 0, W, H, 90)).toEqual({ x: H, y: 0 });
    expect(rotatePoint(0, 0, W, H, 180)).toEqual({ x: W, y: H });
    expect(rotatePoint(0, 0, W, H, 270)).toEqual({ x: 0, y: W });
    expect(rotatePoint(W, H, W, H, 90)).toEqual({ x: 0, y: W });
    // the displayed page is H x W after a quarter turn, so every mapped corner stays inside it
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      const p = rotatePoint(x, y, W, H, 90);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(H);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(W);
    }
  });

  it('unrotatePoint inverts rotatePoint for every rotation', () => {
    for (const rotation of ROTATIONS) {
      for (const [x, y] of [[10, 20], [0, 0], [595.5, 842], [300, 400.25]]) {
        const shown = rotatePoint(x, y, 595.5, 842, rotation);
        const back = unrotatePoint(shown.x, shown.y, 595.5, 842, rotation);
        near(back.x, x); near(back.y, y);
      }
    }
  });

  it('rotates rects as boxes: size swaps on quarter turns and the box stays on the same text', () => {
    const rect = { x: 72, y: 100, width: 40, height: 10 };
    expect(rotateRect(rect, 612, 792, 0)).toEqual(rect);
    expect(rotateRect(rect, 612, 792, 90)).toEqual({ x: 792 - 110, y: 72, width: 10, height: 40 });
    expect(rotateRect(rect, 612, 792, 180)).toEqual({ x: 612 - 112, y: 792 - 110, width: 40, height: 10 });
    expect(rotateRect(rect, 612, 792, 270)).toEqual({ x: 100, y: 612 - 112, width: 10, height: 40 });
    // rotating by 90 twice equals rotating by 180 (the second pass works on the rotated page)
    const once = rotateRect(rect, 612, 792, 90);
    const twice = rotateRect(once, 792, 612, 90);
    expect(twice).toEqual(rotateRect(rect, 612, 792, 180));
  });

  it('pageMatrix maps document points to displayed pixels exactly like rotatePoint x zoom', () => {
    for (const rotation of ROTATIONS) {
      for (const zoom of [0.5, 1, 2.5]) {
        const [a, b, c, d, e, f] = pageMatrix(600, 800, rotation, zoom);
        for (const [x, y] of [[0, 0], [120, 30], [600, 800]]) {
          const expected = rotatePoint(x, y, 600, 800, rotation);
          near(a * x + c * y + e, expected.x * zoom); near(b * x + d * y + f, expected.y * zoom);
        }
      }
    }
  });
});

describe('zoom', () => {
  it('clamps and steps through nice values in both directions', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM); expect(clampZoom(0.001)).toBe(MIN_ZOOM); expect(clampZoom(Number.NaN)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.1); expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.0004, 1)).toBe(1.1);
    expect(stepZoom(0.97, 1)).toBe(1);
    expect(stepZoom(8, 1)).toBe(MAX_ZOOM); expect(stepZoom(0.1, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(5, -1)).toBe(4);
  });

  it('parses typed percentages and rejects garbage', () => {
    expect(parseZoomInput('150')).toBe(1.5);
    expect(parseZoomInput(' 150 % ')).toBe(1.5);
    expect(parseZoomInput('62,5%')).toBeCloseTo(0.625);
    expect(parseZoomInput('9999')).toBe(MAX_ZOOM);
    expect(parseZoomInput('1')).toBe(MIN_ZOOM);
    for (const bad of ['', 'abc', '-50', '0', '1e3', '12%%x', '%']) expect(parseZoomInput(bad), bad).toBeNull();
    expect(formatZoom(1.2345)).toBe('123%');
  });

  it('fit width ignores height, fit page uses the tighter side', () => {
    const viewport = { width: 1000, height: 600 };
    near(fitZoom('width', viewport, { width: 600, height: 800 }, 20), 960 / 600);
    near(fitZoom('page', viewport, { width: 600, height: 800 }, 20), 560 / 800);
    expect(fitZoom('width', { width: 0, height: 0 }, { width: 600, height: 800 }, 20)).toBe(1);
    expect(fitZoom('width', viewport, { width: 1, height: 1 }, 20)).toBe(MAX_ZOOM);
  });
});

describe('continuous layout and virtualization', () => {
  const sizes = Array.from({ length: 10 }, (_, i) => ({ width: 600 + (i === 4 ? 200 : 0), height: 800 }));
  const options = { zoom: 1, gap: 10, padding: 20, viewportWidth: 900 };
  const layout = computeLayout(sizes, options);

  it('stacks pages with padding and gaps and centres them in the content width', () => {
    expect(layout.tops[0]).toBe(20);
    expect(layout.tops[1]).toBe(20 + 800 + 10);
    expect(layout.total).toBe(20 + 10 * 800 + 9 * 10 + 20);
    expect(layout.contentWidth).toBe(900);
    expect(pageLeft(layout, 0)).toBe(150);
    expect(pageLeft(layout, 4)).toBe(50);
    const wide = computeLayout(sizes, { ...options, zoom: 2 });
    expect(wide.contentWidth).toBe(1600 + 40);
    expect(wide.heights[0]).toBe(1600);
  });

  it('handles empty documents', () => {
    const empty = computeLayout([], options);
    expect(empty.count).toBe(0); expect(empty.total).toBe(40);
    expect(visibleRange(empty, 0, 500).last).toBeLessThan(visibleRange(empty, 0, 500).first);
    expect(expandRange({ first: 0, last: -1 }, 1, 0)).toEqual({ first: 0, last: -1 });
    expect(currentPageIndex(empty, 0, 500)).toBe(0);
  });

  it('finds pages by offset with binary search', () => {
    expect(pageIndexAt(layout, -50)).toBe(0);
    expect(pageIndexAt(layout, 20)).toBe(0);
    expect(pageIndexAt(layout, 829)).toBe(0);
    expect(pageIndexAt(layout, 830)).toBe(1);
    expect(pageIndexAt(layout, 1e9)).toBe(9);
  });

  it('visible range covers exactly the intersecting pages (gaps skipped, touching edges excluded)', () => {
    expect(visibleRange(layout, 0, 500)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(layout, 0, 840)).toEqual({ first: 0, last: 1 });
    expect(visibleRange(layout, 0, 830)).toEqual({ first: 0, last: 0 }); // page 2 starts exactly at the bottom edge
    expect(visibleRange(layout, 822, 100)).toEqual({ first: 1, last: 1 }); // inside the gap: page 1 already ended
    expect(visibleRange(layout, 800, 400)).toEqual({ first: 0, last: 1 });
    expect(visibleRange(layout, layout.total - 300, 300)).toEqual({ first: 9, last: 9 });
    expect(expandRange({ first: 4, last: 5 }, 1, 10)).toEqual({ first: 3, last: 6 });
    expect(expandRange({ first: 0, last: 9 }, 1, 10)).toEqual({ first: 0, last: 9 });
  });

  it('keeps the number of visible pages bounded for a 2000-page document', () => {
    const many = computeLayout(Array.from({ length: 2000 }, () => ({ width: 612, height: 792 })), { zoom: 1, gap: 12, padding: 16, viewportWidth: 1200 });
    for (const top of [0, 1e5, 987_654, many.total - 900]) {
      const range = visibleRange(many, top, 900);
      expect(range.last - range.first).toBeLessThanOrEqual(2);
    }
    const tiny = visibleRange(computeLayout(Array.from({ length: 2000 }, () => ({ width: 612, height: 792 })), { zoom: 0.1, gap: 12, padding: 16, viewportWidth: 1200 }), 0, 900);
    expect(tiny.last - tiny.first + 1).toBeLessThan(15);
  });

  it('current page follows a reference line and is the last page at the bottom', () => {
    expect(currentPageIndex(layout, 0, 600)).toBe(0);
    expect(currentPageIndex(layout, 500, 600)).toBe(0); // reference line at 740, page 2 starts at 830
    expect(currentPageIndex(layout, 600, 600)).toBe(1); // line at 840
    expect(currentPageIndex(layout, layout.total - 600, 600)).toBe(9);
    expect(currentPageIndex(layout, 3 * 810 + 20, 600)).toBe(3);
  });

  it('anchors survive a zoom change and a page-size discovery above the viewport', () => {
    const scrollTop = 2500, scrollLeft = 0;
    const anchor = captureAnchor(layout, scrollTop, scrollLeft, 400, 300)!;
    const zoomed = computeLayout(sizes, { ...options, zoom: 1.5 });
    const next = resolveAnchor(zoomed, anchor)!;
    // the same point of the same page is under the same viewport offset
    const before = captureAnchor(layout, scrollTop, scrollLeft, 400, 300)!;
    const after = captureAnchor(zoomed, next.top, next.left, 400, 300)!;
    expect(after.index).toBe(before.index);
    near(after.fy, before.fy, 6); near(after.fx, before.fx, 6);
    // an unknown-page estimate (800 high) replaced by a real 400-high page above the anchor: content moves up by 400, the anchor follows
    const corrected = computeLayout(sizes.map((s, i) => (i === 0 ? { ...s, height: 400 } : s)), options);
    const shifted = resolveAnchor(corrected, anchor)!;
    expect(shifted.top).toBeCloseTo(scrollTop - 400, 6);
    expect(captureAnchor(computeLayout([], options), 0, 0, 0, 0)).toBeNull();
  });
});

describe('render planning', () => {
  it('uses zoom x dpr and caps one canvas to the pixel budget', () => {
    expect(planRenderScale({ width: 612, height: 792 }, 1, 1)).toEqual({ scale: 1, clamped: false });
    expect(planRenderScale({ width: 612, height: 792 }, 1, 2)).toEqual({ scale: 2, clamped: false });
    const huge = planRenderScale({ width: 612, height: 792 }, 8, 2);
    expect(huge.clamped).toBe(true);
    expect(612 * huge.scale * 792 * huge.scale).toBeLessThanOrEqual(16_000_000);
    const poster = planRenderScale({ width: 20_000, height: 100 }, 1, 1);
    expect(20_000 * poster.scale).toBeLessThanOrEqual(16_384);
    expect(planRenderScale({ width: 612, height: 792 }, 1.234567, 1).scale).toBe(1.23);
  });

  it('renders neighbours only while the window stays inside the pixel budget', () => {
    const pixels = () => 1_000_000;
    expect(renderWindow({ first: 5, last: 5 }, 10, pixels, 1, 10_000_000)).toEqual({ first: 4, last: 6 });
    expect(renderWindow({ first: 0, last: 0 }, 10, pixels, 1, 10_000_000)).toEqual({ first: 0, last: 1 });
    expect(renderWindow({ first: 5, last: 5 }, 10, pixels, 1, 2_000_000)).toEqual({ first: 4, last: 5 });
    expect(renderWindow({ first: 5, last: 6 }, 10, pixels, 1, 1_000_000)).toEqual({ first: 5, last: 6 }); // visible pages are never dropped
    expect(renderWindow({ first: 0, last: -1 }, 0, pixels, 1, 1e9)).toEqual({ first: 0, last: -1 });
  });
});

describe('search hit helpers', () => {
  it('wraps navigation in both directions', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0); expect(wrapIndex(0, -1, 3)).toBe(2); expect(wrapIndex(-1, 1, 3)).toBe(0); expect(wrapIndex(0, 1, 0)).toBe(-1);
  });
  it('starts at the first hit on or after the current page, wrapping when none follows', () => {
    const hits = [{ page: 1 }, { page: 3 }, { page: 3 }, { page: 7 }];
    expect(nearestHitIndex(hits, 1)).toBe(0); expect(nearestHitIndex(hits, 2)).toBe(1); expect(nearestHitIndex(hits, 4)).toBe(3);
    expect(nearestHitIndex(hits, 8)).toBe(0); expect(nearestHitIndex([], 1)).toBe(-1);
  });
  it('groups by page, skips page-less entries and bounds each group', () => {
    const groups = groupByPage([{ page: 2, id: 'a' }, { id: 'x' }, { page: 2, id: 'b' }, { page: 5, id: 'c' }, { page: 2, id: 'd' }], 2);
    expect([...groups.keys()]).toEqual([2, 5]);
    expect(groups.get(2)!.map(item => item.id)).toEqual(['a', 'b']);
    expect(groupByPage(undefined).size).toBe(0);
  });
  it('tells whether a rect is comfortably inside the viewport', () => {
    const viewport = { width: 800, height: 600 };
    expect(isRectVisible({ left: 100, top: 1100, width: 50, height: 10 }, 0, 1000, viewport, 40)).toBe(true);
    expect(isRectVisible({ left: 100, top: 1010, width: 50, height: 10 }, 0, 1000, viewport, 40)).toBe(false);
    expect(isRectVisible({ left: 780, top: 1100, width: 50, height: 10 }, 0, 1000, viewport, 40)).toBe(false);
  });
});

describe('BoundedCache', () => {
  it('evicts the least recently used entry and disposes it', () => {
    const disposed: string[] = [];
    const cache = new BoundedCache<string, string>(2, (value, key) => disposed.push(`${key}=${value}`));
    cache.put('a', '1'); cache.put('b', '2'); cache.put('c', '3');
    expect(cache.size).toBe(2); expect(cache.has('a')).toBe(false); expect(disposed).toEqual(['a=1']);
    cache.put('b', '2b'); // replacing disposes the previous value and refreshes recency
    expect(disposed).toEqual(['a=1', 'b=2']);
    cache.put('d', '4');
    expect(cache.has('c')).toBe(false); expect(disposed.at(-1)).toBe('c=3');
  });
  it('take hands ownership over without disposing; clear disposes everything', () => {
    const disposed: string[] = [];
    const cache = new BoundedCache<number, string>(3, value => disposed.push(value));
    cache.put(1, 'one'); cache.put(2, 'two');
    expect(cache.take(1)).toBe('one'); expect(cache.take(1)).toBeUndefined(); expect(disposed).toEqual([]);
    cache.clear();
    expect(disposed).toEqual(['two']); expect(cache.size).toBe(0);
  });
});

describe('BoundedCache lifecycle', () => {
  it('a closed cache disposes late arrivals and can be reopened', () => {
    const disposed: string[] = [];
    const cache = new BoundedCache<number, string>(2, value => disposed.push(value));
    cache.put(1, 'a'); cache.close();
    expect(disposed).toEqual(['a']);
    cache.put(2, 'late'); expect(cache.size).toBe(0); expect(disposed).toEqual(['a', 'late']);
    cache.open(); cache.put(3, 'kept'); expect(cache.size).toBe(1);
  });
});

describe('TaskQueue', () => {
  it('reads priorities lazily so a queued task can be promoted', async () => {
    const queue = new TaskQueue(1);
    const order: string[] = [];
    let gate!: () => void;
    const blocker = queue.run(() => new Promise<void>(resolve => { gate = resolve; }));
    let urgent = 1;
    const a = queue.run(async () => { order.push('a'); }, { priority: () => 1 });
    const b = queue.run(async () => { order.push('b'); }, { priority: () => urgent });
    urgent = 0; // b scrolled into view while queued
    gate(); await Promise.all([blocker, a, b]);
    expect(order).toEqual(['b', 'a']);
  });

  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  it('never exceeds its concurrency and runs lower priority numbers first', async () => {
    const queue = new TaskQueue(2);
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const task = (name: string, gate: ReturnType<typeof deferred>) => async () => { order.push(name); await gate.promise; return name; };
    const results = [
      queue.run(task('low-1', gates[0]), { priority: 5 }),
      queue.run(task('low-2', gates[1]), { priority: 5 }),
      queue.run(task('low-3', gates[2]), { priority: 5 }),
      queue.run(task('urgent', gates[3]), { priority: 0 }),
    ];
    expect(queue.active).toBe(2); expect(queue.queued).toBe(2);
    gates[0].resolve(); await tick();
    expect(order).toEqual(['low-1', 'low-2', 'urgent']); // the urgent task overtakes low-3
    expect(queue.active).toBeLessThanOrEqual(2);
    gates.forEach(gate => gate.resolve());
    expect(await Promise.all(results)).toEqual(['low-1', 'low-2', 'low-3', 'urgent']);
    expect(queue.active).toBe(0); expect(queue.started).toBe(4);
  });

  it('drops queued tasks whose signal aborted and rejects with task errors', async () => {
    const queue = new TaskQueue(1);
    const gate = deferred();
    const controller = new AbortController();
    const first = queue.run(async () => { await gate.promise; return 1; });
    const second = queue.run(async () => 2, { signal: controller.signal });
    controller.abort();
    expect(await second).toBeUndefined(); expect(queue.skipped).toBe(1); expect(queue.queued).toBe(0);
    expect(await queue.run(async () => 3, { signal: controller.signal })).toBeUndefined(); // already aborted: never queued
    gate.resolve(); expect(await first).toBe(1);
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await queue.run(async () => 4)).toBe(4); // the failure did not wedge the queue
  });
});

describe('createThrottle', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('delivers the latest arguments at most once per interval and supports flush/cancel', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const throttled = createThrottle((value: number) => calls.push(value), 100);
    throttled.call(1); throttled.call(2); throttled.call(3);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([3]);
    throttled.call(4); vi.advanceTimersByTime(10);
    throttled.flush();
    expect(calls).toEqual([3, 4]);
    throttled.call(5); throttled.cancel(); vi.advanceTimersByTime(500);
    expect(calls).toEqual([3, 4]);
  });
});
