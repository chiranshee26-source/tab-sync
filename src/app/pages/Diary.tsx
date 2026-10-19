import type { MessageKey } from '../../i18n';
import { ITEM_DEFAULTS, MOODS, isoDate, recordKey, type Mood } from '../../schema';
import { AlsoOpen, EmptyState, Flash, PageHeader } from '../components/common';
import { SyncedTextarea } from '../components/SyncedText';
import { formatLongDate, shiftDate } from '../format';
import { Icon } from '../icons';
import { useModel } from '../model';
import { href } from '../router';
import { snippet } from './Notes';

export const MOOD_EMOJI: Record<Mood, string> = { great: '😄', good: '🙂', okay: '😐', low: '😕', bad: '😞' };
const MOOD_LABEL: Record<Mood, MessageKey> = {
  great: 'moodGreat',
  good: 'moodGood',
  okay: 'moodOkay',
  low: 'moodLow',
  bad: 'moodBad',
};

export function MoodPicker({ date }: { date: string }) {
  const { store, t } = useModel();
  const mood = (store.get('diary', date) ?? ITEM_DEFAULTS.diary).mood;
  return (
    <div className="mood-picker" role="group" aria-label={t('mood')}>
      {MOODS.map((option) => (
        <button
          key={option}
          type="button"
          className="mood"
          aria-pressed={mood === option}
          aria-label={t(MOOD_LABEL[option])}
          title={t(MOOD_LABEL[option])}
          // Clicking the selected mood clears it.
          onClick={() => store.update('diary', date, { mood: mood === option ? '' : option, updatedAt: Date.now() })}
        >
          <span aria-hidden="true">{MOOD_EMOJI[option]}</span>
        </button>
      ))}
    </div>
  );
}

export function DiaryEditor({ date, rows = 12 }: { date: string; rows?: number }) {
  const model = useModel();
  const { store, t } = model;
  const entry = store.get('diary', date) ?? ITEM_DEFAULTS.diary;
  return (
    <div className="diary-editor">
      <Flash count={model.flashCount(recordKey('diary', date))} />
      <MoodPicker date={date} />
      <SyncedTextarea
        key={date}
        className="journal-page"
        rows={rows}
        placeholder={t('diaryPlaceholder')}
        aria-label={t('diaryPlaceholder')}
        value={entry.body}
        onValue={(body) => store.update('diary', date, { body, updatedAt: Date.now() })}
      />
    </div>
  );
}

export function DiaryPage({ date }: { date: string }) {
  const { store, t } = useModel();
  const today = isoDate();
  const language = store.prefs.language;
  const entries = store
    .list('diary')
    .filter((entry) => entry.body.trim() || entry.mood)
    .sort((a, b) => b.id.localeCompare(a.id));

  return (
    <>
      <PageHeader title={t('navDiary')} subtitle={t('diarySubtitle')} />
      <div className="diary-layout">
        <section className="card">
          <div className="diary-nav">
            <a className="icon-button" href={href('diary', shiftDate(date, -1))} aria-label={t('previousDay')} title={t('previousDay')}>
              <Icon name="chevronLeft" className="flip-rtl" />
            </a>
            <h2 className="grow">{formatLongDate(language, date)}</h2>
            {date !== today && (
              <a className="button button-sm" href={href('diary', today)}>
                {t('goToday')}
              </a>
            )}
            <a className="icon-button" href={href('diary', shiftDate(date, 1))} aria-label={t('nextDay')} title={t('nextDay')}>
              <Icon name="chevronRight" className="flip-rtl" />
            </a>
          </div>
          <AlsoOpen view={`diary/${date}`} />
          <DiaryEditor date={date} />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>{t('pastEntries')}</h2>
          </div>
          {entries.length > 0 ? (
            <ul className="entry-links">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <a href={href('diary', entry.id)} aria-current={entry.id === date ? 'page' : undefined}>
                    <span className="entry-mood" aria-hidden="true">
                      {entry.mood ? MOOD_EMOJI[entry.mood] : '·'}
                    </span>
                    <span className="entry-text">
                      <strong>{formatLongDate(language, entry.id)}</strong>
                      <span className="muted small" dir="auto">{snippet(entry.body, 70) || '—'}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="diary">{t('noEntries')}</EmptyState>
          )}
        </section>
      </div>
    </>
  );
}
