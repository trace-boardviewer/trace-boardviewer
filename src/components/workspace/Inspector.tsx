import { ChevronRight, Copy, Focus, Keyboard, StickyNote } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { PdfLinkHit, SchematicTarget } from '../../lib/crossprobe';
import type { BoardPin } from '../../lib/types';
import { indexOfState } from './model';
import type { NoteSubject } from '../../lib/note-keys';
import { BookmarksSection, DocumentsSection, NotesSection, SchematicNetSection, SchematicSection } from './InspectorSections';
import { naturalOrder, PartIcon, kindKey, sideKey, Tool, VirtualList } from './ui';
import { useUi } from './ui-context';
import { noteOf } from './model';
import { modifierLabels } from './shortcuts';

// i18n: pending
const T = { netOnly: 'Selected net', clear: 'Clear selection', pinSelected: (n: string) => `Pin ${n} selected` };

export interface InspectorProps {
  api: WorkspaceApi;
  floating: boolean;
  /** The document the technician is looking at (Documents tab or split pane): its bookmarks are listed here. */
  activeDocumentId: string | null;
  onLocate(): void;
  onEditNote(target: NoteSubject): void;
  onShowSchematic(target: SchematicTarget): void;
  /** Reveals the schematic document that holds the schematic net a board net resolved to. */
  onShowNet(documentId: string): void;
  /** Opens the board/schematic link and alias panel. */
  onLink(): void;
  onOpenHit(documentId: string, hit: PdfLinkHit): void;
  onOpenPage(documentId: string, page: number): void;
}

