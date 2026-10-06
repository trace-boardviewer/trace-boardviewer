import { Component, Cpu, Plug, X } from 'lucide-react';
import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DATA_LOCALE } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import type { PdfSession, PdfSessionSnapshot } from '../../lib/pdf/session-contract';
import { createBackdropDismisser } from '../../lib/support-notice';
import type { BoardComponent } from '../../lib/types';
import './workspace.css';

/** One shared collator: constructing a locale comparison per comparator call cost 34x in the old sort (P02). */
export const naturalCollator = new Intl.Collator(DATA_LOCALE, { numeric: true });
export const naturalOrder = (a: string, b: string) => naturalCollator.compare(a, b);

declare global { interface Window { __wspRenders?: Record<string, number> } }
const countRender = (id: string) => { const counters = window.__wspRenders; if (counters) counters[id] = (counters[id] ?? 0) + 1; };
/** Commit counter for the QA harness (P01 regression). React only calls Profiler callbacks in development builds, so production pays nothing. */
export function Probe({ id, children }: { id: string; children: ReactNode }) {
  return <Profiler id={id} onRender={countRender}>{children}</Profiler>;
}

export function kindKey(component: Pick<BoardComponent, 'ref'>): MessageKey {
  const prefix = component.ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() || '';
  if (prefix.endsWith('U')) return 'kind.ic';
  if (prefix.endsWith('C')) return 'kind.capacitor';
  if (prefix.endsWith('R')) return 'kind.resistor';
  if (prefix.endsWith('L')) return 'kind.inductor';
  if (/[JP]$/.test(prefix)) return 'kind.connector';
  if (prefix.endsWith('D')) return 'kind.diode';
  if (prefix.endsWith('Q')) return 'kind.transistor';
  if (/[XY]$/.test(prefix)) return 'kind.crystal';
  if (prefix.endsWith('F')) return 'kind.fuse';
  return 'kind.part';
}
export const sideKey = (side: string): MessageKey => side === 'top' ? 'side.top' : side === 'bottom' ? 'side.bottom' : 'side.both';
export const sideLabelKey = (side: string): MessageKey => side === 'top' ? 'side.topLabel' : side === 'bottom' ? 'side.bottomLabel' : 'side.bothLabel';
export const sideBadgeKey = (side: string): MessageKey => side === 'top' ? 'side.badgeTop' : side === 'bottom' ? 'side.badgeBottom' : 'side.badgeBoth';

export function PartIcon({ component, size = 17 }: { component: Pick<BoardComponent, 'ref'>; size?: number }) {
  const type = kindKey(component);
  return type === 'kind.ic' ? <Cpu size={size} /> : type === 'kind.connector' ? <Plug size={size} /> : <Component size={size} />;
}

export function Tool({ label, shortcut, active, disabled, testId, onClick, children, className = '' }: { label: string; shortcut?: string; active?: boolean; disabled?: boolean; testId?: string; onClick: () => void; children: ReactNode; className?: string }) {
  return <button type="button" className={'tool-button' + (active ? ' active' : '') + (className ? ' ' + className : '')} title={label + (shortcut ? ` · ${shortcut}` : '')} aria-label={label} aria-pressed={active} disabled={disabled} data-testid={testId} onClick={onClick}>{children}</button>;
}

export function Modal({ title, close, closeLabel, children, wide = false, initialFocus, testId }: { title: string; close: () => void; closeLabel: string; children: ReactNode; wide?: boolean; initialFocus?: string; testId?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Capture the invoker before a child's autoFocus runs during the commit.
  const invoker = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  // A click closes the dialog only when the press and the release were both on the backdrop: a text selection or a drag that starts
  // inside and ends outside keeps it open, and with it a note draft (H3-01). The same rule as the support notice.
  const closeRef = useRef(close); closeRef.current = close;
  const [backdrop] = useState(() => createBackdropDismisser(() => closeRef.current()));
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.showModal();
    if (initialFocus) node.querySelector<HTMLElement>(initialFocus)?.focus({ preventScroll: true });
    return () => { node.close(); if (invoker.current?.isConnected) invoker.current.focus({ preventScroll: true }); };
  }, [initialFocus]);
  return <dialog ref={ref} className={'modal ' + (wide ? 'modal-wide' : '')} data-testid={testId} aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onPointerDown={backdrop.onPointerDown} onClick={backdrop.onClick}
    // The dialog is modal: keys typed in it never reach the shell's global shortcuts (the shortcut context ignores open dialogs as well).
    onKeyDown={e => e.stopPropagation()}>
    <div className="modal-inner"><header className="modal-header"><h2>{title}</h2><Tool label={closeLabel} onClick={close}><X size={19} /></Tool></header>{children}</div>
  </dialog>;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  itemHeight: number | ((item: T, index: number) => number);
  render: (item: T, index: number) => ReactNode;
  /** Scroll position returns to the top whenever this changes: a new result set must not inherit the old scrollTop (B12). */
  resetKey?: string | number;
  /** Row that must stay visible (keyboard / selection); undefined or negative = leave scrolling alone. */
  scrollToIndex?: number;
  className?: string;
  label?: string;
  role?: string;
  id?: string;
  itemKey?: (item: T, index: number) => string | number;
  style?: React.CSSProperties;
}

