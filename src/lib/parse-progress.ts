/**
 * Progress of a running board parse. A parser that knows how far it got calls `reportParseProgress(done, total)` from its main
 * loop (cheap: one comparison when nobody listens); the board worker installs a listener around `parseBoard` and forwards throttled
 * fractions to the UI, where the import watchdog treats every report as a sign of life. Parsers that do not report are still watched,
 * by the time since the parse started.
 */

let listener: ((fraction: number) => void) | null = null;

/** Runs `parse` with `onProgress` receiving fractions between 0 and 1 (never decreasing within one run). */
export function withParseProgress<T>(onProgress: (fraction: number) => void, parse: () => T): T {
  const previous = listener;
  let last = -1;
  listener = fraction => { if (fraction > last) { last = fraction; onProgress(fraction); } };
  try { return parse(); }
  finally { listener = previous; }
}

/** Called by parsers: `done` of `total` units (bytes, characters, lines) are processed. */
export function reportParseProgress(done: number, total: number): void {
  if (listener && total > 0 && Number.isFinite(done)) listener(Math.min(1, Math.max(0, done / total)));
}
