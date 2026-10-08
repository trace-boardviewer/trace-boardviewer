import { CircuitBoard } from 'lucide-react';
import type { ImportProgress } from '../../app/api';
import { useUi } from './ui-context';

export interface LoadingOverlayProps {
  phase: 'reading' | 'processing';
  progress: ImportProgress | null;
  onCancel(): void;
}

/**
 * The import in progress: what is happening, how far the parser got (when it reports it), a "taking unusually long" line once the
 * watchdog saw no progress for a while, and Cancel (the previous board, if any, stays open).
 */
export function LoadingOverlay({ phase, progress, onCancel }: LoadingOverlayProps) {
  const { t } = useUi();
  const percent = progress?.fraction === null || progress?.fraction === undefined ? null : Math.floor(progress.fraction * 100);
  const title = t(phase === 'processing' ? 'loading.processing' : 'loading.reading');
  const detail = progress?.stalled ? t('loading.stalled') : percent !== null ? t('loading.progress', { percent }) : t('loading.hint');
  return <div className="loading-overlay" role="status" data-testid="loading-overlay" data-stalled={progress?.stalled ? 'true' : undefined}>
    <div className="loading-card"><CircuitBoard size={32} /><h2>{title}</h2>
      <div className="loading-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        {percent === null ? <span /> : <span className="determinate" style={{ width: `${percent}%` }} />}
      </div>
      <p data-testid="loading-detail">{detail}</p>
      <button type="button" className="outline-button loading-cancel" data-testid="loading-cancel" onClick={onCancel}>{t('loading.cancel')}</button>
    </div>
  </div>;
}
