// Reel lifecycle helpers.

import { blobKey, db, deleteReelCompletely, getBlob, putBlob, trackUsage } from './db';
import { uid } from './ids';
import { defaultBrand, type BrandConfig, type ReelRecord, type ReelVersion, type TemplateId } from './types';
import type { Timeline } from './engine/types';
import { buildTimeline } from './engine/buildReel';
import { analyzeBeats, decodeAudio } from './audio/beats';

export async function getBrand(): Promise<BrandConfig> {
  return (await db.brand.get('brand')) ?? defaultBrand();
}

export async function saveBrand(brand: BrandConfig): Promise<void> {
  await db.brand.put({ ...brand, updatedAt: Date.now() });
}

export async function createReel(name?: string): Promise<ReelRecord> {
  const brand = await getBrand();
  const reel: ReelRecord = {
    id: uid(),
    name: name ?? `Reel — ${new Date().toLocaleDateString()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'draft',
    templateId: null,
    durationSec: 9,
    text: { title: '', caption: '', cta: brand.cta, showHandle: true },
    musicAssetKey: null,
    musicName: null,
    versions: [],
    activeVersionId: null,
    manualOrder: null,
  };
  await db.reels.add(reel);
  await trackUsage('reel-created');
  return reel;
}

export async function touchReel(reelId: string, patch: Partial<ReelRecord> = {}): Promise<void> {
  await db.reels.update(reelId, { ...patch, updatedAt: Date.now() });
}

export async function beatsForReel(reel: ReelRecord): Promise<number[]> {
  if (!reel.musicAssetKey) return [];
  try {
    const blob = await getBlob(reel.musicAssetKey);
    if (!blob) return [];
    const analysis = await analyzeBeats(reel.musicAssetKey, blob);
    return analysis.beats;
  } catch {
    return [];
  }
}

/**
 * Generate a new arrangement as a new version. Previous versions are never
 * destroyed — "Try Another Edit" simply appends with a fresh seed.
 */
export async function generateVersion(
  reelId: string,
  templateId: TemplateId,
  seed?: number,
): Promise<ReelVersion> {
  const reel = await db.reels.get(reelId);
  if (!reel) throw new Error('Reel not found');
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  const brand = await getBrand();
  const beats = await beatsForReel(reel);
  const usedSeed = seed ?? (reel.versions.length + 1) * 7919 + reelId.length;

  const timeline: Timeline = buildTimeline({
    reel,
    photos,
    brand,
    templateId,
    beats,
    seed: usedSeed,
  });

  const version: ReelVersion = {
    id: uid(),
    label: `Version ${reel.versions.length + 1}`,
    createdAt: Date.now(),
    timeline,
  };
  await db.reels.update(reelId, {
    versions: [...reel.versions, version],
    activeVersionId: version.id,
    templateId,
    status: 'ready',
    updatedAt: Date.now(),
  });
  return version;
}

/**
 * Rebuild the active version in place after edits (text, music, duration,
 * order, template) while keeping its identity. Other versions are untouched.
 */
export async function rebuildActiveVersion(reelId: string): Promise<void> {
  const reel = await db.reels.get(reelId);
  if (!reel || !reel.templateId) return;
  const active = reel.versions.find((v) => v.id === reel.activeVersionId);
  if (!active) return;
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  const brand = await getBrand();
  const beats = await beatsForReel(reel);
  const timeline = buildTimeline({
    reel,
    photos,
    brand,
    templateId: reel.templateId,
    beats,
    seed: active.timeline.seed,
  });
  const versions = reel.versions.map((v) =>
    v.id === active.id ? { ...v, timeline } : v,
  );
  await db.reels.update(reelId, { versions, updatedAt: Date.now() });
}

export async function duplicateReel(reelId: string): Promise<ReelRecord | null> {
  const reel = await db.reels.get(reelId);
  if (!reel) return null;
  const photos = await db.photos.where('reelId').equals(reelId).toArray();
  const copy: ReelRecord = {
    ...reel,
    id: uid(),
    name: `${reel.name} (copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    versions: [],
    activeVersionId: null,
    status: 'draft',
    exportedAt: undefined,
  };
  await db.reels.add(copy);
  const idMap = new Map<string, string>();
  for (const photo of photos) {
    const newId = uid();
    idMap.set(photo.id, newId);
    await db.photos.add({ ...photo, id: newId, reelId: copy.id });
    for (const variant of ['original', 'preview', 'thumb', 'corrected'] as const) {
      const blob = await getBlob(blobKey[variant](photo.id));
      if (blob) await putBlob(blobKey[variant](newId), blob);
    }
  }
  if (copy.manualOrder) {
    copy.manualOrder = copy.manualOrder
      .map((id) => idMap.get(id))
      .filter((id): id is string => Boolean(id));
    await db.reels.update(copy.id, { manualOrder: copy.manualOrder });
  }
  return copy;
}

export { deleteReelCompletely };

// ---------------------------------------------------------------------------
// Music library

export async function addMusicTrack(file: File): Promise<void> {
  const id = uid();
  const key = blobKey.music(id);
  await putBlob(key, file);
  let durationSec = 0;
  try {
    const buf = await decodeAudio(file);
    durationSec = buf.duration;
  } catch {
    // duration is cosmetic
  }
  await db.music.add({
    id,
    name: file.name.replace(/\.[a-z0-9]+$/i, ''),
    assetKey: key,
    durationSec,
    addedAt: Date.now(),
  });
}

export async function removeMusicTrack(id: string): Promise<void> {
  const track = await db.music.get(id);
  if (track) {
    await db.blobs.delete(track.assetKey);
    await db.music.delete(id);
  }
}
