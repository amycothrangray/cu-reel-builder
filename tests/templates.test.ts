import { describe, expect, it } from 'vitest';
import { TEMPLATES, surpriseMe } from '../src/lib/engine/templates';
import { photoCountFor, planCuts, cutsToWindows, type TemplateContext } from '../src/lib/engine/templates/shared';
import { defaultBrand } from '../src/lib/types';
import { face, makePhoto } from './helpers';
import type { Timeline } from '../src/lib/engine/types';

const ctx = (overrides: Partial<TemplateContext> = {}): TemplateContext => ({
  durationMs: 9000,
  text: { title: 'The Andersons', caption: 'golden hour', cta: 'Book your session', showHandle: true },
  brand: { ...defaultBrand(), instagram: '@studio' },
  beats: [],
  audio: null,
  seed: 11,
  ...overrides,
});

const photoSet = (n = 10) =>
  Array.from({ length: n }, (_, i) =>
    makePhoto({
      width: i % 3 === 0 ? 6000 : 2000,
      height: i % 3 === 0 ? 4000 : 3000,
      score: 0.4 + (i % 5) * 0.12,
      faces: i % 2 === 0 ? [face(0.35, 0.25, 0.15, 0.2)] : [],
    }),
  );

function checkTimelineInvariants(t: Timeline) {
  expect(t.width).toBe(1080);
  expect(t.height).toBe(1920);
  expect(t.clips.length).toBeGreaterThanOrEqual(3);
  // Clips tile the full duration contiguously.
  expect(t.clips[0].startMs).toBe(0);
  for (let i = 0; i < t.clips.length; i++) {
    const clip = t.clips[i];
    expect(clip.endMs).toBeGreaterThan(clip.startMs);
    if (i > 0) expect(clip.startMs).toBe(t.clips[i - 1].endMs);
    for (const layer of clip.layers) {
      // Crops are valid normalized rects.
      for (const crop of [layer.crop, layer.cropEnd]) {
        expect(crop.x).toBeGreaterThanOrEqual(-0.001);
        expect(crop.y).toBeGreaterThanOrEqual(-0.001);
        expect(crop.x + crop.w).toBeLessThanOrEqual(1.001);
        expect(crop.y + crop.h).toBeLessThanOrEqual(1.001);
      }
    }
  }
  expect(t.clips[t.clips.length - 1].endMs).toBe(t.durationMs);
  // Overlays live inside the reel.
  for (const o of t.overlays) {
    expect(o.startMs).toBeGreaterThanOrEqual(0);
    expect(o.endMs).toBeLessThanOrEqual(t.durationMs);
    expect(o.endMs).toBeGreaterThan(o.startMs);
  }
}

describe('reel template timing', () => {
  it('planCuts distributes evenly and respects minimum clip length', () => {
    const cuts = planCuts(9000, 5, [], { minClipMs: 900 });
    const windows = cutsToWindows(9000, cuts);
    expect(windows).toHaveLength(5);
    for (const w of windows) expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(899);
  });

  it('snaps cuts to nearby beats but not distant ones', () => {
    const beats = [2210, 4500, 8990];
    const cuts = planCuts(9000, 4, beats, { snapToleranceMs: 200, minClipMs: 500 });
    // Ideal cuts at 2250, 4500, 6750: first two snap, third has no nearby beat.
    expect(cuts[0]).toBe(2210);
    expect(cuts[1]).toBe(4500);
    expect(Math.abs(cuts[2] - 6750)).toBeLessThan(1);
  });

  it('keeps cuts monotonic even with clustered beats', () => {
    const beats = [4400, 4450, 4500];
    const cuts = planCuts(9000, 4, beats, { snapToleranceMs: 2000, minClipMs: 500 });
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]).toBeGreaterThan(cuts[i - 1]);
  });

  it('photoCountFor adapts to duration and rhythm', () => {
    expect(photoCountFor(9000, 1.7, 20)).toBe(5);
    expect(photoCountFor(15000, 1.05, 20)).toBe(14);
    expect(photoCountFor(9000, 1.7, 4)).toBe(4); // capped by availability
  });

  it('every template produces a valid contiguous timeline at every duration', () => {
    for (const template of TEMPLATES) {
      for (const durationMs of [9000, 12000, 15000]) {
        const t = template.build(photoSet(12), ctx({ durationMs }));
        checkTimelineInvariants(t);
        expect(t.templateId).toBe(template.id);
      }
    }
  });

  it('templates differ meaningfully in pacing', () => {
    const quick = TEMPLATES.find((t) => t.id === 'quick-cut')!.build(photoSet(14), ctx());
    const cinematic = TEMPLATES.find((t) => t.id === 'cinematic-story')!.build(photoSet(14), ctx());
    expect(quick.clips.length).toBeGreaterThan(cinematic.clips.length + 2);
  });

  it('quick-cut drops the caption by design', () => {
    const t = TEMPLATES.find((x) => x.id === 'quick-cut')!.build(photoSet(12), ctx());
    expect(t.overlays.some((o) => o.kind === 'caption')).toBe(false);
  });

  it('CTA appears in the final seconds with brand handle', () => {
    const t = TEMPLATES[0].build(photoSet(10), ctx());
    const cta = t.overlays.find((o) => o.kind === 'cta');
    expect(cta).toBeDefined();
    expect(cta!.endMs).toBe(t.durationMs);
    expect(t.overlays.some((o) => o.kind === 'handle')).toBe(true);
  });

  it('respects a manual fixed order', () => {
    const photos = photoSet(6);
    const t = TEMPLATES[0].build(photos, ctx({ fixedOrder: true, durationMs: 12000 }));
    const usedOrder: string[] = [];
    for (const clip of t.clips) {
      for (const l of clip.layers) if (!usedOrder.includes(l.photoId)) usedOrder.push(l.photoId);
    }
    expect(usedOrder).toEqual(photos.slice(0, usedOrder.length).map((p) => p.id));
  });
});

describe('surprise me', () => {
  it('picks quick-cut for big sets and editorial for face-light sets', () => {
    expect(surpriseMe(photoSet(14), 3)).toBe('quick-cut');
    const scenic = Array.from({ length: 6 }, () => makePhoto({ faces: [] }));
    expect(surpriseMe(scenic, 3)).toBe('editorial-minimal');
  });
});
