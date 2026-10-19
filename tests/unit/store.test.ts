import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deserializeDoc, fingerprint, serializeDoc, type Doc } from '../../src/lww';
import type { Persistence } from '../../src/persistence';
import type { Preferences } from '../../src/preferences';
import { SyncedStore, type StoreOptions } from '../../src/store';
import type { SyncMessage, Transport } from '../../src/transport';

const DEFAULTS: Preferences = { theme: 'light', language: 'en', fontSize: 16 };

/**
 * Simulated browser: a message bus that can hold messages and deliver them
 * in any order, plus a shared "localStorage" string.
 */
class Network {
  storage: string | null = null;
  private readonly handlers = new Map<Transport, (m: SyncMessage) => void>();
  private readonly storageHandlers: ((stored: Doc) => void)[] = [];
  queue: { to: Transport; message: SyncMessage }[] = [];
  autoDeliver = true;

  transport(): Transport {
    const self = this;
    const transport: Transport = {
      kind: 'test',
      post(message) {
        // Structured clone, like the real BroadcastChannel.
        const copy = JSON.parse(JSON.stringify(message)) as SyncMessage;
        for (const to of self.handlers.keys()) if (to !== transport) self.queue.push({ to, message: copy });
        if (self.autoDeliver) self.flush();
      },
      subscribe(handler) {
        self.handlers.set(transport, handler);
      },
      close() {
        self.handlers.delete(transport);
      },
    };
    return transport;
  }

  persistence(): Persistence {
    return {
      load: () => deserializeDoc(this.storage),
      update: async (mergeFn: (stored: Doc) => Doc) => {
        const next = serializeDoc(mergeFn(deserializeDoc(this.storage)));
        if (next !== this.storage) {
          this.storage = next;
          for (const h of this.storageHandlers) h(deserializeDoc(next));
        }
      },
      onExternalChange: (handler) => {
        this.storageHandlers.push(handler);
      },
    };
  }

  flush(shuffle?: () => number): void {
    while (this.queue.length) {
      const index = shuffle ? Math.floor(shuffle() * this.queue.length) : 0;
      const [{ to, message }] = this.queue.splice(index, 1);
      this.handlers.get(to)?.(message);
    }
  }
}

