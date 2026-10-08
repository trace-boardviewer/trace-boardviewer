/*
 * Pipeline stage tracking for the content-free diagnostic report (original TRACE module, MIT). The shared board builder marks
 * the 'build' stage when it starts; the diagnostic collector runs one reader inside `trackBuildStage` and so learns whether a
 * failure came from the reader's own records or from the builder. Outside such a run a mark costs one comparison.
 */
let tracking: { built: boolean } | null = null;

/** Called by buildBoard (formats/common.ts) when it starts assembling a reader's records. */
export function markBuildStage(): void {
  if (tracking) tracking.built = true;
}

/** Runs `run` and reports whether the board builder was entered during it (runs never nest; the previous tracker is restored). */
export function trackBuildStage<T>(run: () => T): { value?: T; error?: unknown; failed: boolean; built: boolean } {
  const previous = tracking, current = { built: false };
  tracking = current;
  try { return { value: run(), failed: false, built: current.built }; }
  catch (error) { return { error, failed: true, built: current.built }; }
  finally { tracking = previous; }
}

/** `trackBuildStage` for a reader that may answer with a promise: the tracker stays installed until the answer settles (runs never interleave). */
export async function trackBuildStageAsync<T>(run: () => T | PromiseLike<T>): Promise<{ value?: T; error?: unknown; failed: boolean; built: boolean }> {
  const previous = tracking, current = { built: false };
  tracking = current;
  try { return { value: await run(), failed: false, built: current.built }; }
  catch (error) { return { error, failed: true, built: current.built }; }
  finally { tracking = previous; }
}
