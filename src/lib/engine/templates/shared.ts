// Shared template machinery: timing, beat alignment, overlay construction.

import { uid } from '../../ids';
import { planSequence } from '../../editorial/plan';
import { refinePlan } from '../../editorial/critic';
import type { BrandConfig, ReelTextConfig } from '../../types';
import type {
  Clip,
  OverlayAnimation,
  TextOverlay,
  Timeline,
  TimelineAudio,
} from '../types';
import { pickTextZone, faceInFrame, TITLE_ZONES } from '../textZones';
import type { SequencePhoto } from '../sequence';

export interface TemplateContext {
  durationMs: number;
  text: ReelTextConfig;
  brand: BrandConfig;
  /** Beat timestamps in ms from audio analysis; empty when no music. */
  beats: number[];
  /** Music energy curve (0..1 per 500ms window); empty without music. */
  intensity?: number[];
  /** Editorial priorities: photography = selective showcase; school = breadth. */
  purpose?: 'photography' | 'school';
  audio: TimelineAudio | null;
  seed: number;
  /** True when the user dragged photos into a manual order — respect it. */
  fixedOrder?: boolean;
  /**
   * Whether to end this reel with the brand sign-off (CTA, handle, logo).
   * Opt-in per reel; the brand kit never applies itself.
   */
  branding?: boolean;
  /** Proof mode: keep two photos mixed at all times (see Timeline). */
  proofOverlap?: boolean;
}

/** Run the shared editorial pipeline (plan → critic → revised plan). */
export function editorialSlots(
  photos: SequencePhoto[],
  ctx: TemplateContext,
  traits: import('../../editorial/plan').StyleTraits,
  /** Styles with bespoke timing (Rapid Fire) supply their own ceiling. */
  capacityOverride?: number,
): import('../../editorial/plan').PlanSlot[] {
  const purpose = ctx.purpose ?? 'photography';
  const capacity =
    capacityOverride ?? Math.max(3, Math.floor(ctx.durationMs / traits.minSlideMs));
  const comfortableCapacity = Math.min(
    capacity,
    Math.max(3, Math.floor(ctx.durationMs / traits.comfortableSlideMs)),
  );
  const plan = planSequence(photos, traits, {
    purpose,
    durationMs: ctx.durationMs,
    seed: ctx.seed,
    fixedOrder: ctx.fixedOrder ?? false,
    intensity: ctx.intensity ?? [],
    capacity,
    comfortableCapacity,
  });
  // Second-pass Reel Critic: don't present the first construction —
  // evaluate it and revise before it becomes a version.
  return refinePlan(plan, { purpose, fixedOrder: ctx.fixedOrder ?? false }).plan.slots;
}

/**
 * Respect a user's manual order; otherwise let the template arrange.
 *
 * A manual list is an exact request: use ALL of it, in order, even past the
 * template's ideal count — capped only by what physically fits the duration
 * at the template's minimum slide length.
 */
export function sequenceFor(
  photos: SequencePhoto[],
  _idealCount: number,
  ctx: TemplateContext,
  arrange: () => SequencePhoto[],
  minClipMs = 900,
): SequencePhoto[] {
  if (!ctx.fixedOrder) return arrange();
  const capacity = Math.max(3, Math.floor(ctx.durationMs / minClipMs));
  return photos.slice(0, Math.min(photos.length, capacity));
}

export const FRAME = { width: 1080, height: 1920, fps: 30 };
export const TARGET_ASPECT = FRAME.width / FRAME.height;

/**
 * Distribute cut times across the reel and, when beats are available, snap
 * each cut to the nearest beat within a tolerance. Cuts stay monotonic and
 * no clip may shrink below `minClipMs` — musical, not mechanical.
 */
