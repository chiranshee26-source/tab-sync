/**
 * SyncedPreferences: the replicated preference store each tab owns.
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
  createDoc,
  fingerprint,
  merge,
  valuesOf,
  type MergeResult,
  type PartialDoc,
  type PrefsDoc,
} from './lww';
import type { Persistence } from './persistence';
import { FONT_SIZE, LANGUAGES, PREF_KEYS, THEMES, type PrefKey, type Preferences } from './preferences';
import type { SyncMessage, Transport } from './transport';

export type ChangeSource = 'local' | 'remote' | 'storage';

export interface PeerState {
  id: string;
  /** True when the peer's last reported state equals ours. */
  inSync: boolean;
}

export type StoreEvent =
  | { type: 'change'; values: Preferences; keys: PrefKey[]; source: ChangeSource; from?: string }
  | { type: 'conflict'; keys: PrefKey[]; from: string }
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
}

interface Peer {
  lastSeen: number;
  fp?: string;
  hidden: boolean;
}

/** A visible tab that misses ~3 heartbeats is gone (closing a tab also sends `bye`). */
const PEER_TIMEOUT_FACTOR = 3.5;
/**
 * Background tabs get their timers throttled (Chrome: down to one run per
 * minute after five minutes hidden), so their heartbeats can be far apart.
 */
const HIDDEN_PEER_TIMEOUT_MS = 90_000;
export const RACE_DELAY_MS = 400;

export class SyncedPreferences {
  readonly tabId: string;
  private doc: PrefsDoc;
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
    this.isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    this.random = options.random ?? Math.random;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.clock = new HybridLogicalClock(this.tabId, this.wallNow);
    // Defaults carry the zero timestamp, so any real edit from any tab wins.
    this.doc = createDoc(options.defaults);
    this.absorb(options.persistence.load());
  }

  get values(): Preferences {
    return valuesOf(this.doc);
  }

  get document(): PrefsDoc {
    return this.doc;
  }

  get fingerprint(): string {
    return fingerprint(this.doc);
  }

  get peerIds(): string[] {
    return [...this.peers.keys()];
  }

  get peerStates(): PeerState[] {
    const own = this.fingerprint;
    return [...this.peers].map(([id, peer]) => ({ id, inSync: peer.fp === own }));
  }

  get transportKind(): string {
    return this.options.transport.kind;
  }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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

  /** Tells peers right away that this tab went to the background or came back. */
  announce(): void {
    this.post({ type: 'heartbeat' });
  }

  /** Re-reads storage and re-announces this tab, e.g. after restoring from bfcache. */
  resync(): void {
    this.applyMerge(merge(this.doc, this.options.persistence.load()), 'storage');
    this.post({ type: 'hello' });
  }

  set<K extends PrefKey>(key: K, value: Preferences[K]): void {
    if (this.doc[key].value === value) return;
    const entry = { value, ts: this.clock.now() };
    const entries = { [key]: entry } as PartialDoc;
    this.doc = { ...this.doc, [key]: entry };
    this.post({ type: 'update', entries });
    this.emit({ type: 'change', values: this.values, keys: [key], source: 'local' });
    this.schedulePersist();
  }

  /** Restores the defaults as a regular (synced, timestamped) edit. */
  reset(): void {
    for (const key of PREF_KEYS) this.set(key, this.options.defaults[key]);
  }

  /** Asks every tab (including this one) to make random edits at the same instant. */
  startRace(): void {
    const at = this.wallNow() + RACE_DELAY_MS;
    this.post({ type: 'race', at });
    this.runRace(at, this.tabId);
  }

  private receive(message: SyncMessage): void {
    if (message.from === this.tabId) return;
    this.touchPeer(message.from, message.fp, message.hidden ?? false);
    switch (message.type) {
      case 'hello':
        this.post({ type: 'state', entries: this.doc });
        break;
      case 'bye':
        this.dropPeer(message.from);
        break;
      case 'update':
        this.applyMerge(this.absorbFrom(message.entries), 'remote', message.from);
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
        this.applyMerge(this.absorbFrom(message.entries), 'remote', message.from);
        // The sender lacks something we have: send it back once. After that
        // both sides hold the join of the two states, so this cannot loop.
        if (message.fp && message.fp !== this.fingerprint) this.post({ type: 'state', entries: this.doc });
        break;
      case 'heartbeat':
        if (message.fp && message.fp !== this.fingerprint) this.post({ type: 'state', entries: this.doc });
        break;
      case 'race':
        this.runRace(message.at, message.from);
        break;
    }
  }

  /** Merges validated entries and advances the clock past them. */
  private absorbFrom(entries: PartialDoc): MergeResult {
    for (const entry of Object.values(entries) as { ts: Timestamp }[]) this.clock.observe(entry.ts);
    return merge(this.doc, entries);
  }

  private absorb(entries: PartialDoc): void {
    this.doc = this.absorbFrom(entries).doc;
  }

  private applyMerge(result: MergeResult, source: ChangeSource, from?: string): void {
    const before = this.doc;
    this.doc = result.doc;
    const changed = result.accepted.filter((key) => before[key].value !== result.doc[key].value);
    if (changed.length > 0) this.emit({ type: 'change', values: this.values, keys: changed, source, from });
    if (result.rejected.length > 0 && from) this.emit({ type: 'conflict', keys: result.rejected, from });
    if (result.accepted.length > 0) {
      this.schedulePersist();
      this.scheduleAck();
    }
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

  /** Coalesces bursts (e.g. slider drags) into one storage write per task. */
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
      const { fontSize, language, theme } = this.values;
      this.set('fontSize', pickOther(sizes, fontSize));
      this.set('language', pickOther(LANGUAGES, language));
      this.set('theme', pickOther(THEMES, theme));
    }, Math.max(0, at - this.wallNow()));
  }

  private post(body: DistributiveOmit<SyncMessage, 'from' | 'sentAt' | 'fp' | 'hidden'>): void {
    this.ackQueued = false;
    this.options.transport.post({
      ...body,
      from: this.tabId,
      sentAt: this.now(),
      fp: this.fingerprint,
      hidden: this.isHidden(),
    } as SyncMessage);
  }

  private touchPeer(id: string, fp: string | undefined, hidden: boolean): void {
    const previous = this.peers.get(id);
    this.peers.set(id, { lastSeen: this.now(), fp: fp ?? previous?.fp, hidden });
    if (!previous) this.emitPeers([id], []);
    else if (fp && fp !== previous.fp) this.emitPeers([], []);
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
