import { AlertTriangle, CircuitBoard, FileQuestion, Link2, Paperclip } from 'lucide-react';
import { useMemo } from 'react';
import type { DocumentRuntime, WorkspaceApi } from '../../app/api';
import { SchematicOverlayContext } from '../SchematicOverlay';
import { BoardMappingBanner, BoardNetBanner } from './InspectorSections';
import { DocumentList, StatusChip } from './DocumentList';
import { DocumentViewer } from './DocumentViewer';
import type { ViewerChrome } from './DocumentViewer';
import { Tool } from './ui';
import './workspace.css';

// i18n: pending
const T = {
  schematicTitle: 'Schematic', pick: 'Schematic document', pickDocument: 'Document shown in this pane',
  emptyTitle: 'No schematic attached', emptyHint: 'Attach a KiCad schematic (.kicad_sch, KiCad 6 or newer), a legacy KiCad .sch or an EAGLE .sch. Hierarchical sheets and symbol libraries are read only from the SAME folder as the schematic you pick, so keep them together.',
  attach: 'Attach a schematic…', attachDocs: 'Attach documents…', diagnostics: 'Diagnostics', parser: 'parser', connectivity: 'connectivity', none: 'No parser or connectivity problems reported.',
  unresolved: 'Sheet files that could not be read', unresolvedHint: 'Their content is not shown and not part of the connectivity. Put the file in the same folder as the schematic and attach it again.',
  sheets: (n: number) => `${n} sheet${n === 1 ? '' : 's'}`, parts: (n: number) => `${n} part${n === 1 ? '' : 's'}`, nets: (n: number) => `${n} net${n === 1 ? '' : 's'}`,
  warnings: (n: number) => `${n} warning${n === 1 ? '' : 's'}`, errors: (n: number) => `${n} error${n === 1 ? '' : 's'}`,
  linkPanel: 'Link and aliases', linkPanelHint: 'Compare the board with this schematic and confirm aliases for names that differ', noDoc: 'Select a document in the list.', emptyPane: 'Nothing to show here yet. Attach a document or pick one above.', hasNone: 'No documents',
};

function Diagnostics({ doc }: { doc: DocumentRuntime }) {
  const design = doc.design;
  const info = useMemo(() => {
    if (!design) return null;
    const { schematic, connectivity } = design;
    const all = [...schematic.diagnostics.map(d => ({ ...d, from: T.parser })), ...connectivity.diagnostics.map(d => ({ ...d, from: T.connectivity }))];
    const unresolved = schematic.defs.flatMap(def => def.sheetRefs.filter(ref => ref.defId === null).map(ref => ({ sheet: def.name, name: ref.name, file: ref.file })));
    const parts = schematic.defs.reduce((sum, def) => sum + def.symbols.filter(s => !s.virtual && !s.power).length, 0);
    return { all, parserCount: schematic.diagnostics.length, connectivityCount: connectivity.diagnostics.length, unresolved, parts, errors: all.filter(d => d.severity === 'error').length, warnings: all.filter(d => d.severity === 'warning').length, sheets: schematic.instances.length, nets: connectivity.nets.length, label: schematic.formatLabel };
  }, [design]);
  if (!info) return null;
  return <details className="wsp-diag" data-testid="schematic-diagnostics">
    <summary><span className="wsp-diag-label">{T.diagnostics}</span><span className="wsp-diag-counts mono"><span>{info.label}</span><span>{T.sheets(info.sheets)}</span><span>{T.parts(info.parts)}</span><span>{T.nets(info.nets)}</span><span>{T.parser} {info.parserCount}</span><span>{T.connectivity} {info.connectivityCount}</span>
      <span className={info.errors ? 'bad' : info.warnings ? 'warn' : 'ok'}>{info.errors ? T.errors(info.errors) : T.warnings(info.warnings)}</span></span></summary>
    <div className="wsp-diag-body">
      {info.unresolved.length > 0 && <div className="wsp-unresolved" data-testid="unresolved-sheets"><strong><AlertTriangle size={13} />{T.unresolved}</strong><p>{T.unresolvedHint}</p><ul>{info.unresolved.map((u, i) => <li key={i} className="mono">{u.file} <span className="muted">({u.name})</span></li>)}</ul></div>}
      {info.all.length === 0 ? <p className="empty-caption">{T.none}</p> : <ul className="wsp-diag-list">{info.all.slice(0, 80).map((d, i) => <li key={i} data-severity={d.severity}><span className="mono">{d.code}</span><span>{d.message}</span><span className="muted">{d.from}</span></li>)}</ul>}
      {info.all.length > 80 && <p className="muted">+{info.all.length - 80}</p>}
    </div>
  </details>;
}