export function planCuts(
  durationMs: number,
  clipCount: number,
  beats: number[],
  opts: { snapToleranceMs?: number; minClipMs?: number; weights?: number[] } = {},
): number[] {
  const { snapToleranceMs = 180, minClipMs = 500 } = opts;
  const weights = opts.weights ?? Array(clipCount).fill(1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Ideal cut positions from the weights.
  const cuts: number[] = [];
  let acc = 0;
  for (let i = 0; i < clipCount - 1; i++) {
    acc += weights[i];
    cuts.push((acc / totalWeight) * durationMs);
  }

  if (beats.length > 0) {
    for (let i = 0; i < cuts.length; i++) {
      const ideal = cuts[i];
      let best = ideal;
      let bestDist = snapToleranceMs + 1;
      for (const b of beats) {
        const d = Math.abs(b - ideal);
        if (d < bestDist) {
          bestDist = d;
          best = b;
        }
      }
      if (bestDist <= snapToleranceMs) cuts[i] = best;
    }
  }

  // Enforce monotonicity and minimum clip length.
  let prev = 0;
  for (let i = 0; i < cuts.length; i++) {
    cuts[i] = Math.max(cuts[i], prev + minClipMs);
    // Also leave room for the remaining clips.
    const remaining = cuts.length - i;
    cuts[i] = Math.min(cuts[i], durationMs - minClipMs * remaining);
    prev = cuts[i];
  }
  return cuts;
}

/** Turn cut times into [start,end] windows covering the full duration. */
export function cutsToWindows(durationMs: number, cuts: number[]): { startMs: number; endMs: number }[] {
  const bounds = [0, ...cuts, durationMs];
  const out: { startMs: number; endMs: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    out.push({ startMs: bounds[i], endMs: bounds[i + 1] });
  }
  return out;
}

/**
 * Number of photos a template should use for a duration, given a target
 * seconds-per-photo rhythm.
 */
export function photoCountFor(
  durationMs: number,
  secondsPerPhoto: number,
  available: number,
  min = 3,
): number {
  const ideal = Math.round(durationMs / 1000 / secondsPerPhoto);
  return Math.max(min, Math.min(available, ideal));
}

// ---------------------------------------------------------------------------
// Overlays

export interface OverlayStyle {
  titleSize: number;
  captionSize: number;
  ctaSize: number;
  animation: OverlayAnimation;
  uppercaseTitle: boolean;
  letterSpacing: number;
}

/**
 * Build the standard overlay set: optional title in the early-middle,
 * optional caption later, CTA + handle in the final second, brand logo when
 * available. Text zones are chosen against the faces visible at that moment.
 */
export function buildOverlays(
  ctx: TemplateContext,
  clips: Clip[],
  photosById: Map<string, SequencePhoto>,
  style: OverlayStyle,
): TextOverlay[] {
  const overlays: TextOverlay[] = [];
  const durationMs = ctx.durationMs;
  const textColor = '#ffffff';

  const facesDuring = (fromMs: number, toMs: number) => {
    const frameFaces = [];
    for (const clip of clips) {
      if (clip.endMs <= fromMs || clip.startMs >= toMs) continue;
      for (const layer of clip.layers) {
        const photo = photosById.get(layer.photoId);
        if (!photo) continue;
        for (const face of photo.faces) {
          // Check at the clip's end crop (where text will mostly coexist).
          const mapped = faceInFrame(face, layer.cropEnd, layer.dest);
          if (mapped) frameFaces.push(mapped);
        }
      }
    }
    return frameFaces;
  };

  // Title: ~30–60% through the reel, on a clip boundary.
  if (ctx.text.title.trim()) {
    const start = Math.max(1500, durationMs * 0.3);
    const end = Math.min(durationMs * 0.62, start + 2600);
    const zone = pickTextZone(facesDuring(start, end), TITLE_ZONES);
    overlays.push({
      id: uid(),
      kind: 'title',
      text: ctx.text.title.trim(),
      startMs: start,
      endMs: end,
      pos: zone.pos,
      align: 'center',
      sizePx: style.titleSize,
      font: 'primary',
      color: textColor,
      scrim: 0.25,
      animation: style.animation,
      letterSpacing: style.letterSpacing,
      uppercase: style.uppercaseTitle,
    });
  }

  // Supporting caption after the title.
  if (ctx.text.caption.trim()) {
    const start = Math.min(durationMs * 0.66, durationMs - 2600);
    const end = Math.min(durationMs - 1100, start + 2200);
    if (end > start + 600) {
      const zone = pickTextZone(facesDuring(start, end), TITLE_ZONES);
      overlays.push({
        id: uid(),
        kind: 'caption',
        text: ctx.text.caption.trim(),
        startMs: start,
        endMs: end,
        pos: zone.pos,
        align: 'center',
        sizePx: style.captionSize,
        font: 'secondary',
        color: textColor,
        scrim: 0.22,
        animation: 'fade',
        letterSpacing: 0.02,
        uppercase: false,
      });
    }
  }

  // The brand sign-off in the final second(s) — call to action, handle and
  // logo. This is the part that turns a reel into an advertisement, so it
  // appears only when she has switched branding on for this reel. There is
  // deliberately no fallback to the saved brand CTA: clearing the field means
  // no call to action, not "use the default one".
  const cta = ctx.branding ? ctx.text.cta.trim() : '';
  if (cta) {
    const start = durationMs - Math.min(2000, durationMs * 0.2);
    overlays.push({
      id: uid(),
      kind: 'cta',
      text: cta,
      startMs: start,
      endMs: durationMs,
      pos: { x: 0.5, y: 0.78 },
      align: 'center',
      sizePx: style.ctaSize,
      font: 'primary',
      color: textColor,
      scrim: 0.35,
      animation: 'fade',
      letterSpacing: style.letterSpacing,
      uppercase: style.uppercaseTitle,
    });
    const handle = ctx.brand.instagram.trim() || ctx.brand.website.trim();
    if (ctx.text.showHandle && handle) {
      overlays.push({
        id: uid(),
        kind: 'handle',
        text: handle.startsWith('@') || handle.includes('.') ? handle : `@${handle}`,
        startMs: start,
        endMs: durationMs,
        pos: { x: 0.5, y: 0.845 },
        align: 'center',
        sizePx: 30,
        font: 'secondary',
        color: textColor,
        scrim: 0,
        animation: 'fade',
        letterSpacing: 0.06,
        uppercase: false,
      });
    }
    if (ctx.brand.logoAssetKey && ctx.text.showLogo !== false) {
      overlays.push({
        id: uid(),
        kind: 'logo',
        text: '',
        startMs: start,
        endMs: durationMs,
        pos: { x: 0.5, y: 0.68 },
        align: 'center',
        sizePx: 200, // logo max width in frame px
        font: 'primary',
        color: textColor,
        scrim: 0,
        animation: 'fade',
        letterSpacing: 0,
        uppercase: false,
      });
    }
  }

  return overlays;
}

export function baseTimeline(
  ctx: TemplateContext,
  templateId: Timeline['templateId'],
  clips: Clip[],
  overlays: TextOverlay[],
): Timeline {
  return {
    templateId,
    width: FRAME.width,
    height: FRAME.height,
    fps: FRAME.fps,
    durationMs: ctx.durationMs,
    background: '#0d0c0a',
    clips,
    overlays,
    audio: ctx.audio,
    seed: ctx.seed,
    ...(ctx.proofOverlap ? { continuousOverlap: true } : {}),
  };
}
