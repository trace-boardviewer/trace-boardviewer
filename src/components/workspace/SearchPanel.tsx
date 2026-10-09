import { Clock3, FileText, LoaderCircle, Route, Search, StickyNote, X, CircuitBoard } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { SearchRow } from '../../lib/crossprobe';
import { searchQueryOf } from '../../lib/crossprobe';
import { annotatedComponentIds } from '../../lib/note-keys';
import { symbolKey } from '../../lib/schematic/model';
import type { BoardComponent, ViewSide } from '../../lib/types';
import { flattenResults, GROUP_LABEL, resultIdentity, rowKey } from './search-model';
import { indexOfState } from './model';
import type { FlatItem } from './search-model';
import { useUi } from './ui-context';
import { Highlight, naturalOrder, PartIcon, kindKey, sideBadgeKey, sideLabelKey, VirtualList } from './ui';

// i18n: pending
const T = {
  placeholder: 'Reference, net, value or document text',
  searching: 'Searching…',
  results: 'Search results',
  noMatch: 'Nothing matches this search.',
  caseDiffers: 'case differs',
  more: (shown: number, total: number) => `showing ${shown} of ${total}`,
  pins: (n: number) => `${n} pin${n === 1 ? '' : 's'}`,
  members: (n: number) => `${n} pin${n === 1 ? '' : 's'}`,
  page: (n: number | string) => `p. ${n}`,
  global: 'global', local: 'local sheet', hierarchical: 'hierarchical',
  auto: 'auto-named',
  noteMark: 'Has a note',
};

const ROW_HEIGHT = 46, HEADER_HEIGHT = 30;
const heightOf = (item: FlatItem) => item.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT;

export interface SearchController {
  draft: string;
  query: string;
  items: FlatItem[];
  rows: SearchRow[];
  pending: boolean;
  active: number;
  identity: string;
  inputProps: {
    value: string;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
  clear(): void;
  activate(row: SearchRow): void;
}

/**
 * Search box logic. The query is committed to the workspace only from committed text: never while an IME composition is in progress
 * (B25), and Enter during composition neither selects nor blurs. Escape clears the field itself (B14).
 */
export function useSearchController(api: WorkspaceApi, inputRef: RefObject<HTMLInputElement | null>, onActivated?: (row: SearchRow) => void): SearchController {
  const { search } = api.state;
  const { actions } = api;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [draft, setDraft] = useState(search.query);
  const composing = useRef(false);
  const lastCommit = useRef(search.query);
  const commit = useCallback((value: string) => { lastCommit.current = value; actionsRef.current.setSearchQuery(value); }, []);
  // External changes (Escape on the canvas, a new board) win; the core echoing our own text back must not rewrite the draft.
  useEffect(() => {
    if (composing.current || search.query.trim() === lastCommit.current.trim()) return;
    lastCommit.current = search.query; setDraft(search.query);
  }, [search.query]);
  const { items, rows } = useMemo(() => flattenResults(search.result), [search.result]);
  const identity = resultIdentity(search.result);
  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [identity]);
  const activatedRef = useRef(onActivated); activatedRef.current = onActivated;
  const activate = useCallback((row: SearchRow) => {
    if (!search.result || search.result.query !== searchQueryOf(search.query)) return;
    actionsRef.current.activateSearchRow(row);
    activatedRef.current?.(row);
    if (row.source !== 'documents') inputRef.current?.blur();
  }, [inputRef, search.query, search.result]);
  const clear = useCallback(() => { setDraft(''); commit(''); }, [commit]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const activeRef = useRef(active); activeRef.current = active;
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    // keyCode 229 = the browser's "processing by an IME" marker, for engines that report isComposing late.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      const row = rowsRef.current[Math.min(activeRef.current, rowsRef.current.length - 1)];
      if (row) { event.preventDefault(); activate(row); }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rowsRef.current.length) return;
      event.preventDefault();
      setActive(index => Math.max(0, Math.min(rowsRef.current.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (event.currentTarget.value) clear(); else event.currentTarget.blur();
    }
  }, [activate, clear]);
  const inputProps = useMemo(() => ({
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setDraft(value);
      if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) commit(value);
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement>) => { composing.current = false; const value = event.currentTarget.value; setDraft(value); commit(value); },
    onKeyDown,
  }), [draft, commit, onKeyDown]);
  return { draft, query: search.query, items, rows, pending: search.pending, active, identity, inputProps, clear, activate };
}