function openTab(net: Network, id: string, overrides: Partial<StoreOptions> = {}): SyncedStore {
  const store = new SyncedStore({
    tabId: id,
    transport: net.transport(),
    persistence: net.persistence(),
    defaults: DEFAULTS,
    now: () => Date.now(),
    isHidden: () => false,
    ...overrides,
  });
  store.start();
  return store;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SyncedPreferences', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('propagates a local change to every other tab', () => {
    const net = new Network();
    const [a, b, c] = ['a', 'b', 'c'].map((id) => openTab(net, id));
    a.setPref('theme', 'dark');
    expect(b.prefs.theme).toBe('dark');
    expect(c.prefs.theme).toBe('dark');
    [a, b, c].forEach((s) => s.stop());
  });

  it('persists changes and restores them in a tab opened later', async () => {
    const net = new Network();
    const a = openTab(net, 'a');
    a.setPref('fontSize', 22);
    a.setPref('language', 'de');
    await settle();
    a.stop();

    const later = openTab(net, 'z');
    expect(later.prefs).toEqual({ theme: 'light', language: 'de', fontSize: 22 });
    later.stop();
  });

  it('a new tab catches up via hello/state even before storage is written', () => {
    const net = new Network();
    const a = openTab(net, 'a');
    a.setPref('theme', 'dark'); // persistence is still queued in a microtask
    expect(net.storage).toBeNull();
    const b = openTab(net, 'b');
    expect(b.prefs.theme).toBe('dark');
    a.stop();
    b.stop();
  });

  it('converges when many tabs edit simultaneously and messages arrive in random order', async () => {
    const net = new Network();
    net.autoDeliver = false;
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const tabs = Array.from({ length: 5 }, (_, i) => openTab(net, `tab${i}`, { wallNow: () => 1_000 })); // identical wall clocks
    net.flush(random);

    for (let round = 0; round < 20; round++) {
      for (const tab of tabs) {
        tab.setPref('fontSize', 12 + Math.floor(random() * 13));
        tab.setPref('theme', random() < 0.5 ? 'dark' : 'light');
        tab.setPref('language', (['en', 'fr', 'ja'] as const)[Math.floor(random() * 3)]);
      }
      if (round % 3 === 0) net.flush(random); // partial interleavings
    }
    net.flush(random);
    await settle();

    const prints = new Set(tabs.map((t) => fingerprint(t.document)));
    expect(prints.size).toBe(1);
    // Storage converges to the same state too.
    expect(fingerprint(deserializeDoc(net.storage))).toBe(fingerprint(tabs[0].document));
    tabs.forEach((t) => t.stop());
  });

  it('an edit made after seeing a remote value wins, even with a lagging clock', () => {
    const net = new Network();
    const fast = openTab(net, 'fast', { wallNow: () => 10_000 });
    const slow = openTab(net, 'slow', { wallNow: () => 1 }); // badly skewed clock
    fast.setPref('theme', 'dark');
    slow.setPref('theme', 'light'); // the user saw "dark" and deliberately changed it
    expect(fast.prefs.theme).toBe('light');
    expect(slow.prefs.theme).toBe('light');
    fast.stop();
    slow.stop();
  });

  it('reports conflicts when a stale update loses', () => {
    const net = new Network();
    net.autoDeliver = false;
    const a = openTab(net, 'a', { wallNow: () => 1 });
    const b = openTab(net, 'b', { wallNow: () => 2 });
    net.flush();
    const conflicts: string[] = [];
    b.subscribe((e) => e.type === 'conflict' && conflicts.push(...e.changes.map((c) => `${c.key}.${c.field}`)));
    a.setPref('language', 'fr'); // older
    b.setPref('language', 'de'); // newer, concurrent
    net.flush();
    expect(a.prefs.language).toBe('de');
    expect(b.prefs.language).toBe('de');
    expect(conflicts).toEqual(['prefs.language']);
    a.stop();
    b.stop();
  });

  it('reports whether peers have converged, and repairs a dropped update via heartbeat', async () => {
    vi.useFakeTimers();
    const net = new Network();
    net.autoDeliver = false;
    const a = openTab(net, 'a');
    const b = openTab(net, 'b');
    net.flush();
    expect(a.peerStates).toMatchObject([{ id: 'b', inSync: true }]);

    a.setPref('theme', 'dark');
    net.queue = []; // the update is lost in transit
    expect(b.prefs.theme).toBe('light');
    expect(a.peerStates).toMatchObject([{ id: 'b', inSync: false }]);

    net.autoDeliver = true;
    vi.advanceTimersByTime(1000); // next heartbeat exposes the fingerprint mismatch
    await Promise.resolve();
    expect(b.prefs.theme).toBe('dark');
    expect(a.peerStates).toMatchObject([{ id: 'b', inSync: true }]);
    expect(b.peerStates).toMatchObject([{ id: 'a', inSync: true }]);
    a.stop();
    b.stop();
  });

  it('reset() restores defaults as a synced edit', () => {
    const net = new Network();
    const a = openTab(net, 'a');
    const b = openTab(net, 'b');
    a.setPref('fontSize', 22);
    a.setPref('theme', 'dark');
    b.resetPrefs();
    expect(a.prefs).toEqual(DEFAULTS);
    expect(b.prefs).toEqual(DEFAULTS);
    a.stop();
    b.stop();
  });

  it('measures latency as half the round trip, on the sender\'s own clock', () => {
    const net = new Network();
    net.autoDeliver = false;
    let clockA = 100;
    // Wildly different clocks per tab must not matter.
    const a = openTab(net, 'a', { now: () => clockA });
    const b = openTab(net, 'b', { now: () => 1_000_000 });
    net.flush();
    const latencies: { tab: string; ms: number }[] = [];
    a.subscribe((e) => e.type === 'latency' && latencies.push({ tab: 'a', ms: e.ms }));
    b.subscribe((e) => e.type === 'latency' && latencies.push({ tab: 'b', ms: e.ms }));
    a.setPref('theme', 'dark');
    clockA = 110; // the round trip takes 10 ms on a's clock
    net.flush();
    expect(latencies).toEqual([{ tab: 'a', ms: 5 }]);
    a.stop();
    b.stop();
  });

  it('keeps background tabs (throttled timers) listed, but drops silent visible tabs', () => {
    vi.useFakeTimers();
    const net = new Network();
    const a = openTab(net, 'a');
    const background = openTab(net, 'bg', { isHidden: () => true });
    const crashed = openTab(net, 'gone');
    // Simulate throttled / dead tabs: their messages stop arriving, without a `bye`.
    net.autoDeliver = false;
    vi.advanceTimersByTime(10_000);
    net.queue = [];
    expect(a.peerIds).toEqual(['bg']);
    vi.advanceTimersByTime(90_000);
    net.queue = [];
    expect(a.peerIds).toEqual([]);
    [a, background, crashed].forEach((s) => s.stop());
  });

  it('notices when another tab runs a newer deploy', () => {
    const net = new Network();
    const old = openTab(net, 'old', { build: 1 });
    const fresh = openTab(net, 'new', { build: 2 });
    expect(old.newerBuildAvailable).toBe(true);
    expect(fresh.newerBuildAvailable).toBe(false);
    old.stop();
    fresh.stop();
  });

  it('syncs tasks, notes and deletions between tabs', async () => {
    const net = new Network();
    const a = openTab(net, 'a');
    const b = openTab(net, 'b');
    a.update('task', 't1', { title: 'Buy milk', createdAt: 1 });
    b.update('task', 't1', { done: true });
    a.update('note', 'n1', { title: 'Ideas', body: 'Write a diary app' });
    expect(b.list('task')).toEqual([{ id: 't1', title: 'Buy milk', done: true, due: '', createdAt: 1, deleted: false }]);
    expect(a.get('task', 't1')?.done).toBe(true);
    expect(b.get('note', 'n1')?.body).toBe('Write a diary app');
    b.remove('note', 'n1');
    expect(a.list('note')).toEqual([]);
    await settle();
    const later = openTab(net, 'later');
    expect(later.list('task').map((t) => t.title)).toEqual(['Buy milk']);
    [a, b, later].forEach((s) => s.stop());
  });

  it("merges two tabs writing today's diary entry into one record", () => {
    const net = new Network();
    net.autoDeliver = false;
    const a = openTab(net, 'a', { wallNow: () => 10 });
    const b = openTab(net, 'b', { wallNow: () => 10 });
    net.flush();
    a.update('diary', '2026-10-19', { body: 'Morning run' });
    b.update('diary', '2026-10-19', { mood: 'great' });
    net.flush();
    for (const tab of [a, b]) {
      expect(tab.list('diary')).toEqual([{ id: '2026-10-19', body: 'Morning run', mood: 'great', updatedAt: 0 }]);
    }
    a.stop();
    b.stop();
  });

  it('shares which page each tab is viewing', () => {
    const net = new Network();
    const a = openTab(net, 'a');
    const b = openTab(net, 'b');
    b.announce('notes/n1');
    expect(a.peerStates).toEqual([{ id: 'b', inSync: true, outdated: false, view: 'notes/n1' }]);
    a.stop();
    b.stop();
  });

  it('tracks peers joining and leaving', () => {
    const net = new Network();
    const a = openTab(net, 'a');
    const b = openTab(net, 'b');
    expect(a.peerIds).toEqual(['b']);
    expect(b.peerIds).toEqual(['a']);
    b.stop();
    expect(a.peerIds).toEqual([]);
    a.stop();
  });
});
