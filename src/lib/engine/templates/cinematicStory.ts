// Template 2 — Cinematic Story. Slower, emotional: long holds, subtle pans,
// soft transitions, room for a short sentence, gentle build to the final image.

import { uid } from '../../ids';
import { planTreatment } from '../layout';
import { arrangePhotos, type SequencePhoto } from '../sequence';
import type { Timeline } from '../types';
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

export function buildCinematicStory(
  photos: SequencePhoto[],
  ctx: TemplateContext,
): Timeline {
  const count = photoCountFor(ctx.durationMs, 2.6, photos.length, 3);
  const sequence = sequenceFor(photos, count, ctx, () => arrangePhotos(photos, count, ctx.seed), 1600);

  // Even, unhurried pacing with a longer final hold.
  const weights = sequence.map((_, i) => (i === sequence.length - 1 ? 1.35 : 1));
  const cuts = planCuts(ctx.durationMs, sequence.length, ctx.beats, {
    snapToleranceMs: 260, // soft musicality — cuts drift to beats when close
    minClipMs: 1600,
    weights,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);

  const clips = sequence.map((photo, i) => {
    const isLast = i === sequence.length - 1;
    // Pans carry the emotion; the final image settles outward.
    const plan = planTreatment(
      photo,
      TARGET_ASPECT,
      isLast ? 'cover-pull' : photo.width > photo.height ? 'pan' : 'auto',
    );
    return {
      id: uid(),
      startMs: windows[i].startMs,
      endMs: windows[i].endMs,
      layers: [
        {
          photoId: photo.id,
          dest: { x: 0, y: 0, w: 1, h: 1 },
          crop: plan.crop,
          cropEnd: plan.cropEnd,
          easing: 'ease-in-out' as const,
          fill: plan.fill,
        },
      ],
      transitionIn:
        i === 0
          ? { kind: 'cut' as const, durationMs: 0 }
          : { kind: 'fade' as const, durationMs: 600 },
    };
  });

  const photosById = new Map(sequence.map((p) => [p.id, p]));
  const overlays = buildOverlays(ctx, clips, photosById, {
    titleSize: 54,
    captionSize: 38,
    ctaSize: 44,
    animation: 'fade',
    uppercaseTitle: false,
    letterSpacing: 0.03,
  });

  return baseTimeline(ctx, 'cinematic-story', clips, overlays);
}
