import type { ImageStats } from '../types';
import { clamp01, clamp255, looksLikeSkin, type PixelBuffer } from './pixels';

/**
 * Correction strengths, each 0..1. Derived from measured stats so a photo
 * only receives the corrections it actually needs — and never more than the
 * conservative caps below. This is corrective, not creative: no beauty
 * filters, no skin smoothing, no relighting, no material skin-color change.
 */
export interface CorrectionPlan {
  contrastReduce: number;   // soften global contrast
  highlightRecover: number; // pull near-white values down
  shadowLift: number;       // open crushed shadows slightly
  coolWhiteBalance: number; // neutralize overly warm cast
  orangeDesat: number;      // selectively reduce orange/skin oversaturation
}

/** Decide how much of each correction a mobile photo needs. */
export function planCorrection(stats: ImageStats): CorrectionPlan {
  return {
    contrastReduce: clamp01((stats.contrast - 0.24) / 0.12) * 0.6,
    highlightRecover: clamp01(stats.highlightClip / 0.04) * 0.7,
    shadowLift: clamp01(stats.shadowCrush / 0.05) * 0.5,
    coolWhiteBalance: clamp01((stats.warmth - 0.08) / 0.1) * 0.6,
    orangeDesat: clamp01(stats.skinWarmthExcess / 0.08) * 0.7,
  };
}

export const planIsNoop = (p: CorrectionPlan): boolean =>
  p.contrastReduce < 0.05 &&
  p.highlightRecover < 0.05 &&
  p.shadowLift < 0.05 &&
  p.coolWhiteBalance < 0.05 &&
  p.orangeDesat < 0.05;

/**
 * Applies the plan in place. Pure pixel math — usable both in the browser
 * (via ImageData) and in unit tests.
 */
export function applyCorrection(buf: PixelBuffer, plan: CorrectionPlan): void {
  const { data } = buf;

  // Precompute a gentle tone curve as a LUT.
  const lut = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    let out = v;
    // Contrast reduction: blend toward a flatter response around mid-gray.
    if (plan.contrastReduce > 0) {
      const flat = 128 + (v - 128) * 0.82;
      out = out + (flat - out) * plan.contrastReduce;
    }
    // Highlight recovery: soft shoulder above ~200.
    if (plan.highlightRecover > 0 && out > 200) {
      const over = (out - 200) / 55;
      out -= over * over * 18 * plan.highlightRecover;
    }
    // Shadow lift: gentle toe below ~64.
    if (plan.shadowLift > 0 && out < 64) {
      const under = (64 - out) / 64;
      out += under * under * 14 * plan.shadowLift;
    }
    lut[v] = out;
  }

  const wbShiftR = -6 * plan.coolWhiteBalance;
  const wbShiftB = 6 * plan.coolWhiteBalance;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    // Tone curve on each channel keeps hue stable for small adjustments.
    r = lut[r];
    g = lut[g];
    b = lut[b];

    // White-balance neutralization: small, global, hue-preserving.
    r += wbShiftR;
    b += wbShiftB;

    // Selective orange desaturation on skin-looking pixels only.
    if (plan.orangeDesat > 0 && looksLikeSkin(data[i], data[i + 1], data[i + 2])) {
      const mean = (r + g + b) / 3;
      const amount = 0.22 * plan.orangeDesat;
      r += (mean - r) * amount;
      g += (mean - g) * amount * 0.4; // keep green closer to original
      b += (mean - b) * amount * 0.4;
    }

    data[i] = clamp255(r);
    data[i + 1] = clamp255(g);
    data[i + 2] = clamp255(b);
  }
}

/**
 * Browser entry point: renders the corrected variant of an image onto a new
 * canvas. The original bitmap and stored file are never modified.
 */
export function renderCorrected(
  source: ImageBitmap | HTMLCanvasElement,
  stats: ImageStats,
): { canvas: HTMLCanvasElement; plan: CorrectionPlan; changed: boolean } {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);

  const plan = planCorrection(stats);
  if (planIsNoop(plan)) {
    return { canvas, plan, changed: false };
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyCorrection(
    { data: imageData.data, width: canvas.width, height: canvas.height },
    plan,
  );
  ctx.putImageData(imageData, 0, 0);
  return { canvas, plan, changed: true };
}
