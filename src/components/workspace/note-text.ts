import type { Formatters, MessageKey, Translator } from '../../lib/i18n';
import type { NoteFallback, NoteTargetFailure } from '../../lib/note-keys';
import type { BoardNote, NoteAnchor, NoteKey, NoteProblem } from '../../lib/types';

/** Catalog keys of the notes UI: how a fallback is disclosed, why a note cannot be saved, why a note is unresolved. */
export const FALLBACK_TEXT: Readonly<Record<NoteFallback, MessageKey>> = {
  'duplicate-reference': 'notes.fallbackDuplicateRef', 'unnamed-part': 'notes.fallbackUnnamedPart', 'unnamed-pin': 'notes.fallbackUnnamedPin',
};
/** Only the two refusals the technician can cause carry a message; an unknown id is a stale selection and shows the generic "not saved". */
export const REFUSAL_TEXT: Readonly<Partial<Record<NoteTargetFailure, MessageKey>>> = {
  'part-indistinguishable': 'notes.refusePart', 'pin-indistinguishable': 'notes.refusePin',
};
export const PROBLEM_TEXT: Readonly<Record<NoteProblem, MessageKey>> = {
  'component-missing': 'notes.reasonComponentMissing', 'component-ambiguous': 'notes.reasonComponentAmbiguous',
  'pin-missing': 'notes.reasonPinMissing', 'pin-ambiguous': 'notes.reasonPinAmbiguous',
  'legacy-id-missing': 'notes.reasonLegacyIdMissing', 'legacy-indistinguishable': 'notes.reasonLegacyIndistinguishable',
  'duplicate-target': 'notes.reasonDuplicateTarget',
};

const sideName = (t: Translator, side: NoteAnchor['side']) => t(side === 'top' ? 'side.top' : side === 'bottom' ? 'side.bottom' : 'side.both');
const place = (t: Translator, fmt: Formatters, anchor: NoteAnchor) => `${t('inspector.position')} ${fmt.mm(anchor.x)} · ${fmt.mm(anchor.y)} mm, ${sideName(t, anchor.side)}`;

/** What a key designates, in words: "Component U7 · Pin 3", "Component R1 (Position 12.50 · 4.00 mm, Top)". */
export function describeKey(key: NoteKey, t: Translator, fmt: Formatters): string {
  const part = key.ref === undefined ? `${t('notes.targetPart')} (${place(t, fmt, key.at!)})` : `${t('notes.targetPart')} ${key.ref}${key.at ? ` (${place(t, fmt, key.at)})` : ''}`;
  if (key.pin !== undefined) return `${part} · ${t('inspector.colPin')} ${key.pin}`;
  if (key.pinAt) return `${part} · ${t('inspector.colPin')} (${place(t, fmt, key.pinAt)})`;
  return part;
}
/** The old target of an unresolved note: its key, or for a positional note the ids it was saved with. */
export function describeNoteTarget(note: BoardNote, t: Translator, fmt: Formatters): string {
  if ('target' in note) return describeKey(note.target, t, fmt);
  return `${t('notes.targetPart')} ${note.componentId}${note.pinId === undefined ? '' : ` · ${t('inspector.colPin')} ${note.pinId}`}`;
}
