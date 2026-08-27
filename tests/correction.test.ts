import { describe, expect, it } from 'vitest';
import { applyCorrection, planCorrection, planIsNoop } from '../src/lib/imaging/correction';
import { computeStats } from '../src/lib/imaging/stats';
import { makeBuffer, makeStats } from './helpers';

describe('correction planning', () => {
  it('plans nothing for an already-clean image', () => {
    const plan = planCorrection(
      makeStats({ contrast: 0.18, highlightClip: 0, shadowCrush: 0, warmth: 0.02, skinWarmthExcess: 0 }),
    );
    expect(planIsNoop(plan)).toBe(true);
  });

  it('is conservative: strengths never exceed their caps', () => {
    const plan = planCorrection(
      makeStats({ contrast: 1, highlightClip: 1, shadowCrush: 1, warmth: 1, skinWarmthExcess: 1 }),
    );
    expect(plan.contrastReduce).toBeLessThanOrEqual(0.6);
    expect(plan.highlightRecover).toBeLessThanOrEqual(0.7);
    expect(plan.shadowLift).toBeLessThanOrEqual(0.5);
    expect(plan.coolWhiteBalance).toBeLessThanOrEqual(0.6);
    expect(plan.orangeDesat).toBeLessThanOrEqual(0.7);
  });
});

describe('correction application', () => {
  it('reduces harsh contrast without flattening the image', () => {
    // Hard black/white checkerboard = maximum contrast.
    const buf = makeBuffer(64, 64, (x, y) => ((x + y) % 2 === 0 ? [235, 235, 235] : [20, 20, 20]));
    const before = computeStats(buf);
    applyCorrection(buf, { contrastReduce: 0.6, highlightRecover: 0, shadowLift: 0, coolWhiteBalance: 0, orangeDesat: 0 });
    const after = computeStats(buf);
    expect(after.contrast).toBeLessThan(before.contrast);
    expect(after.contrast).toBeGreaterThan(before.contrast * 0.6); // restrained, not crushed
  });

  it('cools an overly warm image only slightly', () => {
    const buf = makeBuffer(32, 32, () => [200, 150, 90]);
    const before = computeStats(buf);
    applyCorrection(buf, { contrastReduce: 0, highlightRecover: 0, shadowLift: 0, coolWhiteBalance: 0.6, orangeDesat: 0 });
    const after = computeStats(buf);
    expect(after.warmth).toBeLessThan(before.warmth);
    expect(before.warmth - after.warmth).toBeLessThan(0.06); // subtle, not a re-grade
  });

  it('does not materially change skin color when desaturating orange', () => {
    const buf = makeBuffer(32, 32, () => [220, 140, 95]); // warm skin tone
    applyCorrection(buf, { contrastReduce: 0, highlightRecover: 0, shadowLift: 0, coolWhiteBalance: 0, orangeDesat: 0.7 });
    // Red channel must still dominate — skin stays skin.
    expect(buf.data[0]).toBeGreaterThan(buf.data[1]);
    expect(buf.data[1]).toBeGreaterThan(buf.data[2]);
    // And the change is bounded.
    expect(220 - buf.data[0]).toBeLessThan(30);
  });

  it('recovers highlights without touching midtones', () => {
    const buf = makeBuffer(32, 32, (x) => (x < 16 ? [250, 250, 250] : [128, 128, 128]));
    applyCorrection(buf, { contrastReduce: 0, highlightRecover: 0.7, shadowLift: 0, coolWhiteBalance: 0, orangeDesat: 0 });
    const highlight = buf.data[0];
    const midIndex = (0 * 32 + 20) * 4;
    expect(highlight).toBeLessThan(250);
    expect(buf.data[midIndex]).toBe(128);
  });
});
