// Template — Rapid Fire. Blink-and-you-miss-it: every included photo in very
// quick succession (~0.15–0.5s per slide), built for big sets of 50–100
// images. Static subject-centered crops (motion would blur at this pace),
// hard cuts, a held opener to hook and a held closer to land.

import { uid } from '../../ids';
import { planTreatment } from '../layout';
import { arrangePhotos, type SequencePhoto } from '../sequence';
import type { Timeline } from '../types';
import {
  baseTimeline,
  buildOverlays,
  cutsToWindows,
  planCuts,
  sequenceFor,
  TARGET_ASPECT,
  type TemplateContext,
} from './shared';

/** Hard floor per slide — below this the eye registers nothing at all. */
export const RAPID_MIN_SLIDE_MS = 120;

/** How many photos a Rapid Fire reel of this duration can physically hold. */
export function rapidFireCapacity(durationMs: number): number {
  // Opener ~0.7s and closer ~0.6s hold longer; the rest ride the floor.
  return Math.floor((durationMs - 1300) / RAPID_MIN_SLIDE_MS) + 2;
}

export function buildRapidFire(photos: SequencePhoto[], ctx: TemplateContext): Timeline {
  const capacity = rapidFireCapacity(ctx.durationMs);
  const count = Math.max(3, Math.min(photos.length, capacity));
  const sequence = sequenceFor(
    photos,
    count,
    ctx,
    () => arrangePhotos(photos, count, ctx.seed),
    RAPID_MIN_SLIDE_MS,
  );

  // Opener and closer hold long enough to read; everything else is a flash.
  const weights = sequence.map((_, i) =>
    i === 0 ? 4 : i === sequence.length - 1 ? 3.5 : 1,
  );
  const avgSlideMs = ctx.durationMs / sequence.length;
  // Beat snapping only makes sense when slides are long enough to drift;
  // at flash pace the even rhythm IS the musicality.
  const beats = avgSlideMs >= 350 ? ctx.beats : [];
  const cuts = planCuts(ctx.durationMs, sequence.length, beats, {
    snapToleranceMs: 120,
    minClipMs: RAPID_MIN_SLIDE_MS,
    weights,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);

  const clips = sequence.map((photo, i) => {
    const isEdge = i === 0 || i === sequence.length - 1;
    // Edges get a hint of motion; the flashes stay static.
    const plan = planTreatment(photo, TARGET_ASPECT, isEdge ? 'cover-push' : 'static');
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
          easing: 'linear' as const,
          fill: plan.fill,
        },
      ],
      transitionIn: { kind: 'cut' as const, durationMs: 0 },
    };
  });

  // Minimal text — a caption would be unreadable at this pace.
  const photosById = new Map(sequence.map((p) => [p.id, p]));
  const overlays = buildOverlays(
    { ...ctx, text: { ...ctx.text, caption: '' } },
    clips,
    photosById,
    {
      titleSize: 60,
      captionSize: 36,
      ctaSize: 46,
      animation: 'reveal',
      uppercaseTitle: true,
      letterSpacing: 0.08,
    },
  );

  return baseTimeline(ctx, 'rapid-fire', clips, overlays);
}
