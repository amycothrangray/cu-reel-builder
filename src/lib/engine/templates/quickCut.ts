// Template 3 — Quick Cut. Rapid, beat-driven, using still photography almost
// like frames of video: bursts run across fast beats, stacked compositions
// mix in, cuts ride the rhythm, and the finish pushes hard.

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
  comfortableSlideMs: 850,
  minSlideMs: 450,
  idealPerSecond: 0.95,
  selectivity: 0.3,
  allowStacks: true,
  allowBursts: true,
  heroHoldBoost: 1.2,
  maxBurstFrames: 4,
};

export function buildQuickCut(photos: SequencePhoto[], ctx: TemplateContext): Timeline {
  const rand = mulberry32(ctx.seed);
  const slots = editorialSlots(photos, ctx, TRAITS);

  const clips = realizeSlots(slots, ctx, {
    minClipMs: 420,
    snapToleranceMs: 240, // ride the beat hard
    easing: 'linear',
    burstFrameMs: 200,
    treatmentFor: (_slot, _i, isLast) => (isLast ? 'cover-push' : 'auto'),
    transitionFor: (_i, _slot, r) =>
      r() < 0.12
        ? { kind: 'push-up', durationMs: 200 }
        : { kind: 'cut', durationMs: 0 },
  }, rand);

  // Minimal text: title only (short window), CTA at the end, no caption.
  const photosById = new Map(slots.flatMap((s) => s.photos).map((p) => [p.id, p]));
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
