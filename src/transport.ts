/**
 * Tab-to-tab messaging. BroadcastChannel is the primary transport (same-origin,
 * in-memory, typically < 1 ms). Browsers without it fall back to the `storage`
 * event, which every engine supports.
 */

import { parseDoc, type Doc } from './lww';
import { CHANNEL_NAME } from './preferences';

interface Envelope {
  /** Sender's tab id. */
  from: string;
  /** Sender's high-resolution epoch time in ms, used to measure latency. */
  sentAt: number;
  /** Fingerprint of the sender's state after this message, for convergence checks. */
  fp?: string;
  /** Whether the sender is a background tab (its timers may be heavily throttled). */
  hidden?: boolean;
  /** Build time of the sender's code, to spot tabs still running an older deploy. */
  build?: number;
  /** Route the sender is showing (e.g. `notes/abc`), so tabs can see what others have open. */
  view?: string;
}

export type SyncMessage = Envelope &
  (
    | { type: 'hello' }
    | { type: 'heartbeat' }
    | { type: 'bye' }
    | { type: 'update'; entries: Doc }
    | { type: 'state'; entries: Doc }
    | { type: 'race'; at: number }
    /** Reply to an `update`, echoing its `sentAt` so the sender can measure the round trip. */
    | { type: 'ack'; to: string; ackOf: number }
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
  const envelope = {
    from: m.from,
    sentAt: m.sentAt,
    fp: typeof m.fp === 'string' && m.fp.length <= 16 ? m.fp : undefined,
    hidden: m.hidden === true,
    build: typeof m.build === 'number' && Number.isFinite(m.build) ? m.build : undefined,
    view: typeof m.view === 'string' && m.view.length <= 100 ? m.view : undefined,
  };
  if (typeof m.type !== 'string') return null;
  if (SIMPLE_TYPES.has(m.type)) return { ...envelope, type: m.type as 'hello' | 'heartbeat' | 'bye' };
  if (m.type === 'update' || m.type === 'state') {
    // Entries (values and timestamps) are validated field by field.
    return { ...envelope, type: m.type, entries: parseDoc(m.entries) };
  }
  if (m.type === 'race' && typeof m.at === 'number' && Number.isFinite(m.at)) {
    return { ...envelope, type: 'race', at: m.at };
  }
  if (m.type === 'ack' && typeof m.to === 'string' && typeof m.ackOf === 'number' && Number.isFinite(m.ackOf)) {
    return { ...envelope, type: 'ack', to: m.to, ackOf: m.ackOf };
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
