/**
 * Boot script: compiled and inlined into <head> at build time (see
 * vite.config.ts). It runs synchronously before the body is parsed, so the
 * first paint already uses the saved theme, font size, language and text
 * direction: no flash of the wrong theme.
 */

import { createDoc, deserializeDoc, merge, valuesOf, type PartialDoc } from './lww';
import { applyToDocument, defaultPreferences, STORAGE_KEY } from './preferences';

let stored: PartialDoc = {};
try {
  stored = deserializeDoc(localStorage.getItem(STORAGE_KEY));
} catch {
  /* storage blocked: fall back to defaults */
}

// Same merge the app uses, so boot and app can never disagree.
applyToDocument(valuesOf(merge(createDoc(defaultPreferences()), stored).doc));
