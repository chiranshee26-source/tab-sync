import { describe, expect, it } from 'vitest';
import type { Timestamp } from '../../src/clock';
import {
  createDoc,
  deserializeDoc,
  fingerprint,
  merge,
  parsePartialDoc,
  serializeDoc,
  valuesOf,
  type PartialDoc,
  type PrefsDoc,
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

function randomDoc(random: () => number): PrefsDoc {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  const stamp = () => ts(Math.floor(random() * 4), Math.floor(random() * 3), pick(['a', 'b', 'c']));
  return {
    theme: { value: pick(THEMES), ts: stamp() },
    language: { value: pick(LANGUAGES), ts: stamp() },
    fontSize: { value: FONT_SIZE.min + Math.floor(random() * 13), ts: stamp() },
  };
}

describe('LWW merge', () => {
  it('keeps the entry with the newer timestamp, per field', () => {
    const base = createDoc(DEFAULTS, ts(1));
    const { doc, accepted, rejected } = merge(base, {
      theme: { value: 'dark', ts: ts(2) },
      fontSize: { value: 20, ts: ts(0) },
    });
    expect(valuesOf(doc)).toEqual({ theme: 'dark', language: 'en', fontSize: 16 });
    expect(accepted).toEqual(['theme']);
    expect(rejected).toEqual(['fontSize']);
  });

  it('breaks exact timestamp ties by value, deterministically', () => {
    const a = createDoc({ ...DEFAULTS, theme: 'light' });
    const b = createDoc({ ...DEFAULTS, theme: 'dark' });
    expect(merge(a, b).doc.theme.value).toBe(merge(b, a).doc.theme.value);
  });

  it('is commutative, associative and idempotent (random property test)', () => {
    const random = rng(42);
    for (let i = 0; i < 500; i++) {
      const [a, b, c] = [randomDoc(random), randomDoc(random), randomDoc(random)];
      const m = (x: PrefsDoc, y: PrefsDoc) => merge(x, y).doc;
      expect(serializeDoc(m(a, b))).toBe(serializeDoc(m(b, a)));
      expect(serializeDoc(m(m(a, b), c))).toBe(serializeDoc(m(a, m(b, c))));
      expect(serializeDoc(m(a, a))).toBe(serializeDoc(a));
    }
  });

  it('converges to the same state for any delivery order', () => {
    const random = rng(7);
    const updates = Array.from({ length: 30 }, () => randomDoc(random) as PartialDoc);
    const base = createDoc(DEFAULTS);
    const apply = (order: PartialDoc[]) => order.reduce<PrefsDoc>((doc, u) => merge(doc, u).doc, base);
    const reference = fingerprint(apply(updates));
    for (let i = 0; i < 50; i++) {
      const shuffled = [...updates].sort(() => random() - 0.5);
      expect(fingerprint(apply(shuffled))).toBe(reference);
    }
  });
});

describe('validation and serialization', () => {
  it('round-trips through storage format', () => {
    const doc = createDoc({ theme: 'dark', language: 'ja', fontSize: 20 }, ts(99, 2, 'tab'));
    const parsed = deserializeDoc(serializeDoc(doc));
    expect(merge(createDoc(DEFAULTS), parsed).doc).toEqual(doc);
  });

  it('drops invalid fields individually and keeps valid ones', () => {
    const parsed = parsePartialDoc({
      theme: { value: 'purple', ts: ts(5) },
      language: { value: 'fr', ts: ts(5) },
      fontSize: { value: 999, ts: ts(5) },
    });
    expect(Object.keys(parsed)).toEqual(['language']);
  });

  it('treats corrupt or unknown-version storage as empty', () => {
    expect(deserializeDoc('{not json')).toEqual({});
    expect(deserializeDoc(JSON.stringify({ version: 2, fields: {} }))).toEqual({});
    expect(deserializeDoc(null)).toEqual({});
  });
});
