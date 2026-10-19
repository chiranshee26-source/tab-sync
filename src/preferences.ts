/**
 * Preference schema: the single source of truth for which settings exist,
 * which values are legal, and what the defaults are. Shared by the app and
 * by the inline boot script, so both always agree on validation.
 */

/** All synced data (preferences, tasks, reading list, notes, diary) lives under one key. */
export const STORAGE_KEY = 'daybook:data:v2';
/** Preferences-only storage of the first version; migrated on load. */
export const LEGACY_STORAGE_KEY = 'tab-sync:preferences:v1';
export const CHANNEL_NAME = 'tab-sync:channel:v1';

export const LANGUAGES = ['en', 'es', 'fr', 'de', 'hi', 'ja', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

export const RTL_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['ar']);

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const FONT_SIZE = { min: 12, max: 24, step: 1, default: 16 } as const;

export interface Preferences {
  theme: Theme;
  language: Language;
  fontSize: number;
}

export type PrefKey = keyof Preferences;

export const PREF_KEYS: readonly PrefKey[] = ['theme', 'language', 'fontSize'];

type Validators = { [K in PrefKey]: (value: unknown) => value is Preferences[K] };

export const isValidPreference: Validators = {
  theme: (v): v is Theme => typeof v === 'string' && (THEMES as readonly string[]).includes(v),
  language: (v): v is Language => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v),
  fontSize: (v): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= FONT_SIZE.min && v <= FONT_SIZE.max,
};

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function detectLanguage(): Language {
  const candidates = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  for (const tag of candidates) {
    const base = tag?.slice(0, 2).toLowerCase();
    if (isValidPreference.language(base)) return base;
  }
  return 'en';
}

/** Defaults used until the user changes something (derived from the environment). */
export function defaultPreferences(): Preferences {
  return {
    theme: systemPrefersDark() ? 'dark' : 'light',
    language: detectLanguage(),
    fontSize: FONT_SIZE.default,
  };
}

/** Applies preferences to the document root. Used by both boot script and app. */
export function applyToDocument(prefs: Preferences, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = prefs.theme;
  root.style.colorScheme = prefs.theme;
  root.style.setProperty('--font-size', `${prefs.fontSize}px`);
  root.lang = prefs.language;
  root.dir = RTL_LANGUAGES.has(prefs.language) ? 'rtl' : 'ltr';
}
