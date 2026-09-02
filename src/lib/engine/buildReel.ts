// Bridges stored records to the template engine: converts PhotoRecords to
// SequencePhotos, applies the three-state photo model (required / eligible /
// excluded), resolves the reel's purpose, and produces a Timeline.

import { effectiveClassification, type BrandConfig, type PhotoRecord, type ReelRecord, type TemplateId } from '../types';
import type { Timeline, TimelineAudio } from './types';
import type { SequencePhoto } from './sequence';
import { getTemplate } from './templates';
import type { TemplateContext } from './templates/shared';
import { clusterIdentities } from '../editorial/identity';
import { inferPurpose } from '../editorial/profile';

/** Photos eligible to appear in the rendered reel. */
export function eligiblePhotos(photos: PhotoRecord[]): PhotoRecord[] {
  return photos.filter(
    (p) =>
      p.status === 'ready' &&
      p.included &&
      // Blocked restricted flags exclude the photo from rendering entirely.
      !p.restrictedFlags.some((f) => f.status === 'blocked'),
  );
}

/** Parse EXIF "YYYY:MM:DD HH:MM:SS" (or anything Date can read) to epoch ms. */
export function parseExifDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? undefined : t;
}

export function toSequencePhoto(p: PhotoRecord, required = false): SequencePhoto {
  return {
    id: p.id,
    width: p.width,
    height: p.height,
    score: p.analysis?.score ?? 0.5,
    phash: p.analysis?.phash ?? '0000000000000000',
    faces: p.analysis?.faces ?? [],
    descriptors: p.analysis?.descriptors,
    stats: p.analysis?.stats ?? {
      sharpness: 0.5,
      contrast: 0.2,
      saturation: 0.3,
      warmth: 0,
      highlightClip: 0,
      shadowCrush: 0,
      meanLuma: 0.5,
      skinWarmthExcess: 0,
      skinFraction: 0,
    },
    ai: p.analysis?.ai,
    aiSubject: p.analysis?.ai?.subjectRect,
    customCrop: p.customCrop,
    takenAt: parseExifDate(p.exif.dateTaken),
    uploadOrder: p.order,
    required,
  };
}

/** Resolve 'auto' purpose from the character of the set. */
export function resolvePurpose(
  reel: ReelRecord,
  photoRecords: PhotoRecord[],
  sequencePhotos: SequencePhoto[],
): 'photography' | 'school' {
  const purpose = reel.purpose ?? 'auto';
  if (purpose !== 'auto') return purpose;
  const ready = photoRecords.filter((p) => p.status === 'ready');
  const proFraction =
    ready.length > 0
      ? ready.filter((p) => effectiveClassification(p) === 'pro').length / ready.length
      : 1;
  return inferPurpose(sequencePhotos, clusterIdentities(sequencePhotos), proFraction);
}

export interface BuildOptions {
  reel: ReelRecord;
  photos: PhotoRecord[];
  brand: BrandConfig;
  templateId: TemplateId;
  beats: number[];
  intensity?: number[];
  seed: number;
}

export function buildTimeline(opts: BuildOptions): Timeline {
  const { reel, brand, templateId, beats, seed } = opts;
  const eligible = eligiblePhotos(opts.photos);
  const requiredIds = new Set(reel.requiredIds ?? []);

  let sequencePhotos = eligible.map((p) => toSequencePhoto(p, requiredIds.has(p.id)));
  let fixedOrder = false;
  if (reel.manualOrder && reel.manualOrder.length > 0) {
    // ORDER lock: a manual order is an exact request — THESE photos, in THIS
    // order. Photos she never put in the reel stay eligible for a future
    // rethink, but are not pulled in behind her back just because she nudged
    // one thumbnail. (Adding photos from the review screen appends them to
    // this list, so newly added work still appears.)
    const orderIndex = new Map(reel.manualOrder.map((id, i) => [id, i]));
    const fallback = orderIndex.size;
    const listed = sequencePhotos.filter(
      (p) => orderIndex.has(p.id) || requiredIds.has(p.id),
    );
    // If every photo in the list is gone (deleted or excluded), the order no
    // longer refers to anything — fall back to letting the engine choose.
    if (listed.length > 0) {
      sequencePhotos = listed.sort(
        (a, b) => (orderIndex.get(a.id) ?? fallback) - (orderIndex.get(b.id) ?? fallback),
      );
      fixedOrder = true;
    }
  }

  // Instagram Audio: the reference drives preview and timing but is never
  // embedded in the export — the official song is added inside Instagram.
  const instagram = reel.instagramAudio;
  const audio: TimelineAudio | null = instagram?.referenceAssetKey
    ? {
        assetKey: instagram.referenceAssetKey,
        name: `${instagram.songTitle} — ${instagram.artist} (reference)`,
        gain: 1,
        fadeOutMs: 0,
        offsetSec: instagram.startSec,
        embedInExport: false,
      }
    : reel.musicAssetKey
      ? {
          assetKey: reel.musicAssetKey,
          name: reel.musicName ?? 'Track',
          gain: 1,
          fadeOutMs: 900,
          offsetSec: 0,
          embedInExport: true,
        }
      : null;

  const ctx: TemplateContext = {
    durationMs: reel.durationSec * 1000,
    text: reel.text,
    brand,
    beats,
    intensity: opts.intensity ?? [],
    purpose: resolvePurpose(reel, opts.photos, sequencePhotos),
    audio,
    seed,
    fixedOrder,
  };

  const template = getTemplate(templateId);
  const timeline = template.build(sequencePhotos, ctx);

  // What actually made it to the screen? Compared against what the user was
  // promised, this is the only honest source for "these three didn't fit".
  // Checking the finished timeline (rather than the planner's intent) also
  // catches photos lost later, e.g. burst frames trimmed by the realizer.
  const rendered = new Set<string>();
  for (const clip of timeline.clips) {
    for (const layer of clip.layers) rendered.add(layer.photoId);
  }
  const guaranteed = fixedOrder
    ? sequencePhotos.map((p) => p.id)
    : sequencePhotos.filter((p) => p.required).map((p) => p.id);
  const omittedPhotoIds = guaranteed.filter((id) => !rendered.has(id));

  return omittedPhotoIds.length > 0 ? { ...timeline, omittedPhotoIds } : timeline;
}
