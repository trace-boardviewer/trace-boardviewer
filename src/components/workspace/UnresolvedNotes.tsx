import { Copy, StickyNote, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import type { WorkspaceApi } from '../../app/api';
import { unresolvedNotes } from '../../lib/note-keys';
import { MEASUREMENT_FIELDS } from './model';
import { describeNoteTarget, PROBLEM_TEXT } from './note-text';
import { Modal, Tool } from './ui';
import { useUi } from './ui-context';

const FIELD_TEXT = { voltage: 'notes.measureVoltage', resistance: 'notes.measureResistance', other: 'notes.measureOther' } as const;

/** The notes that are not attached to any component of the open board, with what each was attached to and why it is not any more. */
export function UnresolvedNotesList({ api }: { api: WorkspaceApi }) {
  const { t, fmt, copy } = useUi();
  const { state, actions } = api;
  const rows = useMemo(() => unresolvedNotes(state.board, state.notes), [state.board, state.notes]);
  if (rows.length === 0) return <p className="empty-caption" role="status" data-testid="unresolved-empty">{t('notes.unresolvedEmpty')}</p>;
  return <ul className="wsp-lostnotes" data-testid="unresolved-list">{rows.map(({ note, problem }) => <li key={note.id} className="wsp-card" data-testid="unresolved-note">
    <div className="wsp-lostnotes-head"><StickyNote size={13} /><span className="wsp-lostnotes-target"><span className="muted">{t('notes.wasAttachedTo')}</span> <strong className="mono" data-testid="unresolved-target">{describeNoteTarget(note, t, fmt)}</strong></span>
      <Tool label={t('notes.copyText')} testId="unresolved-copy" onClick={() => copy(note.text)}><Copy size={13} /></Tool>
      <Tool label={t('common.delete')} testId="unresolved-delete" onClick={() => void actions.removeNote(note.id)}><Trash2 size={13} /></Tool></div>
    <p className="wsp-reason" data-testid="unresolved-reason">{t(PROBLEM_TEXT[problem])}</p>
    {note.text && <p className="wsp-note-text" data-testid="unresolved-text">{note.text}</p>}
    {note.measurements && <dl className="wsp-measures">{MEASUREMENT_FIELDS.filter(name => note.measurements?.[name]).map(name => <div key={name}><dt>{t(FIELD_TEXT[name])}</dt><dd className="mono">{note.measurements?.[name]}</dd></div>)}</dl>}
  </li>)}</ul>;
}

/**
 * Notes that are not attached to any component of the open board: positional notes the one-time conversion could not place, and notes whose
 * reference or pin the board no longer has. They stay stored; here the technician sees the text and what the note was attached to, can copy the
 * text and, when done with it, delete the entry. Nothing is deleted without this explicit action.
 */
export function UnresolvedNotesDialog({ api, onClose }: { api: WorkspaceApi; onClose(): void }) {
  const { t } = useUi();
  return <Modal title={t('notes.unresolvedTitle')} closeLabel={t('common.close')} wide testId="unresolved-notes-dialog" close={onClose}>
    <p className="settings-hint">{t('notes.unresolvedIntro')}</p>
    <UnresolvedNotesList api={api} />
  </Modal>;
}
