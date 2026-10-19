import { useState } from 'react';
import { LANGUAGE_NAMES, type MessageKey } from '../../i18n';
import { FONT_SIZE, LANGUAGES } from '../../preferences';
import { RACE_DELAY_MS } from '../../store';
import { NAV } from '../App';
import { Flash, PageHeader, TabDot } from '../components/common';
import { formatTime } from '../format';
import { Icon } from '../icons';
import { WHAT, useModel, type SyncState } from '../model';

const LATENCY_TARGET_MS = 100;

const STATUS: Record<SyncState, { title: MessageKey; icon: 'tabs' | 'check' | 'sync' }> = {
  alone: { title: 'statusAlone', icon: 'tabs' },
  synced: { title: 'statusSynced', icon: 'check' },
  syncing: { title: 'statusSyncing', icon: 'sync' },
};

function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

function Preferences() {
  const model = useModel();
  const { store, t } = model;
  const prefs = store.prefs;
  const stepFont = (delta: number) =>
    store.setPref('fontSize', Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, prefs.fontSize + delta)));

  return (
    <section className="card" aria-labelledby="prefs-heading">
      <div className="card-head">
        <h2 id="prefs-heading">{t('preferences')}</h2>
        <button type="button" className="button button-ghost button-sm" onClick={() => store.resetPrefs()}>
          <Icon name="reset" />
          {t('reset')}
        </button>
      </div>

      <div className="setting">
        <Flash count={model.flashCount('prefs.theme')} />
        <span className="setting-icon">
          <Icon name="moon" />
        </span>
        <div className="setting-text">
          <span className="setting-label" id="dark-label">
            {t('darkMode')}
          </span>
          <span className="setting-hint">{t('darkModeHint')}</span>
        </div>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={prefs.theme === 'dark'}
          aria-labelledby="dark-label"
          onClick={() => store.setPref('theme', prefs.theme === 'dark' ? 'light' : 'dark')}
        >
          <span className="switch-icon">
            <Icon name="sun" />
          </span>
          <span className="switch-icon">
            <Icon name="moon" />
          </span>
          <span className="switch-thumb" />
        </button>
      </div>

      <div className="setting">
        <Flash count={model.flashCount('prefs.language')} />
        <span className="setting-icon">
          <Icon name="globe" />
        </span>
        <div className="setting-text">
          <label className="setting-label" htmlFor="language">
            {t('language')}
          </label>
          <span className="setting-hint">{t('languageHint')}</span>
        </div>
        <div className="select-wrap">
          <select
            id="language"
            className="select"
            value={prefs.language}
            onChange={(event) => {
              const language = LANGUAGES.find((code) => code === event.target.value);
              if (language) store.setPref('language', language);
            }}
          >
            {LANGUAGES.map((code) => (
              <option key={code} value={code} lang={code}>
                {LANGUAGE_NAMES[code]}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" />
        </div>
      </div>

      <div className="setting setting-stacked">
        <Flash count={model.flashCount('prefs.fontSize')} />
        <div className="setting-row">
          <span className="setting-icon">
            <Icon name="type" />
          </span>
          <div className="setting-text">
            <label className="setting-label" htmlFor="font-size">
              {t('fontSize')}
            </label>
            <span className="setting-hint">{t('fontSizeHint')}</span>
          </div>
          <output htmlFor="font-size" className="badge">
            {prefs.fontSize}px
          </output>
        </div>
        <div className="slider-row">
          <button
            type="button"
            className="icon-button"
            aria-label={t('decrease')}
            title={t('decrease')}
            disabled={prefs.fontSize <= FONT_SIZE.min}
            onClick={() => stepFont(-FONT_SIZE.step)}
          >
            <Icon name="minus" />
          </button>
          <span className="slider-a slider-a-small" aria-hidden="true">
            A
          </span>
          <input
            id="font-size"
            type="range"
            className="range"
            min={FONT_SIZE.min}
            max={FONT_SIZE.max}
            step={FONT_SIZE.step}
            value={prefs.fontSize}
            onChange={(event) => store.setPref('fontSize', Number(event.target.value))}
          />
          <span className="slider-a slider-a-large" aria-hidden="true">
            A
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={t('increase')}
            title={t('increase')}
            disabled={prefs.fontSize >= FONT_SIZE.max}
            onClick={() => stepFont(FONT_SIZE.step)}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>
    </section>
  );
}

function SyncPanel() {
  const model = useModel();
  const { store, t } = model;
  const [racing, setRacing] = useState(false);
  const state = model.syncState;
  const peers = store.peerStates;
  const live = peers.filter((peer) => !peer.outdated);
  const samples = model.latencies;

  const viewLabel = (view?: string) => {
    if (!view) return '';
    const [page, id] = view.split('/');
    const nav = NAV.find((item) => item.page === page);
    const note = page === 'notes' && id ? store.get('note', id) : undefined;
    return [nav ? t(nav.label) : '', note ? note.title || t('untitled') : ''].filter(Boolean).join(' · ');
  };

  const metric = (label: MessageKey, ms: number) => (
    <div className="metric">
      <span className="metric-label">{t(label)}</span>
      <span className="metric-value mono" data-ok={String(ms < LATENCY_TARGET_MS)}>
        {formatMs(ms)}
      </span>
    </div>
  );

  return (
    <section className="card" aria-labelledby="sync-heading">
      <div className="card-head">
        <h2 id="sync-heading">{t('syncStatus')}</h2>
      </div>

      <div className="status-hero" data-state={state}>
        <span className="status-icon">
          <Icon name={STATUS[state].icon} />
        </span>
        <div className="status-text">
          <strong>{t(STATUS[state].title)}</strong>
          <span>{state === 'alone' ? t('aloneHint') : t('openTabsCount', { count: String(live.length + 1) })}</span>
        </div>
      </div>

      <ul className="tab-list" aria-label={t('connectedTabs')}>
        <li className="tab-chip tab-chip-self">
          <TabDot id={store.tabId} />
          <span className="mono">
            {store.tabId} ({t('you')})
          </span>
        </li>
        {peers.map((peer) => (
          <li key={peer.id} className="tab-chip" data-outdated={peer.outdated || undefined}>
            <TabDot id={peer.id} />
            <span className="mono">{peer.id}</span>
            {peer.view && <span className="muted">{viewLabel(peer.view)}</span>}
            {peer.outdated ? (
              <span className="muted">· {t('outdated')}</span>
            ) : (
              <span className={`tab-chip-state ${peer.inSync || state === 'synced' ? 'ok' : 'pending'}`}>
                <Icon name={peer.inSync || state === 'synced' ? 'check' : 'sync'} />
              </span>
            )}
          </li>
        ))}
      </ul>

      {samples.length > 0 ? (
        <div className="metrics">
          {metric('lastLatency', model.lastLatency ?? 0)}
          {metric('avgLatency', samples.reduce((a, b) => a + b, 0) / samples.length)}
          {metric('maxLatency', Math.max(...samples))}
        </div>
      ) : (
        <p className="metrics-empty">{t('noLatency')}</p>
      )}
      <p className="setting-hint metric-target">
        <Icon name="bolt" />
        {t('latencyTarget')}
      </p>

      <div className="actions">
        <button type="button" className="button" onClick={() => window.open(location.href, '_blank')}>
          <Icon name="externalTab" />
          {t('openTab')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={racing}
          onClick={() => {
            setRacing(true);
            setTimeout(() => setRacing(false), RACE_DELAY_MS + 400);
            store.startRace();
          }}
        >
          <Icon name="bolt" />
          {t('raceTest')}
        </button>
      </div>
      <p className="setting-hint">{t('raceHint')}</p>

      <details className="details">
        <summary>
          <Icon name="chevronDown" />
          {t('details')}
        </summary>
        <dl className="detail-list">
          <div>
            <dt>{t('thisTab')}</dt>
            <dd className="mono">{store.tabId}</dd>
          </div>
          <div>
            <dt>{t('transport')}</dt>
            <dd className="mono">{store.transportKind}</dd>
          </div>
          <div>
            <dt>{t('records')}</dt>
            <dd className="mono">{Object.keys(store.document).length}</dd>
          </div>
          <div>
            <dt>{t('fingerprint')}</dt>
            <dd>
              <code className="fingerprint" data-testid="fingerprint">
                {store.fingerprint}
              </code>
            </dd>
          </div>
        </dl>
        <p className="setting-hint">{t('fingerprintHint')}</p>
      </details>
    </section>
  );
}

function ActivityLog() {
  const model = useModel();
  const { store, t } = model;
  return (
    <section className="card" aria-labelledby="activity-heading">
      <div className="card-head">
        <h2 id="activity-heading">{t('activity')}</h2>
      </div>
      {model.log.length === 0 ? (
        <p className="muted">{t('emptyLog')}</p>
      ) : (
        <ol className="log">
          {model.log.map((entry) => (
            <li key={entry.id} className={`log-item log-${entry.message}`}>
              <time className="log-time mono">{formatTime(store.prefs.language, entry.time)}</time>
              {entry.tab ? <TabDot id={entry.tab} /> : <span className="tab-dot tab-dot-none" />}
              <span className="log-text">
                {t(entry.message, {
                  tab: entry.tab === store.tabId ? t('you') : (entry.tab ?? ''),
                  what: entry.kinds.map((kind) => t(WHAT[kind])).join(', '),
                })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { t } = useModel();
  return (
    <>
      <PageHeader title={t('navSettings')} subtitle={t('settingsSubtitle')} />
      <div className="settings-layout">
        <div className="column">
          <Preferences />
          <ActivityLog />
        </div>
        <SyncPanel />
      </div>
    </>
  );
}
