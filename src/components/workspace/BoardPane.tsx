import { Layers2, Minus, Plus, RotateCw, Route, Ruler, Scan, StickyNote, Tags, X } from 'lucide-react';
import type { RefObject } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { SearchRow } from '../../lib/crossprobe';
import type { AppSettings, ViewCommand, ViewSide } from '../../lib/types';
import BoardCanvas from '../BoardCanvas';
import type { BoardCamera } from '../board-camera';
import { indexOfState } from './model';
import { FocusSearch } from './SearchPanel';
import { LiveMeasurement, LiveRotation, LiveZoom } from './StatusBar';
import { Tool } from './ui';
import { useUi } from './ui-context';
import './workspace.css';

export interface BoardPaneProps {
  api: WorkspaceApi;
  side: ViewSide; onSide(side: ViewSide): void;
  netVisible: boolean; onNetVisible(next: boolean): void;
  measure: boolean; onMeasure(next: boolean): void;
  viewCommand: (ViewCommand & { automatic?: boolean }) | null; command(type: ViewCommand['type']): void;
  /** Stored view of this board, restored instead of the automatic fit; `onCameraChange` persists user changes (idle-debounced by the canvas). */
  initialCamera: BoardCamera | null; onCameraRestore(camera: BoardCamera): void; onCameraChange(camera: BoardCamera): void;
  settings: AppSettings; onSettings(next: Partial<AppSettings>): void;
  theme: 'dark' | 'light';
  focusLayout: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  recentSelections: string[];
  hasNote: boolean;
  onEditNote(): void;
  onSelectComponent(id: string | null): void;
  onSelectPin(id: string): void;
  onLocate(id: string): void;
  onSearchActivated(row: SearchRow): void;
}

/** The board canvas with its overlays. Pointer-rate values (zoom, rotation, measurement) come from the status store, so this pane never re-renders for them. */
export function BoardPane(props: BoardPaneProps) {
  const { api, side, onSide, netVisible, onNetVisible, measure, onMeasure, viewCommand, command, initialCamera, onCameraRestore, onCameraChange, settings, onSettings, theme, focusLayout, searchRef, recentSelections, hasNote, onEditNote, onSelectComponent, onSelectPin, onLocate, onSearchActivated } = props;
  const { t, fmt, language } = useUi();
  const { state, statusStore } = api;
  const board = state.board!;
  const index = indexOfState(state)!;
  const { selection } = state;
  return <main className="canvas-pane" aria-label={t('canvas.region')} data-testid="board-pane">
    <BoardCanvas board={board} index={index} side={side} selectedComponentId={selection.componentId} selectedPinId={selection.pinId} selectedNet={netVisible ? selection.net : null} showLabels={settings.showLabels} showConnections={settings.showConnections}
      measureMode={measure} viewCommand={viewCommand} initialCamera={initialCamera} onCameraRestore={onCameraRestore} onCameraChange={onCameraChange} theme={theme} motion={settings.motion} language={language} onSelectComponent={onSelectComponent} onSelectPin={onSelectPin} onStatusChange={statusStore.publish} />
    <div className="canvas-top"><div className="side-switch" aria-label={t('canvas.sideSwitch')}><button type="button" aria-pressed={side === 'top'} data-testid="side-top" onClick={() => onSide('top')}><Layers2 size={15} />{t('side.top')}</button><button type="button" aria-pressed={side === 'bottom'} data-testid="side-bottom" onClick={() => onSide('bottom')}>{t('side.bottom')}</button></div>
      <div className="canvas-meta"><span data-testid="side-label">{t(side === 'top' ? 'canvas.sideLabelTop' : 'canvas.sideLabelBottom')}</span><LiveRotation store={statusStore} /><span>2D</span></div></div>
    {focusLayout && <FocusSearch api={api} inputRef={searchRef} onActivated={onSearchActivated} />}
    {measure && <div className="mode-pill" data-testid="measure-pill"><Ruler size={14} /><LiveMeasurement store={statusStore} fmt={fmt} prompt={t('measure.prompt')} /><button type="button" aria-label={t('measure.finish')} onClick={() => onMeasure(false)}><X size={14} /></button></div>}
    {focusLayout && recentSelections.length > 0 && <div className="quick-parts">{recentSelections.map(id => { const c = index.componentById.get(id); return c && <button type="button" key={id} className={'quick-part mono' + (id === selection.componentId ? ' selected' : '')} onClick={() => onLocate(id)}>{c.ref}</button>; })}</div>}
    <div className="canvas-bottom">
      <div className="tool-group"><Tool label={t('tool.zoomOut')} shortcut="−" onClick={() => command('zoom-out')}><Minus size={16} /></Tool><LiveZoom store={statusStore} /><Tool label={t('tool.zoomIn')} shortcut="+" onClick={() => command('zoom-in')}><Plus size={16} /></Tool><span className="tool-divider" /><Tool label={t('tool.fit')} shortcut="F" testId="fit-tool" onClick={() => command('fit')}><Scan size={16} /></Tool><Tool label={t('tool.rotate')} shortcut="R" onClick={() => command('rotate')}><RotateCw size={16} /></Tool></div>
      <div className="tool-group canvas-secondary-tools"><Tool label={t('tool.netHighlight')} active={netVisible && !!selection.net} disabled={!selection.net} onClick={() => onNetVisible(!netVisible)}><Route size={16} /></Tool><Tool label={t('tool.measure')} shortcut="M" testId="measure-tool" active={measure} onClick={() => onMeasure(!measure)}><Ruler size={16} /></Tool><Tool label={t('tool.labels')} shortcut="L" active={settings.showLabels} onClick={() => onSettings({ showLabels: !settings.showLabels })}><Tags size={16} /></Tool><Tool label={t('common.note')} shortcut="N" testId="note-tool-canvas" disabled={!selection.componentId} active={hasNote} onClick={onEditNote}><StickyNote size={16} /></Tool></div>
    </div>
  </main>;
}
