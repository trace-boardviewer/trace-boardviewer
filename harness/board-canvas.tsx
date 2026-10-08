import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '../src/styles.css';
import BoardCanvas from '../src/components/BoardCanvas';
import { cameraToView } from '../src/components/board-camera';
import type { BoardCamera } from '../src/components/board-camera';
import type { RenderStats } from '../src/components/board-renderer';
import { parseBoard } from '../src/lib/formats';
import { boardToScreen, boundsCenter, fitView } from '../src/lib/geometry';
import type { Bounds2, Point2 } from '../src/lib/geometry';
import type { Board, BoardComponent, BoardPin, Language, ViewCommand } from '../src/lib/types';

/**
 * Dev harness of the board canvas alone, driven by scripts/qa-board-render.cjs (pixel captures and frame timing).
 * The board arrives as bytes from a URL the driver serves; nothing is read from disk here.
 * URL: ?strict=0 (no StrictMode: no double render in dev, so the first-draw time is not doubled).
 * Test hooks: window.__boardHarness (load, show, command, picks, toScreen, capture, perf).
 */
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------------------------
// Frame instrumentation: every animation-frame callback that touches a canvas is one frame.
// ---------------------------------------------------------------------------------------------

interface FrameRecord {
  phase: string; start: number; end: number; duration: number; base: boolean; overlay: boolean; fenceMs: number;
  /** Renderer layer times of the base surface drawn in this frame (ms by layer id). */
  layers?: Record<string, number>;
}
const perfState = { phase: 'boot', fence: false, frames: [] as FrameRecord[] };
const nativeRaf = window.requestAnimationFrame.bind(window);
let currentFrame: FrameRecord | null = null;
window.requestAnimationFrame = (callback: FrameRequestCallback) => nativeRaf(timestamp => {
  const frame: FrameRecord = { phase: perfState.phase, start: performance.now(), end: 0, duration: 0, base: false, overlay: false, fenceMs: 0 };
  const prior = currentFrame;
  currentFrame = frame;
  try { callback(timestamp); } finally {
    currentFrame = prior;
    frame.end = performance.now();
    frame.duration = frame.end - frame.start;
    if (frame.base || frame.overlay) {
      if (frame.base && perfState.fence) {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.board-canvas');
        const context = canvas?.getContext('2d');
        if (canvas && context) { const t0 = performance.now(); context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1); frame.fenceMs = performance.now() - t0; }
      }
      perfState.frames.push(frame);
    }
  }
});
// A base redraw sets the transform of the board canvas, an overlay redraw the transform of the overlay canvas.
const nativeSetTransform = CanvasRenderingContext2D.prototype.setTransform;
CanvasRenderingContext2D.prototype.setTransform = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
  if (currentFrame) { if (this.canvas.classList.contains('board-canvas')) currentFrame.base = true; else currentFrame.overlay = true; }
  return (nativeSetTransform as (...a: unknown[]) => void).apply(this, args);
} as CanvasRenderingContext2D['setTransform'];

/** The canvas reports the time of each renderer layer; the base surface's layers are added to the frame that drew them. */
function recordRender(stats: RenderStats) {
  if (!currentFrame || stats.surface !== 'base') return;
  const layers = (currentFrame.layers ??= {});
  for (const [id, ms] of Object.entries(stats.layers)) layers[id] = (layers[id] ?? 0) + ms;
}

const nextFrame = () => new Promise<void>(resolve => nativeRaf(() => setTimeout(resolve, 0)));
async function settle(frames = 3) {
  await document.fonts.ready;
  for (let i = 0; i < frames; i++) await nextFrame();
}

// ---------------------------------------------------------------------------------------------
// Scenario state
// ---------------------------------------------------------------------------------------------

interface Selection { componentId: string | null; pinId: string | null; net: string | null }
interface Scenario {
  side: 'top' | 'bottom';
  theme: 'dark' | 'light';
  showLabels: boolean;
  showConnections: boolean;
  measureMode: boolean;
  motion: boolean;
  language: Language;
  /** Null: the canvas fits the board on its own. */
  camera: BoardCamera | null;
  selection: Selection;
}
const DEFAULT_SCENARIO: Scenario = {
  side: 'top', theme: 'dark', showLabels: true, showConnections: true, measureMode: false, motion: false, language: 'en', camera: null,
  selection: { componentId: null, pinId: null, net: null },
};

let board: Board | null = null;
let scenario: Scenario = DEFAULT_SCENARIO;
let mountKey = 0;
let commandNonce = 0;
let viewCommand: (ViewCommand & { automatic?: boolean }) | null = null;
let rerender: (() => void) | null = null;
let committed: (() => void) | null = null;
const callbacks = { selectComponent: [] as Array<string | null>, selectPin: [] as string[], cameras: [] as BoardCamera[] };

