import { useState } from 'react';
import { newId, recordKey } from '../../schema';
import { AlsoOpen, DeleteButton, EmptyState, Flash, PageHeader } from '../components/common';
import { SyncedInput, SyncedTextarea } from '../components/SyncedText';
import { formatRelative } from '../format';
import { Icon } from '../icons';
import { useModel } from '../model';
import { href, navigate } from '../router';

export function createNote(store: ReturnType<typeof useModel>['store']): void {
  const id = newId();
  const now = Date.now();
  store.update('note', id, { createdAt: now, updatedAt: now });
  navigate('notes', id);
}

export function snippet(text: string, length = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

function NoteEditor({ id }: { id: string }) {
  const model = useModel();
  const { store, t } = model;
  const note = store.get('note', id)!;
  const edit = (fields: { title?: string; body?: string }) => store.update('note', id, { ...fields, updatedAt: Date.now() });

  return (
    <>
      <div className="editor-toolbar">
        <a className="button button-ghost button-sm only-mobile" href={href('notes')}>
          <Icon name="chevronLeft" className="flip-rtl" />
          {t('allNotes')}
        </a>
        <span className="muted small grow">{t('edited', { time: formatRelative(store.prefs.language, note.updatedAt) })}</span>
        <a className="button button-sm" href={href('notes', id)} target="_blank" rel="noopener">
          <Icon name="externalTab" />
          {t('openInNewTab')}
        </a>
        <DeleteButton
          onConfirm={() => {
            store.remove('note', id);
            navigate('notes');
          }}
        />
      </div>
      <AlsoOpen view={`notes/${id}`} />
      <div className="editor-fields">
        <Flash count={model.flashCount(recordKey('note', id))} />
        <SyncedInput
          className="editor-title"
          placeholder={t('noteTitlePlaceholder')}
          aria-label={t('noteTitlePlaceholder')}
          value={note.title}
          maxLength={500}
          onValue={(title) => edit({ title })}
        />
        <SyncedTextarea
          className="editor-body"
          placeholder={t('notePlaceholder')}
          aria-label={t('notePlaceholder')}
          value={note.body}
          onValue={(body) => edit({ body })}
        />
      </div>
    </>
  );
}

export function NotesPage({ noteId }: { noteId?: string }) {
  const model = useModel();
  const { store, t } = model;
  const [query, setQuery] = useState('');
  const notes = store.list('note').sort((a, b) => b.updatedAt - a.updatedAt);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? notes.filter((note) => `${note.title}\n${note.body}`.toLowerCase().includes(needle))
    : notes;
  const current = noteId ? store.get('note', noteId) : undefined;
  const exists = current !== undefined && !current.deleted;

  return (
    <>
      <PageHeader title={t('navNotes')} subtitle={t('notesSubtitle')}>
        <button type="button" className="button button-primary" onClick={() => createNote(store)}>
          <Icon name="plus" />
          {t('newNote')}
        </button>
      </PageHeader>
      <div className="notes-layout" data-has-note={noteId ? 'true' : undefined}>
        <section className="card notes-list" aria-label={t('navNotes')}>
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              placeholder={t('searchNotes')}
              aria-label={t('searchNotes')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {visible.length > 0 ? (
            <ul className="note-links">
              {visible.map((note) => (
                <li key={note.id}>
                  <a href={href('notes', note.id)} aria-current={note.id === noteId ? 'page' : undefined}>
                    <Flash count={model.flashCount(recordKey('note', note.id))} />
                    <strong dir="auto">{note.title || t('untitled')}</strong>
                    <span className="muted small" dir="auto">{snippet(note.body) || '—'}</span>
                    <span className="muted tiny">{formatRelative(store.prefs.language, note.updatedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="note">{needle ? t('noMatches') : t('noNotes')}</EmptyState>
          )}
        </section>
        <section className="card note-editor">
          {exists ? (
            <NoteEditor key={noteId} id={noteId!} />
          ) : (
            <EmptyState icon="note">{noteId ? t('noteDeleted') : t('selectNote')}</EmptyState>
          )}
        </section>
      </div>
    </>
  );
}
