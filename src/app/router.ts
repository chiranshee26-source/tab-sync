/**
 * Hash routing (`#/notes/<id>`), so every page works on a static host and
 * each tab can show a different page.
 */

import { useEffect, useState } from 'react';

export const PAGES = ['today', 'tasks', 'reading', 'notes', 'diary', 'settings'] as const;
export type Page = (typeof PAGES)[number];

export interface Route {
  page: Page;
  /** Note id or diary date, when the page has one. */
  param?: string;
}

export function parseRoute(hash: string): Route {
  const [page, param] = hash.replace(/^#\/?/, '').split('/');
  return (PAGES as readonly string[]).includes(page) ? { page: page as Page, param: param || undefined } : { page: 'today' };
}

/** The route as a short string (`notes/abc`) for presence messages. */
export function routeToPath(route: Route): string {
  return route.param ? `${route.page}/${route.param}` : route.page;
}

export function href(page: Page, param?: string): string {
  return param ? `#/${page}/${param}` : `#/${page}`;
}

export function navigate(page: Page, param?: string): void {
  location.hash = href(page, param);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
