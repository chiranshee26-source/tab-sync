/**
 * Durable storage of the synced document in localStorage.
 *
 * Writes are read-merge-write: the stored document is merged with the
 * in-memory one before saving, so a tab can never overwrite a newer value
 * written by another tab. Where the Web Locks API exists, the cycle runs
 * under a cross-tab lock so two tabs cannot interleave their read and write.
 */

import { deserializeDoc, serializeDoc, type Doc } from './lww';
import { LEGACY_STORAGE_KEY, STORAGE_KEY } from './preferences';

export interface Persistence {
  load(): Doc;
  /**
   * Runs `merge` against the stored document under a lock (if available)
   * and saves the result when it differs from what is stored.
   */
  update(merge: (stored: Doc) => Doc): Promise<void>;
  /** Calls `handler` when another tab writes the stored document. */
  onExternalChange(handler: (stored: Doc) => void): void;
}

/** Reads the stored document, falling back to (and migrating) the v1 preferences key. */
export function readStoredDoc(storage: Storage): Doc {
  try {
    return deserializeDoc(storage.getItem(STORAGE_KEY) ?? storage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    return {};
  }
}

const LOCK_NAME = `${STORAGE_KEY}:lock`;

export class LocalStoragePersistence implements Persistence {
  constructor(private readonly storage: Storage = window.localStorage) {}

  load(): Doc {
    return readStoredDoc(this.storage);
  }

  async update(merge: (stored: Doc) => Doc): Promise<void> {
    const cycle = () => {
      const raw = this.read();
      const next = serializeDoc(merge(deserializeDoc(raw)));
      if (next !== raw) this.write(next);
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks) await locks.request(LOCK_NAME, cycle);
    else cycle();
  }

  onExternalChange(handler: (stored: Doc) => void): void {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY && event.newValue) handler(deserializeDoc(event.newValue));
    });
  }

  private read(): string | null {
    try {
      return this.storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private write(value: string): void {
    try {
      this.storage.setItem(STORAGE_KEY, value);
    } catch {
      /* quota exceeded or storage disabled: sync still works in memory */
    }
  }
}