function Harness() {
  const [, setTick] = useState(0);
  useEffect(() => { rerender = () => setTick(tick => tick + 1); return () => { rerender = null; }; }, []);
  useEffect(() => { const done = committed; committed = null; done?.(); });
  if (!board) return <div className="bch-root"><div className="bch-empty">No board</div></div>;
  const s = scenario;
  return <div className="bch-root"><div className="bch-view">
    <BoardCanvas key={mountKey} board={board} side={s.side} selectedComponentId={s.selection.componentId} selectedPinId={s.selection.pinId} selectedNet={s.selection.net}
      showLabels={s.showLabels} showConnections={s.showConnections} measureMode={s.measureMode} viewCommand={viewCommand} initialCamera={s.camera}
      onCameraChange={camera => callbacks.cameras.push(camera)} theme={s.theme} motion={s.motion} language={s.language} onRender={recordRender}
      onSelectComponent={id => callbacks.selectComponent.push(id)} onSelectPin={id => callbacks.selectPin.push(id)} />
  </div></div>;
}

function commit(): Promise<void> {
  return new Promise(resolve => { committed = resolve; rerender?.(); });
}

// ---------------------------------------------------------------------------------------------
// Deterministic targets of a board, so a driver can name them without knowing the board
// ---------------------------------------------------------------------------------------------

interface PartPick { id: string; ref: string; side: string; center: Point2; bounds: Bounds2; pins: number }
interface NetPick { name: string; pins: number; pinId: string; componentId: string; center: Point2; bounds: Bounds2 }
const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const partPick = (component: BoardComponent | undefined): PartPick | null => component
  ? { id: component.id, ref: component.ref, side: component.side, center: boundsCenter(component.bounds), bounds: component.bounds, pins: component.pinIds.length }
  : null;

function picks(target: Board) {
  const visibleOn = (item: { side: string }, side: string) => item.side === side || item.side === 'both';
  const bySize = (list: BoardComponent[]) => [...list].sort((a, b) => b.pinIds.length - a.pinIds.length || before(a.ref, b.ref) || before(a.id, b.id));
  const area = (c: BoardComponent) => (c.bounds.maxX - c.bounds.minX) * (c.bounds.maxY - c.bounds.minY);
  const top = target.components.filter(c => visibleOn(c, 'top'));
  const bottom = target.components.filter(c => visibleOn(c, 'bottom'));
  const groups = new Map<string, BoardPin[]>();
  for (const pin of target.pins) {
    if (!pin.net || !visibleOn(pin, 'top')) continue;
    const list = groups.get(pin.net);
    if (list) list.push(pin); else groups.set(pin.net, [pin]);
  }
  const nets = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || before(a[0], b[0]));
  const netPick = (entry: [string, BoardPin[]] | undefined): NetPick | null => {
    if (!entry) return null;
    const [name, pins] = entry;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pin of pins) { minX = Math.min(minX, pin.x); minY = Math.min(minY, pin.y); maxX = Math.max(maxX, pin.x); maxY = Math.max(maxY, pin.y); }
    const bounds = { minX, minY, maxX, maxY };
    return { name, pins: pins.length, pinId: pins[0].id, componentId: pins[0].componentId, center: boundsCenter(bounds), bounds };
  };
  return {
    largestPart: partPick(bySize(top)[0]),
    bottomPart: partPick(bySize(bottom)[0]),
    smallPart: partPick([...top].sort((a, b) => area(a) - area(b) || before(a.ref, b.ref))[0]),
    largestNet: netPick(nets[0]),
    /** The largest net that still gets dashed lines (at most 192 other pins). */
    midNet: netPick(nets.find(([, pins]) => pins.length >= 3 && pins.length <= 150)),
    bounds: target.bounds,
  };
}

// ---------------------------------------------------------------------------------------------
// Driver API
// ---------------------------------------------------------------------------------------------

