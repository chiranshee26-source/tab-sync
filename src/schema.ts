/**
 * Record schema for everything Daybook syncs.
 *
 * The synced document is a map of records. Each record has a key
 * (`prefs`, or `<kind>:<id>`) and a set of fields; each field is an
 * independent last-writer-wins register (see lww.ts). This module defines
 * which kinds and fields exist and validates every value that comes from
 * storage or from another tab.
 */

import { isValidPreference, type Preferences } from './preferences';

export const READING_STATUSES = ['toRead', 'reading', 'finished'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const MOODS = ['great', 'good', 'okay', 'low', 'bad'] as const;
export type Mood = (typeof MOODS)[number];

export interface Task {
  title: string;
  done: boolean;
  /** ISO date (YYYY-MM-DD) or '' for no due date. */
  due: string;
  createdAt: number;
  deleted: boolean;
}

export interface ReadingItem {
  title: string;
  url: string;
  status: ReadingStatus;
  createdAt: number;
  deleted: boolean;
}

export interface Note {
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

/**
 * Background picture and the colours extracted from it. The picture itself
 * lives in IndexedDB (see images.ts); this record only names it, so it syncs
 * and persists like everything else without moving megabytes around.
 */
export interface Appearance {
  /** Content hash of the picture, or '' for the default illustrated theme. */
  image: string;
  /** Comma-separated hex seeds [base, accent, …] (see color.ts), or ''. */
  palette: string;
}

/** One entry per day; the record id is the date, so tabs writing "today" share it. */
export interface DiaryEntry {
  body: string;
  mood: Mood | '';
  updatedAt: number;
}

export interface RecordTypes {
  prefs: Preferences;
  appearance: Appearance;
  task: Task;
  reading: ReadingItem;
  note: Note;
  diary: DiaryEntry;
}

export type Kind = keyof RecordTypes;
export type ItemKind = Exclude<Kind, 'prefs'>;

type Validator<T> = (value: unknown) => value is T;

const text =
  (max: number): Validator<string> =>
  (v): v is string =>
    typeof v === 'string' && v.length <= max;
const bool: Validator<boolean> = (v): v is boolean => typeof v === 'boolean';
const time: Validator<number> = (v): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const oneOf =
  <T extends string>(options: readonly T[]): Validator<T> =>
  (v): v is T =>
    typeof v === 'string' && (options as readonly string[]).includes(v);
const isoDateOrEmpty: Validator<string> = (v): v is string =>
  typeof v === 'string' && (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v));

type Schema<T> = { readonly [F in keyof T]: Validator<T[F]> };

export const SCHEMAS: { readonly [K in Kind]: Schema<RecordTypes[K]> } = {
  prefs: isValidPreference,
  task: { title: text(500), done: bool, due: isoDateOrEmpty, createdAt: time, deleted: bool },
  reading: {
    title: text(500),
    url: text(2000),
    status: oneOf(READING_STATUSES),
    createdAt: time,
    deleted: bool,
  },
  note: { title: text(500), body: text(200_000), createdAt: time, updatedAt: time, deleted: bool },
  diary: { body: text(200_000), mood: oneOf<Mood | ''>(['', ...MOODS]), updatedAt: time },
  appearance: {
    image: (v): v is string => typeof v === 'string' && /^([0-9a-f]{16})?$/.test(v),
    palette: (v): v is string => typeof v === 'string' && /^(#[0-9a-f]{6}(,#[0-9a-f]{6}){0,7})?$/.test(v),
  },
};

/** Values for fields nobody has written yet. */
export const ITEM_DEFAULTS: { readonly [K in ItemKind]: RecordTypes[K] } = {
  task: { title: '', done: false, due: '', createdAt: 0, deleted: false },
  reading: { title: '', url: '', status: 'toRead', createdAt: 0, deleted: false },
  note: { title: '', body: '', createdAt: 0, updatedAt: 0, deleted: false },
  diary: { body: '', mood: '', updatedAt: 0 },
  appearance: { image: '', palette: '' },
};

const KINDS = Object.keys(SCHEMAS) as Kind[];
/** Kinds with exactly one record, keyed by the kind name alone. */
const SINGLETONS: ReadonlySet<Kind> = new Set<Kind>(['prefs', 'appearance']);
const ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/;

export function recordKey(kind: Kind, id?: string): string {
  return SINGLETONS.has(kind) ? kind : `${kind}:${id}`;
}

export function parseRecordKey(key: string): { kind: Kind; id: string } | null {
  if (SINGLETONS.has(key as Kind)) return { kind: key as Kind, id: '' };
  const separator = key.indexOf(':');
  if (separator < 0) return null;
  const kind = key.slice(0, separator) as Kind;
  const id = key.slice(separator + 1);
  return !SINGLETONS.has(kind) && KINDS.includes(kind) && ID_PATTERN.test(id) ? { kind, id } : null;
}

export function isValidField(kind: Kind, field: string, value: unknown): boolean {
  const schema = SCHEMAS[kind] as Record<string, Validator<unknown>>;
  return Object.hasOwn(schema, field) && schema[field](value);
}

export function newId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/** Local calendar date as YYYY-MM-DD (diary record ids). */
export function isoDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
