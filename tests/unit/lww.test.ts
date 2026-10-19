import { describe, expect, it } from 'vitest';
import type { Timestamp } from '../../src/clock';
import {
  deserializeDoc,
  fingerprint,
  merge,
  parseDoc,
  prefsRecord,
  prefsValues,
  recordValues,
  serializeDoc,
  type Doc,
} from '../../src/lww';
import { FONT_SIZE, LANGUAGES, THEMES, type Preferences } from '../../src/preferences';

const DEFAULTS: Preferences = { theme: 'light', language: 'en', fontSize: 16 };
const ts = (wall: number, counter = 0, node = 'a'): Timestamp => ({ wall, counter, node });

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Random docs touching overlapping records and fields, with colliding timestamps. */
function randomDoc(random: () => number): Doc {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  const stamp = () => ts(Math.floor(random() * 4), Math.floor(random() * 3), pick(['a', 'b', 'c']));
  const doc: Record<string, Record<string, { value: unknown; ts: Timestamp }>> = {
    prefs: {
      theme: { value: pick(THEMES), ts: stamp() },
      language: { value: pick(LANGUAGES), ts: stamp() },
      fontSize: { value: FONT_SIZE.min + Math.floor(random() * 13), ts: stamp() },
    },
  };
  for (const id of ['t1', 't2']) {
    if (random() < 0.7) {
      doc[`task:${id}`] = {
        title: { value: pick(['milk', 'eggs', 'call mum']), ts: stamp() },
        done: { value: random() < 0.5, ts: stamp() },
        ...(random() < 0.3 ? { deleted: { value: true, ts: stamp() } } : {}),
      };
    }
  }
  return doc;
}

describe('LWW map merge', () => {
  it('keeps the entry with the newer timestamp, per record and field', () => {
    const base: Doc = { prefs: prefsRecord(DEFAULTS, ts(1)), 'task:x': { title: { value: 'old', ts: ts(1) } } };
    const { doc, accepted, rejected } = merge(base, {
      prefs: { theme: { value: 'dark', ts: ts(2) }, fontSize: { value: 20, ts: ts(0) } },
      'task:x': { done: { value: true, ts: ts(1) } },
    });
    expect(prefsValues(doc)).toEqual({ theme: 'dark', language: 'en', fontSize: 16 });
    expect(recordValues(doc, 'task', 'task:x')).toMatchObject({ title: 'old', done: true });
    expect(accepted).toEqual([
      { key: 'prefs', field: 'theme' },
      { key: 'task:x', field: 'done' },
    ]);
    expect(rejected).toEqual([{ key: 'prefs', field: 'fontSize' }]);
  });

  it('adds records the base has never seen', () => {
    const { doc } = merge({}, { 'note:n1': { title: { value: 'Hello', ts: ts(1) } } });
    expect(recordValues(doc, 'note', 'note:n1').title).toBe('Hello');
  });

  it('returns the same object when nothing changes', () => {
    const base: Doc = { prefs: prefsRecord(DEFAULTS, ts(5)) };
    expect(merge(base, { prefs: prefsRecord(DEFAULTS, ts(1)) }).doc).toBe(base);
  });

  it('orders a delete against a concurrent edit like any other write', () => {
    const edit: Doc = { 'task:x': { title: { value: 'edited', ts: ts(3) } } };
    const del: Doc = { 'task:x': { deleted: { value: true, ts: ts(2) } } };
    const result = merge(merge({}, edit).doc, del).doc;
    expect(recordValues(result, 'task', 'task:x')).toMatchObject({ title: 'edited', deleted: true });
  });

  it('breaks exact timestamp ties by value, deterministically', () => {
    const a = { prefs: prefsRecord({ ...DEFAULTS, theme: 'light' }) };
    const b = { prefs: prefsRecord({ ...DEFAULTS, theme: 'dark' }) };
    expect(merge(a, b).doc.prefs.theme.value).toBe(merge(b, a).doc.prefs.theme.value);
  });

  it('is commutative, associative and idempotent (random property test)', () => {
    const random = rng(42);
    const m = (x: Doc, y: Doc) => merge(x, y).doc;
    for (let i = 0; i < 500; i++) {
      const [a, b, c] = [randomDoc(random), randomDoc(random), randomDoc(random)];
      expect(serializeDoc(m(a, b))).toBe(serializeDoc(m(b, a)));
      expect(serializeDoc(m(m(a, b), c))).toBe(serializeDoc(m(a, m(b, c))));
      expect(serializeDoc(m(a, a))).toBe(serializeDoc(a));
    }
  });

  it('converges to the same state for any delivery order', () => {
    const random = rng(7);
    const updates = Array.from({ length: 30 }, () => randomDoc(random));
    const apply = (order: Doc[]) => order.reduce<Doc>((doc, u) => merge(doc, u).doc, {});
    const reference = fingerprint(apply(updates));
    for (let i = 0; i < 50; i++) {
      const shuffled = [...updates].sort(() => random() - 0.5);
      expect(fingerprint(apply(shuffled))).toBe(reference);
    }
  });
});

describe('validation and serialization', () => {
  it('round-trips through storage format', () => {
    const doc: Doc = {
      prefs: prefsRecord({ theme: 'dark', language: 'ja', fontSize: 20 }, ts(99, 2, 'tab')),
      'diary:2026-10-19': { body: { value: 'A good day', ts: ts(5) }, mood: { value: 'great', ts: ts(5) } },
    };
    expect(deserializeDoc(serializeDoc(doc))).toEqual(doc);
  });

  it('migrates the version 1 (preferences only) format', () => {
    const v1 = JSON.stringify({ version: 1, fields: prefsRecord({ theme: 'dark', language: 'fr', fontSize: 18 }, ts(3)) });
    expect(prefsValues(deserializeDoc(v1))).toEqual({ theme: 'dark', language: 'fr', fontSize: 18 });
  });

  it('drops invalid records and fields individually and keeps valid ones', () => {
    const parsed = parseDoc({
      prefs: { theme: { value: 'purple', ts: ts(5) }, language: { value: 'fr', ts: ts(5) } },
      'task:ok': { title: { value: 'Buy milk', ts: ts(5) }, done: { value: 'yes', ts: ts(5) }, hack: { value: 1, ts: ts(5) } },
      'reading:x': { status: { value: 'skimmed', ts: ts(5) } },
      'unknown:1': { title: { value: 'x', ts: ts(5) } },
      'task:bad id!': { title: { value: 'x', ts: ts(5) } },
    });
    expect(parsed).toEqual({
      prefs: { language: { value: 'fr', ts: ts(5) } },
      'task:ok': { title: { value: 'Buy milk', ts: ts(5) } },
    });
  });

  it('treats corrupt or unknown-version storage as empty', () => {
    expect(deserializeDoc('{not json')).toEqual({});
    expect(deserializeDoc(JSON.stringify({ version: 9, records: {} }))).toEqual({});
    expect(deserializeDoc(null)).toEqual({});
  });
});
