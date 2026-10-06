import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { WorkspaceExportResult } from '../../lib/documents';
import { STATUS_LABEL } from './DocumentList';
import { Modal } from './ui';
import { useUi } from './ui-context';

// i18n: pending
const T = {
  title: 'Export workspace', intro: 'Choose exactly what goes into the bundle. Nothing is included unless it is ticked here; the originals are never modified.',
  documents: 'Documents', none: 'No documents are attached.', board: 'Include the board file', boardHint: 'The board file may be private or proprietary. Leave it out when you share the bundle.',
  notes: 'Include notes', notesHint: 'Technician notes and measurements of this board.', summary: (docs: number, board: boolean, notes: boolean) => `${docs} document${docs === 1 ? '' : 's'}, board file: ${board ? 'yes' : 'no'}, notes: ${notes ? 'yes' : 'no'}`,
  nothing: 'Tick at least one item to export.', export: 'Export…', exporting: 'Exporting…', done: (r: WorkspaceExportResult) => `Saved ${r.files} file${r.files === 1 ? '' : 's'} (${(r.bytes / 1048576).toFixed(1)} MB) to ${r.path}`, cancelled: 'Export cancelled. Nothing was written.',
  sessionOnly: 'Browser mode: the workspace is not saved. The export reads what is in memory right now.', selectAll: 'Tick all', clearAll: 'Clear',
};

export function ExportDialog({ api, onClose }: { api: WorkspaceApi; onClose(): void }) {
  const { t } = useUi();
  const { state, actions } = api;
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [board, setBoard] = useState(false);
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const docs = state.documents;
  const toggle = (id: string) => setIds(prev => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; });
  const empty = ids.size === 0 && !board && !notes;
  const run = async () => {
    if (busy || empty) return;
    setBusy(true); setResult(null);
    const done = await actions.exportWorkspace({ documentIds: docs.map(d => d.record.id).filter(id => ids.has(id)), includeBoard: board, includeNotes: notes });
    setBusy(false); setResult(done ? T.done(done) : T.cancelled);
  };
  return <Modal title={T.title} closeLabel={t('common.close')} wide testId="export-dialog" close={() => { if (!busy) onClose(); }}>
    <p className="settings-hint wsp-export-intro">{T.intro}</p>
    {state.persistence === 'session-only' && <p className="wsp-persist" role="note"><TriangleAlert size={13} />{T.sessionOnly}</p>}
    <fieldset className="wsp-export-set" disabled={busy}><legend>{T.documents}</legend>
      {docs.length === 0 ? <p className="empty-caption">{T.none}</p> : <>
        <div className="wsp-export-bulk"><button type="button" className="text-button" onClick={() => setIds(new Set(docs.map(d => d.record.id)))}>{T.selectAll}</button><button type="button" className="text-button" onClick={() => setIds(new Set())}>{T.clearAll}</button></div>
        {docs.map(doc => <label key={doc.record.id} className="wsp-export-row"><input type="checkbox" data-testid="export-doc" checked={ids.has(doc.record.id)} onChange={() => toggle(doc.record.id)} /><span className="wsp-doc-title">{doc.record.name}</span><span className="wsp-export-status" data-status={doc.status}>{STATUS_LABEL[doc.status]}</span></label>)}
      </>}
    </fieldset>
    <fieldset className="wsp-export-set" disabled={busy}>
      <label className="wsp-export-row"><input type="checkbox" data-testid="export-board" checked={board} onChange={e => setBoard(e.target.checked)} /><span><strong>{T.board}</strong><small>{T.boardHint}</small></span></label>
      <label className="wsp-export-row"><input type="checkbox" data-testid="export-notes" checked={notes} onChange={e => setNotes(e.target.checked)} /><span><strong>{T.notes}</strong><small>{T.notesHint}</small></span></label>
    </fieldset>
    {result && <p className="wsp-export-result" role="status" data-testid="export-result">{result}</p>}
    <div className="modal-footer"><span className="muted" data-testid="export-summary">{empty ? T.nothing : T.summary(ids.size, board, notes)}</span>
      <button type="button" className="primary-button" data-testid="export-run" disabled={busy || empty} onClick={() => void run()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? T.exporting : T.export}</button></div>
  </Modal>;
}
