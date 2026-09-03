import { describe, expect, it } from 'vitest';
import { buildRapidFire, rapidFireCapacity, RAPID_MIN_SLIDE_MS } from '../src/lib/engine/templates/rapidFire';
import { defaultBrand } from '../src/lib/types';
import { face, makePhoto } from './helpers';
import type { TemplateContext } from '../src/lib/engine/templates/shared';

const ctx = (durationMs: number): TemplateContext => ({
  durationMs,
  text: { title: 'Season Recap', caption: 'ignored at this pace', cta: 'Book now', showHandle: true },
  brand: defaultBrand(),
  beats: [],
  audio: null,
  seed: 3,
});

const bigSet = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    makePhoto({
      width: i % 2 === 0 ? 6000 : 2000,
      height: i % 2 === 0 ? 4000 : 3000,
      faces: i % 3 === 0 ? [face(0.35, 0.25, 0.15, 0.2)] : [],
    }),
  );

describe('Rapid Fire template', () => {
  it('fits 100 photos into a 15-second reel', () => {
    expect(rapidFireCapacity(15000)).toBeGreaterThanOrEqual(100);
    const t = buildRapidFire(bigSet(100), ctx(15000));
    expect(t.clips.length).toBe(100);
    expect(t.clips[t.clips.length - 1].endMs).toBe(15000);
  });

  it('never drops below the minimum readable slide length', () => {
    for (const [n, durationMs] of [
      [100, 15000],
      [80, 9000], // more photos than the duration can hold
      [40, 12000],
    ] as const) {
      const t = buildRapidFire(bigSet(n), ctx(durationMs));
      for (const clip of t.clips) {
        expect(clip.endMs - clip.startMs).toBeGreaterThanOrEqual(RAPID_MIN_SLIDE_MS - 1);
      }
    }
  });

  it('caps the photo count at the duration capacity instead of breaking timing', () => {
    const t = buildRapidFire(bigSet(200), ctx(9000));
    expect(t.clips.length).toBeLessThanOrEqual(rapidFireCapacity(9000));
    // Contiguous, monotonic coverage of the whole duration.
    expect(t.clips[0].startMs).toBe(0);
    for (let i = 1; i < t.clips.length; i++) {
      expect(t.clips[i].startMs).toBe(t.clips[i - 1].endMs);
    }
    expect(t.clips[t.clips.length - 1].endMs).toBe(9000);
  });

  it('holds the opener and closer longer than the flashes', () => {
    const t = buildRapidFire(bigSet(60), ctx(15000));
    const durations = t.clips.map((c) => c.endMs - c.startMs);
    const middle = durations.slice(1, -1);
    const avgMiddle = middle.reduce((a, b) => a + b, 0) / middle.length;
    expect(durations[0]).toBeGreaterThan(avgMiddle * 2);
    expect(durations[durations.length - 1]).toBeGreaterThan(avgMiddle * 1.8);
  });

  it('drops the caption but keeps the CTA of a branded reel', () => {
    const t = buildRapidFire(bigSet(50), { ...ctx(12000), branding: true });
    expect(t.overlays.some((o) => o.kind === 'caption')).toBe(false);
    expect(t.overlays.some((o) => o.kind === 'cta')).toBe(true);
  });

  it('the opener always cuts in hard, whatever its hold length', () => {
    const t = buildRapidFire(bigSet(100), ctx(9000));
    expect(t.clips[0].transitionIn.kind).toBe('cut');
    expect(t.clips[0].transitionIn.durationMs).toBe(0);
  });

  it('packed-to-the-floor slides stay pure hard cuts (no transition to spare)', () => {
    const t = buildRapidFire(bigSet(100), ctx(9000));
    // Every clip except possibly the closer is at/near the 90ms floor —
    // far under the threshold a transition needs to not swallow the slide.
    for (const clip of t.clips.slice(1, -1)) {
      expect(clip.transitionIn.kind).toBe('cut');
    }
  });

  it('a transition never lasts longer than the slide it belongs to', () => {
    for (const durationMs of [9000, 12000, 15000]) {
      const t = buildRapidFire(bigSet(60), ctx(durationMs));
      for (const clip of t.clips) {
        const clipMs = clip.endMs - clip.startMs;
        expect(clip.transitionIn.durationMs).toBeLessThanOrEqual(clipMs);
        expect(clip.transitionIn.durationMs).toBeLessThanOrEqual(120);
      }
    }
  });

  it('gives longer slides occasional texture instead of pure strobing', () => {
    // Few photos over a longer reel => generous per-slide time, so some
    // non-cut transitions should appear given the deterministic seed.
    const t = buildRapidFire(bigSet(24), ctx(15000));
    const nonCuts = t.clips.filter((c) => c.transitionIn.kind !== 'cut');
    expect(nonCuts.length).toBeGreaterThan(0);
    for (const clip of nonCuts) {
      expect(['fade', 'push-left']).toContain(clip.transitionIn.kind);
    }
  });

  it('is deterministic: the same seed produces the same transitions', () => {
    // ctx() always carries seed: 3, so two calls are already same-seed.
    const a = buildRapidFire(bigSet(24), ctx(15000));
    const b = buildRapidFire(bigSet(24), ctx(15000));
    expect(a.clips.map((c) => c.transitionIn.kind)).toEqual(
      b.clips.map((c) => c.transitionIn.kind),
    );
  });
});