/** Variable-height windowed list: only the visible rows (plus overscan) exist in the DOM. */
export function VirtualList<T>({ items, itemHeight, render, resetKey, scrollToIndex, className = '', label, role, id, itemKey, style }: VirtualListProps<T>) {
  const element = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const offsets = useMemo(() => {
    const result = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) result[i + 1] = result[i] + (typeof itemHeight === 'number' ? itemHeight : itemHeight(items[i], i));
    return result;
  }, [items, itemHeight]);
  const total = offsets[items.length];
  useEffect(() => {
    const node = element.current!;
    setViewport(v => ({ ...v, height: node.clientHeight }));
    const observer = new ResizeObserver(() => setViewport(v => ({ ...v, height: node.clientHeight })));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const firstReset = useRef(true);
  useLayoutEffect(() => {
    if (firstReset.current) { firstReset.current = false; return; }
    const node = element.current;
    if (node) { node.scrollTop = 0; setViewport(v => ({ ...v, top: 0 })); }
  }, [resetKey]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const max = Math.max(0, total - node.clientHeight);
    if (node.scrollTop > max) { node.scrollTop = max; setViewport(v => ({ ...v, top: max })); }
  }, [total]);
  useEffect(() => {
    const node = element.current;
    if (!node || scrollToIndex == null || scrollToIndex < 0 || scrollToIndex >= items.length) return;
    const top = offsets[scrollToIndex], bottom = offsets[scrollToIndex + 1];
    if (top < node.scrollTop) node.scrollTop = top;
    else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = Math.max(0, bottom - node.clientHeight);
  }, [scrollToIndex, offsets, items.length]);
  const indexAt = useCallback((y: number) => {
    let lo = 0, hi = items.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }, [offsets, items.length]);
  const start = Math.max(0, indexAt(viewport.top) - 4);
  const end = Math.min(items.length, indexAt(viewport.top + viewport.height) + 5);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    rows.push(<div key={itemKey ? itemKey(item, i) : i} className="wsp-vrow" style={{ top: offsets[i], height: offsets[i + 1] - offsets[i] }}>{render(item, i)}</div>);
  }
  return <div ref={element} id={id} role={role} aria-label={label} style={style} className={'virtual-list ' + className} onScroll={e => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
    <div style={{ height: total, position: 'relative' }}>{rows}</div>
  </div>;
}

/** The PDF session is an external store: subscribe so the badge reflects scan-only/opening state without a shell re-render. */
export function usePdfSnapshot(session: PdfSession | undefined): PdfSessionSnapshot | null {
  const subscribe = useCallback((listener: () => void) => session ? session.subscribe(listener) : () => {}, [session]);
  const getSnapshot = useCallback(() => session ? session.getSnapshot() : null, [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Observed width of an element, used to switch the viewers to their compact chrome (split panes, narrow windows).
 * The element is tracked through a callback ref: the shell mounts before a board exists, so the element it measures appears
 * (and disappears) later and a mount-time effect would never see it (W-win-viewers-02: the width stayed 0, compact never applied).
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) { setWidth(0); return; }
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node); return () => observer.disconnect();
  }, [node]);
  return [setNode, width];
}

/** True while the window's inner width (CSS px) is below `limit`; React re-renders only when that boolean flips, not on every resize tick. */
export function useWindowBelow(limit: number): boolean {
  const [below, setBelow] = useState(() => window.innerWidth < limit);
  useEffect(() => {
    const update = () => setBelow(window.innerWidth < limit);
    window.addEventListener('resize', update); update();
    return () => window.removeEventListener('resize', update);
  }, [limit]);
  return below;
}

/** Splits `text` on case-insensitive occurrences of `query` for the calm accent highlight; plain text when it does not match. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="wsp-mark">{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>;
}
