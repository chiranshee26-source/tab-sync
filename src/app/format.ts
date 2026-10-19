/** Locale-aware formatting helpers (Intl does the translation work). */

import type { Language } from '../preferences';
import { isoDate } from '../schema';

export function formatLongDate(language: Language, iso: string): string {
  return new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
    parseIsoDate(iso),
  );
}

export function formatShortDate(language: Language, iso: string): string {
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short' }).format(parseIsoDate(iso));
}

export function formatTime(language: Language, date: Date): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

/** "5 minutes ago", "yesterday", … in the chosen language. */
export function formatRelative(language: Language, timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}

export function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function shiftDate(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Adds https:// to bare domains so the link works. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Only http(s) links are rendered as links. */
export function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
