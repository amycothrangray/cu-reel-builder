import Dexie, { type Table } from 'dexie';
import type {
  AuditEntry,
  BrandConfig,
  MusicTrack,
  PhotoAnalysis,
  PhotoRecord,
  ReelRecord,
  RestrictedProfile,
  RestrictedProfileData,
  SettingRow,
  UsageEvent,
} from './types';

export interface BlobRow {
  /** e.g. `${photoId}:original` | `:preview` | `:thumb` | `:corrected`,
   *  `font:${id}`, `logo:${id}`, `music:${id}`, `export:${reelId}:${versionId}` */
  key: string;
  blob: Blob;
}

export interface AnalysisCacheRow {
  hash: string;
  analysis: PhotoAnalysis;
}

class ReelStudioDB extends Dexie {
  photos!: Table<PhotoRecord, string>;
  blobs!: Table<BlobRow, string>;
  reels!: Table<ReelRecord, string>;
  brand!: Table<BrandConfig, string>;
  music!: Table<MusicTrack, string>;
  restrictedProfiles!: Table<RestrictedProfile, string>;
  restrictedData!: Table<RestrictedProfileData, string>;
  audit!: Table<AuditEntry, number>;
  usage!: Table<UsageEvent, number>;
  analysisCache!: Table<AnalysisCacheRow, string>;
  settings!: Table<SettingRow, string>;

  constructor() {
    super('reel-studio');
    this.version(1).stores({
      photos: 'id, reelId, hash, [reelId+order]',
      blobs: 'key',
      reels: 'id, updatedAt, status',
      brand: 'id',
      music: 'id, addedAt',
      restrictedProfiles: 'id, disabled',
      restrictedData: 'profileId',
      audit: '++id, at',
      usage: '++id, at, kind',
      analysisCache: 'hash',
      settings: 'key',
    });
  }
}

export const db = new ReelStudioDB();

// ---------------------------------------------------------------------------
// Blob helpers

export const blobKey = {
  original: (photoId: string) => `${photoId}:original`,
  preview: (photoId: string) => `${photoId}:preview`,
  thumb: (photoId: string) => `${photoId}:thumb`,
  corrected: (photoId: string) => `${photoId}:corrected`,
  font: (id: string) => `font:${id}`,
  logo: (id: string) => `logo:${id}`,
  music: (id: string) => `music:${id}`,
  export: (reelId: string, versionId: string) => `export:${reelId}:${versionId}`,
};

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await db.blobs.put({ key, blob });
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const row = await db.blobs.get(key);
  return row?.blob;
}

export async function deleteBlobs(keys: string[]): Promise<void> {
  await db.blobs.bulkDelete(keys);
}

// ---------------------------------------------------------------------------
// Object URL cache
//
// Object URLs are made once per blob key and shared for the session (a photo
// shown in three places is decoded once). They live here, next to the blobs
// they point at, so every path that deletes or replaces a blob can drop the
// URL that would otherwise keep serving the old bytes.

export interface CachedBlobUrl {
  url: string;
  /** The blob's own mime type — an export is MP4 or WebM depending on the
   *  renderer that produced it. */
  type: string;
}

const urlCache = new Map<string, CachedBlobUrl>();
/** Loads in flight, so two callers on the same key don't each make a URL. */
const urlLoading = new Map<string, Promise<CachedBlobUrl | null>>();

/** The cached entry for a key, if one has already been made. */
export function cachedBlobUrl(key: string): CachedBlobUrl | undefined {
  return urlCache.get(key);
}

/** Object URL + mime type for a stored blob, cached for the session. */
export function loadBlobUrl(key: string): Promise<CachedBlobUrl | null> {
  let pending = urlLoading.get(key);
  if (!pending) {
    pending = getBlob(key)
      .then((blob) => {
        if (!blob) return null;
        const cached = urlCache.get(key);
        if (cached) return cached;
        const entry: CachedBlobUrl = { url: URL.createObjectURL(blob), type: blob.type };
        urlCache.set(key, entry);
        return entry;
      })
      .finally(() => urlLoading.delete(key));
    urlLoading.set(key, pending);
  }
  return pending;
}

/** Drop a cached object URL (call after replacing or deleting a stored blob). */
export function invalidateBlobUrl(key: string): void {
  const entry = urlCache.get(key);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    urlCache.delete(key);
  }
}

/** File extension for a stored export — the compatibility renderer makes WebM. */
export function exportExtension(mimeType: string | null | undefined): string {
  const subtype = (mimeType ?? '').split(';')[0].split('/')[1]?.toLowerCase();
  return subtype === 'webm' ? 'webm' : 'mp4';
}

const photoBlobKeys = (photoId: string) => [
  blobKey.original(photoId),
  blobKey.preview(photoId),
  blobKey.thumb(photoId),
  blobKey.corrected(photoId),
];

/** Remove a photo and every stored derivative. */
export async function deletePhotoCompletely(photoId: string): Promise<void> {
  const keys = photoBlobKeys(photoId);
  await db.transaction('rw', db.photos, db.blobs, async () => {
    await db.photos.delete(photoId);
    await db.blobs.bulkDelete(keys);
  });
  // Without this the session URL cache keeps handing out — and holding on to
  // — pictures the user just deleted.
  for (const key of keys) invalidateBlobUrl(key);
}

/** Delete a reel, its photos, derivatives and cached exports. */
export async function deleteReelCompletely(reelId: string): Promise<void> {
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  const reel = await db.reels.get(reelId);
  const exportKeys = reel?.versions.map((v) => blobKey.export(reelId, v.id)) ?? [];
  await db.transaction('rw', db.photos, db.blobs, db.reels, async () => {
    for (const p of photos) {
      await deletePhotoCompletely(p.id);
    }
    await db.blobs.bulkDelete(exportKeys);
    await db.reels.delete(reelId);
  });
  for (const key of exportKeys) invalidateBlobUrl(key);
}

// ---------------------------------------------------------------------------
// Usage + audit

export async function trackUsage(kind: UsageEvent['kind'], meta?: string): Promise<void> {
  try {
    await db.usage.add({ at: Date.now(), kind, meta });
  } catch {
    // usage tracking must never break the workflow
  }
}

export async function auditLog(actor: string, action: string, details: string): Promise<void> {
  await db.audit.add({ at: Date.now(), actor, action, details });
}
