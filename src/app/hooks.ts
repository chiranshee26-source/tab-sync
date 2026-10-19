import { useEffect, useState } from 'react';
import { loadImage } from '../images';

/** Current time, refreshed every `intervalMs` (the hero's sun moves with it). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// One object URL per picture for the whole tab, shared by every component.
const urls = new Map<string, Promise<string | undefined>>();

function imageUrl(id: string): Promise<string | undefined> {
  let url = urls.get(id);
  if (!url) {
    url = loadImage(id)
      .then((blob) => (blob ? URL.createObjectURL(blob) : undefined))
      .catch(() => undefined)
      .then((value) => {
        if (!value) urls.delete(id); // not stored (yet): retry next time
        return value;
      });
    urls.set(id, url);
  }
  return url;
}

/** Object URL of a stored background picture ('' → none). */
export function useImageUrl(id: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setUrl(undefined);
    if (id) void imageUrl(id).then((value) => !cancelled && setUrl(value));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return url;
}
