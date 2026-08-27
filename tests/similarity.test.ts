import { describe, expect, it } from 'vitest';
import { computePhash, isNearDuplicate, phashDistance } from '../src/lib/imaging/similarity';
import { makeBuffer } from './helpers';

describe('perceptual hashing / duplicate detection', () => {
  const gradient = makeBuffer(100, 80, (x, y) => [x * 2, y * 2, 100]);
  const gradientResized = makeBuffer(50, 40, (x, y) => [x * 4, y * 4, 100]);
  const stripes = makeBuffer(100, 80, (x) => (Math.floor(x / 10) % 2 === 0 ? [240, 240, 240] : [15, 15, 15]));

  it('identical images hash identically', () => {
    expect(computePhash(gradient)).toBe(computePhash(makeBuffer(100, 80, (x, y) => [x * 2, y * 2, 100])));
  });

  it('a resized copy is a near-duplicate', () => {
    const d = phashDistance(computePhash(gradient), computePhash(gradientResized));
    expect(d).toBeLessThanOrEqual(4);
    expect(isNearDuplicate(computePhash(gradient), computePhash(gradientResized))).toBe(true);
  });

  it('different compositions are far apart', () => {
    const d = phashDistance(computePhash(gradient), computePhash(stripes));
    expect(d).toBeGreaterThan(10);
    expect(isNearDuplicate(computePhash(gradient), computePhash(stripes))).toBe(false);
  });
});
