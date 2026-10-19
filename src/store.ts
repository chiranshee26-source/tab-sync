/**
 * SyncedStore: the replicated document each tab owns (preferences, tasks,
 * reading list, notes and diary).
 *
 *  local edit ──► stamp with HLC ──► apply ──► broadcast `update` ──► persist
 *  remote msg ──► validate ──► observe HLC ──► LWW merge ──► notify UI ──► persist
 *
 * New tabs announce themselves with `hello`; peers answer with their full
 * `state`, which covers any update still in flight to localStorage. Storage
 * `storage` events act as a second, independent path, so a missed broadcast
 * is repaired as soon as any tab persists.
 *
 * Every message carries the sender's state fingerprint. A tab that sees a
 * fingerprint different from its own on a heartbeat answers with its full
 * state, so tabs that diverged (e.g. a dropped message) repair themselves,
 * and the UI can show whether all tabs have converged.
 */

import { HybridLogicalClock, type Timestamp } from './clock';
import {
  fingerprint,
  merge,
  prefsRecord,
  prefsValues,
  recordValues,
  type Doc,
  type Entry,
  type FieldRef,
  type MergeResult,
} from './lww';
import type { Persistence } from './persistence';
import { FONT_SIZE, LANGUAGES, THEMES, type PrefKey, type Preferences } from './preferences';
import { recordKey, type ItemKind, type RecordTypes } from './schema';
import type { SyncMessage, Transport } from './transport';

export type ChangeSource = 'local' | 'remote' | 'storage';

export interface PeerState {
  id: string;
  /** True when the peer's last reported state equals ours. */
  inSync: boolean;
  /** Runs an older deploy; it cannot sync with this tab until reloaded. */
  outdated: boolean;
  /** Route the peer is showing, if it reported one. */
  view?: string;
}

export type StoreEvent =
  | { type: 'change'; changes: FieldRef[]; source: ChangeSource; from?: string }
  | { type: 'conflict'; changes: FieldRef[]; from: string }
  | { type: 'latency'; ms: number; from: string }
  | { type: 'peers'; peers: PeerState[]; joined: string[]; left: string[] }
  | { type: 'race'; at: number; from: string };

export interface StoreOptions {
  tabId: string;
  transport: Transport;
  persistence: Persistence;
  defaults: Preferences;
  /** Local monotonic clock (ms) for latency and presence; never compared across tabs. */
  now?: () => number;
  /** Wall-clock time (ms), shared by all tabs on the machine: drives the HLC and the race start. */
  wallNow?: () => number;
  /** Whether this tab is currently in the background. */
  isHidden?: () => boolean;
  random?: () => number;
  heartbeatMs?: number;
  /** Build time of this tab's code (see vite.config.ts). */
  build?: number;
}

interface Peer {
  lastSeen: number;
  fp?: string;
  hidden: boolean;
  build?: number;
  view?: string;
}

/** A visible tab that misses ~3 heartbeats is gone (closing a tab also sends `bye`). */
const PEER_TIMEOUT_FACTOR = 3.5;
/**
 * Background tabs get their timers throttled (Chrome: down to one run per
 * minute after five minutes hidden), so their heartbeats can be far apart.
 */
const HIDDEN_PEER_TIMEOUT_MS = 90_000;
export const RACE_DELAY_MS = 400;

export class SyncedStore {
  readonly tabId: string;
  private doc: Doc;
  private cachedFingerprint?: string;
  private view?: string;
  private readonly clock: HybridLogicalClock;
  private readonly listeners = new Set<(event: StoreEvent) => void>();
  private readonly peers = new Map<string, Peer>();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly isHidden: () => boolean;
  private readonly random: () => number;
  private readonly heartbeatMs: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private persistQueued = false;
  private ackQueued = false;

  constructor(private readonly options: StoreOptions) {
    this.tabId = options.tabId;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.isHidden =
      options.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    this.random = options.random ?? Math.random;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.clock = new HybridLogicalClock(this.tabId, this.wallNow);
    // Defaults carry the zero timestamp, so any real edit from any tab wins.
    this.doc = { prefs: prefsRecord(options.defaults) };
    this.doc = this.absorb(options.persistence.load()).doc;
  }

  // ---------- Reading ----------

  /** The whole document. A new object after every change (handy for React). */
  get document(): Doc {
    return this.doc;
  }

  get prefs(): Preferences {
    return prefsValues(this.doc);
  }

  get<K extends ItemKind>(kind: K, id: string): RecordTypes[K] | undefined {
    const key = recordKey(kind, id);
    return this.doc[key] ? recordValues(this.doc, kind, key) : undefined;
  }

  get appearance(): RecordTypes['appearance'] {
    return recordValues(this.doc, 'appearance', 'appearance');
  }

  setAppearance(appearance: RecordTypes['appearance']): void {
    // Both fields share one timestamp, so concurrent changes from two tabs
    // resolve to the same tab's picture *and* palette, never a mix.
    this.write('appearance', { ...appearance }, true);
  }

