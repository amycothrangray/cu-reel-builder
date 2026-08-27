// Template 1 — Signature Energy. The strong default: fast, upbeat, polished.
// ~1.5–2s per photo, gentle motion, music-aware cuts, photography as hero.

import { uid } from '../../ids';
import { planTreatment } from '../layout';
import { arrangePhotos, mulberry32, type SequencePhoto } from '../sequence';
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

export function buildSignatureEnergy(
  photos: SequencePhoto[],
  ctx: TemplateContext,
): Timeline {
  const rand = mulberry32(ctx.seed);
  const count = photoCountFor(ctx.durationMs, 1.7, photos.length);
  const sequence = sequenceFor(photos, count, ctx, () => arrangePhotos(photos, count, ctx.seed));

  // The opener holds a touch longer to land the hook; the closer breathes.
  const weights = sequence.map((_, i) =>
    i === 0 ? 1.25 : i === sequence.length - 1 ? 1.2 : 1,
  );
  const cuts = planCuts(ctx.durationMs, sequence.length, ctx.beats, {
    snapToleranceMs: 180,
    minClipMs: 900,
    weights,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);

  const clips = sequence.map((photo, i) => {
    const isLast = i === sequence.length - 1;
    const plan = planTreatment(
      { ...photo, aiSubject: photo.aiSubject },
      TARGET_ASPECT,
      isLast ? 'cover-pull' : 'auto',
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
      // Mostly clean cuts with the occasional short fade for texture.
      transitionIn:
        i === 0
          ? { kind: 'cut' as const, durationMs: 0 }
          : rand() < 0.25
            ? { kind: 'fade' as const, durationMs: 240 }
            : { kind: 'cut' as const, durationMs: 0 },
    };
  });

  const photosById = new Map(sequence.map((p) => [p.id, p]));
  const overlays = buildOverlays(ctx, clips, photosById, {
    titleSize: 64,
    captionSize: 40,
    ctaSize: 48,
    animation: 'slide-up',
    uppercaseTitle: false,
    letterSpacing: 0.02,
  });

  return baseTimeline(ctx, 'signature-energy', clips, overlays);
}
