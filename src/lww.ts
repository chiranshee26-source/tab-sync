/**
 * Last-Writer-Wins map CRDT over records.
 *
 * The document maps record keys (`prefs`, `task:<id>`, `note:<id>`, …) to
 * records, and every field of every record is an independent LWW register:
 * { value, ts }. Merging keeps, per (record, field), the entry with the
 * greater (timestamp, value) pair. That merge is commutative, associative and
 * idempotent, so tabs that have seen the same set of updates hold identical
 * state regardless of the order (or number of times) the updates arrived.
 *
 * Deleting is just another field write (`deleted: true`, a tombstone), so a
 * delete and a concurrent edit are ordered like any other two writes.
 */

import { compareTimestamps, isTimestamp, ZERO_TIMESTAMP, type Timestamp } from './clock';
import { PREF_KEYS, type Preferences } from './preferences';
import { isValidField, ITEM_DEFAULTS, parseRecordKey, type ItemKind, type RecordTypes } from './schema';

export interface Entry<T = unknown> {
  readonly value: T;
  readonly ts: Timestamp;
}

export type RecordEntries = { readonly [field: string]: Entry };
export type Doc = { readonly [key: string]: RecordEntries };

export interface FieldRef {
  key: string;
  field: string;
}

export interface MergeResult {
  doc: Doc;
  /** Fields where `incoming` won (new value or newer timestamp). */
  accepted: FieldRef[];
  /** Fields where `incoming` carried a different value but lost. */
  rejected: FieldRef[];
}

/**
 * Total order on entries. Timestamps alone are already unique per tab, but
 * comparing the serialized value as a last resort keeps the merge
 * deterministic even for equal timestamps (e.g. two tabs' zero-time defaults).
 */
export function compareEntries(a: Entry, b: Entry): number {
  const byTime = compareTimestamps(a.ts, b.ts);
  if (byTime !== 0) return byTime;
  const av = JSON.stringify(a.value);
  const bv = JSON.stringify(b.value);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

/** Preference record with the given values, all stamped `ts` (zero = "default"). */
export function prefsRecord(values: Preferences, ts: Timestamp = ZERO_TIMESTAMP): RecordEntries {
  return Object.fromEntries(PREF_KEYS.map((key) => [key, { value: values[key], ts }]));
}

export function merge(base: Doc, incoming: Doc): MergeResult {
  let doc: Record<string, RecordEntries> | undefined;
  const accepted: FieldRef[] = [];
  const rejected: FieldRef[] = [];
  for (const [key, theirs] of Object.entries(incoming)) {
    const ours = base[key];
    let record: Record<string, Entry> | undefined;
    for (const [field, entry] of Object.entries(theirs)) {
      const current = ours?.[field];
      const order = current ? compareEntries(entry, current) : 1;
      if (order > 0) {
        record ??= { ...ours };
        record[field] = entry;
        accepted.push({ key, field });
      } else if (order < 0 && current && entry.value !== current.value) {
        rejected.push({ key, field });
      }
    }
    if (record) {
      doc ??= { ...base };
      doc[key] = record;
    }
  }
  return { doc: doc ?? base, accepted, rejected };
}

/** Field values of a record, with defaults for fields nobody has written. */
export function recordValues<K extends ItemKind>(doc: Doc, kind: K, key: string): RecordTypes[K] {
  const values: Record<string, unknown> = { ...ITEM_DEFAULTS[kind] };
  for (const [field, entry] of Object.entries(doc[key] ?? {})) values[field] = entry.value;
  return values as unknown as RecordTypes[K];
}

export function prefsValues(doc: Doc): Preferences {
  const record = doc.prefs;
  return Object.fromEntries(PREF_KEYS.map((key) => [key, record[key].value])) as unknown as Preferences;
}

/**
 * Validates untrusted input (storage contents, messages from other tabs that
 * may run another build). Invalid records and fields are dropped
 * individually, so one corrupt value never discards the rest.
 */
export function parseDoc(raw: unknown): Doc {
  const doc: Record<string, Record<string, Entry>> = {};
  if (typeof raw !== 'object' || raw === null) return doc;
  for (const [key, fields] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseRecordKey(key);
    if (!parsed || typeof fields !== 'object' || fields === null) continue;
    for (const [field, entry] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { value, ts } = entry as Record<string, unknown>;
      if (!isTimestamp(ts) || !isValidField(parsed.kind, field, value)) continue;
      (doc[key] ??= {})[field] = { value, ts };
    }
  }
  return doc;
}

/** Canonical serialization: sorted keys, so equal docs give equal strings. */
export function serializeDoc(doc: Doc): string {
  const records: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(doc).sort()) {
    const record = doc[key];
    const fields: Record<string, unknown> = {};
    for (const field of Object.keys(record).sort()) {
      const { value, ts } = record[field];
      fields[field] = { value, ts: { wall: ts.wall, counter: ts.counter, node: ts.node } };
    }
    records[key] = fields;
  }
  return JSON.stringify({ version: 2, records });
}

export function deserializeDoc(raw: string | null): Doc {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; records?: unknown; fields?: unknown };
    if (parsed.version === 2) return parseDoc(parsed.records);
    // Version 1 stored only the preference fields.
    if (parsed.version === 1) return parseDoc({ prefs: parsed.fields });
    return {};
  } catch {
    return {};
  }
}

/** Short FNV-1a hash of the canonical doc; equal across tabs iff states converged. */
export function fingerprint(doc: Doc): string {
  const text = serializeDoc(doc);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
