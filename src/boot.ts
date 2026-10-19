/**
 * Boot script: compiled and inlined into <head> at build time (see
 * vite.config.ts). It runs synchronously before the body is parsed, so the
 * first paint already uses the saved theme, colours, font size, language and
 * text direction: no flash of the wrong theme.
 */

import { merge, prefsRecord, prefsValues, recordValues } from './lww';
import { readStoredDoc } from './persistence';
import { applyToDocument, defaultPreferences } from './preferences';
import { applyPalette } from './theme';

let stored = {};
try {
  stored = readStoredDoc(localStorage);
} catch {
  /* storage blocked: fall back to defaults */
}

// Same merge the app uses, so boot and app can never disagree.
const doc = merge({ prefs: prefsRecord(defaultPreferences()) }, stored).doc;
applyToDocument(prefsValues(doc));
// Colours from the background picture, also before first paint.
applyPalette(recordValues(doc, 'appearance', 'appearance').palette);
