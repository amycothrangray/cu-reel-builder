// Reel lifecycle helpers.

import { blobKey, db, deleteReelCompletely, getBlob, putBlob, trackUsage } from './db';
import { uid } from './ids';
import { defaultBrand, type BrandConfig, type ReelRecord, type ReelVersion, type TemplateId } from './types';
import type { Timeline } from './engine/types';
import { buildTimeline } from './engine/buildReel';
import { analyzeBeats, decodeAudio } from './audio/beats';
import { sliceMusicAnalysis } from './audio/segments';

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
    requiredIds: [],
    manualOrder: null,
    purpose: 'auto',
  };
  await db.reels.add(reel);
  await trackUsage('reel-created');
  return reel;
}

export async function touchReel(reelId: string, patch: Partial<ReelRecord> = {}): Promise<void> {
  await db.reels.update(reelId, { ...patch, updatedAt: Date.now() });
}

export interface ReelMusic {
  beats: number[];
  strongBeats: number[];
  intensity: number[];
}

const NO_MUSIC: ReelMusic = { beats: [], strongBeats: [], intensity: [] };

/**
 * Music timing for the reel. For Instagram Audio, the reference track's
 * analysis is sliced to the chosen section and re-based to 0 — the edit is
 * built against exactly the section the user will select inside Instagram.
 */
export async function musicAnalysisForReel(reel: ReelRecord): Promise<ReelMusic> {
  const instagram = reel.instagramAudio;
  const key = instagram?.referenceAssetKey ?? reel.musicAssetKey;
  if (!key) return NO_MUSIC;
  try {
    const blob = await getBlob(key);
    if (!blob) return NO_MUSIC;
    const analysis = await analyzeBeats(key, blob);
    if (instagram?.referenceAssetKey) {
      return sliceMusicAnalysis(analysis, instagram.startSec * 1000, reel.durationSec * 1000);
    }
    return {
      beats: analysis.beats,
      strongBeats: analysis.strongBeats,
      intensity: analysis.intensity,
    };
  } catch {
    return NO_MUSIC;
  }
}

/** Set the Instagram Audio plan (clears embedded studio music — one source). */
export async function setInstagramAudio(
  reelId: string,
  plan: import('./types').InstagramAudioPlan,
): Promise<void> {
  await db.reels.update(reelId, {
    instagramAudio: plan,
    musicAssetKey: null,
    musicName: null,
    updatedAt: Date.now(),
  });
  await rebuildActiveVersion(reelId);
}

export async function clearInstagramAudio(reelId: string): Promise<void> {
  await db.reels.update(reelId, { instagramAudio: null, updatedAt: Date.now() });
  await rebuildActiveVersion(reelId);
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
  const music = await musicAnalysisForReel(reel);
  const usedSeed = seed ?? (reel.versions.length + 1) * 7919 + reelId.length;

  const timeline: Timeline = buildTimeline({
    reel,
    photos,
    brand,
    templateId,
    beats: music.beats,
    intensity: music.intensity,
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
  const music = await musicAnalysisForReel(reel);
  const timeline = buildTimeline({
    reel,
    photos,
    brand,
    templateId: reel.templateId,
    beats: music.beats,
    intensity: music.intensity,
    seed: active.timeline.seed,
  });
  const versions = reel.versions.map((v) =>
    v.id === active.id ? { ...v, timeline } : v,
  );
  await db.reels.update(reelId, { versions, updatedAt: Date.now() });
}

/** Photo order as the given timeline plays it (stacked layers flattened). */
export function stripOrder(timeline: Timeline): string[] {
  const ids: string[] = [];
  for (const clip of timeline.clips) {
    for (const layer of clip.layers) {
      if (!ids.includes(layer.photoId)) ids.push(layer.photoId);
    }
  }
  return ids;
}

/**
 * CONTENT lock: guarantee photos a place in the reel. Choosing content is
 * not volunteering to be the video editor — the engine still finds the
 * strongest sequence unless the user has also manually ordered (in which
 * case the new photos join the end of their list).
 */
export async function addPhotosToArrangement(reelId: string, photoIds: string[]): Promise<void> {
  await db.photos.where('id').anyOf(photoIds).modify({ included: true });
  const reel = await db.reels.get(reelId);
  if (!reel) return;
  const requiredIds = [...(reel.requiredIds ?? [])];
  for (const id of photoIds) {
    if (!requiredIds.includes(id)) requiredIds.push(id);
  }
  const patch: Partial<ReelRecord> = { requiredIds, updatedAt: Date.now() };
  if (reel.manualOrder) {
    const order = [...reel.manualOrder];
    for (const id of photoIds) {
      if (!order.includes(id)) order.push(id);
    }
    patch.manualOrder = order;
  }
  await db.reels.update(reelId, patch);
  await rebuildActiveVersion(reelId);
}

/** Take photos out of the reel (clears both locks for them). */
export async function removePhotosFromArrangement(reelId: string, photoIds: string[]): Promise<void> {
  await db.photos.where('id').anyOf(photoIds).modify({ included: false });
  const reel = await db.reels.get(reelId);
  if (!reel) return;
  const remove = new Set(photoIds);
  await db.reels.update(reelId, {
    requiredIds: (reel.requiredIds ?? []).filter((id) => !remove.has(id)),
    manualOrder: reel.manualOrder
      ? reel.manualOrder.filter((id) => !remove.has(id))
      : null,
    updatedAt: Date.now(),
  });
  await rebuildActiveVersion(reelId);
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
  const remap = (ids: string[] | null | undefined) =>
    ids?.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)) ?? null;
  await db.reels.update(copy.id, {
    manualOrder: remap(copy.manualOrder),
    requiredIds: remap(copy.requiredIds) ?? [],
  });
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
