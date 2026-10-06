import { describe, expect, it } from 'vitest';
import { anyContextLost, bindCanvasRecovery } from './board-canvas-recovery';
import type { LossAwareContext } from './board-canvas-recovery';

/** An element-like target: Node's EventTarget with the two properties the helper reads. */
class FakeDocument extends EventTarget { visibilityState = 'visible'; }
class FakeContext implements LossAwareContext {
  lost = false;
  isContextLost() { return this.lost; }
}

function setup(options: { withDocument?: boolean } = {}) {
  const base = new EventTarget(), overlay = new EventTarget();
  const baseContext = new FakeContext(), overlayContext = new FakeContext();
  const doc = new FakeDocument(), win = new EventTarget();
  let redraws = 0;
  const recovery = bindCanvasRecovery({
    canvases: [base, overlay],
    contexts: () => [baseContext, overlayContext],
    redraw: () => { redraws++; },
    doc: options.withDocument === false ? undefined : doc,
    win: options.withDocument === false ? undefined : win,
  });
  const lose = () => { baseContext.lost = overlayContext.lost = true; for (const canvas of [base, overlay]) canvas.dispatchEvent(new Event('contextlost', { cancelable: true })); };
  const restore = () => { baseContext.lost = overlayContext.lost = false; for (const canvas of [base, overlay]) canvas.dispatchEvent(new Event('contextrestored')); };
  return { base, overlay, baseContext, overlayContext, doc, win, recovery, lose, restore, redraws: () => redraws };
}

describe('W-fix2-portable-02 BoardCanvas repaints after a lost 2D context (GPU process reset)', () => {
  it('redraws the whole frame when the context is restored, without any input', () => {
    const h = setup();
    expect(h.redraws()).toBe(0);
    h.lose();
    expect(h.recovery.invalidated).toBe(true);
    expect(h.recovery.isLost()).toBe(true);
    expect(h.redraws()).toBe(0); // nothing can be painted while the context is lost
    h.restore();
    expect(h.recovery.invalidated).toBe(false);
    expect(h.redraws()).toBe(2); // one request per canvas; BoardCanvas coalesces them into a single animation frame
  });

  it('never cancels contextlost (a cancelled 2D loss event would keep Chromium from restoring the context)', () => {
    const h = setup();
    const event = new Event('contextlost', { cancelable: true });
    h.base.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('handles a restore of only one canvas and a loss of only the overlay', () => {
    const h = setup();
    h.overlayContext.lost = true;
    h.overlay.dispatchEvent(new Event('contextlost'));
    expect(h.recovery.invalidated).toBe(true);
    h.overlayContext.lost = false;
    h.overlay.dispatchEvent(new Event('contextrestored'));
    expect(h.redraws()).toBe(1);
    expect(h.recovery.invalidated).toBe(false);
  });

  it('is idle when nothing was invalidated: the periodic/visible/focus check never requests a draw', () => {
    const h = setup();
    for (let i = 0; i < 20; i++) h.recovery.check();
    h.doc.dispatchEvent(new Event('visibilitychange'));
    h.win.dispatchEvent(new Event('focus'));
    expect(h.redraws()).toBe(0);
    expect(h.recovery.invalidated).toBe(false);
  });

  it('the check repaints exactly once when the contexts are usable again but the restore event was missed', () => {
    const h = setup();
    h.baseContext.lost = true; // lost without any event reaching us
    h.recovery.check();
    expect(h.recovery.invalidated).toBe(true);
    expect(h.redraws()).toBe(0);
    h.recovery.check(); // still lost
    expect(h.redraws()).toBe(0);
    h.baseContext.lost = false;
    h.recovery.check();
    expect(h.redraws()).toBe(1);
    h.recovery.check();
    h.recovery.check();
    expect(h.redraws()).toBe(1);
  });

  it('repaints when the document becomes visible or the window is focused after an invalidated draw', () => {
    const h = setup();
    h.recovery.invalidate(); // the renderer skipped a draw because a context was lost
    h.doc.visibilityState = 'hidden';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.redraws()).toBe(0); // hidden: stays invalidated
    expect(h.recovery.invalidated).toBe(true);
    h.doc.visibilityState = 'visible';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.redraws()).toBe(1);
    expect(h.recovery.invalidated).toBe(false);

    h.recovery.invalidate();
    h.win.dispatchEvent(new Event('focus'));
    expect(h.redraws()).toBe(2);
    h.win.dispatchEvent(new Event('focus'));
    expect(h.redraws()).toBe(2);
  });

  it('keeps the frame invalidated while a context is still lost at a visible/focus tick', () => {
    const h = setup();
    h.lose();
    h.win.dispatchEvent(new Event('focus'));
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.redraws()).toBe(0);
    expect(h.recovery.invalidated).toBe(true);
    h.restore();
    expect(h.redraws()).toBe(2);
  });

  it('treats a context without isContextLost (older embedders) and a missing context as never lost', () => {
    expect(anyContextLost([{}, null, undefined])).toBe(false);
    expect(anyContextLost([{}, { isContextLost: () => false }])).toBe(false);
    expect(anyContextLost([{}, { isContextLost: () => true }])).toBe(true);
  });

  it('dispose removes every listener', () => {
    const h = setup();
    h.recovery.dispose();
    h.lose();
    h.restore();
    h.win.dispatchEvent(new Event('focus'));
    h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.redraws()).toBe(0);
    expect(h.recovery.invalidated).toBe(false);
  });

  it('works without a document/window (only element events)', () => {
    const h = setup({ withDocument: false });
    h.lose();
    h.restore();
    expect(h.redraws()).toBe(2);
  });
});
