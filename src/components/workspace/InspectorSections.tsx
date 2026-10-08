import { AlertTriangle, ArrowUpRight, Bookmark, CircuitBoard, FileText, Link2, Pencil, Plus, RotateCw, ScanLine, StickyNote, Trash2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { DocumentRuntime, WorkspaceApi } from '../../app/api';
import type { BoardNetTarget, BoardTarget, Mapping, MappingReason, PdfLinkHit, PdfRefLink, PinLinkRow, PinStatus, RefLinkRow, SchematicNetTarget, SchematicTarget } from '../../lib/crossprobe';
import type { BoardNote } from '../../lib/types';
import { noteKeyIndex } from '../../lib/note-keys';
import type { NoteSubject, NoteTargetResult } from '../../lib/note-keys';
import { MEASUREMENT_FIELDS, noteOf } from './model';
import { FALLBACK_TEXT, REFUSAL_TEXT } from './note-text';
import { usePdfSnapshot } from './ui';
import { useUi } from './ui-context';

// i18n: pending
const T = {
  schematic: 'Schematic', documents: 'Documents', notes: 'Notes', bookmarks: 'Bookmarks',
  noSchematic: 'No schematic is attached, so nothing can be cross-probed. Attach a KiCad or EAGLE schematic in the Documents tab.',
  attach: 'Attach documents',
  notResolved: 'The schematic counterpart is not resolved yet.',
  unique: 'Linked to one schematic part', ambiguous: 'Several schematic candidates: choose one explicitly', missing: 'No schematic counterpart found. Nothing is guessed.',
  sheet: 'Sheet', part: 'Part', pin: 'Pin', net: 'Net', linkStatus: 'Link', show: 'Show in schematic', choose: 'Use this candidate',
  viaAlias: 'via confirmed alias', viaCase: 'differs only in letter case', autoNamed: 'auto-named net', noConnect: 'no-connect marker', netConflict: 'the schematic pin touches several nets',
  flagged: 'Flagged (letter case differs, not linked):', moreCandidates: (shown: number, total: number) => `Showing ${shown} of ${total} candidates.`,
  disagreements: 'Board and schematic disagree', pinsCompared: (m: number) => `${m} pin${m === 1 ? '' : 's'} matched`,
  boardNet: 'board net', schNet: 'schematic net', none: 'none',
  linkTruncated: 'The comparison list was truncated.',
  hits: (n: number) => `${n} occurrence${n === 1 ? '' : 's'}`, page: (n: number) => `Page ${n}`, go: 'Go to', chooseHit: 'choose the one to open.',
  noHit: 'No exact match in this document.', scanOnly: 'Scan-only PDF: no text layer, so no text can be matched.', scanning: 'Indexing text…', truncatedScan: 'The text scan was cut by its budget: results may be incomplete.',
  severalParts: 'Several board parts carry this reference: choose the part on the board first.', caseOnly: 'Differs only in letter case (not linked):',
  noDocs: 'No PDF is attached.', noRef: 'Select a component to see where it appears in the attached PDFs.',
  noteFor: (what: string) => `Note for ${what}`, addNote: (what: string) => `Add a note to ${what}`, edit: 'Edit note', technician: 'Technician-entered, not an inferred measurement.',
  voltage: 'Voltage', resistance: 'Resistance', other: 'Other', component: 'component', pinWord: (n: string) => `pin ${n}`,
  blocked: 'Notes are locked because the saved notes could not be read. Nothing is overwritten.', retry: 'Retry reading notes',
  noBookmarks: 'The open document has no bookmarks.', removeBookmark: 'Remove bookmark',
  schNetTitle: 'Schematic net', netUnique: 'Linked to one schematic net', netAmbiguous: 'Several schematic nets carry this name: choose one explicitly', netMissing: 'No schematic net has this name. Nothing is guessed.',
  netScope: { global: 'global', local: 'local to a sheet', hierarchical: 'hierarchical' } as Record<SchematicNetTarget['scope'], string>, allSheets: 'all sheets', rootSheet: 'Root sheet',
  connections: (n: number) => `${n} connection${n === 1 ? '' : 's'}`, useNet: 'Use this net', showNet: 'Show in schematic', linkPanel: 'Link and aliases…',
  boardNetAmbiguous: 'Several board nets match this schematic net: choose one.', boardNetMissing: 'No board net matches this schematic net.', pinsOf: (n: number) => `${n} pin${n === 1 ? '' : 's'}`,
  aliasHint: 'Different names are linked only by an alias you confirm.',
};

export const Section = ({ title, count, icon, children, testId }: { title: string; count?: number | string; icon?: ReactNode; children: ReactNode; testId?: string }) =>
  <section className="wsp-section" data-testid={testId} aria-label={title}><div className="section-heading"><span className="wsp-section-title">{icon}{title}</span>{count !== undefined && <span className="muted mono">{count}</span>}</div>{children}</section>;

const MAPPING_REASON: Record<MappingReason, string> = {
  'several-schematic-placements': 'The reference is placed more than once in the schematic.', 'several-board-parts': 'Several board parts carry this reference.',
  'alias-merged-parts': 'Parts were merged by a confirmed alias.', 'unannotated-schematic-reference': 'The schematic reference is not annotated (for example "R?").',
  'duplicate-annotation': 'The schematic annotates this reference more than once.', 'schematic-pin-nets-conflict': 'The schematic pin touches several nets.',
  'board-pin-nets-conflict': 'The board pin carries several nets.', 'no-schematic-part': 'No schematic part has exactly this reference.', 'no-board-component': 'No board component has exactly this reference.',
  'pin-missing-on-schematic': 'The schematic part has no pin with this number.', 'pin-missing-on-board': 'The board part has no pin with this number.', 'unknown-component': 'Unknown board component.',
  'unknown-pin': 'Unknown pin.', 'unknown-symbol': 'Unknown schematic symbol.', 'virtual-symbol': 'A power or virtual symbol: there is no physical part.', 'unknown-net': 'Unknown net.',
  'several-schematic-nets': 'Several schematic nets carry this name.', 'several-board-nets': 'Several board nets carry this name.', 'no-schematic-net': 'No schematic net has this name.', 'no-board-net': 'No board net has this name.',
};
export const mappingReasons = (reasons: readonly MappingReason[]) => reasons.map(reason => MAPPING_REASON[reason] ?? reason).join(' ');
const PIN_STATUS: Record<PinStatus, string> = { match: 'matches', 'net-differs': 'net differs', 'pin-missing-on-board': 'pin missing on the board', 'pin-missing-on-schematic': 'pin missing in the schematic', ambiguous: 'ambiguous', 'net-unknown': 'net unknown' };
const REF_STATUS: Record<RefLinkRow['status'], string> = { unique: 'linked', ambiguous: 'ambiguous', 'board-only': 'board only', 'schematic-only': 'schematic only', alias: 'linked by alias' };

const docName = (documents: readonly DocumentRuntime[], id: string) => documents.find(doc => doc.record.id === id)?.record.name ?? id;
const sheetText = (target: SchematicTarget) => target.sheets.map(sheet => `${sheet.label || sheet.name}${sheet.page ? ` (p. ${sheet.page})` : ''}`).join(', ') || '—';

function TargetFacts({ target, documents, pinNumber }: { target: SchematicTarget; documents: readonly DocumentRuntime[]; pinNumber: string | null }) {
  const pin = target.pin;
  return <dl className="wsp-facts">
    <div><dt>{T.sheet}</dt><dd>{sheetText(target)}</dd></div>
    <div><dt>{T.part}</dt><dd className="mono">{target.ref}{target.via !== 'exact' && <em className="wsp-chip">{target.via === 'alias' ? T.viaAlias : T.viaCase}</em>}</dd></div>
    {pinNumber !== null && <div><dt>{T.pin}</dt><dd className="mono">{pin ? `${pin.number}${pin.name ? ` · ${pin.name}` : ''}` : `${pinNumber} · ${T.none}`}</dd></div>}
    {pin && <div><dt>{T.net}</dt><dd className="mono wsp-net-value">{pin.netName ?? T.none}{pin.netAuto && <em className="wsp-chip">{T.autoNamed}</em>}{pin.noConnect && <em className="wsp-chip warn">{T.noConnect}</em>}{pin.netConflict && <em className="wsp-chip warn">{T.netConflict}</em>}</dd></div>}
    {documents.filter(doc => doc.record.kind === 'schematic').length > 1 && <div><dt>{T.documents}</dt><dd>{docName(documents, target.documentId)}</dd></div>}
  </dl>;
}

export interface SchematicSectionProps {
  api: WorkspaceApi; componentId: string; pinNumber: string | null; pinId: string | null;
  onShow(target: SchematicTarget): void;
  /** Opens the link and alias panel (a missing or case-differing counterpart can only be resolved by an explicit alias). */
  onLink?(): void;
}
/** Board → schematic resolution of the selection: one target, an explicit candidate list, or an honest "missing"; never a guess. */
export function SchematicSection({ api, componentId, pinNumber, pinId, onShow, onLink }: SchematicSectionProps) {
  const { state, actions } = api;
  const mapping: Mapping<SchematicTarget> | null = state.probe.schematicMapping;
  const hasSchematic = state.documents.some(doc => doc.record.kind === 'schematic' && doc.status === 'ready' && doc.design);
  const link = state.link;
  const refRow = useMemo(() => link?.refs.rows.find(row => row.boardComponentIds.includes(componentId)), [link, componentId]);
  const pinRows = useMemo(() => link?.pins.rows.filter(row => row.boardComponentId === componentId) ?? [], [link, componentId]);
  const thisPin: PinLinkRow | undefined = pinId ? pinRows.find(row => row.boardPinIds.includes(pinId)) : undefined;
  if (!hasSchematic) {
    return <Section title={T.schematic} testId="inspector-schematic" icon={<CircuitBoard size={12} />}><p className="empty-caption">{T.noSchematic}</p><button type="button" className="outline-button" onClick={() => actions.setActiveTab('documents')}>{T.attach}</button></Section>;
  }
  return <Section title={T.schematic} testId="inspector-schematic" icon={<CircuitBoard size={12} />}>
    {!mapping && <p className="empty-caption">{T.notResolved}</p>}
    {mapping?.status === 'unique' && mapping.candidates[0] && <div className="wsp-card" data-mapping="unique">
      <p className="wsp-status ok"><Link2 size={13} />{T.unique}</p>
      <TargetFacts target={mapping.candidates[0]} documents={state.documents} pinNumber={pinNumber} />
      {(thisPin || refRow) && <p className="wsp-linkline">{T.linkStatus}: {thisPin ? PIN_STATUS[thisPin.status] : refRow ? REF_STATUS[refRow.status] : ''}{refRow?.pins && !thisPin ? ` · ${T.pinsCompared(refRow.pins.match)}` : ''}</p>}
      <button type="button" className="outline-button" data-testid="show-schematic" onClick={() => onShow(mapping.candidates[0])}><ArrowUpRight size={14} />{T.show}</button>
    </div>}
    {mapping?.status === 'ambiguous' && <div className="wsp-card" data-mapping="ambiguous">
      <p className="wsp-status warn"><AlertTriangle size={13} />{T.ambiguous}</p>
      {mapping.reasons.length > 0 && <p className="wsp-reason">{mappingReasons(mapping.reasons)}</p>}
      <ol className="wsp-candidates" aria-label={T.ambiguous}>{mapping.candidates.map((candidate, index) => <li key={index}>
        <button type="button" className="wsp-candidate" data-testid="schematic-candidate" onClick={() => actions.chooseSchematicTarget(index)}>
          <span className="mono">{candidate.ref}</span><span className="wsp-candidate-where">{sheetText(candidate)}{state.documents.length > 1 ? ` · ${docName(state.documents, candidate.documentId)}` : ''}</span>
          {candidate.pin && <span className="mono wsp-candidate-pin">{pinNumber ?? candidate.pin.number} → {candidate.pin.netName ?? T.none}</span>}
          <span className="wsp-candidate-choose">{T.choose}</span>
        </button></li>)}</ol>
      {mapping.truncated && <p className="wsp-reason">{T.moreCandidates(mapping.candidates.length, mapping.total)}</p>}
    </div>}
    {mapping?.status === 'missing' && <div className="wsp-card" data-mapping="missing">
      <p className="wsp-status bad"><AlertTriangle size={13} />{T.missing}</p>
      {mapping.reasons.length > 0 && <p className="wsp-reason">{mappingReasons(mapping.reasons)}</p>}
      {onLink && <button type="button" className="text-button" data-testid="open-link-panel-part" onClick={onLink}>{T.linkPanel}</button>}
    </div>}
    {mapping && mapping.caseInsensitive.length > 0 && <p className="wsp-reason">{T.flagged} <span className="mono">{mapping.caseInsensitive.map(c => c.ref).join(', ')}</span></p>}
    {pinRows.some(row => row.status !== 'match') && <div className="wsp-disagree" data-testid="link-disagreements">
      <div className="wsp-subheading">{T.disagreements}</div>
      <ul>{pinRows.filter(row => row.status !== 'match').map(row => <li key={row.pinNumber + row.status} className={row === thisPin ? 'current' : ''}>
        <span className="mono">{row.pinNumber}</span>
        <span>{PIN_STATUS[row.status]}{row.status === 'net-differs' ? `: ${T.boardNet} ${row.boardNet || T.none}, ${T.schNet} ${row.schematic?.netName ?? T.none}` : ''}</span>
      </li>)}</ul>
      {link?.pins.truncated && <p className="wsp-reason">{T.linkTruncated}</p>}
    </div>}
  </Section>;
}

function HitList({ hits, onOpen }: { hits: readonly PdfLinkHit[]; onOpen(hit: PdfLinkHit): void }) {
  return <ul className="wsp-hits">{hits.map((hit, index) => <li key={`${hit.page}:${hit.itemIndex}:${index}`}>
    <button type="button" data-testid="document-hit" onClick={() => onOpen(hit)}><span className="mono">{T.page(hit.page)}</span><span className="wsp-hit-context">{hit.context}</span><ArrowUpRight size={13} aria-label={T.go} /></button></li>)}</ul>;
}

function DocumentHits({ doc, link, state, onOpen }: { doc: DocumentRuntime; link: PdfRefLink | null; state: WorkspaceApi['state']; onOpen(hit: PdfLinkHit): void }) {
  const snapshot = usePdfSnapshot(doc.pdf);
  const overlay = state.overlays[doc.record.id];
  const truncated = state.pdfLinks[doc.record.id]?.truncated || overlay?.state === 'truncated';
  let body: ReactNode;
  if (snapshot?.searchable === false) body = <p className="wsp-reason"><ScanLine size={13} /> {T.scanOnly}</p>;
  else if (!link) body = <p className="wsp-reason">{overlay?.state === 'working' ? T.scanning : T.noHit}</p>;
  else if (link.status === 'unique') body = <HitList hits={link.hits.slice(0, 1)} onOpen={onOpen} />;
  else if (link.status === 'duplicate-hits') body = <><p className="wsp-status warn"><AlertTriangle size={13} />{T.hits(link.hitsTotal)}: {T.chooseHit}</p><HitList hits={link.hits} onOpen={onOpen} /></>;
  else if (link.status === 'ambiguous-board-ref') body = <p className="wsp-status warn"><AlertTriangle size={13} />{T.severalParts}</p>;
  else body = <><p className="wsp-reason">{T.noHit}</p>{link.caseInsensitiveHits.length > 0 && <><p className="wsp-reason">{T.caseOnly}</p><HitList hits={link.caseInsensitiveHits} onOpen={onOpen} /></>}</>;
  return <div className="wsp-card wsp-doc-card" data-testid="document-hits-card"><div className="wsp-doc-name"><FileText size={13} /><span title={doc.record.name}>{doc.record.name}</span></div>{body}{truncated && <p className="wsp-reason">{T.truncatedScan}</p>}</div>;
}

export function DocumentsSection({ api, refName, onOpen }: { api: WorkspaceApi; refName: string | null; onOpen(documentId: string, hit: PdfLinkHit): void }) {
  const { state } = api;
  const pdfs = state.documents.filter(doc => doc.record.kind === 'pdf' && (doc.status === 'ready' || doc.pdf));
  return <Section title={T.documents} testId="inspector-documents" icon={<FileText size={12} />}>
    {!pdfs.length ? <p className="empty-caption">{T.noDocs}</p> : !refName ? <p className="empty-caption">{T.noRef}</p>
      : pdfs.map(doc => <DocumentHits key={doc.record.id} doc={doc} state={state} link={state.pdfLinks[doc.record.id]?.links.find(link => link.kind === 'ref' && link.name === refName) ?? null} onOpen={hit => onOpen(doc.record.id, hit)} />)}
  </Section>;
}

/** A note card. When the file does not name the part or pin uniquely the note is bound by position, and the card says so; when even position cannot tell it from another one, nothing can be added. */
function NoteCard({ note, label, target, onEdit }: { note: BoardNote | undefined; label: string; target: NoteTargetResult | null; onEdit(): void }) {
  const { t } = useUi();
  const measurements = note?.measurements;
  const names: Record<(typeof MEASUREMENT_FIELDS)[number], string> = { voltage: T.voltage, resistance: T.resistance, other: T.other };
  const fallbacks = target?.ok ? target.fallbacks.map(fallback => <p key={fallback} className="wsp-fallback-note" data-testid="note-fallback">{t(FALLBACK_TEXT[fallback])}</p>) : null;
  const refusal = target && !target.ok ? REFUSAL_TEXT[target.reason] : undefined;
  if (!note) return <>{refusal ? <p className="wsp-status warn" role="note" data-testid="note-refused"><AlertTriangle size={13} />{t(refusal)}</p>
    : <button type="button" className="outline-button wsp-add-note" data-testid="add-note" onClick={onEdit}><Plus size={14} />{T.addNote(label)}</button>}{fallbacks}</>;
  return <div className="wsp-note" data-testid="note-card">
    <div className="wsp-note-head"><StickyNote size={13} /><span>{T.noteFor(label)}</span><button type="button" className="tool-button" aria-label={`${T.edit}: ${label}`} onClick={onEdit}><Pencil size={13} /></button></div>
    {note.text && <p className="wsp-note-text">{note.text}</p>}
    {measurements && <dl className="wsp-measures">{MEASUREMENT_FIELDS.filter(name => measurements[name]).map(name => <div key={name}><dt>{names[name]}</dt><dd className="mono">{measurements[name]}</dd></div>)}</dl>}
    <p className="wsp-note-foot">{T.technician}</p>
    {fallbacks}
  </div>;
}

export function NotesSection({ api, componentRef, componentId, pinId, pinNumber, onEdit }: { api: WorkspaceApi; componentRef: string; componentId: string; pinId: string | null; pinNumber: string | null; onEdit(target: NoteSubject): void }) {
  const { state, actions } = api;
  const { text } = useUi();
  const board = state.board;
  const part = useMemo(() => board ? noteKeyIndex(board).target(componentId) : null, [board, componentId]);
  const pin = useMemo(() => board && pinId ? noteKeyIndex(board).target(componentId, pinId) : null, [board, componentId, pinId]);
  return <Section title={T.notes} testId="inspector-notes" icon={<StickyNote size={12} />}>
    {state.notesBlocked && <div className="wsp-card" role="alert"><p className="wsp-status bad"><AlertTriangle size={13} />{T.blocked}</p><p className="wsp-reason">{text(state.notesBlocked)}</p>
      <button type="button" className="outline-button" data-testid="retry-notes" onClick={() => void actions.retryNotes()}><RotateCw size={14} />{T.retry}</button></div>}
    <NoteCard note={noteOf(board, state.notes, componentId)} target={part} label={`${componentRef} (${T.component})`} onEdit={() => onEdit({ componentId })} />
    {pinId && pinNumber !== null && <NoteCard note={noteOf(board, state.notes, componentId, pinId)} target={pin} label={`${componentRef} ${T.pinWord(pinNumber)}`} onEdit={() => onEdit({ componentId, pinId })} />}
  </Section>;
}

export function BookmarksSection({ api, documentId, onOpen }: { api: WorkspaceApi; documentId: string | null; onOpen(documentId: string, page: number): void }) {
  const { state, actions } = api;
  const doc = documentId ? state.documents.find(candidate => candidate.record.id === documentId) : undefined;
  if (!doc) return null;
  const bookmarks = doc.record.bookmarks;
  return <Section title={T.bookmarks} count={bookmarks.length} testId="inspector-bookmarks" icon={<Bookmark size={12} />}>
    <p className="wsp-doc-name"><FileText size={13} /><span title={doc.record.name}>{doc.record.name}</span></p>
    {bookmarks.length === 0 ? <p className="empty-caption">{T.noBookmarks}</p> : <ul className="wsp-hits">{bookmarks.map(bookmark => <li key={bookmark.id} className="wsp-bookmark">
      <button type="button" data-testid="bookmark-go" onClick={() => onOpen(doc.record.id, bookmark.page)}><span className="mono">{T.page(bookmark.page)}</span><span className="wsp-hit-context">{bookmark.label}</span></button>
      <button type="button" className="tool-button" aria-label={`${T.removeBookmark}: ${bookmark.label}`} onClick={() => actions.setBookmarks(doc.record.id, bookmarks.filter(item => item.id !== bookmark.id))}><Trash2 size={13} /></button></li>)}</ul>}
  </Section>;
}

const viaChip = (via: 'exact' | 'alias' | 'case-insensitive') => via === 'alias' ? <em className="wsp-chip">{T.viaAlias}</em> : via === 'case-insensitive' ? <em className="wsp-chip warn">{T.viaCase}</em> : null;

/** Board net selection → schematic nets: one net, an explicit candidate list (scope and sheet identity per candidate) or an honest "missing"; never a silent pick. */
export function SchematicNetSection({ api, onShow, onLink }: { api: WorkspaceApi; onShow(documentId: string): void; onLink(): void }) {
  const { state, actions } = api;
  const mapping: Mapping<SchematicNetTarget> | null = state.probe.schematicNetMapping;
  const manyDocs = state.documents.filter(doc => doc.record.kind === 'schematic').length > 1;
  if (!mapping || !state.documents.some(doc => doc.record.kind === 'schematic' && doc.status === 'ready' && doc.design)) return null;
  const sheetOf = (net: SchematicNetTarget) => {
    if (net.scopePath === undefined) return T.allSheets;
    const sheet = api.sheetsOf(net.documentId).find(item => item.path === net.scopePath);
    return sheet ? `${sheet.name || T.rootSheet}${sheet.page ? ` (p. ${sheet.page})` : ''}` : net.scopePath || T.rootSheet;
  };
  const facts = (net: SchematicNetTarget) => <>
    <span className="mono">{net.name}</span>
    <span className="wsp-candidate-where">{T.netScope[net.scope]} · {sheetOf(net)} · {T.connections(net.memberCount)}{manyDocs ? ` · ${docName(state.documents, net.documentId)}` : ''}</span>
    <span className="wsp-candidate-chips">{net.auto && <em className="wsp-chip">{T.autoNamed}</em>}{viaChip(net.via)}</span></>;
  return <Section title={T.schNetTitle} testId="inspector-schematic-net" icon={<CircuitBoard size={12} />}>
    {mapping.status === 'unique' && mapping.candidates[0] && <div className="wsp-card" data-mapping="unique">
      <p className="wsp-status ok"><Link2 size={13} />{T.netUnique}</p>
      <div className="wsp-net-facts" data-testid="schematic-net-unique">{facts(mapping.candidates[0])}</div>
      <button type="button" className="outline-button" data-testid="show-schematic-net" onClick={() => onShow(mapping.candidates[0].documentId)}><ArrowUpRight size={14} />{T.showNet}</button>
    </div>}
    {mapping.status === 'ambiguous' && <div className="wsp-card" data-mapping="ambiguous">
      <p className="wsp-status warn"><AlertTriangle size={13} />{T.netAmbiguous}</p>
      {mapping.reasons.some(reason => reason !== 'several-schematic-nets') && <p className="wsp-reason">{mappingReasons(mapping.reasons.filter(reason => reason !== 'several-schematic-nets'))}</p>}
      <ol className="wsp-candidates" aria-label={T.netAmbiguous}>{mapping.candidates.map((candidate, index) => <li key={candidate.netKey + index}>
        <button type="button" className="wsp-candidate wsp-net-candidate" data-testid="schematic-net-candidate" onClick={() => actions.chooseSchematicNet(index)}>{facts(candidate)}<span className="wsp-candidate-choose">{T.useNet}</span></button></li>)}</ol>
      {mapping.truncated && <p className="wsp-reason">{T.moreCandidates(mapping.candidates.length, mapping.total)}</p>}
    </div>}
    {mapping.status === 'missing' && <div className="wsp-card" data-mapping="missing">
      <p className="wsp-status bad"><AlertTriangle size={13} />{T.netMissing}</p>
      {mapping.reasons.length > 0 && <p className="wsp-reason">{mappingReasons(mapping.reasons)}</p>}
      <p className="wsp-reason">{T.aliasHint}</p>
      <button type="button" className="text-button" data-testid="open-link-panel-net" onClick={onLink}>{T.linkPanel}</button>
    </div>}
    {mapping.caseInsensitive.length > 0 && <p className="wsp-reason" data-testid="schematic-net-flagged">{T.flagged} <span className="mono">{mapping.caseInsensitive.map(c => c.name).join(', ')}</span></p>}
  </Section>;
}

/** Schematic net → board nets (Schematic tab): an ambiguous or missing counterpart needs the technician; nothing is chosen silently. */
export function BoardNetBanner({ mapping, onChoose, onLink }: { mapping: Mapping<BoardNetTarget> | null; onChoose(index: number): void; onLink?(): void }) {
  if (!mapping || mapping.status === 'unique') return null;
  return <div className="wsp-banner" role="status" data-testid="board-net-mapping" data-mapping={mapping.status}>
    <AlertTriangle size={14} />
    <div><strong>{mapping.status === 'ambiguous' ? T.boardNetAmbiguous : T.boardNetMissing}</strong>
      {mapping.reasons.length > 0 && <span> {mappingReasons(mapping.reasons)}</span>}
      {mapping.status === 'ambiguous' && <span className="wsp-banner-choices">{mapping.candidates.map((candidate, index) => <button key={candidate.name + index} type="button" className="outline-button" data-testid="board-net-candidate" onClick={() => onChoose(index)}><span className="mono">{candidate.name}</span><span>{T.pinsOf(candidate.pinCount)}</span>{viaChip(candidate.via)}</button>)}</span>}
      {mapping.status === 'missing' && mapping.caseInsensitive.length > 0 && <span data-testid="board-net-flagged"> {T.flagged} <span className="mono">{mapping.caseInsensitive.map(c => c.name).join(', ')}</span></span>}
      {mapping.status === 'missing' && onLink && <span className="wsp-banner-choices"><button type="button" className="text-button" data-testid="open-link-panel-banner" onClick={onLink}>{T.linkPanel}</button></span>}
    </div></div>;
}

/** Schematic → board resolution of the current schematic selection (shown in the Schematic tab); ambiguous asks for an explicit choice. */
export function BoardMappingBanner({ mapping, onChoose }: { mapping: Mapping<BoardTarget> | null; onChoose(index: number): void }) {
  if (!mapping || mapping.status === 'unique') return null;
  return <div className="wsp-banner" role="status" data-testid="board-mapping" data-mapping={mapping.status}>
    <AlertTriangle size={14} />
    <div><strong>{mapping.status === 'ambiguous' ? 'Several board parts match this schematic selection: choose one.' : 'No board part matches this schematic selection.'}</strong>
      {mapping.reasons.length > 0 && <span> {mappingReasons(mapping.reasons)}</span>}
      {mapping.status === 'ambiguous' && <span className="wsp-banner-choices">{mapping.candidates.map((candidate, index) => <button key={index} type="button" className="outline-button" data-testid="board-candidate" onClick={() => onChoose(index)}><span className="mono">{candidate.ref}</span><span>{candidate.side}</span>{candidate.pin ? <span className="mono">pin {candidate.pin.number}</span> : null}</button>)}</span>}
    </div></div>;
}