  /** All records of a kind, without deleted ones. */
  list<K extends ItemKind>(kind: K): (RecordTypes[K] & { id: string })[] {
    const prefix = `${kind}:`;
    const items: (RecordTypes[K] & { id: string })[] = [];
    for (const key of Object.keys(this.doc)) {
      if (!key.startsWith(prefix)) continue;
      const values = recordValues(this.doc, kind, key);
      if (!('deleted' in values && values.deleted)) items.push({ ...values, id: key.slice(prefix.length) });
    }
    return items;
  }

  get fingerprint(): string {
    return (this.cachedFingerprint ??= fingerprint(this.doc));
  }

  get peerIds(): string[] {
    return [...this.peers.keys()];
  }

  get peerStates(): PeerState[] {
    const own = this.fingerprint;
    return [...this.peers].map(([id, peer]) => ({
      id,
      inSync: peer.fp === own,
      outdated: this.isOutdated(peer),
      view: peer.view,
    }));
  }

  /** True when another tab runs a newer deploy, so this one should reload. */
  get newerBuildAvailable(): boolean {
    const own = this.options.build ?? 0;
    return [...this.peers.values()].some((peer) => (peer.build ?? 0) > own);
  }

  get transportKind(): string {
    return this.options.transport.kind;
  }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- Writing ----------

  /** Writes some fields of a record; unchanged values are skipped. */
  update<K extends ItemKind>(kind: K, id: string, fields: Partial<RecordTypes[K]>): void {
    this.write(recordKey(kind, id), fields as Record<string, unknown>);
  }

  remove(kind: 'task' | 'reading' | 'note', id: string): void {
    this.update(kind, id, { deleted: true });
  }

  setPref<K extends PrefKey>(key: K, value: Preferences[K]): void {
    this.write('prefs', { [key]: value });
  }

  /** Restores the default preferences as a regular (synced, timestamped) edit. */
  resetPrefs(): void {
    this.write('prefs', { ...this.options.defaults });
  }

  /** `together`: stamp every given field, even unchanged ones, so they win or lose as a unit. */
  private write(key: string, fields: Record<string, unknown>, together = false): void {
    const current = this.doc[key] ?? {};
    const differs = Object.entries(fields).some(([field, value]) => current[field]?.value !== value);
    if (!differs) return;
    const changed = Object.entries(fields).filter(([field, value]) => together || current[field]?.value !== value);
    const ts = this.clock.now();
    const record: Record<string, Entry> = {};
    for (const [field, value] of changed) record[field] = { value, ts };
    this.setDoc({ ...this.doc, [key]: { ...current, ...record } });
    this.post({ type: 'update', entries: { [key]: record } });
    this.emit({ type: 'change', changes: changed.map(([field]) => ({ key, field })), source: 'local' });
    this.schedulePersist();
  }

  // ---------- Lifecycle and presence ----------

  start(): void {
    this.options.transport.subscribe((message) => this.receive(message));
    this.options.persistence.onExternalChange((stored) => this.applyMerge(merge(this.doc, stored), 'storage'));
    this.post({ type: 'hello' });
    this.heartbeatTimer = setInterval(() => {
      this.post({ type: 'heartbeat' });
      this.prunePeers();
    }, this.heartbeatMs);
  }

  stop(): void {
    clearInterval(this.heartbeatTimer);
    this.post({ type: 'bye' });
  }

  /** Tells peers right away that this tab changed page, went to the background or came back. */
  announce(view: string | undefined = this.view): void {
    this.view = view;
    this.post({ type: 'heartbeat' });
  }

  /** Re-reads storage and re-announces this tab, e.g. after restoring from bfcache. */
  resync(): void {
    this.applyMerge(merge(this.doc, this.options.persistence.load()), 'storage');
    this.post({ type: 'hello' });
  }

  /** Asks every tab (including this one) to make conflicting preference edits at the same instant. */
  startRace(): void {
    const at = this.wallNow() + RACE_DELAY_MS;
    this.post({ type: 'race', at });
    this.runRace(at, this.tabId);
  }

  private receive(message: SyncMessage): void {
    if (message.from === this.tabId) return;
    this.touchPeer(message.from, message);
    // Repair only with tabs running the same build: an older build cannot
    // represent our data, so exchanging full states with it would never converge.
    const sameBuild = message.build === this.options.build;
    switch (message.type) {
      case 'hello':
        this.post({ type: 'state', entries: this.doc });
        break;
      case 'bye':
        this.dropPeer(message.from);
        break;
      case 'update':
        this.applyMerge(this.absorb(message.entries), 'remote', message.from);
        // Acknowledge with our new fingerprint; the echo lets the sender time the round trip.
        this.post({ type: 'ack', to: message.from, ackOf: message.sentAt });
        break;
      case 'ack':
        // Both timestamps come from our own clock, so clock differences between tabs cancel out.
        if (message.to === this.tabId) {
          this.emit({ type: 'latency', ms: Math.max(0, this.now() - message.ackOf) / 2, from: message.from });
        }
        break;
      case 'state':
        this.applyMerge(this.absorb(message.entries), 'remote', message.from);
        // The sender lacks something we have: send it back once. After that
        // both sides hold the join of the two states, so this cannot loop.
        if (sameBuild && message.fp && message.fp !== this.fingerprint) this.post({ type: 'state', entries: this.doc });
        break;
      case 'heartbeat':
        if (sameBuild && message.fp && message.fp !== this.fingerprint) this.post({ type: 'state', entries: this.doc });
        break;
      case 'race':
        this.runRace(message.at, message.from);
        break;
    }
  }

