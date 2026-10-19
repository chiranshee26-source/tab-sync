import { useEffect, useState, type ReactNode } from 'react';
import { useModel } from '../model';
import { Icon, type IconName } from '../icons';

/** Colour dot that is stable per tab id, so a tab looks the same everywhere. */
export function TabDot({ id }: { id: string }) {
  const hue = parseInt(id.slice(0, 6), 16) % 360;
  return <span className="tab-dot" style={{ '--hue': hue } as React.CSSProperties} aria-hidden="true" />;
}

/** Replays a highlight animation each time `count` increases (another tab changed this). */
export function Flash({ count }: { count: number }) {
  return count > 0 ? <span key={count} className="flash-ring" aria-hidden="true" /> : null;
}

/** Two-step delete: the first click arms it, a second click within 3 s confirms. */
export function DeleteButton({ onConfirm, label }: { onConfirm: () => void; label?: string }) {
  const { t } = useModel();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`icon-button danger${armed ? ' armed' : ''}`}
      aria-label={armed ? t('confirmDelete') : (label ?? t('delete'))}
      title={armed ? t('confirmDelete') : (label ?? t('delete'))}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      <Icon name={armed ? 'check' : 'trash'} />
      {armed && <span className="armed-label">{t('confirmDelete')}</span>}
    </button>
  );
}

export function EmptyState({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} />
      <p>{children}</p>
    </div>
  );
}

/** "Also open in tab …" for the record a page is editing. */
export function AlsoOpen({ view }: { view: string }) {
  const model = useModel();
  const others = model.store.peerStates.filter((peer) => peer.view === view && !peer.outdated);
  if (others.length === 0) return null;
  return (
    <p className="also-open" role="status">
      {others.map((peer) => (
        <TabDot key={peer.id} id={peer.id} />
      ))}
      {model.t('alsoOpenIn', { tabs: others.map((peer) => peer.id).join(', ') })}
    </p>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