export function SearchField({ ctl, inputRef }: { ctl: SearchController; inputRef: RefObject<HTMLInputElement | null> }) {
  const { t } = useUi();
  return <label className="search-field wsp-search-field">
    <Search size={16} />
    <input ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={ctl.rows.length > 0} aria-controls="wsp-results" aria-activedescendant={ctl.rows.length ? `wsp-row-${Math.min(ctl.active, ctl.rows.length - 1)}` : undefined}
      data-testid="search-input" placeholder={T.placeholder} aria-label={t('search.aria')} autoComplete="off" spellCheck={false} {...ctl.inputProps} />
    <span className="key-hint">⌃ F</span>
    {ctl.pending && <LoaderCircle size={14} className="spin" aria-label={T.searching} />}
    {ctl.draft && <button type="button" aria-label={t('search.clear')} data-testid="search-clear" onClick={() => { ctl.clear(); inputRef.current?.focus(); }}><X size={14} /></button>}
  </label>;
}

function ResultRow({ row, index, active, selected, query, annotated, onActivate }: { row: SearchRow; index: number; active: boolean; selected: boolean; query: string; annotated: boolean; onActivate: (row: SearchRow) => void }) {
  const { t } = useUi();
  let icon: React.ReactNode, title: React.ReactNode, sub: React.ReactNode, side: React.ReactNode = null;
  switch (row.source) {
    case 'board-components':
      icon = <PartIcon component={row} />;
      title = <Highlight text={row.ref} query={query} />;
      sub = <>{row.value || t(kindKey(row))}{row.match.caseInsensitive && <em className="wsp-chip"> {T.caseDiffers}</em>}</>;
      side = <span className="side-badge">{t(sideBadgeKey(row.side))}</span>;
      break;
    case 'board-nets':
      icon = <Route size={16} />; title = <Highlight text={row.name} query={query} />; sub = T.pins(row.pinCount);
      break;
    case 'schematic-symbols':
      icon = <CircuitBoard size={16} />; title = <Highlight text={row.ref} query={query} />;
      sub = <>{row.value || row.libId}</>; side = <span className="wsp-where">{row.sheetLabel || row.sheetName}{row.page ? ` · ${T.page(row.page)}` : ''}</span>;
      break;
    case 'schematic-nets':
      icon = <Route size={16} />; title = <Highlight text={row.name} query={query} />;
      sub = <>{row.scope === 'global' ? T.global : row.scope === 'local' ? T.local : T.hierarchical}{row.auto ? ` · ${T.auto}` : ''} · {T.members(row.memberCount)}</>;
      side = <span className="wsp-where">{row.sheetLabel ?? ''}{row.page ? ` · ${T.page(row.page)}` : ''}</span>;
      break;
    case 'documents':
      icon = <FileText size={16} />; title = <span className="wsp-doc-title">{row.documentName}</span>;
      sub = <Highlight text={row.context} query={query} />; side = <span className="wsp-where">{T.page(row.page)}</span>;
      break;
  }
  const netLike = row.source === 'board-nets' || row.source === 'schematic-nets';
  return <button type="button" role="option" id={`wsp-row-${index}`} aria-selected={active} data-source={row.source} data-testid="search-row"
    className={'wsp-result' + (active ? ' active' : '') + (selected ? ' selected' : '') + (netLike ? ' net' : '')} onClick={() => onActivate(row)}>
    <span className="component-icon">{icon}</span>
    <span className="component-row-text"><span className="component-ref mono">{title}</span><span className="component-value">{sub}</span></span>
    {annotated && <StickyNote size={12} className="note-dot" aria-label={T.noteMark} />}{side}
  </button>;
}

export function SearchResults({ api, ctl, className = '' }: { api: WorkspaceApi; ctl: SearchController; className?: string }) {
  const { state } = api;
  const annotated = useMemo(() => annotatedComponentIds(state.board, state.notes), [state.board, state.notes]);
  const sch = state.probe.schematic;
  const isSelected = (row: SearchRow) => {
    switch (row.source) {
      case 'board-components': return state.selection.componentId === row.componentId;
      case 'board-nets': return state.selection.net === row.name;
      case 'schematic-symbols': return sch?.documentId === row.documentId && sch.selection.symbolKey === symbolKey(row.instancePath, row.symbolId);
      case 'schematic-nets': return sch?.documentId === row.documentId && sch.selection.netId === row.netId;
      default: return false;
    }
  };
  if (!ctl.items.length) {
    return <div className={'no-results ' + className} role="status" data-testid="search-empty"><Search size={24} /><p>{ctl.pending ? T.searching : T.noMatch}</p></div>;
  }
  const activeItem = ctl.items.findIndex(item => item.kind === 'row' && item.index === ctl.active);
  return <VirtualList items={ctl.items} itemHeight={heightOf} resetKey={ctl.identity} scrollToIndex={activeItem} role="listbox" id="wsp-results" label={T.results} className={'wsp-result-list ' + className}
    itemKey={(item, i) => item.kind === 'header' ? 'h:' + item.source : rowKey(item.row) + ':' + i}
    render={item => item.kind === 'header'
      ? <div className="wsp-group-header" role="presentation" data-source={item.source}><span>{GROUP_LABEL[item.source]}</span><span className="mono">{item.truncated ? T.more(item.shown, item.total) : item.total}</span></div>
      : <ResultRow row={item.row} index={item.index} active={item.index === ctl.active} selected={isSelected(item.row)} query={ctl.query} annotated={item.row.source === 'board-components' && annotated.has(item.row.componentId)} onActivate={ctl.activate} />} />;
}