  /** Advances the clock past incoming timestamps, then merges. */
  private absorb(entries: Doc): MergeResult {
    for (const record of Object.values(entries)) {
      for (const entry of Object.values(record) as { ts: Timestamp }[]) this.clock.observe(entry.ts);
    }
    return merge(this.doc, entries);
  }

  private applyMerge(result: MergeResult, source: ChangeSource, from?: string): void {
    const before = this.doc;
    this.setDoc(result.doc);
    const changed = result.accepted.filter(({ key, field }) => before[key]?.[field]?.value !== result.doc[key][field].value);
    if (changed.length > 0) this.emit({ type: 'change', changes: changed, source, from });
    if (result.rejected.length > 0 && from) this.emit({ type: 'conflict', changes: result.rejected, from });
    if (result.accepted.length > 0) {
      this.schedulePersist();
      this.scheduleAck();
    }
  }

  private setDoc(doc: Doc): void {
    if (doc === this.doc) return;
    this.doc = doc;
    this.cachedFingerprint = undefined;
  }

  /**
   * Tells peers our new fingerprint right away, so their sync indicator
   * settles fast. Every message carries the fingerprint, so any message sent
   * before the microtask runs (e.g. the `ack` to an update) already does it.
   */
  private scheduleAck(): void {
    if (this.ackQueued) return;
    this.ackQueued = true;
    queueMicrotask(() => {
      if (this.ackQueued) this.post({ type: 'heartbeat' });
    });
  }

  /** Coalesces bursts (typing, slider drags) into one storage write per task. */
  private schedulePersist(): void {
    if (this.persistQueued) return;
    this.persistQueued = true;
    queueMicrotask(() => {
      this.persistQueued = false;
      void this.options.persistence.update((stored) => {
        this.applyMerge(merge(this.doc, stored), 'storage');
        return this.doc;
      });
    });
  }

  private runRace(at: number, from: string): void {
    this.emit({ type: 'race', at, from });
    setTimeout(() => {
      // Always pick a value different from the current one, so every tab really edits.
      const pickOther = <T>(items: readonly T[], current: T) => {
        const others = items.filter((item) => item !== current);
        return others[Math.floor(this.random() * others.length)];
      };
      const sizes = Array.from({ length: FONT_SIZE.max - FONT_SIZE.min + 1 }, (_, i) => FONT_SIZE.min + i);
      const { fontSize, language, theme } = this.prefs;
      this.setPref('fontSize', pickOther(sizes, fontSize));
      this.setPref('language', pickOther(LANGUAGES, language));
      this.setPref('theme', pickOther(THEMES, theme));
    }, Math.max(0, at - this.wallNow()));
  }

  private post(body: DistributiveOmit<SyncMessage, 'from' | 'sentAt' | 'fp' | 'hidden' | 'build' | 'view'>): void {
    this.ackQueued = false;
    this.options.transport.post({
      ...body,
      from: this.tabId,
      sentAt: this.now(),
      fp: this.fingerprint,
      hidden: this.isHidden(),
      build: this.options.build,
      view: this.view,
    } as SyncMessage);
  }

  private isOutdated(peer: Peer): boolean {
    return (peer.build ?? 0) < (this.options.build ?? 0);
  }

  private touchPeer(id: string, message: SyncMessage): void {
    const previous = this.peers.get(id);
    const { fp, hidden = false, build, view } = message;
    this.peers.set(id, { lastSeen: this.now(), fp: fp ?? previous?.fp, hidden, build, view });
    if (!previous) this.emitPeers([id], []);
    else if ((fp && fp !== previous.fp) || view !== previous.view) this.emitPeers([], []);
  }

  private dropPeer(id: string): void {
    if (this.peers.delete(id)) this.emitPeers([], [id]);
  }

  private prunePeers(): void {
    const now = this.now();
    const left = [...this.peers]
      .filter(([, peer]) => now - peer.lastSeen > (peer.hidden ? HIDDEN_PEER_TIMEOUT_MS : this.heartbeatMs * PEER_TIMEOUT_FACTOR))
      .map(([id]) => id);
    for (const id of left) this.peers.delete(id);
    if (left.length > 0) this.emitPeers([], left);
  }

  private emitPeers(joined: string[], left: string[]): void {
    this.emit({ type: 'peers', peers: this.peerStates, joined, left });
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

