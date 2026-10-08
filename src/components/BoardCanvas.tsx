import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Board, BoardComponent, BoardPin, CanvasStatus, Language, ViewCommand, ViewSide } from '../lib/types';
import { createTranslator } from '../lib/i18n';
import { boundsCenter, clamp, distance, expandBounds, fitView, panBy, zoomAt } from '../lib/geometry';
import type { Point2, ViewTransform } from '../lib/geometry';
import { boardIndexOf } from '../lib/board-index';
import type { BoardIndex } from '../lib/board-index';
import { cameraToView, sameCamera, viewShowsBoard, viewToCamera } from './board-camera';
import type { BoardCamera } from './board-camera';
import { hitTestBoard } from './board-hit-test';
import { bindCanvasRecovery } from './board-canvas-recovery';
import type { CanvasRecovery } from './board-canvas-recovery';
import { BOARD_PALETTES } from './board-palette';
import { Canvas2DBoardRenderer } from './board-render-2d';
import type { Layer2D } from './board-render-2d';
import type { BoardRenderState, RenderStats } from './board-renderer';
import { buildBoardScene } from './board-scene';
import { canvasToBoard, fullPane, paneAt } from './board-view';
import type { BoardPane } from './board-view';

export interface BoardCanvasProps {
  board: Board;
  /**
   * The shared index of `board` (WorkspaceState.boardIndex). The canvas takes its id maps, part kinds and per-side pad buckets from it
   * instead of building its own; only render data (spatial indices, paths) is built here. Defaults to `boardIndexOf(board)`.
   */
  index?: BoardIndex;
  side: ViewSide;
  selectedComponentId: string | null;
  selectedPinId: string | null;
  selectedNet: string | null;
  showLabels: boolean;
  showConnections: boolean;
  measureMode: boolean;
  /** `automatic` = issued by the shell on its own (initial fit after a load): applied, but it is not a user change and is never persisted. */
  viewCommand: (ViewCommand & { automatic?: boolean }) | null;
  /**
   * Stored view of THIS board (the shell derives it from the workspace manifest). It replaces the automatic fit: applied once per
   * board, only while the user has not moved the view yet and only when it shows part of the board; it may arrive after the board
   * because the workspace loads asynchronously. Absent or rejected → the board stays fitted.
   */
  initialCamera?: BoardCamera | null;
  /** Called when a stored camera was applied, so the shell can show the stored side (a mirrored bottom view needs the matching `side` prop). */
  onCameraRestore?(camera: BoardCamera): void;
  /** Idle-debounced (CAMERA_IDLE_MS, flushed on unmount/hide) view after a USER change; never for the automatic fit or the restore itself. */
  onCameraChange?(camera: BoardCamera): void;
  theme: 'dark' | 'light';
  motion: boolean;
  /** Only the language code is passed (never a translator function), so the memoized canvas keeps stable props. */
  language: Language;
  /**
   * Feature layers drawn together with the built-in ones (LAYER_ORDER in board-renderer.ts says where each built-in layer sits).
   * Pass a stable array: a new array, or a new layer object in it, redraws the board.
   */
  layers?: readonly Layer2D[];
  /** Called after each drawn surface with the renderer's timing (diagnostics and the canvas harness). */
  onRender?(stats: RenderStats): void;
  onSelectComponent(id: string | null): void;
  onSelectPin(id: string): void;
  onStatusChange?(status: CanvasStatus): void;
}

/** The view is reported once it stopped changing for this long: a pan/zoom gesture never reaches the shell at pointer rate. */
const CAMERA_IDLE_MS = 350;
/** Backstop for a missed contextrestored event: the (draw-free) lost-context check runs this often. Idle stays at 0 draws. */
const CONTEXT_CHECK_MS = 1000;
const NO_LAYERS: readonly Layer2D[] = [];

interface HoverTarget { component: BoardComponent; pin?: BoardPin; screen: Point2 }
interface DragState { id: number; start: Point2; last: Point2; moved: boolean }
interface CanvasDimensions { width: number; height: number; dpr: number }

