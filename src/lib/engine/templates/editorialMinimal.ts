// Template 4 — Editorial Minimal. Confidence through restraint: a small
// curated set, gallery matting on the brand ground, stills that simply sit
// there, elegant type. Doing less, deliberately.

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
  comfortableSlideMs: 2100,
  minSlideMs: 1400,
  idealPerSecond: 0.45,
  selectivity: 0.9, // the most curated style — capacity is not a target
  allowStacks: false,
  allowBursts: false,
  heroHoldBoost: 1.6, // an exceptional photograph is allowed to just sit there
  maxBurstFrames: 2,
};

export function buildEditorialMinimal(
  photos: SequencePhoto[],
  ctx: TemplateContext,
): Timeline {
  const rand = mulberry32(ctx.seed);
  const slots = editorialSlots(photos, ctx, TRAITS);

  let sinceMatte = 0;
  const clips = realizeSlots(slots, ctx, {
    minClipMs: 1200,
    snapToleranceMs: 120, // only snap when a beat is essentially already there
    easing: 'linear',
    treatmentFor: (slot, i, isLast, r) => {
      // Full-bleed heroes; alternate matted gallery frames for support.
      if (slot.hero || isLast || i === 0) {
        sinceMatte++;
        return r() < 0.5 ? 'static' : 'cover-push';
      }
      if (sinceMatte >= 1 && r() < 0.8) {
        sinceMatte = 0;
        return 'matte';
      }
      sinceMatte++;
      return 'static';
    },
    transitionFor: () => ({ kind: 'fade', durationMs: 350 }),
  }, rand);

  const photosById = new Map(slots.flatMap((s) => s.photos).map((p) => [p.id, p]));
  const overlays = buildOverlays(ctx, clips, photosById, {
    titleSize: 50,
    captionSize: 34,
    ctaSize: 40,
    animation: 'fade',
    uppercaseTitle: true,
    letterSpacing: 0.14,
  });

  const timeline = baseTimeline(ctx, 'editorial-minimal', clips, overlays);
  timeline.background = ctx.brand.secondaryColor || '#faf8f5';
  return timeline;
}
