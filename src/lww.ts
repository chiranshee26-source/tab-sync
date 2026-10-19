/**
 * Last-Writer-Wins map CRDT over the preference fields.
 *
 * Every field is an independent LWW register: { value, ts }. Merging two
 * documents keeps, per field, the entry with the greater (timestamp, value)
 * pair. That merge is commutative, associative and idempotent, so tabs that
 * have seen the same set of updates hold identical state regardless of the
 * order (or number of times) the updates arrived.
 */

import { compareTimestamps, isTimestamp, ZERO_TIMESTAMP, type Timestamp } from './clock';
import { isValidPreference, PREF_KEYS, type PrefKey, type Preferences } from './preferences';

export interface Entry<T> {
  readonly value: T;
  readonly ts: Timestamp;
}

export type PrefsDoc = { readonly [K in PrefKey]: Entry<Preferences[K]> };
export type PartialDoc = { [K in PrefKey]?: Entry<Preferences[K]> };

/**
 * Total order on entries. Timestamps alone are already unique per tab, but
 * comparing the serialized value as a last resort keeps the merge
 * deterministic even for equal timestamps (e.g. two tabs' zero-time defaults).
 */
export function compareEntries<T>(a: Entry<T>, b: Entry<T>): number {
  const byTime = compareTimestamps(a.ts, b.ts);
  if (byTime !== 0) return byTime;
  const av = JSON.stringify(a.value);
  const bv = JSON.stringify(b.value);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

export function createDoc(values: Preferences, ts: Timestamp = ZERO_TIMESTAMP): PrefsDoc {
  return {
    theme: { value: values.theme, ts },
    language: { value: values.language, ts },
    fontSize: { value: values.fontSize, ts },
  };
}

export interface MergeResult {
  doc: PrefsDoc;
  /** Fields where `incoming` won and changed the value or timestamp. */
  accepted: PrefKey[];
  /** Fields where `incoming` carried a different value but lost. */
  rejected: PrefKey[];
}

export function merge(base: PrefsDoc, incoming: PartialDoc): MergeResult {
  const doc: Record<string, Entry<unknown>> = { ...base };
  const accepted: PrefKey[] = [];
  const rejected: PrefKey[] = [];
  for (const key of PREF_KEYS) {
    const theirs = incoming[key];
    if (!theirs) continue;
    const order = compareEntries<unknown>(theirs, base[key]);
    if (order > 0) {
      doc[key] = theirs;
      accepted.push(key);
    } else if (order < 0 && theirs.value !== base[key].value) {
      rejected.push(key);
    }
  }
  return { doc: doc as unknown as PrefsDoc, accepted, rejected };
}

export function valuesOf(doc: PrefsDoc): Preferences {
  return { theme: doc.theme.value, language: doc.language.value, fontSize: doc.fontSize.value };
}

/**
 * Validates untrusted input (storage contents, messages from other tabs that
 * may run an older build). Invalid fields are dropped individually so one
 * corrupt field never discards the others.
 */
export function parsePartialDoc(raw: unknown): PartialDoc {
  const result: PartialDoc = {};
  if (typeof raw !== 'object' || raw === null) return result;
  const record = raw as Record<string, unknown>;
  for (const key of PREF_KEYS) {
    const entry = record[key] as Record<string, unknown> | undefined;
    if (typeof entry !== 'object' || entry === null) continue;
    if (!isTimestamp(entry.ts) || !isValidPreference[key](entry.value)) continue;
    (result as Record<string, Entry<unknown>>)[key] = { value: entry.value, ts: entry.ts };
  }
  return result;
}

/** Canonical serialization: fixed key order so equal docs give equal strings. */
export function serializeDoc(doc: PrefsDoc): string {
  const ordered: Record<string, unknown> = {};
  for (const key of PREF_KEYS) {
    const { value, ts } = doc[key];
    ordered[key] = { value, ts: { wall: ts.wall, counter: ts.counter, node: ts.node } };
  }
  return JSON.stringify({ version: 1, fields: ordered });
}

export function deserializeDoc(raw: string | null): PartialDoc {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; fields?: unknown };
    return parsed.version === 1 ? parsePartialDoc(parsed.fields) : {};
  } catch {
    return {};
  }
}

/** Short FNV-1a hash of the canonical doc; equal across tabs iff states converged. */
export function fingerprint(doc: PrefsDoc): string {
  const text = serializeDoc(doc);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
