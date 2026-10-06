import { AlertCircle, Check, CircuitBoard, FolderOpen, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Notice, WorkspaceApi } from '../../app/api';
import type { DocumentHitRow, PdfLinkHit, SchematicTarget, SearchRow } from '../../lib/crossprobe';
import { SUPPORTED_EXTENSIONS } from '../../lib/formats';
import type { WorkspaceAliases } from '../../lib/documents';
import type { Message } from '../../lib/i18n';
import type { Board, ViewCommand, ViewSide } from '../../lib/types';
import type { NoteTarget } from '../../lib/workspace';
import SupportNotice from '../SupportNotice';
import UpdateNotice from '../UpdateNotice';
import { BUG_REPORT_FAILED_KEY, resolveSupportLinkOpener } from '../../lib/support-notice';
import { UPDATE_OPEN_FAILED_KEY } from '../../lib/update-check';
import type { BoardCamera } from '../board-camera';
import { parseBoardCamera } from '../board-camera';
import type { ViewerCamera, ViewerRotation } from '../viewer-contracts';
import { BoardPane } from './BoardPane';
import { HelpDialog, InfoDialog, KeyDialog, RecentsDialog, SettingsDialog } from './Dialogs';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { LinkDialog } from './LinkDialog';
import { NoteDialog } from './NoteDialog';
import { SearchPanel } from './SearchPanel';
import { SplitLayout } from './SplitLayout';
import { StatusBar } from './StatusBar';
import { DocumentsTab, SchematicTab, SplitDocumentPane } from './Tabs';
import { TopBar } from './TopBar';
import { Welcome, DROP_HINT } from './Welcome';
import { PANEL_AUTO_COLLAPSE_BELOW, autoCollapsePanels, deriveSide, noteOf, resolvePanels } from './model';
import type { PanelPreference } from './model';
import { useSettings } from './settings';
import { resolveShortcut } from './shortcuts';
import { Probe, useElementWidth, useWindowBelow } from './ui';
import { UiContext } from './ui-context';
import type { UiContextValue } from './ui-context';
import './workspace.css';

// i18n: pending
const T = { dropDocuments: 'Drop to attach', dropDocumentsHint: 'Documents are attached to this board. Board files open as a new board.', tabpanel: 'Workspace', notAFile: 'Nothing readable was dropped.' };
const isBoardName = (name: string) => { const dot = name.lastIndexOf('.'); return dot >= 0 && SUPPORTED_EXTENSIONS.includes(name.slice(dot).toLowerCase()); };
const NARROW_PANE = 760, AUTO_COLLAPSE_WIDTH = 1280;
type ModalName = 'settings' | 'help' | 'recents' | 'info' | 'export' | 'link' | null;
const NO_ALIASES: WorkspaceAliases = { refs: {}, nets: {} };
interface LocalToast { id: number; kind: 'info' | 'success' | 'error'; message: Message }

