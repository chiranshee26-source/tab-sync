import { useState, type FormEvent } from 'react';
import { recordKey, isoDate, newId, type Task } from '../../schema';
import { DeleteButton, EmptyState, Flash, PageHeader } from '../components/common';
import { SyncedInput } from '../components/SyncedText';
import { formatShortDate } from '../format';
import { Icon } from '../icons';
import { useModel } from '../model';

type TaskWithId = Task & { id: string };

/** Open tasks first by due date (undated last), then by creation. */
export function sortTasks(tasks: TaskWithId[]): TaskWithId[] {
  return [...tasks].sort(
    (a, b) =>
      Number(a.due === '') - Number(b.due === '') || a.due.localeCompare(b.due) || a.createdAt - b.createdAt,
  );
}

export function AddTaskForm({ withDueDate = true }: { withDueDate?: boolean }) {
  const { store, t } = useModel();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    store.update('task', newId(), { title: title.trim(), due, createdAt: Date.now() });
    setTitle('');
    setDue('');
  };
  return (
    <form className="add-form" onSubmit={submit}>
      <input
        dir="auto"
        className="input grow"
        placeholder={t('addTaskPlaceholder')}
        aria-label={t('addTaskPlaceholder')}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={500}
      />
      {withDueDate && (
        <input
          type="date"
          className="input input-date"
          aria-label={t('dueDate')}
          title={t('dueDate')}
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
      )}
      <button type="submit" className="button button-primary" disabled={!title.trim()}>
        <Icon name="plus" />
        {t('add')}
      </button>
    </form>
  );
}

export function TaskRow({ task }: { task: TaskWithId }) {
  const model = useModel();
  const { store, t } = model;
  const today = isoDate();
  const overdue = !task.done && task.due !== '' && task.due < today;
  return (
    <li className={`item-row task-row${task.done ? ' is-done' : ''}`}>
      <Flash count={model.flashCount(recordKey('task', task.id))} />
      <input
        type="checkbox"
        className="checkbox"
        checked={task.done}
        aria-label={t('markDone')}
        onChange={(event) => store.update('task', task.id, { done: event.target.checked })}
      />
      <SyncedInput
        className="inline-input"
        value={task.title}
        aria-label={t('taskTitle')}
        maxLength={500}
        onValue={(title) => store.update('task', task.id, { title })}
      />
      {task.due && (
        <span className={`chip${overdue ? ' chip-danger' : task.due === today ? ' chip-accent' : ''}`}>
          <Icon name="calendar" />
          {overdue ? `${t('overdue')} · ` : ''}
          {task.due === today ? t('dueToday') : formatShortDate(store.prefs.language, task.due)}
        </span>
      )}
      <DeleteButton onConfirm={() => store.remove('task', task.id)} />
    </li>
  );
}

export function TasksPage() {
  const { store, t } = useModel();
  const tasks = store.list('task');
  const open = sortTasks(tasks.filter((task) => !task.done));
  const done = tasks.filter((task) => task.done).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <PageHeader title={t('navTasks')} subtitle={t('tasksSubtitle')} />
      <section className="card">
        <AddTaskForm />
        {open.length > 0 ? (
          <ul className="item-list">
            {open.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        ) : (
          <EmptyState icon="tasks">{t('noTasks')}</EmptyState>
        )}
      </section>
      {done.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>
              {t('completed')} <span className="count">{done.length}</span>
            </h2>
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => done.forEach((task) => store.remove('task', task.id))}
            >
              <Icon name="trash" />
              {t('clearCompleted')}
            </button>
          </div>
          <ul className="item-list">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
