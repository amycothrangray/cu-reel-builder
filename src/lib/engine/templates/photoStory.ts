// Template 5 — Photo Story. Feels like experiencing the session or event:
// the arc (establishing scene → people interacting → closeups → emotional
// close) drives both the order and how each image is treated.

import type { StyleTraits } from '../../editorial/plan';
import { inferStoryRole, mulberry32, type SequencePhoto } from '../sequence';
import type { Timeline } from '../types';
import {
  baseTimeline,
  buildOverlays,
  editorialSlots,
  type TemplateContext,
} from './shared';
import { realizeSlots } from './realize';

const TRAITS: StyleTraits = {
  comfortableSlideMs: 1800,
  minSlideMs: 900,
  idealPerSecond: 0.53,
  selectivity: 0.5,
  allowStacks: false,
  allowBursts: true, // moments unfolding are the heart of a story
  heroHoldBoost: 1.3,
  maxBurstFrames: 3,
};

export function buildPhotoStory(photos: SequencePhoto[], ctx: TemplateContext): Timeline {
  const rand = mulberry32(ctx.seed);
  const slots = editorialSlots(photos, ctx, TRAITS);

  const clips = realizeSlots(slots, ctx, {
    minClipMs: 800,
    snapToleranceMs: 200,
    easing: 'ease-in-out',
    treatmentFor: (slot, _i, isLast) => {
      if (isLast) return 'cover-pull';
      const photo = slot.photos[0];
      const role = inferStoryRole(photo);
      if (role === 'establishing') return photo.width > photo.height ? 'pan' : 'auto';
      if (role === 'closeup' || role === 'portrait') return 'cover-push';
      if (role === 'detail') return 'static';
      return 'auto';
    },
    transitionFor: (_i, slot) => {
      const emotional = slot.photos.some(
        (p) => inferStoryRole(p) === 'emotional' || inferStoryRole(p) === 'closing',
      );
      return emotional || slot.role === 'close'
        ? { kind: 'fade', durationMs: 450 }
        : { kind: 'cut', durationMs: 0 };
    },
  }, rand);

  const photosById = new Map(slots.flatMap((s) => s.photos).map((p) => [p.id, p]));
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
