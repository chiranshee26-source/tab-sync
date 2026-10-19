import { useLayoutEffect } from 'react';
import { applyToDocument } from '../preferences';
import { isoDate } from '../schema';
import { TabDot } from './components/common';
import { Icon, type IconName } from './icons';
import { WHAT, useModel, type SyncState } from './model';
import { href, useRoute, type Page } from './router';
import { DiaryPage } from './pages/Diary';
import { NotesPage } from './pages/Notes';
import { ReadingPage } from './pages/Reading';
import { SettingsPage } from './pages/Settings';
import { TasksPage } from './pages/Tasks';
import { TodayPage } from './pages/Today';
import type { MessageKey } from '../i18n';

export const NAV: { page: Page; icon: IconName; label: MessageKey }[] = [
  { page: 'today', icon: 'home', label: 'navToday' },
  { page: 'tasks', icon: 'tasks', label: 'navTasks' },
  { page: 'reading', icon: 'book', label: 'navReading' },
  { page: 'notes', icon: 'note', label: 'navNotes' },
  { page: 'diary', icon: 'diary', label: 'navDiary' },
  { page: 'settings', icon: 'settings', label: 'navSettings' },
];

const STATUS_LABEL: Record<SyncState, MessageKey> = {
  alone: 'statusAlone',
  synced: 'statusSynced',
  syncing: 'statusSyncing',
};

export function App() {
  const model = useModel();
  const { store, t } = model;
  const prefs = store.prefs;
  const route = useRoute();

  useLayoutEffect(() => {
    applyToDocument(prefs);
    document.title = `Daybook · ${t(NAV.find((item) => item.page === route.page)!.label)}`;
  });

  const counts: Partial<Record<Page, number>> = {
    tasks: store.list('task').filter((task) => !task.done).length,
    reading: store.list('reading').filter((item) => item.status !== 'finished').length,
  };
  const state = model.syncState;
  const tabCount = store.peerStates.filter((peer) => !peer.outdated).length + 1;

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href={href('today')}>
          <span className="logo">
            <Icon name="logo" />
          </span>
          <span className="brand-name">Daybook</span>
        </a>
        <nav className="nav" aria-label="Daybook">
          {NAV.map((item) => (
            <a
              key={item.page}
              href={item.page === 'diary' ? href('diary', isoDate()) : href(item.page)}
              className="nav-link"
              aria-current={route.page === item.page ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{t(item.label)}</span>
              {counts[item.page] ? <span className="nav-count">{counts[item.page]}</span> : null}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <a className="sync-pill" data-state={state} href={href('settings')} role="status">
            <span className="sync-dot" />
            <span>
              {t(STATUS_LABEL[state])} · {tabCount}
            </span>
          </a>
          <button
            type="button"
            className="icon-button"
            onClick={() => store.setPref('theme', prefs.theme === 'dark' ? 'light' : 'dark')}
            aria-label={t('darkMode')}
            aria-pressed={prefs.theme === 'dark'}
            title={t('darkMode')}
          >
            <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      </aside>

      <main className="main">
        {store.newerBuildAvailable && (
          <div className="update-banner" role="alert">
            <Icon name="sync" />
            <span>{t('updateAvailable')}</span>
            <button type="button" className="button button-sm button-primary" onClick={() => location.reload()}>
              {t('reload')}
            </button>
          </div>
        )}
        {route.page === 'today' && <TodayPage />}
        {route.page === 'tasks' && <TasksPage />}
        {route.page === 'reading' && <ReadingPage />}
        {route.page === 'notes' && <NotesPage noteId={route.param} />}
        {route.page === 'diary' && <DiaryPage date={route.param ?? isoDate()} />}
        {route.page === 'settings' && <SettingsPage />}
      </main>

      <div className="toasts" aria-live="polite">
        {model.toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <TabDot id={toast.tab} />
            <span className="toast-text">
              {t('logRemote', { tab: toast.tab, what: toast.kinds.map((kind) => t(WHAT[kind])).join(', ') })}
            </span>
            <button
              type="button"
              className="toast-close"
              aria-label={t('dismiss')}
              onClick={() => model.dismissToast(toast.id)}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
