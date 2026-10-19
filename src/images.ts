/**
 * Background pictures: resized in the browser, stored in IndexedDB (shared by
 * every tab of the origin, persistent, no 5 MB localStorage limit) and named
 * by a hash of their contents, so the synced document only carries a short id.
 */

import { chooseSeeds, clusterPixels } from './color';

const DB_NAME = 'daybook-images';
const STORE = 'images';
/** Longest edge of the stored picture; plenty for a full-screen background. */
const MAX_EDGE = 2200;
/** Longest edge of the copy used for colour extraction. */
const SAMPLE_EDGE = 96;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const loadImage = (id: string) => withStore<Blob | undefined>('readonly', (store) => store.get(id));
const saveImage = (id: string, blob: Blob) => withStore('readwrite', (store) => store.put(blob, id));
export const deleteImage = (id: string) => withStore('readwrite', (store) => store.delete(id));

async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest.slice(0, 8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function drawScaled(bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export interface ProcessedImage {
  id: string;
  /** Comma-separated theme seeds for the appearance record. */
  palette: string;
}

/**
 * Resizes and stores a user's picture, and extracts its colours. Throws when
 * the file is not an image the browser can decode.
 */
export async function importImage(file: Blob): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const sample = drawScaled(bitmap, SAMPLE_EDGE);
    const pixels = sample.getContext('2d')!.getImageData(0, 0, sample.width, sample.height).data;
    const palette = chooseSeeds(clusterPixels(pixels)).join(',');

    const full = drawScaled(bitmap, MAX_EDGE);
    const blob = await new Promise<Blob>((resolve, reject) =>
      full.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.86),
    );
    const id = await hashBlob(blob);
    await saveImage(id, blob);
    return { id, palette };
  } finally {
    bitmap.close();
  }
}