const ComponentRow = memo(function ComponentRow({ component, selected, annotated, compact, onLocate }: { component: BoardComponent; selected: boolean; annotated: boolean; compact?: boolean; onLocate: (id: string) => void }) {
  const { t } = useUi();
  return <button type="button" className={'component-row' + (selected ? ' selected' : '') + (compact ? ' compact' : '')} onClick={() => onLocate(component.id)} aria-pressed={selected} data-testid="component-row"
    title={t('list.rowTitle', { ref: component.ref, value: component.value || t(kindKey(component)), side: t(sideLabelKey(component.side)) })}>
    <span className="component-icon"><PartIcon component={component} /></span><span className="component-row-text"><span className="component-ref mono">{component.ref}</span><span className="component-value">{component.value || t(kindKey(component))}</span></span>
    {annotated && <StickyNote size={12} className="note-dot" aria-label={T.noteMark} />}<span className="side-badge">{t(sideBadgeKey(component.side))}</span>
  </button>;
});

export function ComponentList({ api, side, allSides, resetKey }: { api: WorkspaceApi; side: ViewSide; allSides: boolean; resetKey: string }) {
  const { state, actions } = api;
  // The index sorts once per board and side (natural reference order); a side switch no longer re-sorts the whole board.
  const index = indexOfState(state);
  const components = useMemo(() => index?.componentsInOrder(allSides ? undefined : side) ?? [], [index, side, allSides]);
  const annotated = useMemo(() => annotatedComponentIds(state.board, state.notes), [state.board, state.notes]);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const locate = useCallback((id: string) => actionsRef.current.selectComponent(id, { center: true, origin: 'search' }), []);
  const selectedIndex = components.findIndex(component => component.id === state.selection.componentId);
  return <VirtualList items={components} itemHeight={46} resetKey={resetKey} scrollToIndex={selectedIndex} className="component-list" label="Components"
    itemKey={component => component.id} render={component => <ComponentRow component={component} selected={component.id === state.selection.componentId} annotated={annotated.has(component.id)} onLocate={locate} />} />;
}

export interface SearchPanelProps { api: WorkspaceApi; side: ViewSide; allSides: boolean; onAllSides(value: boolean): void; onRecents(): void; inputRef: RefObject<HTMLInputElement | null>; onActivated(row: SearchRow): void }

export function SearchPanel({ api, side, allSides, onAllSides, onRecents, inputRef, onActivated }: SearchPanelProps) {
  const { t, fmt } = useUi();
  const ctl = useSearchController(api, inputRef, onActivated);
  const searching = ctl.query.trim().length > 0;
  const board = api.state.board;
  const count = searching ? ctl.rows.length : indexOfState(api.state)?.componentsInOrder(allSides ? undefined : side).length ?? 0;
  return <aside className="search-panel" aria-label={t('panel.components')}>
    <div className="pane-title"><span>{searching ? T.results : t('panel.components')}</span><span className="mono" data-testid="search-count">{fmt.count(count)}</span></div>
    <SearchField ctl={ctl} inputRef={inputRef} />
    <div className="search-options">
      <label>{!searching && <><input type="checkbox" checked={allSides} onChange={e => onAllSides(e.target.checked)} />{t('side.bothLabel')}</>}</label>
      <button type="button" onClick={onRecents} title={t('search.recentFiles')} aria-label={t('search.recentFiles')}><Clock3 size={15} /></button>
    </div>
    {searching
      ? <SearchResults api={api} ctl={ctl} />
      : <><div className="list-heading"><span>{t('list.heading.reference')}</span><span>{t('list.heading.side')}</span></div><ComponentList api={api} side={side} allSides={allSides} resetKey={`${board?.name}|${side}|${allSides}`} /></>}
    <div className="sidebar-foot"><span>{t(side === 'top' ? 'side.topLabel' : 'side.bottomLabel')}</span><span className="mono">{board ? t('unit.total', { count: board.components.length }) : ''}</span></div>
  </aside>;
}

/** Focus layout: the same search as a floating box over the canvas. */
export function FocusSearch({ api, inputRef, onActivated }: { api: WorkspaceApi; inputRef: RefObject<HTMLInputElement | null>; onActivated(row: SearchRow): void }) {
  const { t } = useUi();
  const ctl = useSearchController(api, inputRef, onActivated);
  return <div className="focus-search">
    <SearchField ctl={ctl} inputRef={inputRef} />
    {ctl.query.trim() && <div className="focus-search-results"><div className="list-heading"><span>{t('unit.results', { count: ctl.rows.length })}</span><span>{t('list.heading.side')}</span></div><SearchResults api={api} ctl={ctl} className="focus-result-list" /></div>}
  </div>;
}