export function Inspector({ api, floating, activeDocumentId, onLocate, onEditNote, onShowSchematic, onShowNet, onLink, onOpenHit, onOpenPage }: InspectorProps) {
  const { t, fmt, copy } = useUi();
  const { mod } = modifierLabels();
  const { state, actions } = api;
  const { board, selection } = state;
  const actionsRef = useRef(actions); actionsRef.current = actions;
  // Every lookup goes through the board's shared index (no maps of its own).
  const index = indexOfState(state);
  const selected = selection.componentId ? index?.componentById.get(selection.componentId) ?? null : null;
  const selectedPin = selection.pinId ? index?.pinById.get(selection.pinId) ?? null : null;
  const selectedNet = selection.net;
  const pins = useMemo<readonly BoardPin[]>(() => (selected && index ? index.pinsOf(selected.id) : []), [selected, index]);
  const netPins = useMemo<readonly BoardPin[]>(() => (selectedNet && index ? index.pinsOfNet(selectedNet) : []), [selectedNet, index]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [selection.componentId]);
  const connected = useMemo(() => {
    if (!index || !netPins.length) return [];
    const tally = new Map<string, number>();
    for (const p of netPins) tally.set(p.componentId, (tally.get(p.componentId) || 0) + 1);
    return [...tally].map(([id, count]) => ({ component: index.componentById.get(id)!, pins: count })).filter(x => x.component).sort((a, b) => naturalOrder(a.component.ref, b.component.ref));
  }, [index, netPins]);
  const noteTarget: NoteSubject | null = selected ? { componentId: selected.id, ...(selectedPin ? { pinId: selectedPin.id } : {}) } : null;
  const hasNote = selected ? !!noteOf(board, state.notes, selected.id, selectedPin?.id) : false;

  // "{pins} · {components}" names the list as well as its toggle: with empty parameters the list was announced as " · ".
  const connectionSummary = selectedNet ? t('inspector.connections', { pins: t('unit.pins', { count: netPins.length }), components: t('unit.components', { count: connected.length }) }) : '';
  const netSection = selectedNet && <div className="net-section" data-testid="inspector-net">
    <div className="net-title"><span className="net-dot" /><strong className="mono" title={selectedNet}>{selectedNet}</strong><Tool label={t('inspector.copyNet')} onClick={() => copy(selectedNet)}><Copy size={13} /></Tool></div>
    <button type="button" className="connection-summary" aria-expanded={expanded || !selected} onClick={() => setExpanded(v => !v)}>{connectionSummary}<ChevronRight size={14} style={{ transform: expanded || !selected ? 'rotate(90deg)' : '' }} /></button>
    {(expanded || !selected) && <VirtualList items={connected} itemHeight={32} className="connection-list" resetKey={selectedNet} label={connectionSummary} itemKey={x => x.component.id}
      render={({ component, pins: count }) => <button type="button" className={'connection-row' + (component.id === selected?.id ? ' selected' : '')} onClick={() => actionsRef.current.selectComponent(component.id, { center: true, origin: 'inspector' })}><span className="mono">{component.ref}</span><span>{t('unit.pins', { count })}</span><span>{t(sideKey(component.side))}</span></button>} />}
  </div>;

  return <aside className={'inspector ' + (floating ? 'floating-inspector' : '')} aria-label={t('inspector.aria')} data-testid="inspector">
    <div className="pane-title"><span>{t('inspector.title')}</span><Focus size={15} /></div>
    {selected ? <div className="inspector-content" key={selected.id}>
      <div className="part-hero"><span className="part-hero-icon"><PartIcon component={selected} size={26} /></span><div className="part-hero-text"><div className="hero-ref mono" title={selected.ref} data-testid="hero-ref">{selected.ref}</div><div className="hero-kind">{t(kindKey(selected))}</div></div><Tool label={t('inspector.copyRef')} testId="copy-ref" className="hero-copy" onClick={() => copy(selected.ref)}><Copy size={14} /></Tool></div>
      {selected.value && <div className="part-value-full" title={selected.value}>{selected.value}</div>}
      <dl className="specs"><div><dt>{t('inspector.package')}</dt><dd title={selected.package}>{selected.package || '—'}</dd></div><div><dt>{t('inspector.side')}</dt><dd>{t(sideKey(selected.side))}</dd></div><div><dt>{t('inspector.position')}</dt><dd className="mono">{fmt.mm(selected.position.x)} · {fmt.mm(selected.position.y)} mm</dd></div><div><dt>{t('inspector.pins')}</dt><dd className="mono">{fmt.count(pins.length)}</dd></div></dl>
      <div className="selection-actions"><button type="button" className="outline-button locate-button" onClick={onLocate}><Focus size={15} />{t('inspector.locate')}</button><Tool label={t('common.note')} shortcut="N" testId="note-tool" active={hasNote} onClick={() => noteTarget && onEditNote(noteTarget)}><StickyNote size={16} /></Tool></div>
      <div className="section-heading">{t('inspector.pinsNets')}<span className="muted mono">{fmt.count(pins.length)}</span></div>
      <div className="pin-table-header"><span>{t('inspector.colPin')}</span><span>{t('inspector.colSignal')}</span><span>{t('inspector.colNet')}</span></div>
      {pins.length ? <VirtualList items={pins} itemHeight={34} scrollToIndex={pins.findIndex(p => p.id === selectedPin?.id)} resetKey={selected.id} className="pin-list" style={{ height: Math.min(pins.length * 34, 6 * 34), minHeight: 0, maxHeight: 'none' }} label={t('inspector.pinsNets')} itemKey={p => p.id}
        render={(p: BoardPin) => <button type="button" className={'pin-row' + (p.id === selectedPin?.id ? ' selected' : '') + (p.net && p.net === selectedNet ? ' linked' : '')} data-testid="pin-row" onClick={() => actionsRef.current.selectPin(p.id, { origin: 'inspector' })} aria-pressed={p.id === selectedPin?.id} title={t('inspector.pinTitle', { number: p.number, name: p.name || '—', net: p.net || t('canvas.noNet') })}><span>{p.number}</span><span>{p.name || '—'}</span><span>{p.net || '—'}</span></button>} /> : <p className="empty-caption">{t('inspector.noPinData')}</p>}
      {netSection}
      <SchematicSection api={api} componentId={selected.id} pinNumber={selectedPin?.number ?? null} pinId={selectedPin?.id ?? null} onShow={onShowSchematic} onLink={onLink} />
      <DocumentsSection api={api} refName={state.probe.documentRef ?? selected.ref} onOpen={onOpenHit} />
      <NotesSection api={api} componentRef={selected.ref} componentId={selected.id} pinId={selectedPin?.id ?? null} pinNumber={selectedPin?.number ?? null} onEdit={onEditNote} />
      <BookmarksSection api={api} documentId={activeDocumentId} onOpen={onOpenPage} />
    </div> : selectedNet ? <div className="inspector-content" key={'net:' + selectedNet}>
      <div className="section-heading">{T.netOnly}</div>{netSection}
      <SchematicNetSection api={api} onShow={onShowNet} onLink={onLink} />
      <BookmarksSection api={api} documentId={activeDocumentId} onOpen={onOpenPage} />
    </div> : <div className="inspector-empty"><Focus size={32} /><h3>{t('inspector.emptyTitle')}</h3><p>{t('inspector.emptyText')}</p><span className="empty-shortcut"><Keyboard size={13} />{mod} + F</span>
      {activeDocumentId && <div className="wsp-empty-extra"><BookmarksSection api={api} documentId={activeDocumentId} onOpen={onOpenPage} /></div>}</div>}
  </aside>;
}