type Candidates = NonNullable<WorkspaceApi['state']['probe']['boardMapping'] | WorkspaceApi['state']['probe']['boardNetMapping']>;
/** Only an ambiguous or missing counterpart needs the technician; a unique one renders nothing. */
export const needsBanner = (mapping: Pick<Candidates, 'status'> | null) => !!mapping && mapping.status !== 'unique';

/**
 * Board-candidate banners of the Schematic tab. They are drawn OVER the schematic stage (SchematicOverlay), never in the layout flow:
 * inserting them above the canvas re-fitted the sheet under the pointer, so a second click on the same wire hit nothing (W-fin-crossprobe-01).
 */
export function SchematicBanners({ mapping, netMapping, actions, onLink }: { mapping: WorkspaceApi['state']['probe']['boardMapping']; netMapping: WorkspaceApi['state']['probe']['boardNetMapping']; actions: WorkspaceApi['actions']; onLink(): void }) {
  return <>
    <BoardMappingBanner mapping={mapping} onChoose={index => actions.chooseBoardTarget(index)} />
    <BoardNetBanner mapping={netMapping} onChoose={index => actions.chooseBoardNet(index)} onLink={onLink} />
  </>;
}

/** What the Schematic tab hands to the viewer's overlay slot: the banners while a counterpart needs a decision, otherwise nothing (null keeps the slot empty). */
export const schematicOverlay = (mapping: WorkspaceApi['state']['probe']['boardMapping'], netMapping: WorkspaceApi['state']['probe']['boardNetMapping'], actions: WorkspaceApi['actions'], onLink: () => void) =>
  needsBanner(mapping) || needsBanner(netMapping) ? <SchematicBanners mapping={mapping} netMapping={netMapping} actions={actions} onLink={onLink} /> : null;

export interface SchematicTabProps { api: WorkspaceApi; shownId: string | null; chrome: ViewerChrome; onPick(id: string): void; onAttach(): void; onLink(): void }
export function SchematicTab({ api, shownId, chrome, onPick, onAttach, onLink }: SchematicTabProps) {
  const docs = api.state.documents.filter(doc => doc.record.kind === 'schematic');
  const shown = docs.find(doc => doc.record.id === shownId) ?? docs[0];
  const { boardMapping, boardNetMapping } = api.state.probe;
  const { actions } = api;
  // A stable element (null when there is nothing to ask) so the viewer re-renders only when a mapping actually changes.
  const overlay = useMemo(() => schematicOverlay(boardMapping, boardNetMapping, actions, onLink), [boardMapping, boardNetMapping, actions, onLink]);
  if (!shown) {
    return <section className="wsp-empty" data-testid="schematic-empty" aria-label={T.schematicTitle}><CircuitBoard size={34} /><h2>{T.emptyTitle}</h2><p>{T.emptyHint}</p>
      <button type="button" className="primary-button" data-testid="attach-schematic" onClick={onAttach}><Paperclip size={15} />{T.attach}</button></section>;
  }
  return <section className="wsp-tab" aria-label={T.schematicTitle} data-testid="schematic-tab">
    <div className="wsp-toolbar">
      <label className="wsp-select"><span className="wsp-visually-hidden">{T.pick}</span>
        <select value={shown.record.id} aria-label={T.pick} data-testid="schematic-picker" onChange={e => onPick(e.target.value)}>
          {docs.map(doc => <option key={doc.record.id} value={doc.record.id}>{doc.record.name}{doc.status !== 'ready' ? ` (${doc.status})` : ''}</option>)}
        </select></label>
      <StatusChip status={shown.status} />
      <button type="button" className="outline-button" onClick={onAttach}><Paperclip size={14} />{T.attach}</button>
      <button type="button" className="outline-button" data-testid="open-link-panel" title={T.linkPanelHint} onClick={onLink}><Link2 size={14} />{T.linkPanel}</button>
    </div>
    <Diagnostics doc={shown} />
    <div className="wsp-tab-body"><SchematicOverlayContext.Provider value={overlay}><DocumentViewer key={shown.record.id} api={api} doc={shown} chrome={chrome} focusNonce={0} /></SchematicOverlayContext.Provider></div>
  </section>;
}

