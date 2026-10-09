import { Bug, CircuitBoard, SquareSplitHorizontal, Copy, FileBox, FolderOpen, Heart, Languages, Maximize2, Minus, PanelLeft, PanelRight, Settings2, Square, X } from 'lucide-react';
import { memo, useRef, type KeyboardEvent } from 'react';
import type { WorkspaceTab } from '../../lib/documents';
import type { Translator } from '../../lib/i18n';
import type { TraceDesktop } from '../../lib/types';
import { SUPPORT_BUTTON_KEY } from '../../lib/support-notice';
import { modifierLabels } from './shortcuts';
import { Tool } from './ui';
import './workspace.css';
import './support-button.css';

// i18n: pending
const T = {
  tabs: 'Workspace tabs', board: 'Board', schematic: 'Schematic', documents: 'Documents', split: 'Split view', splitOff: 'Split view (off)', panels: 'Search panel', inspector: 'Inspector panel',
};
const TABS: ReadonlyArray<{ id: WorkspaceTab; label: string }> = [{ id: 'board', label: T.board }, { id: 'schematic', label: T.schematic }, { id: 'documents', label: T.documents }];

export interface TopBarProps {
  t: Translator;
  hasBoard: boolean;
  boardName: string; format: string; fileName: string; filePath: string; componentCount: number; layoutName: string;
  activeTab: WorkspaceTab; splitEnabled: boolean; documentCount: number; schematicCount: number;
  focusLayout: boolean; leftOpen: boolean; rightOpen: boolean; maximized: boolean; desktop: TraceDesktop | undefined;
  onTab(tab: WorkspaceTab): void; onSplit(): void; onOpen(): void; onHome(): void; onToggleFocus(): void; onSettings(focus?: string): void; onPanels(which: 'left' | 'right'): void;
  /** Opens the local in-app bug report form. */
  onReportBug(): void;
  /** Opens the skippable support dialog (the heart button). */
  onSupport(): void;
  supportHidden?: boolean;
}

/** Short badge form of a format label: its first word ("GENCAD 1.4" → GENCAD, "Landrex / TestLink BRD" → LANDREX). */
const formatBadge = (format: string) => (format.trim().split(/[\s/]+/)[0] || format).toUpperCase().slice(0, 12);

export const TopBar = memo(function TopBar(p: TopBarProps) {
  const { t } = p;
  const { mod } = modifierLabels();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (move === null) return;
    event.preventDefault();
    const next = (move + TABS.length) % TABS.length;
    tabRefs.current[next]?.focus(); p.onTab(TABS[next].id);
  };
  return <header className="app-titlebar">
    <button type="button" className="brand" onClick={p.onHome} title={t('brand.home')}><span className="brand-mark"><CircuitBoard size={20} /></span><span><strong>TRACE</strong><small>BOARDVIEWER</small></span></button>
    {p.hasBoard ? <div className="project-heading" title={p.filePath || p.fileName}><FileBox size={17} /><div><span className="project-name" data-testid="project-name">{p.boardName}</span><span className="project-subtitle">{p.fileName ? `${p.fileName} · ` : ''}{t('unit.components', { count: p.componentCount })} · {p.layoutName}</span></div><span className="format-badge" title={p.format} data-testid="format-badge">{formatBadge(p.format)}</span></div> : <div className="titlebar-caption">{t('header.tagline')}</div>}
    {p.hasBoard && <div className="wsp-tabs" role="tablist" aria-label={T.tabs} data-testid="tabs">
      {TABS.map((tab, index) => <button key={tab.id} ref={node => { tabRefs.current[index] = node; }} type="button" role="tab" id={`wsp-tab-${tab.id}`} aria-selected={p.activeTab === tab.id} aria-controls="wsp-tabpanel" tabIndex={p.activeTab === tab.id ? 0 : -1} data-testid={`tab-${tab.id}`}
        className={'wsp-tab-button' + (p.activeTab === tab.id ? ' active' : '')} onClick={() => p.onTab(tab.id)} onKeyDown={e => onTabKey(e, index)}>
        {tab.label}{tab.id === 'documents' && p.documentCount > 0 && <span className="wsp-tab-count mono">{p.documentCount}</span>}{tab.id === 'schematic' && p.schematicCount > 0 && <span className="wsp-tab-count mono">{p.schematicCount}</span>}</button>)}
    </div>}
    <div className="header-actions">
      {p.hasBoard && <><Tool label={T.split} shortcut={`${mod} + \\`} testId="split-toggle" active={p.splitEnabled} onClick={p.onSplit}><SquareSplitHorizontal size={18} /></Tool>
        {!p.focusLayout && <Tool label={T.panels} testId="toggle-left" active={p.leftOpen} onClick={() => p.onPanels('left')} className="wsp-panel-toggle"><PanelLeft size={17} /></Tool>}
        <Tool label={T.inspector} testId="toggle-right" active={p.rightOpen} onClick={() => p.onPanels('right')} className="wsp-panel-toggle"><PanelRight size={17} /></Tool></>}
      <button type="button" className="open-button" data-testid="open-board" onClick={p.onOpen} title={`${t('header.openTitle')} · ${mod} + O`}><FolderOpen size={16} /><span>{t('header.open')}</span></button>
      {p.hasBoard && <Tool label={t(p.focusLayout ? 'header.workshopMode' : 'header.focusMode')} shortcut={`${mod} + ${p.focusLayout ? '1' : '2'}`} testId="focus-toggle" active={p.focusLayout} onClick={p.onToggleFocus}>{p.focusLayout ? <PanelLeft size={18} /> : <Maximize2 size={18} />}</Tool>}
      {!p.supportHidden && <Tool label={t(SUPPORT_BUTTON_KEY)} testId="support-button" className="support-heart" onClick={p.onSupport}><Heart size={17} /></Tool>}
      <Tool label={t('support.bug')} testId="report-bug-button" onClick={p.onReportBug}><Bug size={17} /></Tool>
      <Tool label={t('settings.language')} testId="language-button" onClick={() => p.onSettings('#language-select')}><Languages size={17} /></Tool>
      <Tool label={t('header.settings')} testId="settings-button" onClick={() => p.onSettings()}><Settings2 size={17} /></Tool>
    </div>
    {p.desktop && <div className="window-controls"><button type="button" aria-label={t('window.minimize')} onClick={() => p.desktop!.minimize()}><Minus size={15} /></button><button type="button" aria-label={p.maximized ? t('window.restore') : t('window.maximize')} onClick={() => p.desktop!.maximize()}>{p.maximized ? <Copy size={12} /> : <Square size={12} />}</button><button type="button" className="window-close" aria-label={t('window.close')} onClick={() => p.desktop!.close()}><X size={17} /></button></div>}
  </header>;
});
