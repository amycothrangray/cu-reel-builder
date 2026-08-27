import type { FaceBox, ImageStats } from '../src/lib/types';
import type { SequencePhoto } from '../src/lib/engine/sequence';

export function makeStats(overrides: Partial<ImageStats> = {}): ImageStats {
  return {
    sharpness: 0.6,
    contrast: 0.2,
    saturation: 0.32,
    warmth: 0.03,
    highlightClip: 0.001,
    shadowCrush: 0.002,
    meanLuma: 0.5,
    skinWarmthExcess: 0.01,
    skinFraction: 0.08,
    ...overrides,
  };
}

let counter = 0;

export function makePhoto(overrides: Partial<SequencePhoto> = {}): SequencePhoto {
  counter++;
  return {
    id: `photo-${counter}`,
    width: 1200,
    height: 1600,
    score: 0.6,
    // Distinct hashes by default so photos aren't accidental duplicates.
    phash: (BigInt(counter) * 0x9e3779b97f4a7c15n & 0xffffffffffffffffn)
      .toString(16)
      .padStart(16, '0'),
    faces: [],
    stats: makeStats(),
    ...overrides,
  };
}

export const face = (x: number, y: number, w: number, h: number, score = 0.9): FaceBox => ({
  x,
  y,
  w,
  h,
  score,
});

/** Build an RGBA pixel buffer filled by a function of (x, y). */
export function makeBuffer(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
