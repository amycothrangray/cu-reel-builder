// Proof mode: no frame of the reel may ever be a clean copy of one photo.
//
// These tests drive the real renderFrame against a stub 2D context that
// records what was drawn and at what alpha, then assert the guarantee holds
// at every sampled instant — including the opener, which has no photo before
// it and so is the frame most likely to come out clean by accident.

import { describe, expect, it } from 'vitest';
import { renderFrame } from '../src/lib/engine/renderFrame';
import { buildTimeline } from '../src/lib/engine/buildReel';
import { defaultBrand } from '../src/lib/types';
import type { Timeline } from '../src/lib/engine/types';
import type { RenderResources } from '../src/lib/engine/types';
import { makePhotoRecord, makeReelRecord } from './helpers';

interface DrawnImage {
  photoId: string;
  alpha: number;
}

/**
 * A canvas stub that records each image draw with the alpha in force. Only
 * the handful of 2D calls renderFrame actually makes are implemented.
 */
function stubContext(images: Map<string, unknown>) {
  const drawn: DrawnImage[] = [];
  const stack: number[] = [];
  const idOf = new Map<unknown, string>();
  for (const [id, img] of images) idOf.set(img, id);

  const ctx = {
    globalAlpha: 1,
    filter: 'none',
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    letterSpacing: '',
    save() {
      stack.push(this.globalAlpha);
    },
    restore() {
      const a = stack.pop();
      if (a !== undefined) this.globalAlpha = a;
    },
    drawImage(img: unknown) {
      const id = idOf.get(img);
      if (id) drawn.push({ photoId: id, alpha: this.globalAlpha });
    },
    fillRect() {},
    strokeRect() {},
    fillText() {},
    strokeText() {},
    measureText: () => ({ width: 100 }),
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    roundRect() {},
    fill() {},
    stroke() {},
    clip() {},
    translate() {},
    scale() {},
    rotate() {},
    setTransform() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return { ctx, drawn };
}

function buildProofTimeline(photoCount: number, over = {}): { timeline: Timeline; res: RenderResources } {
  const photos = Array.from({ length: photoCount }, (_, i) =>
    makePhotoRecord({ id: `p${i}`, order: i }),
  );
  const reel = makeReelRecord({
    templateId: 'rapid-fire',
    durationSec: 12,
    proofOverlap: true,
    ...over,
  });
  const timeline = buildTimeline({
    reel,
    photos,
    brand: defaultBrand(),
    templateId: reel.templateId ?? 'rapid-fire',
    beats: [],
    seed: 9,
  });
  const images = new Map<string, unknown>();
  for (const p of photos) images.set(p.id, { __photo: p.id, width: 1200, height: 1600 });
  const res = {
    images,
    blurred: new Map(),
    logo: null,
    fontPrimary: 'sans-serif',
    fontSecondary: 'sans-serif',
  } as unknown as RenderResources;
  return { timeline, res };
}

/** Every distinct photo visible at time t, with the alpha it was drawn at. */
function visibleAt(timeline: Timeline, res: RenderResources, tMs: number): DrawnImage[] {
  const { ctx, drawn } = stubContext(res.images as Map<string, unknown>);
  renderFrame(ctx as unknown as CanvasRenderingContext2D, timeline, tMs, res);
  return drawn;
}

describe('proof mode never shows a clean single photo', () => {
  it('turns the flag on for the reel it is asked for', () => {
    const { timeline } = buildProofTimeline(20);
    expect(timeline.continuousOverlap).toBe(true);
  });

  it('leaves ordinary reels alone', () => {
    const photos = Array.from({ length: 8 }, (_, i) => makePhotoRecord({ id: `q${i}`, order: i }));
    const reel = makeReelRecord({ templateId: 'rapid-fire', durationSec: 12 });
    const t = buildTimeline({
      reel,
      photos,
      brand: defaultBrand(),
      templateId: 'rapid-fire',
      beats: [],
      seed: 9,
    });
    expect(t.continuousOverlap).toBeUndefined();
  });

  it('and without it, frames really are clean — so the checks above have teeth', () => {
    const photos = Array.from({ length: 24 }, (_, i) => makePhotoRecord({ id: `q${i}`, order: i }));
    const reel = makeReelRecord({ templateId: 'rapid-fire', durationSec: 12 });
    const timeline = buildTimeline({
      reel,
      photos,
      brand: defaultBrand(),
      templateId: 'rapid-fire',
      beats: [],
      seed: 9,
    });
    const images = new Map<string, unknown>();
    for (const p of photos) images.set(p.id, { __photo: p.id });
    const res = {
      images,
      blurred: new Map(),
      logo: null,
      fontPrimary: 'sans-serif',
      fontSecondary: 'sans-serif',
    } as unknown as RenderResources;

    let cleanFrames = 0;
    for (let tMs = 0; tMs < timeline.durationMs; tMs += 37) {
      const drawn = visibleAt(timeline, res, tMs);
      if (drawn.length === 1 && drawn[0].alpha === 1) cleanFrames++;
    }
    expect(cleanFrames).toBeGreaterThan(0);
  });

  it('always has two different photos in the frame, at every instant', () => {
    const { timeline, res } = buildProofTimeline(24);
    for (let tMs = 0; tMs < timeline.durationMs; tMs += 37) {
      const drawn = visibleAt(timeline, res, tMs);
      const distinct = new Set(drawn.map((d) => d.photoId));
      expect(distinct.size, `only one photo visible at ${tMs}ms`).toBeGreaterThanOrEqual(2);
    }
  });

  it('never lets one photo hold the frame at full strength', () => {
    // A screenshot is only clean if some photo is drawn opaque with nothing
    // meaningful over it. Both the under and over layer must stay mixed.
    const { timeline, res } = buildProofTimeline(24);
    for (let tMs = 0; tMs < timeline.durationMs; tMs += 37) {
      const drawn = visibleAt(timeline, res, tMs);
      const top = drawn[drawn.length - 1];
      expect(top.alpha, `top layer fully opaque at ${tMs}ms`).toBeLessThan(0.9);
      expect(top.alpha, `top layer invisible at ${tMs}ms`).toBeGreaterThan(0.05);
    }
  });

  it('protects the opening frame, which has no photo before it', () => {
    const { timeline, res } = buildProofTimeline(24);
    for (const tMs of [0, 1, 5, 20]) {
      const drawn = visibleAt(timeline, res, tMs);
      expect(new Set(drawn.map((d) => d.photoId)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('protects the final frame too', () => {
    const { timeline, res } = buildProofTimeline(24);
    const last = timeline.durationMs - 1;
    expect(new Set(visibleAt(timeline, res, last).map((d) => d.photoId)).size).toBeGreaterThanOrEqual(2);
  });

  it('works on the slower styles as well, not just Rapid Fire', () => {
    for (const templateId of ['cinematic-story', 'signature-energy', 'editorial-minimal'] as const) {
      const { timeline, res } = buildProofTimeline(10, { templateId });
      for (let tMs = 0; tMs < timeline.durationMs; tMs += 101) {
        const drawn = visibleAt(timeline, res, tMs);
        expect(
          new Set(drawn.map((d) => d.photoId)).size,
          `${templateId} showed one photo at ${tMs}ms`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