export default function Shell({ api }: { api: WorkspaceApi }) {
  const { state, actions, statusStore } = api;
  const { board, activeTab, split, documents, selection } = state;
  const desktop = window.traceDesktop;
  const [localToasts, setLocalToasts] = useState<LocalToast[]>([]);
  const toastCounter = useRef(0);
  const notify = useCallback((message: Message, error = false) => {
    const id = -(++toastCounter.current);
    setLocalToasts(list => [...list.slice(-2), { id, kind: error ? 'error' : 'success', message }]);
    setTimeout(() => setLocalToasts(list => list.filter(toast => toast.id !== id)), error ? 7500 : 3000);
  }, []);
  const { settings, settingsRef, update, ready, theme, language, t, fmt, text } = useSettings(notify);
  // The update strip appears only once the support notice is closed (or was never shown), so the two never compete for attention.
  const [supportSettled, setSupportSettled] = useState(false);
  const onSupportSettled = useCallback(() => setSupportSettled(true), []);
  const onUpdateOpenFailed = useCallback(() => notify({ key: UPDATE_OPEN_FAILED_KEY }, true), [notify]);
  // Top bar "Report a bug" button: the main process opens the GitHub bug report form (id only, never a URL); a failure shows a toast.
  const reportBug = useCallback(() => { void Promise.resolve().then(() => resolveSupportLinkOpener(window.traceDesktop)('bug')).catch(() => notify({ key: BUG_REPORT_FAILED_KEY }, true)); }, [notify]);
  const copy = useCallback((value: string) => { navigator.clipboard.writeText(value).then(() => notify({ key: 'toast.copied' }), () => notify({ key: 'toast.clipboardUnavailable' }, true)); }, [notify]);
  const ui = useMemo<UiContextValue>(() => ({ t, fmt, language, text, copy }), [t, fmt, language, text, copy]);

  const [side, setSide] = useState<ViewSide>('top');
  const [allSides, setAllSides] = useState(false);
  const [netVisible, setNetVisible] = useState(true);
  const [measure, setMeasure] = useState(false);
  const [viewCommand, setViewCommand] = useState<(ViewCommand & { automatic?: boolean }) | null>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recentSelections, setRecentSelections] = useState<string[]>([]);
  // The side panels: `null` follows the automatic rule below, a boolean is the user's explicit choice (W-win-viewers-02).
  const [panelPref, setPanelPref] = useState<PanelPreference>({ left: null, right: null });
  const [pickedSchematic, setPickedSchematic] = useState<string | null>(null);
  const [pdfFocus, setPdfFocus] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const boardInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const settingsFocus = useRef<string | undefined>(undefined);
  const commandCounter = useRef(0);
  const dragDepth = useRef(0);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const [mainRef, mainWidth] = useElementWidth<HTMLDivElement>();
  const narrowWindow = useWindowBelow(PANEL_AUTO_COLLAPSE_BELOW);
  const panelsCollapsed = autoCollapsePanels(narrowWindow, activeTab, split.enabled);
  const panelsCollapsedRef = useRef(panelsCollapsed); panelsCollapsedRef.current = panelsCollapsed;
  const panels = useMemo(() => resolvePanels(panelPref, panelsCollapsed), [panelPref, panelsCollapsed]);
  // Aliases come from the workspace manifest (native). Without persistence the core publishes no manifest, so the panel keeps a mirror of what was set in this session.
  const [sessionAliases, setSessionAliases] = useState<WorkspaceAliases>(NO_ALIASES);
  useEffect(() => { setSessionAliases(NO_ALIASES); }, [state.boardKey]);
  const aliases = state.manifest ? state.manifest.aliases ?? NO_ALIASES : sessionAliases;
  const createAlias = useCallback((kind: 'refs' | 'nets', from: string, to: string) => { actionsRef.current.setAlias(kind, from, to); setSessionAliases(current => ({ ...current, [kind]: { ...current[kind], [from]: to } })); }, []);
  const removeAlias = useCallback((kind: 'refs' | 'nets', from: string) => { actionsRef.current.removeAlias(kind, from); setSessionAliases(current => { const next = { ...current[kind] }; delete next[from]; return { ...current, [kind]: next }; }); }, []);
  const openLink = useCallback(() => setModal('link'), []);

  const focusLayout = settings.layout === 'focus';
  const native = state.persistence === 'native';
  const boardVisible = !!board && (activeTab === 'board' || split.enabled);
  const command = useCallback((type: ViewCommand['type']) => setViewCommand({ type, nonce: ++commandCounter.current }), []);

  // --- board camera: the stored view of THIS board (the manifest of the current board) replaces the automatic fit ---
  const storedCamera = board && state.boardKey ? actions.cameraOf('board') : null;
  const boardCamera = useMemo(() => parseBoardCamera(storedCamera), [storedCamera]);
  const boardCameraRef = useRef(boardCamera); boardCameraRef.current = boardCamera;
  const restoredBoard = useRef<Board | null>(null);
  const onCameraRestore = useCallback((camera: BoardCamera) => { restoredBoard.current = stateRef.current.board; setSide(camera.side); }, []);
  // `side` is not part of ViewerCamera (src/components/viewer-contracts.ts); the core stores it with the board camera (DocumentCamera.side).
  const onCameraChange = useCallback((camera: BoardCamera) => {
    const next: ViewerCamera & { side: BoardCamera['side'] } = { zoom: camera.zoom, x: camera.x, y: camera.y, rotation: camera.rotation as ViewerRotation, side: camera.side };
    actionsRef.current.setCamera('board', next);
  }, []);

  // --- derived document selection (the manifest's split.right is the persisted "selected document") ---
  const docById = useMemo(() => new Map(documents.map(doc => [doc.record.id, doc])), [documents]);
  const rightId = split.right?.id && docById.has(split.right.id) ? split.right.id : null;
  const docSelected = rightId ?? documents[0]?.record.id ?? null;
  const probeSchematic = state.probe.schematic?.documentId ?? null;
  const isSchematicId = (id: string | null) => !!id && docById.get(id)?.record.kind === 'schematic';
  const firstSchematic = documents.find(doc => doc.record.kind === 'schematic' && doc.status === 'ready') ?? documents.find(doc => doc.record.kind === 'schematic');
  const schematicShown = isSchematicId(pickedSchematic) ? pickedSchematic : isSchematicId(probeSchematic) ? probeSchematic : isSchematicId(rightId) ? rightId : firstSchematic?.record.id ?? null;
  useEffect(() => { setPickedSchematic(null); }, [probeSchematic]);
  const chrome = useMemo(() => ({ theme, motion: settings.motion, compact: split.enabled || (mainWidth > 0 && mainWidth < NARROW_PANE) }), [theme, settings.motion, split.enabled, mainWidth]);
  const bookmarkDocument = (activeTab === 'documents' || (activeTab === 'board' && split.enabled)) && docSelected && docById.get(docSelected)?.record.kind !== 'schematic' ? docSelected : null;

  // --- board lifecycle effects ---
  useEffect(() => {
    if (restoredBoard.current !== board) setSide('top');
    setMeasure(false); setNetVisible(true); setRecentSelections([]); setModal(null); setNoteTarget(null);
    // The initial fit is automatic (never persisted) and is skipped when this board already has a stored view.
    if (state.boardKey && !boardCameraRef.current) setViewCommand({ type: 'fit', nonce: ++commandCounter.current, automatic: true });
  }, [state.boardKey, command]);
  useEffect(() => { setSide(current => deriveSide(board, selection, current)); }, [board, selection.componentId, selection.pinId]);
  const firstNonce = useRef(true);
  useEffect(() => {
    if (firstNonce.current) { firstNonce.current = false; return; }
    if (state.probe.nonce > 0 && selection.componentId) command('center-selection');
  }, [state.probe.nonce]);
  useEffect(() => {
    const id = selection.componentId;
    if (id) setRecentSelections(ids => [id, ...ids.filter(item => item !== id)].slice(0, 6));
  }, [selection.componentId]);
  useEffect(() => {
    document.title = board ? `${board.name || t('board.unnamed')} — TRACE` : 'TRACE Boardviewer';
  }, [board, t]);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop.isMaximized().then(value => { if (active) setMaximized(value); }).catch(() => {});
    const off = desktop.onMaximized(setMaximized);
    return () => { active = false; off(); };
  }, [desktop]);
  // Notices from the core vanish by themselves (errors linger longer); the core stays the owner of the list.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const notice of state.notices) {
      if (timers.current.has(notice.id)) continue;
      timers.current.set(notice.id, setTimeout(() => { timers.current.delete(notice.id); actionsRef.current.dismissNotice(notice.id); }, notice.kind === 'error' ? 7500 : 3000));
    }
  }, [state.notices]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);

  // --- handlers (stable: they read the latest actions through the ref) ---
  const onSelectComponent = useCallback((id: string | null) => actionsRef.current.selectComponent(id, { origin: 'board' }), []);
  const onSelectPin = useCallback((id: string) => actionsRef.current.selectPin(id, { origin: 'board' }), []);
  const onLocate = useCallback((id: string) => actionsRef.current.selectComponent(id, { center: true, origin: 'search' }), []);
  const closeModal = useCallback(() => setModal(null), []);
  const closeNote = useCallback(() => setNoteTarget(null), []);
  const openSettings = useCallback((focus?: string) => { settingsFocus.current = focus; setModal('settings'); }, []);
  const open = useCallback(() => { if (native) void actionsRef.current.openBoard(); else boardInput.current?.click(); }, [native]);
  const attach = useCallback(() => { if (native) void actionsRef.current.attachDocuments(); else docInput.current?.click(); }, [native]);
  const onHome = useCallback(() => actionsRef.current.closeBoard(), []);
  const onTab = useCallback((tab: 'board' | 'schematic' | 'documents') => actionsRef.current.setActiveTab(tab), []);
  const onToggleFocus = useCallback(() => update({ layout: settingsRef.current.layout === 'focus' ? 'workshop' : 'focus' }), [update, settingsRef]);
  const onPanels = useCallback((which: 'left' | 'right') => setPanelPref(p => ({ ...p, [which]: !(p[which] ?? !panelsCollapsedRef.current) })), []);
  const stateRef = useRef(state); stateRef.current = state;
  const toggleSplit = useCallback(() => {
    const current = stateRef.current;
    const enabled = !current.split.enabled;
    const first = current.documents[0];
    const right = enabled && !current.split.right && first ? { kind: first.record.kind === 'schematic' ? 'schematic' as const : 'document' as const, id: first.record.id } : undefined;
    actionsRef.current.setSplit({ enabled, ...(right ? { right } : {}) });
    if (enabled && window.innerWidth < AUTO_COLLAPSE_WIDTH) setPanelPref(p => ({ ...p, left: false }));
  }, []);
  const reveal = useCallback((kind: 'schematic' | 'document', id: string) => {
    actionsRef.current.setSplit({ right: { kind, id } });
    if (!stateRef.current.split.enabled) actionsRef.current.setActiveTab(kind === 'schematic' ? 'schematic' : 'documents');
  }, []);
  const showSchematic = useCallback((target: SchematicTarget) => {
    const pin = target.pin?.placements[0]; const unit = target.units[0];
    if (pin && target.pin) actionsRef.current.selectSchematicPin({ documentId: target.documentId, instancePath: pin.instancePath, symbolId: pin.symbolId, pinId: pin.pinId, ref: target.ref, pinNumber: target.pin.number });
    else if (unit) actionsRef.current.selectSchematicSymbol({ documentId: target.documentId, instancePath: unit.instancePath, symbolId: unit.symbolId, ref: target.ref });
    setPickedSchematic(target.documentId); reveal('schematic', target.documentId);
  }, [reveal]);
  const showNet = useCallback((documentId: string) => { setPickedSchematic(documentId); reveal('schematic', documentId); }, [reveal]);
  const openHit = useCallback((documentId: string, hit: PdfLinkHit) => {
    const name = stateRef.current.documents.find(doc => doc.record.id === documentId)?.record.name ?? documentId;
    const row: DocumentHitRow = { source: 'documents', documentId, documentName: name, page: hit.page, itemIndex: hit.itemIndex, x: hit.x, y: hit.y, width: hit.width, height: hit.height, context: hit.context };
    actionsRef.current.activateSearchRow(row); reveal('document', documentId);
  }, [reveal]);
  const openPage = useCallback((documentId: string, page: number) => {
    actionsRef.current.setCamera(documentId, { ...actionsRef.current.cameraOf(documentId), page });
    reveal('document', documentId);
  }, [reveal]);
  // A search row that opens a document or schematic also makes it the selected one (split.right is the persisted selection).
  const onSearchActivated = useCallback((row: SearchRow) => {
    if (row.source === 'documents') reveal('document', row.documentId);
    else if (row.source === 'schematic-symbols' || row.source === 'schematic-nets') { setPickedSchematic(row.documentId); reveal('schematic', row.documentId); }
  }, [reveal]);
  const pickDocument = useCallback((id: string) => { const doc = stateRef.current.documents.find(d => d.record.id === id); if (doc) reveal(doc.record.kind === 'schematic' ? 'schematic' : 'document', id); }, [reveal]);
  const pickSchematic = useCallback((id: string) => {
    setPickedSchematic(id); reveal('schematic', id);
    const first = apiRef.current.sheetsOf(id)[0];
    if (first) actionsRef.current.setSchematicInstance(id, first.path);
  }, [reveal]);
  const apiRef = useRef(api); apiRef.current = api;
  const editNote = useCallback((target?: NoteTarget) => {
    const current = stateRef.current.selection;
    if (target) { setNoteTarget(target); return; }
    if (current.componentId) setNoteTarget({ componentId: current.componentId, ...(current.pinId ? { pinId: current.pinId } : {}) });
  }, []);

  // --- global keyboard workflow (the rules live in shortcuts.ts; the key dialog counts as a modal like the others, H3-02) ---
  const keyCtx = useRef({ modal, noteTarget, keyRequest: !!state.import.keyRequest, boardVisible, focusLayout, hasBoard: !!board, activeTab });
  keyCtx.current = { modal, noteTarget, keyRequest: !!state.import.keyRequest, boardVisible, focusLayout, hasBoard: !!board, activeTab };
  useEffect(() => {
    const focusSearch = () => {
      const ctx = keyCtx.current;
      if (!ctx.boardVisible && ctx.hasBoard) actionsRef.current.setActiveTab('board');
      setPanelPref(p => (p.left ?? !panelsCollapsedRef.current) || ctx.focusLayout ? p : { ...p, left: true });
      requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
    };
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const ctx = keyCtx.current;
      const target = event.target as HTMLElement;
      const result = resolveShortcut(event, {
        modal: !!ctx.modal, note: !!ctx.noteTarget, keyRequest: ctx.keyRequest, hasBoard: ctx.hasBoard, boardVisible: ctx.boardVisible,
        editable: !!target.matches?.('input, textarea, select, [contenteditable]'), viewer: !!target.closest?.('.pdfv, .schv, .imgv'), pdf: !!target.closest?.('.pdfv'),
      });
      if (!result) return;
      if (result.prevent) event.preventDefault();
      switch (result.action) {
        case 'close-modal': setModal(null); break;
        case 'open': if (stateRef.current.persistence === 'native') void actionsRef.current.openBoard(); else boardInput.current?.click(); break;
        case 'search': focusSearch(); break;
        case 'pdf-search': setPdfFocus(n => n + 1); break;
        case 'help': setModal('help'); break;
        case 'layout-workshop': update({ layout: 'workshop' }); break;
        case 'layout-focus': update({ layout: 'focus' }); break;
        case 'split': toggleSplit(); break;
        case 'tab-board': actionsRef.current.setActiveTab('board'); break;
        case 'tab-schematic': actionsRef.current.setActiveTab('schematic'); break;
        case 'tab-documents': actionsRef.current.setActiveTab('documents'); break;
        case 'fit': command('fit'); break;
        case 'rotate': command('rotate'); break;
        case 'measure': setMeasure(v => !v); break;
        case 'labels': update({ showLabels: !settingsRef.current.showLabels }); break;
        case 'note': editNote(); break;
        case 'zoom-in': command('zoom-in'); break;
        case 'zoom-out': command('zoom-out'); break;
        case 'clear': setMeasure(false); actionsRef.current.selectNet(null); actionsRef.current.setSearchQuery(''); break;
      }
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [command, editNote, settingsRef, toggleSplit, update]);

  // --- drag and drop: board files open a board, everything else is attached as a document of the current board ---
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    if (!board || files.some(file => isBoardName(file.name))) void actions.openDropped(files); else void actions.attachFiles(files);
  };
  const pickedFiles = (input: HTMLInputElement, handler: (files: File[]) => Promise<void>) => { const files = Array.from(input.files ?? []); input.value = ''; if (files.length) void handler(files); };

  const layoutName = t(settings.layout === 'focus' ? 'layout.focus' : 'layout.workshop');
  const hasNote = !!board && !!selection.componentId && !!noteOf(state.notes, selection.componentId, selection.pinId ?? undefined);
  const breadcrumb = useMemo(() => {
    const component = board?.components.find(c => c.id === selection.componentId);
    const pin = selection.pinId ? board?.pins.find(p => p.id === selection.pinId) : undefined;
    return `${component?.ref || t(side === 'top' ? 'side.top' : 'side.bottom')}${pin ? ` → ${pin.number}` : ''}${selection.net ? ` → ${selection.net}` : ''}`;
  }, [board, selection, side, t]);
  const counts = useMemo(() => ({ components: board?.components.length ?? 0, pins: board?.pins.length ?? 0, nets: board?.nets.length ?? 0 }), [board]);

  const boardArea = board && <div className="wsp-board-area" data-floating={focusLayout && panels.right}>
    <BoardPane api={api} side={side} onSide={setSide} netVisible={netVisible} onNetVisible={setNetVisible} measure={measure} onMeasure={setMeasure} viewCommand={viewCommand} command={command} initialCamera={boardCamera} onCameraRestore={onCameraRestore} onCameraChange={onCameraChange}
      settings={settings} onSettings={update} theme={theme} focusLayout={focusLayout} searchRef={searchRef} recentSelections={recentSelections} hasNote={hasNote} onEditNote={() => editNote()} onSelectComponent={onSelectComponent} onSelectPin={onSelectPin} onLocate={onLocate} onSearchActivated={onSearchActivated} />
    {focusLayout && panels.right && <Probe id="inspector"><Inspector api={api} floating activeDocumentId={bookmarkDocument} onLocate={() => command('center-selection')} onEditNote={editNote} onShowSchematic={showSchematic} onShowNet={showNet} onLink={openLink} onOpenHit={openHit} onOpenPage={openPage} /></Probe>}
  </div>;
  const schematicTab = <SchematicTab api={api} shownId={schematicShown} chrome={chrome} onPick={pickSchematic} onAttach={attach} onLink={openLink} />;
  const documentsTab = (layout: 'aside' | 'strip') => <DocumentsTab api={api} selectedId={docSelected} chrome={chrome} layout={layout} focusNonce={pdfFocus} onSelect={pickDocument} onAttach={attach} onExport={() => setModal('export')} />;
  const rightPane = activeTab === 'schematic' ? schematicTab : activeTab === 'documents' ? documentsTab('strip')
    : <SplitDocumentPane api={api} selectedId={docSelected} chrome={chrome} focusNonce={pdfFocus} onPick={pickDocument} onAttach={attach} />;
  const content = !board ? null : split.enabled ? <SplitLayout ratio={split.ratio} onRatio={ratio => actions.setSplit({ ratio })} left={boardArea} right={rightPane} />
    : activeTab === 'board' ? boardArea : activeTab === 'schematic' ? schematicTab : documentsTab('aside');
  const toasts: Array<{ id: number; kind: Notice['kind']; message: Message }> = [...state.notices, ...localToasts].slice(-3);

  return <UiContext.Provider value={ui}>
    <div className={'app ' + (focusLayout ? 'focus-mode' : '')} data-testid="app" data-theme-mode={theme} style={ready ? undefined : { visibility: 'hidden' }}
      onDragEnter={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={e => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={onDrop}>
      <input ref={boardInput} className="hidden-input" type="file" accept={SUPPORTED_EXTENSIONS.join(',')} multiple aria-label={t('fileInput.aria')} data-testid="board-file-input" onChange={e => pickedFiles(e.target, files => actions.openDropped(files))} />
      <input ref={docInput} className="hidden-input" type="file" multiple aria-label="Attach documents" data-testid="document-file-input" onChange={e => pickedFiles(e.target, files => actions.attachFiles(files))} />
      <Probe id="shell"><TopBar t={t} hasBoard={!!board} boardName={board?.name || t('board.unnamed')} format={board?.format ?? ''} fileName={state.import.file?.name ?? ''} filePath={state.import.file?.path ?? ''} componentCount={counts.components} layoutName={layoutName}
        activeTab={activeTab} splitEnabled={split.enabled} documentCount={documents.length} schematicCount={documents.filter(d => d.record.kind === 'schematic').length} focusLayout={focusLayout} leftOpen={panels.left} rightOpen={panels.right} maximized={maximized} desktop={desktop}
        onTab={onTab} onSplit={toggleSplit} onOpen={open} onHome={onHome} onToggleFocus={onToggleFocus} onSettings={openSettings} onPanels={onPanels} onReportBug={reportBug} /></Probe>
      <UpdateNotice enabled={settings.updateCheck} ready={ready} after={supportSettled} t={t} onOpenFailed={onUpdateOpenFailed} />
      {board ? <>
        <div className="workspace" data-left={!focusLayout && panels.left ? 'open' : 'closed'} data-right={!focusLayout && panels.right ? 'open' : 'closed'} data-split={split.enabled} data-tab={activeTab}>
          {!focusLayout && panels.left && <Probe id="left"><SearchPanel api={api} side={side} allSides={allSides} onAllSides={setAllSides} onRecents={() => setModal('recents')} inputRef={searchRef} onActivated={onSearchActivated} /></Probe>}
          <div ref={mainRef} className="wsp-main" role="tabpanel" id="wsp-tabpanel" aria-labelledby={`wsp-tab-${activeTab}`} aria-label={T.tabpanel} data-testid="main-panel">{content}</div>
          {!focusLayout && panels.right && <Probe id="inspector"><Inspector api={api} floating={false} activeDocumentId={bookmarkDocument} onLocate={() => command('center-selection')} onEditNote={editNote} onShowSchematic={showSchematic} onShowNet={showNet} onLink={openLink} onOpenHit={openHit} onOpenPage={openPage} /></Probe>}
        </div>
        <Probe id="status"><StatusBar store={statusStore} fmt={fmt} t={t} counts={counts} warnings={board.warnings.length} save={state.save} persistence={state.persistence} breadcrumb={breadcrumb} onInfo={() => setModal('info')} onHelp={() => setModal('help')} /></Probe>
      </> : <Welcome recents={state.import.recents} onOpen={open} onRecent={path => void actions.openRecent(path)} onHelp={() => setModal('help')} />}

      {modal === 'settings' && <SettingsDialog settings={settings} onUpdate={update} onClose={closeModal} initialFocus={settingsFocus.current} />}
      {modal === 'help' && <HelpDialog onClose={closeModal} />}
      {modal === 'recents' && <RecentsDialog recents={state.import.recents} onOpenRecent={path => { setModal(null); void actions.openRecent(path); }} onOpenOther={() => { setModal(null); open(); }} onClose={closeModal} />}
      {modal === 'info' && board && <InfoDialog board={board} onClose={closeModal} />}
      {modal === 'export' && <ExportDialog api={api} onClose={closeModal} />}
      {modal === 'link' && <LinkDialog api={api} aliases={aliases} onCreate={createAlias} onRemove={removeAlias} onClose={closeModal} />}
      {noteTarget && <NoteDialog api={api} target={noteTarget} onClose={closeNote} />}
      <SupportNotice ready={ready} t={t} onSettled={onSupportSettled} />
      {/* Like the update strip, the key dialog waits for the support notice: shown on top of it, its Esc cancelled the key request instead of skipping the notice (H3-03). The request itself stays pending in the core. */}
      {supportSettled && state.import.keyRequest && <KeyDialog key={state.import.keyRequest.fileName + state.import.keyRequest.code} request={state.import.keyRequest} onSubmit={value => actions.submitKey(value)} onCancel={() => actions.cancelKeyRequest()} />}
      {toasts.length > 0 && <div className="wsp-toasts" aria-live="polite">{toasts.map(toast => <div key={toast.id} className={'toast' + (toast.kind === 'error' ? ' error' : '')} role={toast.kind === 'error' ? 'alert' : 'status'} data-testid="toast">
        {toast.kind === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}<span>{text(toast.message)}</span>
        <button type="button" aria-label={t('toast.close')} onClick={() => toast.id < 0 ? setLocalToasts(list => list.filter(item => item.id !== toast.id)) : actions.dismissNotice(toast.id)}><X size={14} /></button></div>)}</div>}
      {state.import.phase !== 'idle' && <div className="loading-overlay" role="status" data-testid="loading-overlay"><div className="loading-card"><CircuitBoard size={32} /><h2>{t(state.import.phase === 'processing' ? 'loading.processing' : 'loading.reading')}</h2><div className="loading-track"><span /></div><p>{t('loading.hint')}</p></div></div>}
      {dragging && <div className="drop-overlay"><div><FolderOpen size={44} /><h2>{board ? T.dropDocuments : t('drop.title')}</h2><p>{board ? T.dropDocumentsHint : DROP_HINT}</p></div></div>}
    </div>
  </UiContext.Provider>;
}
