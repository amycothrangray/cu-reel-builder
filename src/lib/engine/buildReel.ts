// Bridges stored records to the template engine: converts PhotoRecords to
// SequencePhotos, applies inclusion/blocking rules, resolves the template,
// and produces a Timeline.

import type { BrandConfig, PhotoRecord, ReelRecord, TemplateId } from '../types';
import type { Timeline, TimelineAudio } from './types';
import type { SequencePhoto } from './sequence';
import { getTemplate } from './templates';
import type { TemplateContext } from './templates/shared';

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

export function toSequencePhoto(p: PhotoRecord): SequencePhoto {
  return {
    id: p.id,
    width: p.width,
    height: p.height,
    score: p.analysis?.score ?? 0.5,
    phash: p.analysis?.phash ?? '0000000000000000',
    faces: p.analysis?.faces ?? [],
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
  };
}

export interface BuildOptions {
  reel: ReelRecord;
  photos: PhotoRecord[];
  brand: BrandConfig;
  templateId: TemplateId;
  beats: number[];
  seed: number;
}

export function buildTimeline(opts: BuildOptions): Timeline {
  const { reel, brand, templateId, beats, seed } = opts;
  const eligible = eligiblePhotos(opts.photos);

  let sequencePhotos = eligible.map(toSequencePhoto);
  let fixedOrder = false;
  if (reel.manualOrder && reel.manualOrder.length > 0) {
    const orderIndex = new Map(reel.manualOrder.map((id, i) => [id, i]));
    sequencePhotos = [...sequencePhotos].sort(
      (a, b) => (orderIndex.get(a.id) ?? 999) - (orderIndex.get(b.id) ?? 999),
    );
    fixedOrder = true;
  }

  const audio: TimelineAudio | null = reel.musicAssetKey
    ? {
        assetKey: reel.musicAssetKey,
        name: reel.musicName ?? 'Track',
        gain: 1,
        fadeOutMs: 900,
      }
    : null;

  const ctx: TemplateContext = {
    durationMs: reel.durationSec * 1000,
    text: reel.text,
    brand,
    beats,
    audio,
    seed,
    fixedOrder,
  };

  const template = getTemplate(templateId);
  return template.build(sequencePhotos, ctx);
}
