// Template 1 — Signature Energy. The strong default: fast, upbeat, polished.
// Energetic rhythm, gentle motion, music-aware cuts, occasional burst
// sequences, hero photos held a beat longer — photography stays the hero.

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
  minSlideMs: 900,
  idealPerSecond: 0.59,
  selectivity: 0.5,
  allowStacks: false,
  allowBursts: true,
  heroHoldBoost: 1.35,
  maxBurstFrames: 3,
};

export function buildSignatureEnergy(
  photos: SequencePhoto[],
  ctx: TemplateContext,
): Timeline {
  const rand = mulberry32(ctx.seed);
  const capacity = Math.max(3, Math.floor(ctx.durationMs / TRAITS.minSlideMs));
  const slots = editorialSlots(photos, ctx, TRAITS, capacity);

  const clips = realizeSlots(slots, ctx, {
    minClipMs: 700,
    snapToleranceMs: 180,
    easing: 'ease-in-out',
    treatmentFor: (slot, _i, isLast) => {
      if (isLast) return 'cover-pull'; // the closer settles outward
      if (slot.role === 'breath') return 'static';
      return 'auto';
    },
    // Mostly clean cuts with the occasional short fade for texture; breaths
    // and the closer arrive softly.
    transitionFor: (_i, slot, r) =>
      slot.role === 'close' || slot.role === 'breath'
        ? { kind: 'fade', durationMs: 300 }
        : r() < 0.2
          ? { kind: 'fade', durationMs: 240 }
          : { kind: 'cut', durationMs: 0 },
  }, rand);

  const photosById = new Map(slots.flatMap((s) => s.photos).map((p) => [p.id, p]));
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
