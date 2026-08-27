// Template 2 — Cinematic Story. Slower and emotional: a selective set,
// long holds, subtle pans, soft transitions, a gentle build to the final
// image. Photographs breathe across musical phrases.

import type { StyleTraits } from '../../editorial/plan';
import type { SequencePhoto } from '../sequence';
import { mulberry32 } from '../sequence';
import type { Timeline } from '../types';
import {
  baseTimeline,
  buildOverlays,
  editorialSlots,
  type TemplateContext,
} from './shared';
import { realizeSlots } from './realize';

const TRAITS: StyleTraits = {
  comfortableSlideMs: 2500,
  minSlideMs: 1600,
  idealPerSecond: 0.38,
  selectivity: 0.85, // best with a curated set — restraint is the style
  allowStacks: false,
  allowBursts: false,
  heroHoldBoost: 1.5,
  maxBurstFrames: 2,
};

export function buildCinematicStory(
  photos: SequencePhoto[],
  ctx: TemplateContext,
): Timeline {
  const rand = mulberry32(ctx.seed);
  const slots = editorialSlots(photos, ctx, TRAITS);

  const clips = realizeSlots(slots, ctx, {
    minClipMs: 1400,
    snapToleranceMs: 260, // cuts drift onto beats only when already close
    easing: 'ease-in-out',
    treatmentFor: (slot, _i, isLast) => {
      if (isLast) return 'cover-pull';
      const photo = slot.photos[0];
      return photo.width > photo.height ? 'pan' : 'auto';
    },
    transitionFor: () => ({ kind: 'fade', durationMs: 600 }),
  }, rand);

  const photosById = new Map(slots.flatMap((s) => s.photos).map((p) => [p.id, p]));
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
