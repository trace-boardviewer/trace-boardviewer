import { AlertCircle, Check, LoaderCircle, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { NoteTarget } from '../../lib/workspace';
import { MEASUREMENT_FIELDS, MEASUREMENT_MAX, NOTE_TEXT_MAX, noteMatches, noteOf, normalizeMeasurements } from './model';
import type { Measurements } from './model';
import { Modal } from './ui';
import { useUi } from './ui-context';

// i18n: pending
const T = {
  title: (what: string) => `Note: ${what}`, component: 'component', pin: (n: string) => `pin ${n}`,
  textLabel: 'Note', textPlaceholder: 'What did you find, replace or check?',
  measurements: 'Measured values (typed by you; TRACE never fills these in)',
  voltage: 'Voltage', resistance: 'Resistance', other: 'Other', voltageHint: 'e.g. 1.8 V', resistanceHint: 'e.g. 0.4 Ω', otherHint: 'e.g. 12 mA, ripple 20 mVpp',
  counter: (n: number) => `${n} / ${NOTE_TEXT_MAX}`, blocked: 'Saved notes could not be read, so editing is locked to protect them: ',
  retry: 'Retry reading notes', failed: 'The note was not saved. Your text is kept here; fix the problem and press Save again.',
};
const FIELD_LABEL = { voltage: T.voltage, resistance: T.resistance, other: T.other } as const;
const FIELD_HINT = { voltage: T.voltageHint, resistance: T.resistanceHint, other: T.otherHint } as const;

export interface NoteDialogProps { api: WorkspaceApi; target: NoteTarget; onClose(): void }

/** Editor of ONE note (a component or one of its pins). It closes only after the saved list really contains the submitted note. */
export function NoteDialog({ api, target, onClose }: NoteDialogProps) {
  const { t, text } = useUi();
  const { state, actions } = api;
  const component = state.board?.components.find(c => c.id === target.componentId);
  const pin = target.pinId ? state.board?.pins.find(p => p.id === target.pinId) : undefined;
  const existing = noteOf(state.notes, target.componentId, target.pinId);
  const [draft, setDraft] = useState(existing?.text ?? '');
  const [values, setValues] = useState<Record<(typeof MEASUREMENT_FIELDS)[number], string>>({ voltage: existing?.measurements?.voltage ?? '', resistance: existing?.measurements?.resistance ?? '', other: existing?.measurements?.other ?? '' });
  const [phase, setPhase] = useState<'edit' | 'saving' | 'failed'>('edit');
  const submitted = useRef<{ text: string; measurements?: Measurements } | null>(null);
  const blocked = state.notesBlocked;
  const [retrying, setRetrying] = useState(false);
  const what = `${component?.ref ?? '?'}${pin ? ` · ${T.pin(pin.number)}` : ''}`;
  const busy = phase === 'saving' || retrying;
  const existingRef = useRef(existing); existingRef.current = existing;
  // The shell closes the dialog once the stored note equals what was submitted; a failed write leaves it open with the text intact.
  useEffect(() => {
    if (submitted.current && noteMatches(existing, submitted.current)) { submitted.current = null; onClose(); }
  }, [existing, onClose]);
  const save = async (remove = false) => {
    if (busy || blocked) return;
    const payload = remove ? { text: '', measurements: undefined } : { text: draft, measurements: normalizeMeasurements(values) };
    submitted.current = payload; setPhase('saving');
    await actions.upsertNote(target, { text: payload.text, measurements: payload.measurements ?? null });
    // Saving identical content changes nothing (the effect never fires); otherwise a pending mismatch means the write failed.
    if (submitted.current && noteMatches(existingRef.current, submitted.current)) { submitted.current = null; onClose(); return; }
    setPhase(submitted.current ? 'failed' : 'edit');
  };
  const retry = async () => { setRetrying(true); try { await actions.retryNotes(); } finally { setRetrying(false); } };
  return <Modal title={T.title(what)} closeLabel={t('common.close')} initialFocus="#note-draft" testId="note-dialog" close={() => { if (!busy) onClose(); }}>
    {blocked && <p className="data-warning" role="alert"><AlertCircle size={16} /><span>{T.blocked}{text(blocked)}</span></p>}
    {phase === 'failed' && <p className="data-warning" role="alert"><AlertCircle size={16} /><span>{T.failed}</span></p>}
    <label className="note-label" htmlFor="note-draft">{T.textLabel}</label>
    <textarea id="note-draft" className="note-editor" placeholder={T.textPlaceholder} maxLength={NOTE_TEXT_MAX} value={draft} readOnly={!!blocked || busy} onChange={e => setDraft(e.target.value)} />
    <div className="note-counter mono">{T.counter(draft.length)}</div>
    <fieldset className="wsp-measure-fields" disabled={!!blocked || busy}><legend>{T.measurements}</legend>
      {MEASUREMENT_FIELDS.map(name => <label key={name}><span>{FIELD_LABEL[name]}</span>
        <input className="mono" data-testid={`measure-${name}`} value={values[name]} maxLength={MEASUREMENT_MAX} placeholder={FIELD_HINT[name]} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} autoComplete="off" spellCheck={false} /></label>)}
    </fieldset>
    <div className="modal-footer">
      {blocked && <button type="button" className="outline-button" disabled={retrying} onClick={() => void retry()}>{retrying ? <LoaderCircle className="spin" size={16} /> : <RotateCw size={16} />}{T.retry}</button>}
      {existing && <button type="button" className="text-button danger" data-testid="note-delete" disabled={busy || !!blocked} onClick={() => void save(true)}>{t('common.delete')}</button>}
      <button type="button" className="primary-button" data-testid="note-save" disabled={busy || !!blocked} onClick={() => void save()}>{phase === 'saving' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{t('common.save')}</button>
    </div>
  </Modal>;
}
