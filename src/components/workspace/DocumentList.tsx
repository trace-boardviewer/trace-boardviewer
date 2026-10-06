import { CircuitBoard, FileImage, FileText, Paperclip, PackageOpen, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useState } from 'react';
import type { DocumentRuntime, DocumentStatus, WorkspaceApi } from '../../app/api';
import { Tool, usePdfSnapshot } from './ui';
import './workspace.css';

// i18n: pending
const T = {
  title: 'Documents', attach: 'Attach…', empty: 'No documents yet', emptyHint: 'Attach schematics (KiCad, EAGLE), PDFs such as datasheets or circuit diagrams, and board photos. You can also drop files anywhere in the window. Files stay where they are; TRACE remembers them by content.',
  list: 'Attached documents', sessionOnly: 'Browser mode: this workspace is not saved. Documents, notes and bookmarks are lost when the page closes.', remove: 'Remove', confirmRemove: 'Remove?', yes: 'Yes', no: 'Keep',
  relink: 'Relink', accept: 'Accept change', scanOnly: 'scan only', export: 'Export…', pages: (n: number) => `${n} page${n === 1 ? '' : 's'}`,
  kind: { pdf: 'PDF', image: 'Image', schematic: 'Schematic' },
};
export const STATUS_LABEL: Record<DocumentStatus, string> = { loading: 'Loading', ready: 'Ready', missing: 'Missing', changed: 'Changed', unreadable: 'Unreadable', error: 'Error' };

const formatBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export function StatusChip({ status }: { status: DocumentStatus }) {
  return <span className="wsp-status-chip" data-status={status} data-testid="status-chip">{STATUS_LABEL[status]}</span>;
}

function KindIcon({ kind }: { kind: DocumentRuntime['record']['kind'] }) {
  return kind === 'pdf' ? <FileText size={16} /> : kind === 'image' ? <FileImage size={16} /> : <CircuitBoard size={16} />;
}

function Row({ api, doc, selected, onSelect }: { api: WorkspaceApi; doc: DocumentRuntime; selected: boolean; onSelect(id: string): void }) {
  const { actions } = api;
  const { record } = doc;
  const [confirming, setConfirming] = useState(false);
  const snapshot = usePdfSnapshot(doc.pdf);
  const meta = [T.kind[record.kind], record.pageCount ? T.pages(record.pageCount) : '', formatBytes(record.size)].filter(Boolean).join(' · ');
  const extra = doc.status === 'missing' || doc.status === 'changed' || confirming;
  return <li className={'wsp-doc' + (selected ? ' selected' : '')} data-status={doc.status} data-testid="document-row">
    <div className="wsp-doc-line">
      <button type="button" className="wsp-doc-main" aria-current={selected} onClick={() => onSelect(record.id)} title={record.path || record.name}>
        <span className="component-icon"><KindIcon kind={record.kind} /></span>
        <span className="component-row-text"><span className="wsp-doc-title" title={record.name}>{record.name}</span><span className="component-value">{meta}{snapshot?.searchable === false && <em className="wsp-chip warn"> {T.scanOnly}</em>}</span></span>
        <StatusChip status={doc.status} />
      </button>
      <button type="button" className="tool-button" aria-label={`${T.remove}: ${record.name}`} data-testid="remove-document" onClick={() => setConfirming(true)}><Trash2 size={14} /></button>
    </div>
    {extra && <span className="wsp-doc-actions">
      {doc.status === 'missing' && <button type="button" className="outline-button" data-testid="relink-row" onClick={() => void actions.relinkDocument(record.id)}>{T.relink}</button>}
      {doc.status === 'changed' && <button type="button" className="outline-button" data-testid="accept-row" onClick={() => void actions.acceptChangedDocument(record.id)}>{T.accept}</button>}
      {confirming && <><span className="wsp-confirm">{T.confirmRemove}</span><button type="button" className="text-button danger" data-testid="remove-confirm" onClick={() => { setConfirming(false); actions.removeDocument(record.id); }}>{T.yes}</button><button type="button" className="text-button" onClick={() => setConfirming(false)}>{T.no}</button></>}
    </span>}
  </li>;
}

export interface DocumentListProps {
  api: WorkspaceApi;
  selectedId: string | null;
  onSelect(id: string): void;
  onAttach(): void;
  onExport(): void;
  /** 'aside' = full list for the Documents tab; 'strip' = one compact row for narrow panes. */
  layout: 'aside' | 'strip';
}

export function DocumentList({ api, selectedId, onSelect, onAttach, onExport, layout }: DocumentListProps) {
  const { state } = api;
  const docs = state.documents;
  const notice = state.persistence === 'session-only' && <p className="wsp-persist" role="note" data-testid="session-only"><TriangleAlert size={13} />{T.sessionOnly}</p>;
  if (layout === 'strip') {
    // W-win-viewers-03: the controls sit OUTSIDE the chip list so they never scroll away, and the chips wrap instead of scrolling sideways.
    return <div className="wsp-docstrip" data-testid="document-strip" role="group" aria-label={T.list}>
      <div className="wsp-docstrip-actions">
        <Tool label="Attach documents" testId="attach" onClick={onAttach}><Paperclip size={16} /></Tool>
        {docs.length > 0 && <Tool label={T.export} testId="export-open" onClick={onExport}><Upload size={16} /></Tool>}
      </div>
      <ul className="wsp-docstrip-chips">{docs.map(doc => <li key={doc.record.id}><button type="button" className={'wsp-docchip' + (doc.record.id === selectedId ? ' selected' : '')} aria-current={doc.record.id === selectedId} data-status={doc.status} onClick={() => onSelect(doc.record.id)} title={doc.record.name}>
        <KindIcon kind={doc.record.kind} /><span>{doc.record.name}</span><StatusChip status={doc.status} /></button></li>)}</ul>
    </div>;
  }
  return <aside className="wsp-doclist" aria-label={T.title} data-testid="document-list">
    <div className="pane-title"><span>{T.title}</span><span className="mono">{docs.length}</span></div>
    <div className="wsp-doclist-actions">
      <button type="button" className="primary-button" data-testid="attach" aria-label="Attach documents" onClick={onAttach}><Paperclip size={15} />{T.attach}</button>
      <button type="button" className="outline-button" data-testid="export-open" disabled={!docs.length} onClick={onExport}><Upload size={14} />{T.export}</button>
    </div>
    {notice}
    {docs.length === 0 ? <div className="wsp-doc-empty"><PackageOpen size={30} /><h3>{T.empty}</h3><p>{T.emptyHint}</p></div>
      : <ul className="wsp-doc-items" aria-label={T.list}>{docs.map(doc => <Row key={doc.record.id} api={api} doc={doc} selected={doc.record.id === selectedId} onSelect={onSelect} />)}</ul>}
  </aside>;
}