/**
 * The board canvas: input, camera and panes. What is drawn comes from the board scene (board-scene.ts, built once per board) and is
 * drawn by the renderer (board-render-2d.ts) into two stacked canvases: the base (board, redrawn only when it changed) and the
 * overlay (hover, selection markers, measurement, compass).
 */
function BoardCanvas(props: BoardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Canvas2DBoardRenderer | null>(null);
  const baseDirtyRef = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;
  const dimensionsRef = useRef<CanvasDimensions>({ width: 1, height: 1, dpr: 1 });
  /** The camera: the view of the main pane. */
  const viewRef = useRef<ViewTransform>({ center: boundsCenter(props.board.bounds), scale: 1, rotation: 0, mirrored: props.side === 'bottom' });
  const fitScaleRef = useRef(1);
  const drawRef = useRef<() => void>(() => {});
  const frameRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const selectionTimeRef = useRef(0);
  const cursorRef = useRef<Point2 | null>(null);
  const measurementRef = useRef<Point2[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const lastStatusRef = useRef(0);
  const lastHoverKeyRef = useRef('');
  const touchedRef = useRef(false);
  const restoredBoardRef = useRef<Board | null>(null);
  const cameraTimerRef = useRef<number | null>(null);
  const cameraBoardRef = useRef<Board | null>(null);
  const lastCameraRef = useRef<BoardCamera | null>(null);
  const targetViewRef = useRef<ViewTransform | null>(null);
  const recoveryRef = useRef<CanvasRecovery | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [dragging, setDragging] = useState(false);

  const scene = useMemo(() => buildBoardScene(props.board, props.index ?? boardIndexOf(props.board)), [props.board, props.index]);

  /**
   * The panes of the canvas, in draw order. Today one pane covers the whole canvas and shows the camera's view of the viewed side;
   * the two-sided view and the overview add panes here, and drawing and input already go through the pane list.
   */
  const panes = (): readonly BoardPane[] => {
    const { width, height } = dimensionsRef.current;
    return [fullPane(viewRef.current, propsRef.current.side, width, height)];
  };
  /** The pane that takes input at a canvas point: the one under it, else (a captured drag or a wheel at the edge) the first pane. */
  const inputPane = (point: Point2): BoardPane => {
    const list = panes();
    return paneAt(list, point) ?? list[0];
  };

  const clearHover = useCallback(() => {
    lastHoverKeyRef.current = '';
    setHover(null);
  }, []);

  const requestOverlay = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      drawRef.current();
    });
  }, []);

  const requestDraw = useCallback(() => {
    baseDirtyRef.current = true;
    requestOverlay();
  }, [requestOverlay]);

  const reportStatus = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastStatusRef.current < 50) return;
    lastStatusRef.current = now;
    const view = viewRef.current;
    const cursor = cursorRef.current ?? view.center;
    const measured = measurementRef.current;
    propsRef.current.onStatusChange?.({
      zoom: Math.round(view.scale / Math.max(0.001, fitScaleRef.current) * 100),
      x: cursor.x, y: cursor.y, rotation: view.rotation,
      measurement: measured.length === 2 ? distance(measured[0], measured[1]) : null,
    });
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const emitCamera = useCallback(() => {
    const board = cameraBoardRef.current;
    if (!board || propsRef.current.board !== board) return; // a camera of the previous board must never reach the new one
    const camera = viewToCamera(animationRef.current !== null && targetViewRef.current ? targetViewRef.current : viewRef.current);
    if (sameCamera(camera, lastCameraRef.current)) return;
    lastCameraRef.current = camera;
    propsRef.current.onCameraChange?.(camera);
  }, []);
  const flushCamera = useCallback(() => {
    if (cameraTimerRef.current === null) return;
    window.clearTimeout(cameraTimerRef.current); cameraTimerRef.current = null;
    emitCamera();
  }, [emitCamera]);
  /** Marks a user-driven view change; the view is reported after it has been idle for CAMERA_IDLE_MS. */
  const touchCamera = useCallback(() => {
    touchedRef.current = true;
    cameraBoardRef.current = propsRef.current.board;
    if (cameraTimerRef.current !== null) window.clearTimeout(cameraTimerRef.current);
    cameraTimerRef.current = window.setTimeout(() => { cameraTimerRef.current = null; emitCamera(); }, CAMERA_IDLE_MS);
  }, [emitCamera]);

  const moveView = useCallback((next: ViewTransform, animate = false, user = true) => {
    stopAnimation();
    clearHover();
    const previous = viewRef.current;
    if (user) { targetViewRef.current = next; touchCamera(); }
    if (!animate || !propsRef.current.motion || previous.rotation !== next.rotation || previous.mirrored !== next.mirrored) {
      viewRef.current = next;
      requestDraw();
      reportStatus(true);
      return;
    }
    const start = performance.now();
    const animateFrame = (now: number) => {
      clearHover();
      const progress = clamp((now - start) / 190, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      viewRef.current = {
        ...next,
        center: { x: previous.center.x + (next.center.x - previous.center.x) * eased, y: previous.center.y + (next.center.y - previous.center.y) * eased },
        scale: previous.scale * Math.pow(next.scale / previous.scale, eased),
      };
      requestDraw();
      reportStatus(progress === 1);
      animationRef.current = progress < 1 ? requestAnimationFrame(animateFrame) : null;
    };
    animationRef.current = requestAnimationFrame(animateFrame);
  }, [clearHover, reportStatus, requestDraw, stopAnimation, touchCamera]);

  drawRef.current = () => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const renderer = (rendererRef.current ??= new Canvas2DBoardRenderer(canvas, overlay));
    const status = renderer.status();
    if (status === 'unavailable') return;
    // W-fix2-portable-02: while a context is lost (GPU process gone) every draw call is a no-op; skip, keep the frame dirty and let the
    // contextrestored event (or the visible/focus/timer check) repaint everything once the contexts are usable again.
    if (status === 'lost') { baseDirtyRef.current = true; recoveryRef.current?.invalidate(); return; }
    const current = propsRef.current;
    renderer.setScene(scene);
    renderer.setSize(dimensionsRef.current);
    renderer.setLayers(current.layers ?? NO_LAYERS);
    const selectionPulse = current.motion ? clamp((performance.now() - selectionTimeRef.current) / 360, 0, 1) : 1;
    const state: BoardRenderState = {
      theme: current.theme,
      selectedComponentId: current.selectedComponentId,
      selectedPinId: current.selectedPinId,
      selectedNet: current.selectedNet,
      showLabels: current.showLabels,
      showConnections: current.showConnections,
      measureMode: current.measureMode,
      language: current.language,
      hoverComponentId: hover?.component.id ?? null,
      dragging: dragRef.current !== null,
      measurement: measurementRef.current,
      cursor: cursorRef.current,
      selectionPulse,
    };
    const list = panes();
    if (baseDirtyRef.current) {
      baseDirtyRef.current = false;
      const stats = renderer.render('base', list, state);
      if (stats) current.onRender?.(stats);
    }
    // Hover, measurement and the selection pulse never repaint the board or net.
    const stats = renderer.render('overlay', list, state);
    if (stats) current.onRender?.(stats);
    if (selectionPulse < 1 && current.selectedComponentId) requestOverlay();
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!container || !canvas || !overlay) return;
    let initialized = false;
    let resolutionQuery: MediaQueryList | null = null;
    let observedDpr = window.devicePixelRatio || 1;
    const resize = () => {
      clearHover();
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      dimensionsRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      overlay.width = canvas.width; overlay.height = canvas.height;
      const fit = fitView(propsRef.current.board.bounds, width, height, viewRef.current.rotation, propsRef.current.side === 'bottom');
      fitScaleRef.current = fit.scale;
      if (!initialized) { viewRef.current = fit; initialized = true; }
      requestDraw(); reportStatus(true);
    };
    const onResolutionChange = () => {
      resize();
      watchResolution();
    };
    const watchResolution = () => {
      resolutionQuery?.removeEventListener('change', onResolutionChange);
      observedDpr = window.devicePixelRatio || 1;
      resolutionQuery = window.matchMedia(`(resolution: ${observedDpr}dppx)`);
      resolutionQuery.addEventListener('change', onResolutionChange);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener('resize', resize);
    // Moving between monitors can change DPR while the CSS dimensions stay fixed.
    watchResolution();
    // Some Chromium display/emulation transitions update DPR without any event.
    // Check only the ratio; an unchanged board never redraws because of this timer.
    const resolutionTimer = window.setInterval(() => {
      if ((window.devicePixelRatio || 1) !== observedDpr) onResolutionChange();
    }, 1000);
    resize();
    return () => {
      observer.disconnect(); window.removeEventListener('resize', resize);
      resolutionQuery?.removeEventListener('change', onResolutionChange);
      window.clearInterval(resolutionTimer);
    };
  }, [clearHover, requestDraw, reportStatus]);

  useEffect(() => {
    const { width, height } = dimensionsRef.current;
    const fit = fitView(props.board.bounds, width, height, 0, props.side === 'bottom');
    fitScaleRef.current = fit.scale;
    const previousDrag = dragRef.current;
    const canvas = canvasRef.current;
    if (previousDrag && canvas?.hasPointerCapture(previousDrag.id)) canvas.releasePointerCapture(previousDrag.id);
    dragRef.current = null;
    setDragging(false);
    measurementRef.current = [];
    cursorRef.current = null;
    clearHover();
    // A new board starts untouched: its own stored camera (initialCamera) or the fit decides the view; nothing of the previous board is reported.
    if (cameraTimerRef.current !== null) { window.clearTimeout(cameraTimerRef.current); cameraTimerRef.current = null; }
    touchedRef.current = false; restoredBoardRef.current = null; lastCameraRef.current = null; cameraBoardRef.current = null; targetViewRef.current = null;
    moveView(fit, false, false);
    // A new file gets a fresh view (the renderer's caches belong to the scene, which is new too). Switching sides preserves the location and scale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.board, moveView]);

  useEffect(() => {
    const flipped = viewRef.current.mirrored !== (props.side === 'bottom');
    viewRef.current = { ...viewRef.current, mirrored: props.side === 'bottom' };
    if (flipped) touchCamera(); // the viewed side is part of the stored camera; a restore or a new board already carries its own
    const { width, height } = dimensionsRef.current;
    fitScaleRef.current = fitView(props.board.bounds, width, height, viewRef.current.rotation, props.side === 'bottom').scale;
    clearHover();
    requestDraw(); reportStatus(true);
  }, [props.side, props.board, clearHover, requestDraw, reportStatus, touchCamera]);

  useEffect(() => {
    selectionTimeRef.current = performance.now();
    requestDraw();
  }, [props.selectedComponentId, props.selectedNet, props.selectedPinId, requestDraw]);

  useEffect(() => {
    if (!props.measureMode) measurementRef.current = [];
    requestOverlay(); reportStatus(true);
  }, [props.measureMode, requestOverlay, reportStatus]);

  useEffect(() => { requestDraw(); }, [props.showLabels, props.showConnections, props.theme, props.motion, props.layers, requestDraw]);
  // A language change only needs the localized measurement label repainted: overlay only, no camera or base redraw.
  useEffect(() => { requestOverlay(); }, [props.language, requestOverlay]);

  useEffect(() => { requestOverlay(); }, [hover, requestOverlay]);

  // Only a command issued after this canvas mounted runs: a remount (tab switch) must not replay the last one over the restored view.
  const commandSeenRef = useRef(props.viewCommand?.nonce);
  useEffect(() => {
    const command = props.viewCommand;
    if (!command || command.nonce === commandSeenRef.current) return;
    commandSeenRef.current = command.nonce;
    const { width, height } = dimensionsRef.current;
    const view = viewRef.current;
    switch (command.type) {
      case 'fit': {
        const fit = fitView(props.board.bounds, width, height, view.rotation, view.mirrored);
        fitScaleRef.current = fit.scale; moveView(fit, true, !command.automatic); break;
      }
      case 'rotate': {
        const next = { ...view, rotation: (view.rotation + 90) % 360 };
        fitScaleRef.current = fitView(props.board.bounds, width, height, next.rotation, next.mirrored).scale;
        moveView(next); break;
      }
      case 'zoom-in':
      case 'zoom-out':
        moveView(zoomAt(view, { x: width / 2, y: height / 2 }, view.scale * (command.type === 'zoom-in' ? 1.35 : 1 / 1.35), width, height), true);
        break;
      case 'center-selection': {
        const selected = props.selectedComponentId ? scene.componentsById.get(props.selectedComponentId) : undefined;
        if (!selected) break;
        const b = selected.bounds;
        const target = Math.min(width * 0.42 / Math.max(b.maxX - b.minX + 4, 1), height * 0.42 / Math.max(b.maxY - b.minY + 4, 1));
        moveView({ ...view, center: boundsCenter(b), scale: Math.min(60, Math.max(view.scale, target)) }, true);
        break;
      }
    }
    // nonce makes a command repeatable; selection changes must not re-run an old command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewCommand?.nonce, moveView]);

  // Restore the stored view of this board instead of the automatic fit (declared after the fit effects so it wins within one commit).
  const initialCamera = props.initialCamera ?? null;
  useEffect(() => {
    if (!initialCamera || touchedRef.current || restoredBoardRef.current === props.board) return;
    restoredBoardRef.current = props.board; // decided once per board: a later value must not jump a view the user is looking at
    const { width, height } = dimensionsRef.current;
    const view = cameraToView(initialCamera);
    if (!viewShowsBoard(view, props.board.bounds, width, height)) return;
    fitScaleRef.current = fitView(props.board.bounds, width, height, view.rotation, view.mirrored).scale;
    lastCameraRef.current = viewToCamera(view);
    moveView(view, false, false);
    propsRef.current.onCameraRestore?.(initialCamera);
  }, [initialCamera, props.board, moveView]);

  useEffect(() => {
    window.addEventListener('pagehide', flushCamera);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushCamera(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.removeEventListener('pagehide', flushCamera); document.removeEventListener('visibilitychange', onVisibility); flushCamera(); };
  }, [flushCamera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const pane = inputPane(anchor);
      const local = { x: anchor.x - pane.rect.x, y: anchor.y - pane.rect.y };
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pane.rect.height : 1);
      const view = pane.view;
      moveView(zoomAt(view, local, view.scale * Math.exp(-clamp(delta, -350, 350) * 0.0016), pane.rect.width, pane.rect.height));
      cursorRef.current = canvasToBoard(inputPane(anchor), anchor);
      reportStatus(true);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // inputPane reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveView, reportStatus]);

  // W-fix2-portable-02: a lost 2D context (GPU process killed/reset) comes back with a cleared bitmap and nothing else repaints an idle canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const recovery = bindCanvasRecovery({
      canvases: [canvas, overlay],
      contexts: () => [canvas.getContext('2d', { alpha: false }), overlay.getContext('2d')],
      redraw: requestDraw, doc: document, win: window,
    });
    recoveryRef.current = recovery;
    const timer = window.setInterval(recovery.check, CONTEXT_CHECK_MS);
    return () => {
      window.clearInterval(timer); recovery.dispose();
      if (recoveryRef.current === recovery) recoveryRef.current = null;
    };
  }, [requestDraw]);

  useEffect(() => () => {
    stopAnimation();
    // Release the redraw gate after cancellation, including StrictMode effect replay.
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    rendererRef.current?.dispose(); rendererRef.current = null;
  }, [stopAnimation]);

  const localPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point2 => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const hitTest = (screen: Point2, pinTolerance = 5.5): HoverTarget | null => {
    const pane = inputPane(screen);
    const side = scene.sides[pane.side];
    // Pad ranking and component containment live in board-hit-test.ts (B17, B23), where they are unit-tested.
    const target = hitTestBoard(
      { pins: side.pins, components: side.components, componentsById: scene.componentsById },
      { x: screen.x - pane.rect.x, y: screen.y - pane.rect.y }, pane.view, pane.rect.width, pane.rect.height,
      { selectedComponentId: props.selectedComponentId, pinTolerance },
    );
    return target ? { ...target, screen } : null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    stopAnimation();
    const screen = localPoint(event);
    dragRef.current = { id: event.pointerId, start: screen, last: screen, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    clearHover();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const screen = localPoint(event);
    const drag = dragRef.current;
    if (drag && drag.id === event.pointerId) {
      const delta = { x: screen.x - drag.last.x, y: screen.y - drag.last.y };
      if (distance(screen, drag.start) > 4) drag.moved = true;
      if (drag.moved) {
        clearHover();
        viewRef.current = panBy(viewRef.current, delta);
        touchCamera();
        requestDraw();
      }
      drag.last = screen;
    } else if (!props.measureMode) {
      const target = hitTest(screen);
      const key = target ? `${target.component.id}:${target.pin?.id ?? ''}` : '';
      if (key !== lastHoverKeyRef.current) { lastHoverKeyRef.current = key; setHover(target); }
    }
    cursorRef.current = canvasToBoard(inputPane(screen), screen);
    if (props.measureMode && measurementRef.current.length === 1) requestOverlay();
    reportStatus();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const screen = localPoint(event);
    if (!drag.moved && event.button === 0) {
      if (props.measureMode) {
        const pane = inputPane(screen);
        const canonical = canvasToBoard(pane, screen);
        // Measuring can snap to zero-size source pads without fabricating a physical diameter.
        const radius = 9 / pane.view.scale;
        const candidates = scene.sides[pane.side].pins.query(expandBounds({ minX: canonical.x, minY: canonical.y, maxX: canonical.x, maxY: canonical.y }, radius));
        let point = canonical, nearest = radius;
        for (const pin of candidates) {
          const d = distance(canonical, pin);
          if (d < nearest) { point = { x: pin.x, y: pin.y }; nearest = d; }
        }
        measurementRef.current = measurementRef.current.length === 1 ? [measurementRef.current[0], point] : [point];
        requestOverlay();
      } else {
        const target = hitTest(screen);
        if (target?.pin) props.onSelectPin(target.pin.id);
        else props.onSelectComponent(target?.component.id ?? null);
      }
    }
    reportStatus(true);
  };

  const cancelPointer = () => { dragRef.current = null; setDragging(false); };
  const palette = BOARD_PALETTES[props.theme];
  const t = createTranslator(props.language); // Cached per language: a stable function, no memo or effect depends on it.

  return (
    <div ref={containerRef} className="board-canvas-container" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: palette.background }}>
      <canvas
        ref={canvasRef}
        className="board-canvas"
        tabIndex={0}
        aria-label={t(props.side === 'top' ? (props.measureMode ? 'canvas.ariaTopMeasure' : 'canvas.ariaTopSelect') : (props.measureMode ? 'canvas.ariaBottomMeasure' : 'canvas.ariaBottomSelect'))}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', outline: 'none', cursor: dragging ? 'grabbing' : props.measureMode ? 'crosshair' : hover ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onPointerLeave={() => { if (!dragRef.current) clearHover(); }}
        onDoubleClick={event => {
          if (props.measureMode) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          const pane = inputPane(screen);
          const local = { x: screen.x - pane.rect.x, y: screen.y - pane.rect.y };
          moveView(zoomAt(pane.view, local, pane.view.scale * 1.6, pane.rect.width, pane.rect.height), true);
        }}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            moveView(panBy(viewRef.current, { x: event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0, y: event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0 }));
          }
        }}
      />
      <canvas ref={overlayRef} className="board-canvas-overlay" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
      {hover && !dragging && !props.measureMode && (
        <div className="canvas-hover-card" style={{
          position: 'absolute', left: clamp(hover.screen.x + 16, 12, Math.max(12, dimensionsRef.current.width - 220)),
          top: clamp(hover.screen.y + 16, 12, Math.max(12, dimensionsRef.current.height - 66)),
          maxWidth: 208, padding: '9px 12px', pointerEvents: 'none', border: `1px solid ${palette.boardLine}`,
          borderRadius: 9, background: palette.card, boxShadow: '0 5px 20px #0003', color: palette.text,
          fontSize: 11, lineHeight: 1.5, zIndex: 3,
        }}>
          <div style={{ fontFamily: "'IBM Plex Mono', Consolas, monospace", fontWeight: 600, color: hover.pin ? palette.cyan : palette.amber }}>
            {hover.component.ref}{hover.pin ? ` · ${hover.pin.number}` : ''}
          </div>
          <div style={{ color: palette.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hover.pin ? hover.pin.net || t('canvas.noNet') : hover.component.value || hover.component.package || t('unit.pins', { count: hover.component.pinIds.length })}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(BoardCanvas);
