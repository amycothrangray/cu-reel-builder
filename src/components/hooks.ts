import { useEffect, useState } from 'react';
import { cachedBlobUrl, loadBlobUrl, type CachedBlobUrl } from '../lib/db';

// The cache itself lives with the blobs in lib/db, so deleting or replacing a
// stored blob can drop the URL that points at it.
export { invalidateBlobUrl } from '../lib/db';

function useCachedBlob(key: string | null | undefined): CachedBlobUrl | null {
  const [entry, setEntry] = useState<CachedBlobUrl | null>(key ? (cachedBlobUrl(key) ?? null) : null);
  useEffect(() => {
    if (!key) {
      setEntry(null);
      return;
    }
    const cached = cachedBlobUrl(key);
    if (cached) {
      setEntry(cached);
      return;
    }
    let alive = true;
    void loadBlobUrl(key).then((loaded) => {
      if (alive && loaded) setEntry(loaded);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return entry;
}

/** Object URL for a stored blob, cached for the session. */
export function useBlobUrl(key: string | null | undefined): string | null {
  return useCachedBlob(key)?.url ?? null;
}

/** Mime type of a stored blob — shares the read with useBlobUrl. */
export function useBlobMimeType(key: string | null | undefined): string | null {
  return useCachedBlob(key)?.type ?? null;
}
