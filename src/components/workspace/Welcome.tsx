import { ArrowUpRight, ChevronRight, CircuitBoard, Clock3, FileBox, FolderOpen, Keyboard, Route, Ruler, Search } from 'lucide-react';
import { version as appVersion } from '../../../package.json';
import { SUPPORTED_EXTENSIONS } from '../../lib/formats';
import type { RecentFile } from '../../lib/types';
import { useUi } from './ui-context';

export const DROP_HINT = `${SUPPORTED_EXTENSIONS.slice(0, 6).join(' · ')} …`;

export function Welcome({ recents, onOpen, onRecent, onHelp }: { recents: readonly RecentFile[]; onOpen(): void; onRecent(path: string): void; onHelp(): void }) {
  const { t, fmt } = useUi();
  return <main className="welcome" data-testid="welcome"><div className="welcome-pattern" aria-hidden="true" /><div className="welcome-main"><span className="welcome-eyebrow">{t('welcome.eyebrow')}</span><h1>{t('welcome.title1')}<br /><span>{t('welcome.title2')}</span></h1><p>{t('welcome.lead1')}<br />{t('welcome.lead2')}</p><button type="button" className="primary-button welcome-open" data-testid="welcome-open" onClick={onOpen}><FolderOpen size={19} />{t('welcome.open')}<ArrowUpRight size={17} /></button><span className="welcome-filehint">{t('welcome.fileHint')}</span><div className="welcome-features"><span><Search size={15} />{t('welcome.featureSearch')}</span><span><Route size={15} />{t('welcome.featureNets')}</span><span><Ruler size={15} />{t('welcome.featureMeasure')}</span></div></div>
    <aside className="welcome-side"><div className="welcome-board-art" aria-hidden="true"><CircuitBoard strokeWidth={0.6} size={190} /><span className="art-dot art-dot-one" /><span className="art-dot art-dot-two" /></div><div className="recent-section"><div className="pane-title"><span>{t('welcome.recentTitle')}</span><Clock3 size={15} /></div>{recents.length ? recents.slice(0, 4).map(recent => <button type="button" className="recent-row" key={recent.path} onClick={() => onRecent(recent.path)}><FileBox size={19} /><span><strong>{recent.name.replace(/\.[^.]+$/, '')}</strong><small>{fmt.date(recent.openedAt)}</small></span><ChevronRight size={16} /></button>) : <div className="recent-empty">{t('welcome.recentEmpty')}</div>}</div></aside>
    <footer className="welcome-footer"><span><span className="status-dot" />{t('welcome.footerLocal')}</span><button type="button" onClick={onHelp}><Keyboard size={14} />{t('welcome.shortcuts')}</button><span className="mono">TRACE {appVersion}</span></footer></main>;
}
