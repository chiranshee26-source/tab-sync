/**
 * AppModel: view state derived from the store's events (activity log,
 * toasts, latency samples, highlight counters, sync status), exposed to React
 * through a single version counter for useSyncExternalStore.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import { translate, type MessageKey } from '../i18n';
import type { FieldRef } from '../lww';
import { parseRecordKey, type Kind } from '../schema';
import type { StoreEvent, SyncedStore } from '../store';

const MAX_LOG_ENTRIES = 60;
const MAX_LATENCY_SAMPLES = 200;
const MAX_TOASTS = 3;
const TOAST_MS = 3200;
/** A brief fingerprint mismatch while a message is in flight is not worth showing. */
const SYNCING_GRACE_MS = 300;

export type SyncState = 'alone' | 'synced' | 'syncing';

/** What a change touched, for messages like "Tab x updated a note". */
export const WHAT: Record<Kind, MessageKey> = {
  prefs: 'whatSettings',
  task: 'whatTasks',
  reading: 'whatReading',
  note: 'whatNotes',
  diary: 'whatDiary',
  appearance: 'whatAppearance',
};

export interface LogEntry {
  id: number;
  time: Date;
  message: MessageKey;
  tab?: string;
  kinds: Kind[];
}

export interface Toast {
  id: number;
  tab: string;
  kinds: Kind[];
}

function kindsOf(changes: FieldRef[]): Kind[] {
  const kinds = new Set<Kind>();
  for (const { key } of changes) {
    const parsed = parseRecordKey(key);
    if (parsed) kinds.add(parsed.kind);
  }
  return [...kinds];
}

export class AppModel {
  private version = 0;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly flashes = new Map<string, number>();
  private mismatchSince?: number;
  private graceTimer?: ReturnType<typeof setTimeout>;

  log: LogEntry[] = [];
  toasts: Toast[] = [];
  latencies: number[] = [];
  lastLatency?: number;

  constructor(readonly store: SyncedStore) {
    store.subscribe((event) => this.onEvent(event));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Translates into the current language. */
  t = (key: MessageKey, params?: Record<string, string>): string => translate(this.store.prefs.language, key, params);

  /** Increments whenever another tab changes `key` (or `key.field`); used to replay a highlight. */
  flashCount(key: string): number {
    return this.flashes.get(key) ?? 0;
  }

  get syncState(): SyncState {
    const peers = this.store.peerStates.filter((peer) => !peer.outdated);
    if (peers.length === 0) return 'alone';
    if (peers.every((peer) => peer.inSync)) {
      this.mismatchSince = undefined;
      return 'synced';
    }
    const now = performance.now();
    this.mismatchSince ??= now;
    const remaining = SYNCING_GRACE_MS - (now - this.mismatchSince);
    if (remaining <= 0) return 'syncing';
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.bump(), remaining + 10);
    return 'synced';
  }

  dismissToast(id: number): void {
    clearTimeout(this.toastTimers.get(id));
    this.toastTimers.delete(id);
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
    this.bump();
  }

  private onEvent(event: StoreEvent): void {
    switch (event.type) {
      case 'change': {
        const kinds = kindsOf(event.changes);
        const message = event.source === 'local' ? 'logLocal' : event.source === 'remote' ? 'logRemote' : 'logStorage';
        this.addLog(message, kinds, event.source === 'local' ? this.store.tabId : event.from);
        if (event.source !== 'local') {
          for (const { key, field } of event.changes) {
            for (const flashKey of [key, `${key}.${field}`]) this.flashes.set(flashKey, this.flashCount(flashKey) + 1);
          }
        }
        if (event.source === 'remote' && event.from) this.showToast(event.from, kinds);
        break;
      }
      case 'conflict':
        this.addLog('logConflict', kindsOf(event.changes), event.from);
        break;
      case 'latency':
        this.lastLatency = event.ms;
        this.latencies = [...this.latencies.slice(-(MAX_LATENCY_SAMPLES - 1)), event.ms];
        break;
      case 'peers':
        event.joined.forEach((tab) => this.addLog('logJoined', [], tab));
        event.left.forEach((tab) => this.addLog('logLeft', [], tab));
        break;
      case 'race':
        this.addLog('logRace', [], event.from);
        break;
    }
    this.bump();
  }

  private addLog(message: MessageKey, kinds: Kind[], tab?: string): void {
    // Typing produces a change per keystroke; fold repeats into the latest entry.
    const [latest] = this.log;
    if (latest && latest.message === message && latest.tab === tab && latest.kinds.join() === kinds.join()) {
      this.log = [{ ...latest, time: new Date() }, ...this.log.slice(1)];
      return;
    }
    this.log = [{ id: this.nextId++, time: new Date(), message, tab, kinds }, ...this.log].slice(0, MAX_LOG_ENTRIES);
  }

  /** One toast per tab and kind set: continuous typing refreshes it instead of stacking. */
  private showToast(tab: string, kinds: Kind[]): void {
    let toast = this.toasts.find((item) => item.tab === tab && item.kinds.join() === kinds.join());
    if (!toast) {
      toast = { id: this.nextId++, tab, kinds };
      this.toasts = [...this.toasts, toast].slice(-MAX_TOASTS);
    }
    const id = toast.id;
    clearTimeout(this.toastTimers.get(id));
    this.toastTimers.set(id, setTimeout(() => this.dismissToast(id), TOAST_MS));
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export const ModelContext = createContext<AppModel | null>(null);

/** Re-renders the caller on every store or model change and returns the model. */
export function useModel(): AppModel {
  const model = useContext(ModelContext);
  if (!model) throw new Error('useModel must be used inside <ModelContext.Provider>');
  useSyncExternalStore(model.subscribe, model.getVersion);
  return model;
}
