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

/** Remove a photo and every stored derivative. */
export async function deletePhotoCompletely(photoId: string): Promise<void> {
  await db.transaction('rw', db.photos, db.blobs, async () => {
    await db.photos.delete(photoId);
    await db.blobs.bulkDelete([
      blobKey.original(photoId),
      blobKey.preview(photoId),
      blobKey.thumb(photoId),
      blobKey.corrected(photoId),
    ]);
  });
}

/** Delete a reel, its photos, derivatives and cached exports. */
export async function deleteReelCompletely(reelId: string): Promise<void> {
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  const reel = await db.reels.get(reelId);
  await db.transaction('rw', db.photos, db.blobs, db.reels, async () => {
    for (const p of photos) {
      await deletePhotoCompletely(p.id);
    }
    if (reel) {
      const exportKeys = reel.versions.map((v) => blobKey.export(reelId, v.id));
      await db.blobs.bulkDelete(exportKeys);
    }
    await db.reels.delete(reelId);
  });
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
