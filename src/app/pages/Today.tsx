import type { MessageKey } from '../../i18n';
import { isoDate, type DiaryEntry } from '../../schema';
import { AlmanacScene, FallingLeaves, phaseOf, type Phase } from '../components/AlmanacScene';
import { EmptyState, Flash } from '../components/common';
import { SyncedTextarea } from '../components/SyncedText';
import { formatRelative, parseIsoDate, shiftDate } from '../format';
import { useImageUrl, useNow } from '../hooks';
import { Icon } from '../icons';
import { useModel } from '../model';
import { href } from '../router';
import { MOOD_EMOJI, MoodPicker } from './Diary';
import { createNote, snippet } from './Notes';
import { ReadingRow } from './Reading';
import { AddTaskForm, sortTasks, TaskRow } from './Tasks';

const PHASE_LABEL: Record<Phase, MessageKey> = {
  dawn: 'phaseDawn',
  day: 'phaseDay',
  golden: 'phaseGolden',
  dusk: 'phaseDusk',
  night: 'phaseNight',
};

function greetingKey(hour: number) {
  if (hour >= 5 && hour < 12) return 'greetingMorning' as const;
  if (hour >= 12 && hour < 18) return 'greetingAfternoon' as const;
  return 'greetingEvening' as const;
}

function dayOfYear(date: Date): { day: number; total: number } {
  const start = new Date(date.getFullYear(), 0, 1);
  const day = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - start.getTime()) / 86_400_000) + 1;
  const total = new Date(date.getFullYear(), 1, 29).getMonth() === 1 ? 366 : 365;
  return { day, total };
}

const hasContent = (entry?: DiaryEntry) => Boolean(entry && (entry.body.trim() || entry.mood));

function Hero() {
  const { store, t } = useModel();
  const now = useNow();
  const language = store.prefs.language;
  const photo = useImageUrl(store.appearance.image);
  const phase = phaseOf(now);
  const { day, total } = dayOfYear(now);

  return (
    <section className="hero" data-phase={phase} data-photo={photo ? '' : undefined}>
      {photo ? <img className="hero-photo" src={photo} alt="" /> : <AlmanacScene now={now} />}
      {!photo && <FallingLeaves />}
      <div className="hero-scrim" />
      <div className="hero-content">
        <p className="hero-greeting">{t(greetingKey(now.getHours()))}</p>
        <h1 className="hero-date">
          <span className="hero-weekday">{new Intl.DateTimeFormat(language, { weekday: 'long' }).format(now)}</span>
          <span className="hero-daymonth">
            {new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long' }).format(now)}
          </span>
        </h1>
        <p className="hero-meta">
          <span>{t('dayOfYear', { day: String(day), total: String(total) })}</span>
          <span aria-hidden="true">·</span>
          <span>{t(PHASE_LABEL[phase])}</span>
        </p>
      </div>
    </section>
  );
}

function JournalCard({ date }: { date: string }) {
  const model = useModel();
  const { store, t } = model;
  const entry = store.get('diary', date);
  const words = entry?.body.trim() ? entry.body.trim().split(/\s+/).length : 0;
  return (
    <section className="card journal">
      <Flash count={model.flashCount(`diary:${date}`)} />
      <div className="journal-head">
        <h2>{t('todayEntry')}</h2>
        <MoodPicker date={date} />
      </div>
      <SyncedTextarea
        className="journal-page"
        rows={9}
        placeholder={t('diaryPlaceholder')}
        aria-label={t('todayEntry')}
        value={entry?.body ?? ''}
        onValue={(body) => store.update('diary', date, { body, updatedAt: Date.now() })}
      />
      <div className="journal-foot">
        <span>{t('wordCount', { count: String(words) })}</span>
        <a className="link" href={href('diary', date)}>
          {t('openDiary')}
        </a>
      </div>
    </section>
  );
}

function WeekCard({ today }: { today: string }) {
  const { store, t } = useModel();
  const language = store.prefs.language;
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(today, i - 6));

  // Consecutive days with an entry, ending today (or yesterday, if today is still blank).
  let streak = 0;
  let cursor = hasContent(store.get('diary', today)) ? today : shiftDate(today, -1);
  while (hasContent(store.get('diary', cursor))) {
    streak++;
    cursor = shiftDate(cursor, -1);
  }

  const memories: [number, MessageKey][] = [
    [365, 'onThisDayYear'],
    [30, 'onThisDayMonth'],
    [7, 'onThisDayWeek'],
  ];
  const memory = memories
    .map(([days, label]) => ({ date: shiftDate(today, -days), label }))
    .find(({ date }) => store.get('diary', date)?.body.trim());

  return (
    <section className="card week">
      <h2>{t('yourWeek')}</h2>
      <ol className="mood-week">
        {days.map((date) => {
          const entry = store.get('diary', date);
          return (
            <li key={date}>
              <a href={href('diary', date)} aria-current={date === today ? 'date' : undefined}>
                <span className="mood-week-day">
                  {new Intl.DateTimeFormat(language, { weekday: 'narrow' }).format(parseIsoDate(date))}
                </span>
                <span className="mood-week-dot" data-filled={hasContent(entry) || undefined}>
                  {entry?.mood ? MOOD_EMOJI[entry.mood] : ''}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
      <p className="streak">
        <Icon name="leaf" />
        {streak > 0 ? t('streak', { count: String(streak) }) : t('streakNone')}
      </p>
      {memory && (
        <a className="memory" href={href('diary', memory.date)}>
          <span className="eyebrow">{t(memory.label)}</span>
          <span className="memory-text" dir="auto">
            “{snippet(store.get('diary', memory.date)!.body, 110)}”
          </span>
        </a>
      )}
    </section>
  );
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
      <Hero />

      <div className="today-top">
        <JournalCard date={today} />
        <WeekCard today={today} />
      </div>

      <div className="today-grid">
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

        <div className="column">
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
                    <span className="muted small" dir="auto">
                      {snippet(note.body, 60) || '—'}
                    </span>
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
      </div>
    </>
  );
}
