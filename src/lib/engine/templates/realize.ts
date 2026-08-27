// Turns an editorial plan (slots with roles/weights) into concrete clips.
// Styles keep their character through the RealizeConfig: transitions,
// treatments, easing and backgrounds differ; the editorial engine is shared.

import { uid } from '../../ids';
import { planTreatment, stackedLayers, type TreatmentKind } from '../layout';
import type { PlanSlot } from '../../editorial/plan';
import type { Clip, Easing, Transition } from '../types';
import { cutsToWindows, planCuts, TARGET_ASPECT, type TemplateContext } from './shared';

export type TreatmentPref = TreatmentKind | 'auto' | 'matte';

export interface RealizeConfig {
  minClipMs: number;
  snapToleranceMs: number;
  easing: Easing;
  /** Minimum readable duration for one burst frame. */
  burstFrameMs?: number;
  treatmentFor: (slot: PlanSlot, index: number, isLast: boolean, rand: () => number) => TreatmentPref;
  transitionFor: (index: number, slot: PlanSlot, rand: () => number) => Transition;
}

const CUT: Transition = { kind: 'cut', durationMs: 0 };

export function realizeSlots(
  slots: PlanSlot[],
  ctx: TemplateContext,
  cfg: RealizeConfig,
  rand: () => number,
): Clip[] {
  if (slots.length === 0) return [];
  const weights = slots.map((s) => s.weight);
  const cuts = planCuts(ctx.durationMs, slots.length, ctx.beats, {
    snapToleranceMs: cfg.snapToleranceMs,
    minClipMs: cfg.minClipMs,
    weights,
  });
  const windows = cutsToWindows(ctx.durationMs, cuts);
  const burstFrameMs = cfg.burstFrameMs ?? 220;

  const clips: Clip[] = [];
  slots.forEach((slot, i) => {
    const window = windows[i];
    const isLast = i === slots.length - 1;
    const transition = i === 0 ? CUT : cfg.transitionFor(i, slot, rand);

    if (slot.kind === 'burst') {
      // The moment unfolds: equal rapid frames inside the slot's window.
      const span = window.endMs - window.startMs;
      const frames = Math.max(2, Math.min(slot.photos.length, Math.floor(span / burstFrameMs)));
      const photos = slot.photos.slice(0, frames);
      const frameMs = span / photos.length;
      photos.forEach((photo, f) => {
        const plan = planTreatment(photo, TARGET_ASPECT, 'static');
        clips.push({
          id: uid(),
          startMs: window.startMs + f * frameMs,
          endMs: f === photos.length - 1 ? window.endMs : window.startMs + (f + 1) * frameMs,
          layers: [
            {
              photoId: photo.id,
              dest: { x: 0, y: 0, w: 1, h: 1 },
              crop: plan.crop,
              cropEnd: plan.cropEnd,
              easing: 'linear',
              fill: plan.fill,
            },
          ],
          transitionIn: f === 0 ? transition : CUT,
        });
      });
      return;
    }

    if (slot.kind === 'stack') {
      const layers = stackedLayers(slot.photos[0], slot.photos[1]).map(({ photo, dest, plan }) => ({
        photoId: photo.id,
        dest,
        crop: plan.crop,
        cropEnd: plan.cropEnd,
        easing: 'linear' as const,
        fill: plan.fill,
      }));
      clips.push({
        id: uid(),
        startMs: window.startMs,
        endMs: window.endMs,
        layers,
        transitionIn: transition,
      });
      return;
    }

    const photo = slot.photos[0];
    const pref = cfg.treatmentFor(slot, i, isLast, rand);

    if (pref === 'matte') {
      // Gallery framing: the photo contained over the brand ground.
      const inset = 0.1;
      clips.push({
        id: uid(),
        startMs: window.startMs,
        endMs: window.endMs,
        layers: [
          {
            photoId: photo.id,
            dest: { x: inset, y: 0, w: 1 - inset * 2, h: 1 },
            crop: { x: 0, y: 0, w: 1, h: 1 },
            cropEnd: { x: 0, y: 0, w: 1, h: 1 },
            easing: 'linear',
            fill: 'contain-brand',
          },
        ],
        transitionIn: transition,
      });
      return;
    }

    const plan = planTreatment(photo, TARGET_ASPECT, pref === 'auto' ? 'auto' : pref);
    clips.push({
      id: uid(),
      startMs: window.startMs,
      endMs: window.endMs,
      layers: [
        {
          photoId: photo.id,
          dest: { x: 0, y: 0, w: 1, h: 1 },
          crop: plan.crop,
          cropEnd: plan.cropEnd,
          easing: cfg.easing,
          fill: plan.fill,
        },
      ],
      transitionIn: transition,
    });
  });

  return clips;
}
