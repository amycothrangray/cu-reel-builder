// Template 4 — Editorial Minimal. Clean, sophisticated: neutral treatment,
// generous negative space, elegant brand typography, deliberate pacing.

import { uid } from '../../ids';
import { avoidFaceSlice, coverCrop, planTreatment, subjectRect } from '../layout';
import { arrangePhotos, mulberry32, type SequencePhoto } from '../sequence';
import type { Clip, Timeline } from '../types';
import {
  baseTimeline,
  buildOverlays,
  cutsToWindows,
  photoCountFor,
  planCuts,
  sequenceFor,
  TARGET_ASPECT,
  type TemplateContext,
} from './shared';

export function buildEditorialMinimal(
  photos: SequencePhoto[],
  ctx: TemplateContext,
): Timeline {
  const rand = mulberry32(ctx.seed);
  const count = photoCountFor(ctx.durationMs, 2.2, photos.length, 3);
  const sequence = sequenceFor(photos, count, ctx, () => arrangePhotos(photos, count, ctx.seed));

  // Perfectly even pacing — the discipline is the style.
  const cuts = planCuts(ctx.durationMs, sequence.length, ctx.beats, {
    snapToleranceMs: 120, // only snap when a beat is essentially already there
    minClipMs: 1400,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);

  const clips: Clip[] = sequence.map((photo, i) => {
    // Alternate full-bleed stills with matted "gallery" frames on brand color.
    const matted = i % 2 === 1 && rand() < 0.85;
    if (matted) {
      const inset = 0.1;
      const destW = 1 - inset * 2;
      const dest = { x: inset, y: 0, w: destW, h: 1 };
      // Show the photo contained inside the matte area over brand color.
      return {
        id: uid(),
        startMs: windows[i].startMs,
        endMs: windows[i].endMs,
        layers: [
          {
            photoId: photo.id,
            dest,
            crop: { x: 0, y: 0, w: 1, h: 1 },
            cropEnd: { x: 0, y: 0, w: 1, h: 1 },
            easing: 'linear' as const,
            fill: 'contain-brand' as const,
          },
        ],
        transitionIn: { kind: 'fade' as const, durationMs: 350 },
      };
    }
    // Full-bleed: static or near-static crop. No gimmicks. A user-set crop
    // always wins over automatic framing.
    const focus = subjectRect(photo.faces, photo.aiSubject);
    const crop =
      photo.customCrop ??
      avoidFaceSlice(
        coverCrop(photo.width, photo.height, TARGET_ASPECT, focus),
        photo.faces,
      );
    const still = planTreatment(photo, TARGET_ASPECT, 'static');
    const useStill = photo.customCrop ? true : rand() < 0.5;
    return {
      id: uid(),
      startMs: windows[i].startMs,
      endMs: windows[i].endMs,
      layers: [
        {
          photoId: photo.id,
          dest: { x: 0, y: 0, w: 1, h: 1 },
          crop: useStill ? still.crop : crop,
          cropEnd: useStill
            ? still.cropEnd
            : coverCrop(photo.width, photo.height, TARGET_ASPECT, focus, 1.025),
          easing: 'linear' as const,
          fill: 'cover' as const,
        },
      ],
      transitionIn:
        i === 0
          ? { kind: 'cut' as const, durationMs: 0 }
          : { kind: 'fade' as const, durationMs: 350 },
    };
  });

  const photosById = new Map(sequence.map((p) => [p.id, p]));
  const overlays = buildOverlays(ctx, clips, photosById, {
    titleSize: 50,
    captionSize: 34,
    ctaSize: 40,
    animation: 'fade',
    uppercaseTitle: true,
    letterSpacing: 0.14,
  });

  const timeline = baseTimeline(ctx, 'editorial-minimal', clips, overlays);
  // Editorial background uses the brand's light color rather than black.
  timeline.background = ctx.brand.secondaryColor || '#faf8f5';
  return timeline;
}
