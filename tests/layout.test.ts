import { describe, expect, it } from 'vitest';
import {
  avoidFaceSlice,
  canStackPair,
  coverCrop,
  cropSlicesFace,
  planPan,
  planTreatment,
  stackedLayers,
  subjectRect,
} from '../src/lib/engine/layout';
import { face, makePhoto } from './helpers';

const V = 9 / 16; // vertical reel aspect

describe('safe crop behavior', () => {
  it('cover crops stay inside the image and match the target aspect', () => {
    const crop = coverCrop(3000, 2000, V, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 });
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1.0001);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1.0001);
    // Aspect in pixels: (crop.w * 3000) / (crop.h * 2000) ≈ 9/16
    expect((crop.w * 3000) / (crop.h * 2000)).toBeCloseTo(V, 2);
  });

  it('the crop centers on the subject when it fits', () => {
    const focus = { x: 0.6, y: 0.2, w: 0.1, h: 0.3 };
    const crop = coverCrop(3000, 2000, V, focus);
    const cx = crop.x + crop.w / 2;
    expect(cx).toBeCloseTo(0.65, 1);
  });

  it('detects and repairs a crop that slices a face', () => {
    const faces = [face(0.28, 0.3, 0.1, 0.15)];
    // A crop whose left edge runs through the face.
    const bad = { x: 0.3, y: 0, w: 0.3, h: 1 };
    expect(cropSlicesFace(bad, faces)).toBe(true);
    const fixed = avoidFaceSlice(bad, faces);
    expect(cropSlicesFace(fixed, faces)).toBe(false);
  });

  it('never chops a wide family group: falls back to full-image treatment', () => {
    // Faces spread across the whole horizontal frame.
    const photo = makePhoto({
      width: 6000,
      height: 4000,
      faces: [face(0.05, 0.35, 0.08, 0.14), face(0.45, 0.3, 0.08, 0.15), face(0.85, 0.34, 0.08, 0.14)],
    });
    const plan = planTreatment(photo, V);
    expect(plan.fill).toBe('contain-blur');
  });

  it('pans end on the subject, never away from it', () => {
    const faces = [face(0.7, 0.3, 0.08, 0.14)];
    const plan = planPan(6000, 4000, V, faces);
    const focus = subjectRect(faces);
    const focusCx = focus.x + focus.w / 2;
    const endCx = plan.cropEnd.x + plan.cropEnd.w / 2;
    const startCx = plan.crop.x + plan.crop.w / 2;
    // End frame centers on the subject better than the start frame does.
    expect(Math.abs(endCx - focusCx)).toBeLessThanOrEqual(Math.abs(startCx - focusCx) + 0.001);
    // Motion is restrained.
    expect(Math.abs(startCx - endCx)).toBeLessThanOrEqual(0.25);
  });

  it('portrait photos get gentle push, not pan or blur fallback', () => {
    const photo = makePhoto({ width: 2000, height: 3000, faces: [face(0.4, 0.25, 0.2, 0.2)] });
    const plan = planTreatment(photo, V);
    expect(plan.fill).toBe('cover');
    // Zoom drift exists but is gentle (≤ ~10% frame change).
    expect(Math.abs(plan.crop.w - plan.cropEnd.w) / plan.crop.w).toBeLessThan(0.12);
  });
});

describe('custom crops', () => {
  const custom = { x: 0.55, y: 0.1, w: 0.28, h: 0.8 };

  it('a user-set crop overrides automatic framing exactly', () => {
    const photo = makePhoto({
      width: 6000,
      height: 4000,
      faces: [face(0.1, 0.3, 0.08, 0.14)], // face the user chose to exclude
      customCrop: custom,
    });
    const still = planTreatment(photo, V, 'static');
    expect(still.crop).toEqual(custom);
    expect(still.cropEnd).toEqual(custom);
    // Motion variants stay inside the user's crop.
    const push = planTreatment(photo, V);
    for (const rect of [push.crop, push.cropEnd]) {
      expect(rect.x).toBeGreaterThanOrEqual(custom.x - 0.001);
      expect(rect.y).toBeGreaterThanOrEqual(custom.y - 0.001);
      expect(rect.x + rect.w).toBeLessThanOrEqual(custom.x + custom.w + 0.001);
      expect(rect.y + rect.h).toBeLessThanOrEqual(custom.y + custom.h + 0.001);
    }
  });

  it('custom-cropped photos are never re-framed into stacked slots', () => {
    const a = makePhoto({ width: 6000, height: 4000, customCrop: custom });
    const b = makePhoto({ width: 6000, height: 4000 });
    expect(canStackPair(a, b)).toBe(false);
  });
});

describe('stacked pairs', () => {
  it('only stacks horizontal photos whose faces survive the half-frame crop', () => {
    const a = makePhoto({ width: 6000, height: 4000, faces: [face(0.45, 0.3, 0.1, 0.2)] });
    const b = makePhoto({ width: 6000, height: 4000, faces: [face(0.5, 0.35, 0.1, 0.2)] });
    const portrait = makePhoto({ width: 2000, height: 3000 });
    expect(canStackPair(a, b)).toBe(true);
    expect(canStackPair(a, portrait)).toBe(false);
  });

  it('stacked layers split the frame into top and bottom halves', () => {
    const a = makePhoto({ width: 6000, height: 4000 });
    const b = makePhoto({ width: 6000, height: 4000 });
    const layers = stackedLayers(a, b);
    expect(layers[0].dest).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(layers[1].dest).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});
