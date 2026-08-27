// Template 5 — Photo Story. Builds a micro-narrative: establishing shot →
// people interacting → closeups and details → emotional close.

import { uid } from '../../ids';
import { planTreatment } from '../layout';
import { arrangeStory, inferStoryRole, type SequencePhoto } from '../sequence';
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

export function buildPhotoStory(photos: SequencePhoto[], ctx: TemplateContext): Timeline {
  const count = photoCountFor(ctx.durationMs, 1.9, photos.length, 4);
  const sequence = sequenceFor(photos, count, ctx, () => arrangeStory(photos, count, ctx.seed), 900);

  // Establishing and closing images breathe; details move quicker.
  const weights = sequence.map((p, i) => {
    if (i === 0 || i === sequence.length - 1) return 1.3;
    const role = inferStoryRole(p);
    return role === 'detail' || role === 'closeup' ? 0.85 : 1;
  });
  const cuts = planCuts(ctx.durationMs, sequence.length, ctx.beats, {
    snapToleranceMs: 200,
    minClipMs: 900,
    weights,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);

  const clips = sequence.map((photo, i) => {
    const role = inferStoryRole(photo);
    const isLast = i === sequence.length - 1;
    // Treatment follows the narrative role.
    const prefer = isLast
      ? ('cover-pull' as const)
      : role === 'establishing'
        ? photo.width > photo.height
          ? ('pan' as const)
          : ('auto' as const)
        : role === 'closeup' || role === 'portrait'
          ? ('cover-push' as const)
          : role === 'detail'
            ? ('static' as const)
            : ('auto' as const);
    const plan = planTreatment(photo, TARGET_ASPECT, prefer);
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
          : role === 'emotional' || isLast
            ? { kind: 'fade' as const, durationMs: 450 }
            : { kind: 'cut' as const, durationMs: 0 },
    };
  });

  const photosById = new Map(sequence.map((p) => [p.id, p]));
  const overlays = buildOverlays(ctx, clips, photosById, {
    titleSize: 58,
    captionSize: 38,
    ctaSize: 46,
    animation: 'fade',
    uppercaseTitle: false,
    letterSpacing: 0.02,
  });

  return baseTimeline(ctx, 'photo-story', clips, overlays);
}
