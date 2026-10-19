import { useState, type FormEvent } from 'react';
import type { MessageKey } from '../../i18n';
import { READING_STATUSES, newId, recordKey, type ReadingItem, type ReadingStatus } from '../../schema';
import { DeleteButton, EmptyState, Flash, PageHeader } from '../components/common';
import { hostnameOf, isSafeUrl, normalizeUrl } from '../format';
import { Icon } from '../icons';
import { useModel } from '../model';

export const STATUS_LABEL: Record<ReadingStatus, MessageKey> = {
  toRead: 'statusToRead',
  reading: 'statusReading',
  finished: 'statusFinished',
};

type Filter = ReadingStatus | 'all';

function AddReadingForm() {
  const { store, t } = useModel();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const link = normalizeUrl(url);
    const name = title.trim() || hostnameOf(link);
    if (!name) return;
    store.update('reading', newId(), { title: name, url: link, createdAt: Date.now() });
    setTitle('');
    setUrl('');
  };
  return (
    <form className="add-form" onSubmit={submit}>
      <input
        dir="auto"
        className="input grow"
        placeholder={t('readingTitlePlaceholder')}
        aria-label={t('readingTitlePlaceholder')}
        value={title}
        maxLength={500}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        dir="auto"
        className="input grow"
        type="url"
        inputMode="url"
        placeholder={t('readingUrlPlaceholder')}
        aria-label={t('readingUrlPlaceholder')}
        value={url}
        maxLength={2000}
        onChange={(event) => setUrl(event.target.value)}
      />
      <button type="submit" className="button button-primary" disabled={!title.trim() && !url.trim()}>
        <Icon name="plus" />
        {t('add')}
      </button>
    </form>
  );
}

export function ReadingRow({ item }: { item: ReadingItem & { id: string } }) {
  const model = useModel();
  const { store, t } = model;
  const host = hostnameOf(item.url);
  return (
    <li className={`item-row reading-row status-${item.status}`}>
      <Flash count={model.flashCount(recordKey('reading', item.id))} />
      <span className="reading-icon">
        <Icon name={item.url ? 'link' : 'book'} />
      </span>
      <div className="reading-text">
        {isSafeUrl(item.url) ? (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="reading-title" dir="auto">
            {item.title}
          </a>
        ) : (
          <span className="reading-title" dir="auto">{item.title}</span>
        )}
        {host && <span className="muted small">{host}</span>}
      </div>
      <select
        className="select select-sm"
        value={item.status}
        aria-label={t('status')}
        onChange={(event) => store.update('reading', item.id, { status: event.target.value as ReadingStatus })}
      >
        {READING_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(STATUS_LABEL[status])}
          </option>
        ))}
      </select>
      <DeleteButton onConfirm={() => store.remove('reading', item.id)} />
    </li>
  );
}

export function ReadingPage() {
  const { store, t } = useModel();
  const [filter, setFilter] = useState<Filter>('all');
  const items = store.list('reading').sort((a, b) => b.createdAt - a.createdAt);
  const visible = filter === 'all' ? items : items.filter((item) => item.status === filter);
  const count = (status: Filter) => (status === 'all' ? items.length : items.filter((i) => i.status === status).length);

  return (
    <>
      <PageHeader title={t('navReading')} subtitle={t('readingSubtitle')} />
      <section className="card">
        <AddReadingForm />
        <div className="segmented" role="group" aria-label={t('status')}>
          {(['all', ...READING_STATUSES] as Filter[]).map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={filter === status}
              onClick={() => setFilter(status)}
            >
              {t(status === 'all' ? 'all' : STATUS_LABEL[status])}
              <span className="count">{count(status)}</span>
            </button>
          ))}
        </div>
        {visible.length > 0 ? (
          <ul className="item-list">
            {visible.map((item) => (
              <ReadingRow key={item.id} item={item} />
            ))}
          </ul>
        ) : (
          <EmptyState icon="book">{t('noReading')}</EmptyState>
        )}
      </section>
    </>
  );
}
