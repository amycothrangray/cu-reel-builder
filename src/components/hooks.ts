import { useEffect, useState } from 'react';
import { getBlob } from '../lib/db';

const urlCache = new Map<string, string>();

/** Object URL for a stored blob, cached for the session. */
export function useBlobUrl(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(key ? (urlCache.get(key) ?? null) : null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    const cached = urlCache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    void getBlob(key).then((blob) => {
      if (!alive || !blob) return;
      const u = URL.createObjectURL(blob);
      urlCache.set(key, u);
      setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return url;
}

/** Drop a cached object URL (call after replacing a stored blob). */
export function invalidateBlobUrl(key: string): void {
  const u = urlCache.get(key);
  if (u) {
    URL.revokeObjectURL(u);
    urlCache.delete(key);
  }
}
