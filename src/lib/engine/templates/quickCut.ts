// Template 3 — Quick Cut. Fastest option: rapid, beat-driven, occasional
// stacked compositions, minimal text, very strong first second.

import { uid } from '../../ids';
import { canStackPair, planTreatment, stackedLayers } from '../layout';
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

export function buildQuickCut(photos: SequencePhoto[], ctx: TemplateContext): Timeline {
  const rand = mulberry32(ctx.seed);
  const count = photoCountFor(ctx.durationMs, 1.05, photos.length, 4);
  const sequence = sequenceFor(photos, count, ctx, () => arrangePhotos(photos, count, ctx.seed), 450);

  // Group horizontal neighbours into stacked pairs occasionally.
  const slots: SequencePhoto[][] = [];
  for (let i = 0; i < sequence.length; i++) {
    const current = sequence[i];
    const next = sequence[i + 1];
    if (
      next &&
      slots.length % 3 === 1 && // roughly every third slot may stack
      canStackPair(current, next) &&
      rand() < 0.75
    ) {
      slots.push([current, next]);
      i++;
    } else {
      slots.push([current]);
    }
  }

  const weights = slots.map((s, i) => (i === 0 ? 1.15 : s.length === 2 ? 1.3 : 1));
  const cuts = planCuts(ctx.durationMs, slots.length, ctx.beats, {
    snapToleranceMs: 240, // ride the beat hard
    minClipMs: 450,
    weights,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);

  const clips: Clip[] = slots.map((slot, i) => {
    const isLast = i === slots.length - 1;
    if (slot.length === 2) {
      const layers = stackedLayers(slot[0], slot[1]).map(({ photo, dest, plan }) => ({
        photoId: photo.id,
        dest,
        crop: plan.crop,
        cropEnd: plan.cropEnd,
        easing: 'linear' as const,
        fill: plan.fill,
      }));
      return {
        id: uid(),
        startMs: windows[i].startMs,
        endMs: windows[i].endMs,
        layers,
        transitionIn: { kind: 'cut' as const, durationMs: 0 },
      };
    }
    const photo = slot[0];
    const plan = planTreatment(photo, TARGET_ASPECT, isLast ? 'cover-push' : 'auto');
    // Energetic finish: the closer pushes harder.
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
          easing: (isLast ? 'ease-out' : 'linear') as 'ease-out' | 'linear',
          fill: plan.fill,
        },
      ],
      transitionIn:
        i > 0 && rand() < 0.15
          ? { kind: 'push-up' as const, durationMs: 200 }
          : { kind: 'cut' as const, durationMs: 0 },
    };
  });

  // Minimal text: title only (short window), CTA at the end, no caption.
  const photosById = new Map(sequence.map((p) => [p.id, p]));
  const overlays = buildOverlays(
    { ...ctx, text: { ...ctx.text, caption: '' } },
    clips,
    photosById,
    {
      titleSize: 58,
      captionSize: 36,
      ctaSize: 46,
      animation: 'reveal',
      uppercaseTitle: true,
      letterSpacing: 0.08,
    },
  );

  return baseTimeline(ctx, 'quick-cut', clips, overlays);
}
