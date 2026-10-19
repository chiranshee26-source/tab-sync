/**
 * Boot script: compiled and inlined into <head> at build time (see
 * vite.config.ts). It runs synchronously before the body is parsed, so the
 * first paint already uses the saved theme, font size, language and text
 * direction: no flash of the wrong theme.
 */

import { merge, prefsRecord, prefsValues } from './lww';
import { readStoredDoc } from './persistence';
import { applyToDocument, defaultPreferences } from './preferences';

let stored = {};
try {
  stored = readStoredDoc(localStorage);
} catch {
  /* storage blocked: fall back to defaults */
}

// Same merge the app uses, so boot and app can never disagree.
applyToDocument(prefsValues(merge({ prefs: prefsRecord(defaultPreferences()) }, stored).doc));
