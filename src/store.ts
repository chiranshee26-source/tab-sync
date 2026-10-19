/**
 * SyncedPreferences: the replicated preference store each tab owns.
 *
 *  local edit ──► stamp with HLC ──► apply ──► broadcast `update` ──► persist
 *  remote msg ──► validate ──► observe HLC ──► LWW merge ──► notify UI ──► persist
 *
 * New tabs announce themselves with `hello`; peers answer with their full
 * `state`, which covers any update still in flight to localStorage. Storage
 * `storage` events act as a second, independent path (anti-entropy), so a
 * missed broadcast is repaired as soon as any tab persists.
 */

import { HybridLogicalClock, type Timestamp } from './clock';
import { createDoc, merge, valuesOf, type MergeResult, type PartialDoc, type PrefsDoc } from './lww';
import type { Persistence } from './persistence';
import { FONT_SIZE, LANGUAGES, THEMES, type PrefKey, type Preferences } from './preferences';
import type { SyncMessage, Transport } from './transport';

export type ChangeSource = 'local' | 'remote' | 'storage';

export type StoreEvent =
  | { type: 'change'; values: Preferences; keys: PrefKey[]; source: ChangeSource; from?: string }
  | { type: 'conflict'; keys: PrefKey[]; from: string }
  | { type: 'latency'; ms: number; from: string }
  | { type: 'peers'; peers: string[]; joined: string[]; left: string[] }
  | { type: 'race'; at: number; from: string };

export interface StoreOptions {
  tabId: string;
  transport: Transport;
  persistence: Persistence;
  defaults: Preferences;
  /** High-resolution epoch milliseconds; comparable across tabs. */
  epochNow?: () => number;
  random?: () => number;
  heartbeatMs?: number;
}

const PEER_TIMEOUT_FACTOR = 3.5;
export const RACE_DELAY_MS = 400;

export class SyncedPreferences {
  readonly tabId: string;
  private doc: PrefsDoc;
  private readonly clock: HybridLogicalClock;
  private readonly listeners = new Set<(event: StoreEvent) => void>();
  private readonly peers = new Map<string, number>();
  private readonly epochNow: () => number;
  private readonly random: () => number;
  private readonly heartbeatMs: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private persistQueued = false;

  constructor(private readonly options: StoreOptions) {
    this.tabId = options.tabId;
    this.epochNow = options.epochNow ?? (() => performance.timeOrigin + performance.now());
    this.random = options.random ?? Math.random;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.clock = new HybridLogicalClock(this.tabId);
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

  get peerIds(): string[] {
    return [...this.peers.keys()];
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

  /** Asks every tab (including this one) to make random edits at the same instant. */
  startRace(): void {
    const at = this.epochNow() + RACE_DELAY_MS;
    this.post({ type: 'race', at });
    this.runRace(at, this.tabId);
  }

  private receive(message: SyncMessage): void {
    if (message.from === this.tabId) return;
    this.touchPeer(message.from);
    switch (message.type) {
      case 'hello':
        this.post({ type: 'state', entries: this.doc });
        break;
      case 'bye':
        this.dropPeer(message.from);
        break;
      case 'update':
        this.emit({ type: 'latency', ms: Math.max(0, this.epochNow() - message.sentAt), from: message.from });
        this.applyMerge(this.absorbFrom(message.entries), 'remote', message.from);
        break;
      case 'state':
        this.applyMerge(this.absorbFrom(message.entries), 'remote', message.from);
        break;
      case 'race':
        this.runRace(message.at, message.from);
        break;
      case 'heartbeat':
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
    if (result.accepted.length > 0) this.schedulePersist();
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
      const pick = <T>(items: readonly T[]) => items[Math.floor(this.random() * items.length)];
      const span = FONT_SIZE.max - FONT_SIZE.min;
      this.set('fontSize', FONT_SIZE.min + Math.round(this.random() * span));
      this.set('language', pick(LANGUAGES));
      this.set('theme', pick(THEMES));
    }, Math.max(0, at - this.epochNow()));
  }

  private post(body: DistributiveOmit<SyncMessage, 'from' | 'sentAt'>): void {
    this.options.transport.post({ ...body, from: this.tabId, sentAt: this.epochNow() } as SyncMessage);
  }

  private touchPeer(id: string): void {
    const isNew = !this.peers.has(id);
    this.peers.set(id, this.epochNow());
    if (isNew) this.emitPeers([id], []);
  }

  private dropPeer(id: string): void {
    if (this.peers.delete(id)) this.emitPeers([], [id]);
  }

  private prunePeers(): void {
    const cutoff = this.epochNow() - this.heartbeatMs * PEER_TIMEOUT_FACTOR;
    const left = [...this.peers].filter(([, seen]) => seen < cutoff).map(([id]) => id);
    for (const id of left) this.peers.delete(id);
    if (left.length > 0) this.emitPeers([], left);
  }

  private emitPeers(joined: string[], left: string[]): void {
    this.emit({ type: 'peers', peers: this.peerIds, joined, left });
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