export interface DocumentsTabProps { api: WorkspaceApi; selectedId: string | null; chrome: ViewerChrome; layout: 'aside' | 'strip'; focusNonce: number; onSelect(id: string): void; onAttach(): void; onExport(): void }
export function DocumentsTab({ api, selectedId, chrome, layout, focusNonce, onSelect, onAttach, onExport }: DocumentsTabProps) {
  const doc = api.state.documents.find(candidate => candidate.record.id === selectedId) ?? api.state.documents[0];
  return <section className="wsp-tab wsp-documents" data-layout={layout} aria-label="Documents" data-testid="documents-tab">
    <DocumentList api={api} selectedId={doc?.record.id ?? null} onSelect={onSelect} onAttach={onAttach} onExport={onExport} layout={layout} />
    <div className="wsp-tab-body">{doc ? <DocumentViewer key={doc.record.id} api={api} doc={doc} chrome={chrome} focusNonce={focusNonce} /> : <div className="wsp-empty"><FileQuestion size={30} /><p>{T.emptyPane}</p></div>}</div>
  </section>;
}

/** Right pane of the split view while the Board tab is active: one selected schematic or document with a compact picker. */
export function SplitDocumentPane({ api, selectedId, chrome, focusNonce, onPick, onAttach }: { api: WorkspaceApi; selectedId: string | null; chrome: ViewerChrome; focusNonce: number; onPick(id: string): void; onAttach(): void }) {
  const docs = api.state.documents;
  const doc = docs.find(candidate => candidate.record.id === selectedId) ?? docs[0];
  return <section className="wsp-tab wsp-splitdoc" aria-label={T.pickDocument} data-testid="split-document-pane">
    <div className="wsp-toolbar">
      <label className="wsp-select"><span className="wsp-visually-hidden">{T.pickDocument}</span>
        <select value={doc?.record.id ?? ''} disabled={!doc} aria-label={T.pickDocument} data-testid="split-picker" onChange={e => onPick(e.target.value)}>
          {docs.length === 0 && <option value="">{T.hasNone}</option>}
          {docs.map(d => <option key={d.record.id} value={d.record.id}>{d.record.kind === 'schematic' ? 'Schematic: ' : d.record.kind === 'pdf' ? 'PDF: ' : 'Image: '}{d.record.name}{d.status !== 'ready' ? ` (${d.status})` : ''}</option>)}
        </select></label>
      {doc && <StatusChip status={doc.status} />}
      <Tool label={T.attachDocs} testId="split-attach" onClick={onAttach}><Paperclip size={16} /></Tool>
    </div>
    <div className="wsp-tab-body">{doc ? <DocumentViewer key={doc.record.id} api={api} doc={doc} chrome={chrome} focusNonce={focusNonce} /> : <div className="wsp-empty"><FileQuestion size={30} /><p>{T.emptyPane}</p></div>}</div>
  </section>;
}
