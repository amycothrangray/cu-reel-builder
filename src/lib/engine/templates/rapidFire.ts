// Template — Rapid Fire. Blink-and-you-miss-it: every included photo in very
// quick succession (~0.15–0.5s per slide), built for big sets of 50–100
// images. The editorial planner still orders for variety and people-spread
// (the parent test matters most here), but nothing is dropped.

import type { StyleTraits } from '../../editorial/plan';
import { mulberry32, type SequencePhoto } from '../sequence';
import { planTreatment } from '../layout';
import { uid } from '../../ids';
import type { Transition } from '../types';
import type { Timeline } from '../types';
import {
  baseTimeline,
  buildOverlays,
  cutsToWindows,
  editorialSlots,
  planCuts,
  TARGET_ASPECT,
  type TemplateContext,
} from './shared';

/** Hard floor per slide — below this the eye registers nothing at all. */
export const RAPID_MIN_SLIDE_MS = 120;

/** How many photos a Rapid Fire reel of this duration can physically hold. */
export function rapidFireCapacity(durationMs: number): number {
  // Opener ~0.7s and closer ~0.6s hold longer; the rest ride the floor.
  return Math.max(3, Math.floor((durationMs - 1300) / RAPID_MIN_SLIDE_MS) + 2);
}

const TRAITS: StyleTraits = {
  comfortableSlideMs: RAPID_MIN_SLIDE_MS,
  minSlideMs: RAPID_MIN_SLIDE_MS,
  idealPerSecond: 5,
  selectivity: 0, // the whole set — that's the point
  allowStacks: false,
  allowBursts: false, // every slide already flashes
  heroHoldBoost: 1,
  maxBurstFrames: 2,
};

/**
 * Below this a transition would eat the whole slide — stay a hard cut so
 * the photo itself still registers. Above it, an occasional quick fade or
 * flick gives the flashes some texture instead of being pure strobing.
 */
const MIN_SLIDE_FOR_TRANSITION_MS = 260;
const TRANSITION_CHANCE = 0.3;

/** A transition short enough to never dominate a very brief slide. */
function rapidTransition(clipMs: number, rand: () => number): Transition {
  if (clipMs < MIN_SLIDE_FOR_TRANSITION_MS || rand() >= TRANSITION_CHANCE) {
    return { kind: 'cut', durationMs: 0 };
  }
  const durationMs = Math.min(90, Math.round(clipMs * 0.25));
  const kind = rand() < 0.5 ? 'fade' : 'push-left';
  return { kind, durationMs };
}

export function buildRapidFire(photos: SequencePhoto[], ctx: TemplateContext): Timeline {
  const rand = mulberry32(ctx.seed);
  const slots = editorialSlots(photos, ctx, TRAITS, rapidFireCapacity(ctx.durationMs));
  const sequence = slots.map((s) => s.photos[0]);

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
    const plan = planTreatment(photo, TARGET_ASPECT, isEdge ? 'cover-push' : 'static');
    const clipMs = windows[i].endMs - windows[i].startMs;
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
      // The opener always cuts in hard; the closer favors a soft landing
      // when its hold is long enough; everything else is mostly cuts with
      // an occasional quick fade or flick for texture.
      transitionIn:
        i === 0
          ? ({ kind: 'cut', durationMs: 0 } as const)
          : i === sequence.length - 1 && clipMs >= MIN_SLIDE_FOR_TRANSITION_MS
            ? { kind: 'fade' as const, durationMs: Math.min(120, Math.round(clipMs * 0.3)) }
            : rapidTransition(clipMs, rand),
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
