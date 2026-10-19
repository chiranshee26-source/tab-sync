import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** All pages in one context share localStorage and BroadcastChannel, like tabs. */
async function openTabs(context: BrowserContext, count: number): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < count; i++) {
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.tabSync));
    pages.push(page);
  }
  return pages;
}

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

test('dark-mode toggle propagates to other tabs within 100 ms', async ({ context }) => {
  const [a, b, c] = await openTabs(context, 3);
  const initial = await theme(a);
  const target = initial === 'dark' ? 'light' : 'dark';

  // Register listeners first, then trigger the change.
  await Promise.all(
    [b, c].map((page) =>
      page.evaluate(() => {
        const w = window as unknown as { receivedAt?: number };
        window.tabSync.subscribe((e) => {
          if (e.type === 'change') w.receivedAt ??= performance.timeOrigin + performance.now();
        });
      }),
    ),
  );
  const sentAt = await a.evaluate((value) => {
    const t = performance.timeOrigin + performance.now();
    window.tabSync.set('theme', value as 'light' | 'dark');
    return t;
  }, target);

  for (const page of [b, c]) {
    const handle = await page.waitForFunction(() => (window as unknown as { receivedAt?: number }).receivedAt);
    const receivedAt = (await handle.jsonValue()) as number;
    expect(receivedAt - sentAt).toBeLessThan(100);
  }
  for (const page of [b, c]) expect(await theme(page)).toBe(target);
});

test('UI controls sync language (with RTL) and font size without reloading', async ({ context }) => {
  const [a, b] = await openTabs(context, 2);
  await a.selectOption('#language', 'ar');
  await expect(b.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(b.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(b.locator('h1')).toHaveText('إعدادات متزامنة');

  await a.locator('#font-size').fill('21');
  await expect(b.locator('#font-size')).toHaveValue('21');
  expect(await b.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('21px');

  await b.getByRole('switch').click();
  await expect(a.getByRole('switch')).toHaveAttribute('aria-checked', String((await theme(b)) === 'dark'));
});

test('preferences persist after every tab is closed', async ({ context }) => {
  const [a, b] = await openTabs(context, 2);
  await a.evaluate(() => {
    window.tabSync.set('theme', 'dark');
    window.tabSync.set('language', 'ja');
    window.tabSync.set('fontSize', 23);
  });
  await expect(b.locator('html')).toHaveAttribute('lang', 'ja');
  await a.close();
  await b.close();

  const [reopened] = await openTabs(context, 1);
  expect(await reopened.evaluate(() => window.tabSync.values)).toEqual({
    theme: 'dark',
    language: 'ja',
    fontSize: 23,
  });
});

test('a newly opened tab never paints the wrong theme', async ({ context }) => {
  const [a] = await openTabs(context, 1);
  const target = (await theme(a)) === 'dark' ? 'light' : 'dark';
  await a.evaluate((value) => window.tabSync.set('theme', value as 'light' | 'dark'), target);
  await a.waitForFunction(() => localStorage.length > 0);

  const page = await context.newPage();
  // Record the theme at the moment <body> is created, before anything can paint.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (document.body) {
        (window as unknown as { themeAtBody: string }).themeAtBody = document.documentElement.dataset.theme ?? 'unset';
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  expect(await page.evaluate(() => (window as unknown as { themeAtBody: string }).themeAtBody)).toBe(target);
});

test('simultaneous edits from many tabs converge to one state', async ({ context }) => {
  const tabs = await openTabs(context, 4);
  await tabs[0].getByRole('button', { name: /concurrent-edit/i }).click();

  await expect
    .poll(async () => new Set(await Promise.all(tabs.map((t) => t.getByTestId('fingerprint').textContent()))).size, {
      timeout: 5000,
    })
    .toBe(1);
  const values = await Promise.all(tabs.map((t) => t.evaluate(() => window.tabSync.values)));
  for (const v of values) expect(v).toEqual(values[0]);
  // Storage holds the converged state as well.
  const [fresh] = await openTabs(context, 1);
  expect(await fresh.evaluate(() => window.tabSync.values)).toEqual(values[0]);
});
