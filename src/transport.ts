/**
 * Tab-to-tab messaging. BroadcastChannel is the primary transport (same-origin,
 * in-memory, typically < 1 ms). Browsers without it fall back to the `storage`
 * event, which every engine supports.
 */

import { parsePartialDoc, type PartialDoc } from './lww';
import { CHANNEL_NAME } from './preferences';

interface Envelope {
  /** Sender's tab id. */
  from: string;
  /** Sender's high-resolution epoch time in ms, used to measure latency. */
  sentAt: number;
}

export type SyncMessage = Envelope &
  (
    | { type: 'hello' }
    | { type: 'heartbeat' }
    | { type: 'bye' }
    | { type: 'update'; entries: PartialDoc }
    | { type: 'state'; entries: PartialDoc }
    | { type: 'race'; at: number }
  );

export interface Transport {
  readonly kind: string;
  post(message: SyncMessage): void;
  subscribe(handler: (message: SyncMessage) => void): void;
  close(): void;
}

const SIMPLE_TYPES = new Set(['hello', 'heartbeat', 'bye']);

/** Messages may come from another build of the app; never trust their shape. */
export function parseMessage(raw: unknown): SyncMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.from !== 'string' || typeof m.sentAt !== 'number' || !Number.isFinite(m.sentAt)) return null;
  const envelope = { from: m.from, sentAt: m.sentAt };
  if (typeof m.type !== 'string') return null;
  if (SIMPLE_TYPES.has(m.type)) return { ...envelope, type: m.type as 'hello' | 'heartbeat' | 'bye' };
  if (m.type === 'update' || m.type === 'state') {
    // Entries (values and timestamps) are validated field by field.
    return { ...envelope, type: m.type, entries: parsePartialDoc(m.entries) };
  }
  if (m.type === 'race' && typeof m.at === 'number' && Number.isFinite(m.at)) {
    return { ...envelope, type: 'race', at: m.at };
  }
  return null;
}

export class BroadcastChannelTransport implements Transport {
  readonly kind = 'BroadcastChannel';
  private readonly channel = new BroadcastChannel(CHANNEL_NAME);

  post(message: SyncMessage): void {
    this.channel.postMessage(message);
  }

  subscribe(handler: (message: SyncMessage) => void): void {
    this.channel.addEventListener('message', (event: MessageEvent) => {
      const message = parseMessage(event.data);
      if (message) handler(message);
    });
  }

  close(): void {
    this.channel.close();
  }
}

/** Fallback: writing a key fires `storage` events in every other same-origin tab. */
export class StorageEventTransport implements Transport {
  readonly kind = 'storage event';
  private readonly key = `${CHANNEL_NAME}:message`;
  private listener?: (event: StorageEvent) => void;

  post(message: SyncMessage): void {
    try {
      // A nonce guarantees the value differs, so the event always fires.
      localStorage.setItem(this.key, JSON.stringify({ ...message, nonce: Math.random() }));
      localStorage.removeItem(this.key);
    } catch {
      /* storage unavailable: nothing else we can do */
    }
  }

  subscribe(handler: (message: SyncMessage) => void): void {
    this.listener = (event) => {
      if (event.key !== this.key || !event.newValue) return;
      try {
        const message = parseMessage(JSON.parse(event.newValue));
        if (message) handler(message);
      } catch {
        /* ignore malformed payloads */
      }
    };
    window.addEventListener('storage', this.listener);
  }

  close(): void {
    if (this.listener) window.removeEventListener('storage', this.listener);
  }
}

export function createTransport(): Transport {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannelTransport() : new StorageEventTransport();
}
