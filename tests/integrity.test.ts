// Timeline integrity: the guarantees that must hold for EVERY style, at every
// length the app allows, whatever the user forces into the reel. A reel that
// plays photos at negative timestamps, or quietly loses work she added by
// hand, is worse than one that admits it ran out of room.

import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/lib/engine/buildReel';
import { TEMPLATES, getTemplate, templateCapacity } from '../src/lib/engine/templates';
import { defaultBrand } from '../src/lib/types';
import type { Timeline } from '../src/lib/engine/types';
import { makePhotoRecord, makeReelRecord } from './helpers';

const build = (
  photoCount: number,
  over: Parameters<typeof makeReelRecord>[0] = {},
  photoOver: (i: number) => Parameters<typeof makePhotoRecord>[0] = () => ({}),
): Timeline => {
  const photos = Array.from({ length: photoCount }, (_, i) =>
    makePhotoRecord({ id: `p${i}`, order: i, ...photoOver(i) }),
  );
  const reel = makeReelRecord(over);
  return buildTimeline({
    reel,
    photos,
    brand: defaultBrand(),
    templateId: reel.templateId ?? 'signature-energy',
    beats: [],
    seed: 7,
  });
};

/** Every guarantee a rendered timeline must satisfy, whatever produced it. */
function expectSoundTimeline(t: Timeline, durationMs: number) {
  for (const clip of t.clips) {
    expect(clip.startMs).toBeGreaterThanOrEqual(0);
    expect(clip.endMs).toBeGreaterThan(clip.startMs);
    expect(clip.endMs).toBeLessThanOrEqual(durationMs + 1);
    // A transition can never be longer than the clip it introduces, or it
    // would still be dissolving when the next photo is already due.
    expect(clip.transitionIn.durationMs).toBeLessThanOrEqual(clip.endMs - clip.startMs);
  }
  // Contiguous, monotonic coverage of the whole reel.
  if (t.clips.length > 0) {
    expect(t.clips[0].startMs).toBe(0);
    for (let i = 1; i < t.clips.length; i++) {
      expect(t.clips[i].startMs).toBe(t.clips[i - 1].endMs);
    }
    expect(t.clips[t.clips.length - 1].endMs).toBe(durationMs);
  }
}

describe('timeline integrity', () => {
  it('holds for every style across the whole 5–60s range and many set sizes', () => {
    for (const template of TEMPLATES) {
      for (const durationSec of [5, 9, 12, 15, 30, 60]) {
        for (const n of [1, 3, 8, 25, 60]) {
          const t = build(n, { templateId: template.id, durationSec });
          expectSoundTimeline(t, durationSec * 1000);
        }
      }
    }
  });

  it('never places a photo at a negative timestamp when photos are forced past capacity', () => {
    // Cinematic Story holds ~5 photos in 9 seconds; force in 20.
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const t = build(20, {
      templateId: 'cinematic-story',
      durationSec: 9,
      requiredIds: ids,
    });
    expectSoundTimeline(t, 9000);
    expect(t.clips.length).toBeLessThanOrEqual(
      templateCapacity(getTemplate('cinematic-story'), 9000),
    );
  });

  it('says which forced photos did not fit instead of dropping them silently', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const t = build(20, {
      templateId: 'cinematic-story',
      durationSec: 9,
      requiredIds: ids,
    });
    const rendered = new Set(t.clips.flatMap((c) => c.layers.map((l) => l.photoId)));
    expect(t.omittedPhotoIds?.length ?? 0).toBeGreaterThan(0);
    // Everything reported as omitted really is absent, and nothing absent is
    // left unreported — the count the editor shows her is the true count.
    for (const id of t.omittedPhotoIds ?? []) expect(rendered.has(id)).toBe(false);
    expect(rendered.size + (t.omittedPhotoIds?.length ?? 0)).toBe(20);
  });

  it('reports nothing omitted when everything the user forced fits', () => {
    const t = build(4, {
      templateId: 'cinematic-story',
      durationSec: 15,
      requiredIds: ['p0', 'p1', 'p2', 'p3'],
    });
    expect(t.omittedPhotoIds ?? []).toEqual([]);
    expect(new Set(t.clips.flatMap((c) => c.layers.map((l) => l.photoId))).size).toBe(4);
  });

  it('builds an empty reel instead of throwing when every photo is excluded', () => {
    const t = build(6, {}, () => ({ included: false }));
    expect(t.clips).toEqual([]);
    expect(t.durationMs).toBe(9000);
  });

  it('builds an empty reel instead of throwing when every photo is blocked', () => {
    const t = build(6, {}, () => ({
      restrictedFlags: [
        {
          profileId: 'x',
          profileLabel: 'Student',
          face: { x: 0, y: 0, w: 0.2, h: 0.2, score: 0.9 },
          distance: 0.3,
          status: 'blocked' as const,
        },
      ],
    }));
    expect(t.clips).toEqual([]);
  });
});

describe('manual order is an exact request', () => {
  it('does not pull in photos she never put in the reel', () => {
    // 30 eligible photos; she has hand-ordered the 8 that are in the reel.
    const manualOrder = ['p4', 'p1', 'p7', 'p2', 'p9', 'p0', 'p5', 'p3'];
    const t = build(30, { durationSec: 15, manualOrder });
    const rendered = t.clips.flatMap((c) => c.layers.map((l) => l.photoId));
    expect(rendered).toEqual(manualOrder);
  });

  it('keeps her exact sequence', () => {
    const manualOrder = ['p6', 'p0', 'p3', 'p1', 'p5'];
    const t = build(12, { durationSec: 15, manualOrder });
    expect(t.clips.flatMap((c) => c.layers.map((l) => l.photoId))).toEqual(manualOrder);
  });

  it('still includes photos added later, which join the end of her list', () => {
    const t = build(12, {
      durationSec: 15,
      manualOrder: ['p6', 'p0', 'p3'],
      requiredIds: ['p9'],
    });
    const rendered = t.clips.flatMap((c) => c.layers.map((l) => l.photoId));
    expect(rendered).toEqual(['p6', 'p0', 'p3', 'p9']);
  });

  it('falls back to choosing for her when every hand-placed photo is gone', () => {
    // She ordered photos that have since been deleted; the reel should still
    // build from what is left rather than coming out empty.
    const t = build(10, { durationSec: 12, manualOrder: ['gone-1', 'gone-2'] });
    expect(t.clips.length).toBeGreaterThan(0);
  });
});
