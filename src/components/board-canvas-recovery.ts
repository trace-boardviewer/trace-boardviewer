/**
 * Repaint after a lost 2D canvas context (W-fix2-portable-02). When the GPU process dies (driver reset, TDR) Chromium keeps the renderer
 * and the page alive and recreates the GPU process, but the 2D canvases lose their back buffer: it fires `contextlost` at each canvas
 * element, restores the context ~0.5 s later (`contextrestored`) with a CLEARED bitmap and default state, and nothing repaints it.
 * BoardCanvas only draws on demand (it is idle at 0 draws per second), so without this the board stayed blank until the next zoom or fit.
 * Measured: Electron 44.5.1 / Chrome 152, RTX 5070, GPU child killed → both events on both canvases, blank until a wheel without this module.
 *
 * Deliberately free of imports so it runs unchanged in a plain page (the QA probe) and in unit tests with plain `EventTarget`s.
 * `contextlost` is never `preventDefault()`ed: for 2D contexts a cancelled loss event tells Chromium NOT to restore the context.
 */

/** What is needed of a canvas element, the document and the window: `addEventListener`/`removeEventListener`. */
export interface RecoveryEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface RecoveryDocument extends RecoveryEventTarget { readonly visibilityState?: string }
/** `CanvasRenderingContext2D`; `isContextLost` is absent before Chromium 99 and in other embedders. */
export interface LossAwareContext { isContextLost?(): boolean }

export interface CanvasRecoveryOptions {
  /** The canvas elements; Chromium fires `contextlost` / `contextrestored` at the element. */
  canvases: readonly RecoveryEventTarget[];
  /** The canvases' current contexts (null/undefined before the first draw); polled with `isContextLost()` in `check()`. */
  contexts(): ReadonlyArray<LossAwareContext | null | undefined>;
  /** Marks the whole frame dirty and schedules a draw. */
  redraw(): void;
  /** `visibilitychange` (to a non-hidden state) runs `check()`. */
  doc?: RecoveryDocument;
  /** `focus` runs `check()`. */
  win?: RecoveryEventTarget;
}

export interface CanvasRecovery {
  /** The pixels on screen no longer reflect the last draw: a context was lost and has not been repainted since. */
  readonly invalidated: boolean;
  /** True while any of the contexts reports a lost state. */
  isLost(): boolean;
  /** Called by the renderer when it had to skip a draw because a context was lost. */
  invalidate(): void;
  /** Cheap, draw-free guard for visible/focus/timer ticks: repaints once if the last draw was invalidated and the contexts are usable again. */
  check(): void;
  dispose(): void;
}

export function anyContextLost(contexts: ReadonlyArray<LossAwareContext | null | undefined>): boolean {
  for (const context of contexts) {
    if (context && typeof context.isContextLost === 'function' && context.isContextLost()) return true;
  }
  return false;
}

export function bindCanvasRecovery(options: CanvasRecoveryOptions): CanvasRecovery {
  let invalidated = false;
  const isLost = () => anyContextLost(options.contexts());
  const onLost = () => { invalidated = true; };
  const onRestored = () => {
    // A restored context starts with a cleared bitmap and default state: the whole frame (base and overlay) is repainted.
    invalidated = false;
    options.redraw();
  };
  const check = () => {
    if (isLost()) { invalidated = true; return; } // still lost: nothing can be painted yet; the restore event or the next tick repaints
    if (invalidated) { invalidated = false; options.redraw(); }
  };
  const onVisibility = () => { if (options.doc?.visibilityState !== 'hidden') check(); };
  for (const canvas of options.canvases) {
    canvas.addEventListener('contextlost', onLost);
    canvas.addEventListener('contextrestored', onRestored);
  }
  options.doc?.addEventListener('visibilitychange', onVisibility);
  options.win?.addEventListener('focus', check);
  return {
    get invalidated() { return invalidated; },
    isLost,
    invalidate() { invalidated = true; },
    check,
    dispose() {
      for (const canvas of options.canvases) {
        canvas.removeEventListener('contextlost', onLost);
        canvas.removeEventListener('contextrestored', onRestored);
      }
      options.doc?.removeEventListener('visibilitychange', onVisibility);
      options.win?.removeEventListener('focus', check);
    },
  };
}
