import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** All pages in one context share localStorage and BroadcastChannel, like tabs. */
async function openTabs(context: BrowserContext, count: number, path = ''): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < count; i++) {
    const page = await context.newPage();
    await page.goto(`/${path}`);
    await page.waitForFunction(() => Boolean(window.tabSync));
    pages.push(page);
  }
  return pages;
}

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const english = (page: Page) => page.evaluate(() => window.tabSync.setPref('language', 'en'));

// ---------- Preferences: the original requirements ----------

test('dark-mode toggle propagates to other tabs within 100 ms', async ({ context }) => {
  const [a, b, c] = await openTabs(context, 3);
  const target = (await theme(a)) === 'dark' ? 'light' : 'dark';

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
    window.tabSync.setPref('theme', value as 'light' | 'dark');
    return t;
  }, target);

  for (const page of [b, c]) {
    const handle = await page.waitForFunction(() => (window as unknown as { receivedAt?: number }).receivedAt);
    expect(((await handle.jsonValue()) as number) - sentAt).toBeLessThan(100);
  }
  for (const page of [b, c]) expect(await theme(page)).toBe(target);
});

test('settings controls sync language (with RTL) and font size without reloading', async ({ context }) => {
  const [a, b] = await openTabs(context, 2, '#/settings');
  await a.selectOption('#language', 'ar');
  await expect(b.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(b.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(b.locator('h1')).toHaveText('الإعدادات والمزامنة');

  await a.locator('#font-size').fill('21');
  await expect(b.locator('#font-size')).toHaveValue('21');
  expect(await b.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('21px');

  await b.getByRole('switch').click();
  await expect(a.getByRole('switch')).toHaveAttribute('aria-checked', String((await theme(b)) === 'dark'));
});

test('everything persists after every tab is closed', async ({ context }) => {
  const [a, b] = await openTabs(context, 2);
  await a.evaluate(() => {
    const s = window.tabSync;
    s.setPref('theme', 'dark');
    s.setPref('language', 'ja');
    s.setPref('fontSize', 23);
    s.update('task', 'persisted', { title: 'Water the plants', createdAt: 1 });
    s.update('note', 'persisted', { title: 'Keep me', body: 'Still here', createdAt: 1, updatedAt: 1 });
  });
  await expect(b.locator('html')).toHaveAttribute('lang', 'ja');
  await a.close();
  await b.close();

  const [reopened] = await openTabs(context, 1);
  expect(await reopened.evaluate(() => window.tabSync.prefs)).toEqual({ theme: 'dark', language: 'ja', fontSize: 23 });
  expect(await reopened.evaluate(() => window.tabSync.get('task', 'persisted')?.title)).toBe('Water the plants');
  expect(await reopened.evaluate(() => window.tabSync.get('note', 'persisted')?.body)).toBe('Still here');
});

test('a newly opened tab never paints the wrong theme', async ({ context }) => {
  const [a] = await openTabs(context, 1);
  const target = (await theme(a)) === 'dark' ? 'light' : 'dark';
  await a.evaluate((value) => window.tabSync.setPref('theme', value as 'light' | 'dark'), target);
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

test('preferences saved by the first version are migrated', async ({ context }) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (localStorage.getItem('daybook:data:v2')) return;
    const ts = { wall: 5, counter: 0, node: 'old' };
    localStorage.setItem(
      'tab-sync:preferences:v1',
      JSON.stringify({
        version: 1,
        fields: {
          theme: { value: 'dark', ts },
          language: { value: 'de', ts },
          fontSize: { value: 20, ts },
        },
      }),
    );
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('.hero-greeting')).toHaveText(/^Guten (Morgen|Tag|Abend)$/);
});

// ---------- Conflict resolution ----------

test('simultaneous edits from many tabs converge to one state', async ({ context }) => {
  const tabs = await openTabs(context, 4, '#/settings');
  const fingerprints = () => Promise.all(tabs.map((t) => t.getByTestId('fingerprint').textContent()));
  const before = await fingerprints();
  for (const t of tabs) {
    await t.evaluate(() => {
      window.tabSync.subscribe((e) => {
        if (e.type === 'change' && e.source === 'local') (window as unknown as { raced: boolean }).raced = true;
      });
    });
  }
  await english(tabs[0]);
  await tabs[0].getByRole('button', { name: /concurrent-edit/i }).click();

  // The edits fire ~400 ms after the click; wait until every tab has made its own.
  await Promise.all(tabs.map((t) => t.waitForFunction(() => (window as unknown as { raced?: boolean }).raced)));
  expect(await fingerprints()).not.toEqual(before);

  await expect.poll(async () => new Set(await fingerprints()).size, { timeout: 5000 }).toBe(1);
  const values = await Promise.all(tabs.map((t) => t.evaluate(() => window.tabSync.prefs)));
  for (const v of values) expect(v).toEqual(values[0]);
  // Storage holds the converged state as well.
  const [fresh] = await openTabs(context, 1);
  expect(await fresh.evaluate(() => window.tabSync.prefs)).toEqual(values[0]);
});

test("two tabs writing today's diary at once end up with one merged entry", async ({ context }) => {
  const [a, b] = await openTabs(context, 2, '#/diary');
  await english(a);
  await a.getByRole('button', { name: 'Great' }).click();
  await b.getByPlaceholder('How was your day?').fill('Went hiking');
  for (const page of [a, b]) {
    await expect(page.getByRole('button', { name: 'Great' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByPlaceholder('How was your day?')).toHaveValue('Went hiking');
    await expect(page.locator('.entry-links li')).toHaveCount(1);
  }
});

// ---------- Daybook features ----------

test('tasks added and completed in one tab appear in the others', async ({ context }) => {
  const [a, b] = await openTabs(context, 2, '#/tasks');
  await english(a);
  await a.getByPlaceholder('Add a task…').fill('Buy milk');
  await a.getByRole('button', { name: 'Add' }).click();
  await expect(b.locator('.task-row .inline-input')).toHaveValue('Buy milk');

  await b.getByRole('checkbox', { name: 'Mark as done' }).check();
  await expect(a.getByRole('checkbox', { name: 'Mark as done' })).toBeChecked();
  await expect(a.getByRole('heading', { name: /Completed/ })).toBeVisible();
  await expect(a.locator('.toast')).toContainText('updated tasks');
});

test('a note edited in one tab updates live in another without moving its cursor', async ({ context }) => {
  const [a] = await openTabs(context, 1, '#/notes');
  await english(a);
  await a.getByRole('button', { name: 'New note' }).first().click();
  const url = a.url();
  const [b] = await openTabs(context, 1, url.slice(url.indexOf('#')));

  const bodyA = a.getByPlaceholder('Start writing…');
  const bodyB = b.getByPlaceholder('Start writing…');
  await bodyA.fill('world');
  await expect(bodyB).toHaveValue('world');
  await expect(a.locator('.also-open')).toBeVisible();

  // B's caret sits at the end; A inserts text at the start.
  await bodyB.focus();
  await bodyB.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await bodyA.focus();
  await bodyA.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await a.keyboard.type('Hello ');
  await expect(bodyB).toHaveValue('Hello world');
  expect(await bodyB.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, document.activeElement === el])).toEqual([
    11,
    true,
  ]);
});

test('other tabs get a toast, a highlight and an "in sync" status', async ({ context }) => {
  const [a, b] = await openTabs(context, 2, '#/settings');
  await english(a);
  const aId = await a.evaluate(() => window.tabSync.tabId);

  await a.getByRole('button', { name: 'Larger text' }).click();
  await expect(b.locator('.toast')).toContainText(`Tab ${aId} updated settings`);
  await expect(b.locator('.flash-ring').first()).toBeAttached();
  await expect(a.locator('.sync-pill')).toContainText('All tabs in sync');
  await expect(b.locator('.status-hero')).toHaveAttribute('data-state', 'synced');

  await b.locator('.toast-close').first().click();
  await expect(b.locator('.toast')).toHaveCount(0);
});

test('reset restores default preferences in every tab', async ({ context }) => {
  const [a, b] = await openTabs(context, 2, '#/settings');
  const defaults = await a.evaluate(() => window.tabSync.prefs);
  await a.evaluate(() => {
    window.tabSync.setPref('fontSize', 22);
    window.tabSync.setPref('language', 'de');
  });
  await expect(b.locator('#font-size')).toHaveValue('22');
  await b.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect.poll(() => a.evaluate(() => window.tabSync.prefs)).toEqual(defaults);
});

test('sync panel: lone-tab prompt and latency explanation', async ({ context }) => {
  const [a] = await openTabs(context, 1, '#/settings');
  await english(a);
  await expect(a.locator('.status-hero')).toHaveAttribute('data-state', 'alone');
  await expect(a.locator('.status-hero')).toContainText('Open Daybook in a second tab');

  const [b] = await openTabs(context, 1, '#/settings');
  await a.getByRole('button', { name: 'Larger text' }).click();
  await expect(a.locator('.metric-value').first()).toHaveText(/ms$/);
  await expect(b.locator('.metrics-empty')).toContainText('Change something in this tab');
  await expect(b.locator('.update-banner')).toHaveCount(0);
});

test('a background picture becomes the theme in every tab, and before first paint after reload', async ({
  context,
}) => {
  const [a] = await openTabs(context, 1, '#/settings');
  await english(a);
  const [b] = await openTabs(context, 1);
  const defaultAccent = await b.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));

  // A synthetic "blue hour over a lake" picture.
  const png = await a.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 500;
    const g = canvas.getContext('2d')!;
    const sky = g.createLinearGradient(0, 0, 0, 300);
    sky.addColorStop(0, '#1d2b4f');
    sky.addColorStop(1, '#4f6b9a');
    g.fillStyle = sky;
    g.fillRect(0, 0, 800, 300);
    g.fillStyle = '#12192b';
    g.fillRect(0, 300, 800, 200);
    g.fillStyle = '#e8a87c';
    g.fillRect(560, 220, 90, 80);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await a.locator('input[type=file]').setInputFiles({
    name: 'lake.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });

  await expect(a.locator('.swatches li')).not.toHaveCount(0);
  await expect(a.getByText('Colours from your picture')).toBeVisible();
  // The other tab adopts the palette and shows the picture as its hero.
  await expect(b.locator('html')).toHaveAttribute('data-custom-palette', '');
  await expect(b.locator('.hero-photo')).toBeVisible();
  const accent = await b.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));
  expect(accent).not.toBe(defaultAccent);

  // A fresh tab has the picture's colours before <body> exists.
  const fresh = await context.newPage();
  await fresh.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (document.body) {
        (window as unknown as { accentAtBody: string }).accentAtBody = getComputedStyle(
          document.documentElement,
        ).getPropertyValue('--accent');
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await fresh.goto('/');
  expect(await fresh.evaluate(() => (window as unknown as { accentAtBody: string }).accentAtBody)).toBe(accent);

  // Back to the default theme everywhere.
  await a.getByRole('button', { name: 'Back to autumn' }).click();
  await expect(b.locator('html')).not.toHaveAttribute('data-custom-palette', '');
  await expect(b.locator('.almanac')).toBeVisible();
});

test('previously used pictures are saved and can be switched back to from any tab', async ({ context }) => {
  const [a, b] = await openTabs(context, 2, '#/settings');
  await english(a);
  const picture = (top: string, bottom: string) =>
    a.evaluate(
      ([t, bt]) => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const g = canvas.getContext('2d')!;
        g.fillStyle = t;
        g.fillRect(0, 0, 400, 180);
        g.fillStyle = bt;
        g.fillRect(0, 180, 400, 120);
        return canvas.toDataURL('image/png').split(',')[1];
      },
      [top, bottom],
    );
  const upload = async (name: string, data: string) => {
    await a.locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  };

  await upload('forest.png', await picture('#2f5d3a', '#1a2a1c'));
  await expect(a.locator('.picture-tile')).toHaveCount(1);
  const first = await a.evaluate(() => window.tabSync.appearance.image);
  await upload('sunset.png', await picture('#e07a3f', '#5a2a3c'));
  await expect(b.locator('.picture-tile')).toHaveCount(2);
  await expect(b.locator('.picture-tile[data-current]')).toHaveCount(1);

  // Switch back to the first picture from the other tab.
  await b.getByRole('button', { name: 'Use this picture' }).click();
  await expect.poll(() => a.evaluate(() => window.tabSync.appearance.image)).toBe(first);

  // Removing the picture in use returns to the autumn theme everywhere.
  await a.locator('.picture-tile[data-current]').hover();
  await a.locator('.picture-tile[data-current]').getByRole('button', { name: 'Remove from your pictures' }).click();
  await expect(b.locator('.picture-tile')).toHaveCount(1);
  await expect(b.locator('html')).not.toHaveAttribute('data-custom-palette', '');
});
