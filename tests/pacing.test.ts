import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  getTemplate,
  pacingFor,
  templateCapacity,
  templateComfortableCapacity,
} from '../src/lib/engine/templates';
import { defaultBrand } from '../src/lib/types';
import { makePhoto } from './helpers';
import type { TemplateContext } from '../src/lib/engine/templates/shared';

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  durationMs: 9000,
  text: { title: '', caption: '', cta: '', showHandle: false },
  brand: defaultBrand(),
  beats: [],
  audio: null,
  seed: 4,
  ...over,
});

const photoCountOf = (t: { clips: { layers: { photoId: string }[] }[] }) =>
  new Set(t.clips.flatMap((c) => c.layers.map((l) => l.photoId))).size;

describe('style pacing promises', () => {
  it('comfortable capacity is never larger than physical capacity', () => {
    for (const template of TEMPLATES) {
      for (const ms of [9000, 12000, 15000]) {
        expect(templateComfortableCapacity(template, ms)).toBeLessThanOrEqual(
          templateCapacity(template, ms),
        );
      }
    }
  });

  it('reports when a reel is running faster than its style promises', () => {
    const signature = getTemplate('signature-energy');
    const calm = pacingFor(signature, 9000, 5);
    expect(calm.rushed).toBe(false);
    const rushed = pacingFor(signature, 9000, 10);
    expect(rushed.rushed).toBe(true);
    expect(rushed.perPhotoMs).toBeCloseTo(900);
    // 10 photos need a longer reel to sit at this style's pace.
    expect(rushed.neededSec).toBe(15);
  });

  it('offers no longer length when even 15s cannot hold the set comfortably', () => {
    const cinematic = getTemplate('cinematic-story');
    expect(pacingFor(cinematic, 9000, 30).neededSec).toBeNull();
  });
});

describe('too many photos means fewer photos, not a faster reel', () => {
  it('automatic selection stays at the style pace instead of cramming', () => {
    const plenty = Array.from({ length: 40 }, () => makePhoto({ score: 0.8 }));
    for (const template of TEMPLATES) {
      if (template.id === 'rapid-fire') continue; // speed is the point there
      const timeline = template.build(plenty, ctx());
      const used = photoCountOf(timeline);
      const comfortable = templateComfortableCapacity(template, 9000);
      expect(used).toBeLessThanOrEqual(comfortable);
      // …and every clip holds at least the style's comfortable-ish pace.
      const shortest = Math.min(...timeline.clips.map((c) => c.endMs - c.startMs));
      expect(shortest).toBeGreaterThanOrEqual(template.minSlideMs * 0.75);
    }
  });

  it('Rapid Fire still shows the whole set — speed is its whole point', () => {
    const many = Array.from({ length: 40 }, () => makePhoto({}));
    const timeline = getTemplate('rapid-fire').build(many, ctx());
    expect(photoCountOf(timeline)).toBe(40);
  });

  it('photos the user explicitly added come before anything the engine wants', () => {
    // 8 required photos in a 9s Signature Energy reel (comfortable = 6,
    // physical = 10): past the promised pace, still inside what fits.
    const required = Array.from({ length: 8 }, () => makePhoto({ score: 0.4, required: true }));
    const extras = Array.from({ length: 10 }, () => makePhoto({ score: 0.9 }));
    const timeline = getTemplate('signature-energy').build([...required, ...extras], ctx());
    const used = new Set(timeline.clips.flatMap((c) => c.layers.map((l) => l.photoId)));
    for (const p of required) expect(used.has(p.id)).toBe(true);
    // The engine adds nothing of its own on top of an overflowing lock.
    expect(used.size).toBe(8);
  });

  it('honors as many added photos as physically fit, and no more', () => {
    // 12 required photos in a 9s Signature Energy reel. Only 10 can fit at
    // the style's 900ms floor; cramming in 12 would push clips off the front
    // of the reel, so the engine keeps the first 10 in her order.
    const required = Array.from({ length: 12 }, () => makePhoto({ score: 0.4, required: true }));
    const timeline = getTemplate('signature-energy').build(required, ctx());
    const used = new Set(timeline.clips.flatMap((c) => c.layers.map((l) => l.photoId)));
    const physical = templateCapacity(getTemplate('signature-energy'), 9000);
    expect(used.size).toBe(physical);
    for (const p of required.slice(0, physical)) expect(used.has(p.id)).toBe(true);
    // Every clip still sits inside the reel — no negative timestamps.
    for (const clip of timeline.clips) {
      expect(clip.startMs).toBeGreaterThanOrEqual(0);
      expect(clip.endMs).toBeGreaterThan(clip.startMs);
    }
  });
});
