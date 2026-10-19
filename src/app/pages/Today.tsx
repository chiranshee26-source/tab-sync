import { isoDate } from '../../schema';
import { EmptyState } from '../components/common';
import { formatLongDate, formatRelative } from '../format';
import { Icon } from '../icons';
import { useModel } from '../model';
import { href } from '../router';
import { DiaryEditor } from './Diary';
import { createNote, snippet } from './Notes';
import { ReadingRow } from './Reading';
import { AddTaskForm, sortTasks, TaskRow } from './Tasks';

function greetingKey(hour: number) {
  if (hour < 12) return 'greetingMorning' as const;
  if (hour < 18) return 'greetingAfternoon' as const;
  return 'greetingEvening' as const;
}

export function TodayPage() {
  const { store, t } = useModel();
  const today = isoDate();
  const language = store.prefs.language;
  const openTasks = sortTasks(store.list('task').filter((task) => !task.done));
  const reading = store.list('reading').filter((item) => item.status === 'reading');
  const notes = store
    .list('note')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  return (
    <>
      <header className="page-header today-hero">
        <div>
          <p className="eyebrow">{formatLongDate(language, today)}</p>
          <h1>{t(greetingKey(new Date().getHours()))}</h1>
          <p className="subtitle">{t('todaySubtitle')}</p>
        </div>
      </header>

      <div className="dashboard">
        <section className="card card-diary">
          <div className="card-head">
            <h2>{t('todayEntry')}</h2>
            <a className="link" href={href('diary', today)}>
              {t('openDiary')}
            </a>
          </div>
          <DiaryEditor date={today} rows={6} />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              {t('navTasks')} {openTasks.length > 0 && <span className="count">{openTasks.length}</span>}
            </h2>
            <a className="link" href={href('tasks')}>
              {t('viewAll')}
            </a>
          </div>
          <AddTaskForm withDueDate={false} />
          {openTasks.length > 0 ? (
            <ul className="item-list">
              {openTasks.slice(0, 6).map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          ) : (
            <EmptyState icon="tasks">{t('noTasks')}</EmptyState>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>{t('readingNow')}</h2>
            <a className="link" href={href('reading')}>
              {t('viewAll')}
            </a>
          </div>
          {reading.length > 0 ? (
            <ul className="item-list">
              {reading.slice(0, 4).map((item) => (
                <ReadingRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <EmptyState icon="book">{t('nothingReading')}</EmptyState>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>{t('recentNotes')}</h2>
            <button type="button" className="button button-ghost button-sm" onClick={() => createNote(store)}>
              <Icon name="plus" />
              {t('newNote')}
            </button>
          </div>
          {notes.length > 0 ? (
            <ul className="note-links compact">
              {notes.map((note) => (
                <li key={note.id}>
                  <a href={href('notes', note.id)}>
                    <strong dir="auto">{note.title || t('untitled')}</strong>
                    <span className="muted small" dir="auto">{snippet(note.body, 60) || '—'}</span>
                    <span className="muted tiny">{formatRelative(language, note.updatedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="note">{t('noNotes')}</EmptyState>
          )}
        </section>
      </div>
    </>
  );
}