function canvasElements() {
  const base = document.querySelector<HTMLCanvasElement>('canvas.board-canvas');
  const overlay = document.querySelector<HTMLCanvasElement>('canvas.board-canvas-overlay');
  if (!base || !overlay) throw new Error('The board canvas is not mounted.');
  return { base, overlay };
}
function viewSize() {
  const rect = canvasElements().base.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
/** The view the canvas shows for the current scenario (its stored camera, else its own fit). */
function currentView() {
  if (!board) throw new Error('No board.');
  const { width, height } = viewSize();
  return scenario.camera ? cameraToView(scenario.camera) : fitView(board.bounds, width, height, 0, scenario.side === 'bottom');
}
const base64 = (bytes: Uint8ClampedArray) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

const api = {
  async load(url: string, name: string) {
    const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const t0 = performance.now();
    board = parseBoard({ name, data });
    const parseMs = performance.now() - t0;
    scenario = DEFAULT_SCENARIO; viewCommand = null; mountKey++;
    perfState.phase = 'load';
    await commit(); await settle();
    return { parseMs, components: board.components.length, pins: board.pins.length, nets: board.nets.length, format: board.format, picks: picks(board) };
  },
  /** Mounts a fresh canvas for the scenario (a fresh mount applies its camera) and waits until it has drawn. */
  async show(partial: Partial<Scenario>, options: { phase?: string } = {}) {
    scenario = { ...DEFAULT_SCENARIO, ...partial, selection: { ...DEFAULT_SCENARIO.selection, ...partial.selection } };
    viewCommand = null; mountKey++;
    perfState.phase = options.phase ?? 'show';
    const mountAt = performance.now();
    await commit(); await settle();
    const first = perfState.frames.find(frame => frame.base && frame.start >= mountAt);
    return { ...viewSize(), dpr: window.devicePixelRatio, firstDrawMs: first ? first.end - mountAt : null, firstDrawCallbackMs: first?.duration ?? null };
  },
  /** Changes props of the mounted canvas without remounting it. */
  async update(partial: Partial<Scenario>) {
    scenario = { ...scenario, ...partial, selection: { ...scenario.selection, ...partial.selection } };
    await commit(); await settle();
  },
  async command(type: ViewCommand['type']) {
    viewCommand = { type, nonce: ++commandNonce };
    await commit(); await settle(4);
  },
  picks: () => (board ? picks(board) : null),
  /** A stored camera that fits `bounds` (default: the board) into the canvas, rotated and scaled by `factor`. */
  fitCamera(options: { bounds?: Bounds2; rotation?: number; side?: 'top' | 'bottom'; factor?: number; zoom?: number } = {}): BoardCamera {
    if (!board) throw new Error('No board.');
    const { width, height } = viewSize();
    const side = options.side ?? 'top';
    const view = fitView(options.bounds ?? board.bounds, width, height, options.rotation ?? 0, side === 'bottom');
    return { zoom: options.zoom ?? view.scale * (options.factor ?? 1), x: view.center.x, y: view.center.y, rotation: view.rotation, side };
  },
  /** Page (client) coordinates of a canonical board point in the current scenario's view. */
  toScreen(point: Point2) {
    const size = viewSize();
    const screen = boardToScreen(point, currentView(), size.width, size.height);
    return { x: size.left + screen.x, y: size.top + screen.y };
  },
  /** Exact pixels of both canvases (RGBA, base64) and, on request, PNGs to look at. */
  async capture(options: { png?: boolean } = {}) {
    await settle();
    const { base, overlay } = canvasElements();
    const read = (canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return { width: canvas.width, height: canvas.height, rgba: base64(data), png: options.png ? canvas.toDataURL('image/png') : undefined };
    };
    return { base: read(base), overlay: read(overlay) };
  },
  callbacks,
  perf: {
    reset(phase: string, fence = false) { perfState.frames = []; perfState.phase = phase; perfState.fence = fence; },
    frames: () => perfState.frames,
    /** Drags from `at` by `step` CSS px per frame (`steps` frames); one pointer move per frame. */
    async pan(at: Point2, step: Point2, steps: number) {
      const { base } = canvasElements();
      const init = (x: number, y: number, buttons: number): PointerEventInit => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, bubbles: true, cancelable: true });
      base.dispatchEvent(new PointerEvent('pointerdown', init(at.x, at.y, 1)));
      await nextFrame();
      let x = at.x, y = at.y;
      for (let i = 0; i < steps; i++) {
        x += step.x; y += step.y;
        base.dispatchEvent(new PointerEvent('pointermove', init(x, y, 1)));
        await nextFrame();
      }
      base.dispatchEvent(new PointerEvent('pointerup', init(x, y, 0)));
      await nextFrame();
    },
    /** One wheel event per frame at `at` (client px). */
    async wheel(at: Point2, deltaY: number, steps: number) {
      const { base } = canvasElements();
      for (let i = 0; i < steps; i++) {
        base.dispatchEvent(new WheelEvent('wheel', { clientX: at.x, clientY: at.y, deltaY, deltaMode: 0, bubbles: true, cancelable: true }));
        await nextFrame();
      }
    },
    /** Pointer moves without a button (hover hit tests); returns the handler time of each move. */
    async hover(points: Point2[]) {
      const { base } = canvasElements();
      const times: number[] = [];
      for (const point of points) {
        const t0 = performance.now();
        base.dispatchEvent(new PointerEvent('pointermove', { clientX: point.x, clientY: point.y, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0, bubbles: true }));
        times.push(performance.now() - t0);
        await nextFrame();
      }
      return times;
    },
  },
};
declare global { interface Window { __boardHarness?: typeof api } }
window.__boardHarness = api;

const tree = <Harness />;
createRoot(document.getElementById('root')!).render(params.get('strict') === '0' ? tree : <StrictMode>{tree}</StrictMode>);
