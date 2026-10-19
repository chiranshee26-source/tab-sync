import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deserializeDoc, fingerprint, serializeDoc, type PartialDoc, type PrefsDoc } from '../../src/lww';
import type { Persistence } from '../../src/persistence';
import type { Preferences } from '../../src/preferences';
import { SyncedPreferences, type StoreOptions } from '../../src/store';
import type { SyncMessage, Transport } from '../../src/transport';

const DEFAULTS: Preferences = { theme: 'light', language: 'en', fontSize: 16 };

/**
 * Simulated browser: a message bus that can hold messages and deliver them
 * in any order, plus a shared "localStorage" string.
 */
class Network {
  storage: string | null = null;
  private readonly handlers = new Map<Transport, (m: SyncMessage) => void>();
  private readonly storageHandlers: ((stored: PartialDoc) => void)[] = [];
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
      update: async (mergeFn: (stored: PartialDoc) => PrefsDoc) => {
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

function openTab(net: Network, id: string, overrides: Partial<StoreOptions> = {}): SyncedPreferences {
  const store = new SyncedPreferences({
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
    a.set('theme', 'dark');
    expect(b.values.theme).toBe('dark');
    expect(c.values.theme).toBe('dark');
    [a, b, c].forEach((s) => s.stop());
  });

  it('persists changes and restores them in a tab opened later', async () => {
    const net = new Network();
    const a = openTab(net, 'a');
    a.set('fontSize', 22);
    a.set('language', 'de');
    await settle();
    a.stop();

    const later = openTab(net, 'z');
    expect(later.values).toEqual({ theme: 'light', language: 'de', fontSize: 22 });
    later.stop();
  });

  it('a new tab catches up via hello/state even before storage is written', () => {
    const net = new Network();
    const a = openTab(net, 'a');
    a.set('theme', 'dark'); // persistence is still queued in a microtask
    expect(net.storage).toBeNull();
    const b = openTab(net, 'b');
    expect(b.values.theme).toBe('dark');
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
        tab.set('fontSize', 12 + Math.floor(random() * 13));
        tab.set('theme', random() < 0.5 ? 'dark' : 'light');
        tab.set('language', (['en', 'fr', 'ja'] as const)[Math.floor(random() * 3)]);
      }
      if (round % 3 === 0) net.flush(random); // partial interleavings
    }
    net.flush(random);
    await settle();

    const prints = new Set(tabs.map((t) => fingerprint(t.document)));
    expect(prints.size).toBe(1);
    // Storage converges to the same state too.
    expect(fingerprint(tabs[0].document)).toBe(
      fingerprint({ ...tabs[0].document, ...(deserializeDoc(net.storage) as PrefsDoc) }),
    );
    tabs.forEach((t) => t.stop());
  });

  it('an edit made after seeing a remote value wins, even with a lagging clock', () => {
    const net = new Network();
    const fast = openTab(net, 'fast', { wallNow: () => 10_000 });
    const slow = openTab(net, 'slow', { wallNow: () => 1 }); // badly skewed clock
    fast.set('theme', 'dark');
    slow.set('theme', 'light'); // the user saw "dark" and deliberately changed it
    expect(fast.values.theme).toBe('light');
    expect(slow.values.theme).toBe('light');
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
    b.subscribe((e) => e.type === 'conflict' && conflicts.push(...e.keys));
    a.set('language', 'fr'); // older
    b.set('language', 'de'); // newer, concurrent
    net.flush();
    expect(a.values.language).toBe('de');
    expect(b.values.language).toBe('de');
    expect(conflicts).toEqual(['language']);
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
    expect(a.peerStates).toEqual([{ id: 'b', inSync: true }]);

    a.set('theme', 'dark');
    net.queue = []; // the update is lost in transit
    expect(b.values.theme).toBe('light');
    expect(a.peerStates).toEqual([{ id: 'b', inSync: false }]);

    net.autoDeliver = true;
    vi.advanceTimersByTime(1000); // next heartbeat exposes the fingerprint mismatch
    await Promise.resolve();
    expect(b.values.theme).toBe('dark');
    expect(a.peerStates).toEqual([{ id: 'b', inSync: true }]);
    expect(b.peerStates).toEqual([{ id: 'a', inSync: true }]);
    a.stop();
    b.stop();
  });

  it('reset() restores defaults as a synced edit', () => {
    const net = new Network();
    const a = openTab(net, 'a');
    const b = openTab(net, 'b');
    a.set('fontSize', 22);
    a.set('theme', 'dark');
    b.reset();
    expect(a.values).toEqual(DEFAULTS);
    expect(b.values).toEqual(DEFAULTS);
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
    a.set('theme', 'dark');
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
