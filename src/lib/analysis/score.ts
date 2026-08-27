// Composite photo quality score — pure and testable.

import type { FaceBox, ImageStats } from '../types';
import { clamp01 } from '../imaging/pixels';

export interface ScoreInput {
  stats: ImageStats;
  faces: FaceBox[];
  width: number;
  height: number;
}

/**
 * 0..1 score used to pick the recommended subset and strong open/close
 * images. Weights favor sharp, well-exposed images with clear subjects, and
 * account for how well the image will present in a vertical frame.
 */
export function scorePhoto(input: ScoreInput): number {
  const { stats, faces, width, height } = input;

  const sharp = clamp01(stats.sharpness * 1.4);

  // Exposure: mid luma is good; heavy clipping/crush penalized.
  const exposure =
    clamp01(1 - Math.abs(stats.meanLuma - 0.5) * 1.6) *
    clamp01(1 - stats.highlightClip * 12) *
    clamp01(1 - stats.shadowCrush * 8);

  // Subject: faces of a good relative size read strongly in a reel.
  let subject = 0.35; // baseline for landscapes/details without faces
  if (faces.length > 0) {
    const biggest = Math.max(...faces.map((f) => f.w * f.h));
    subject = clamp01(0.5 + biggest * 6); // a face ≥ ~8% of frame maxes out
  }

  // Vertical compatibility: portrait crops lose nothing; wide panoramas need
  // treatment (still usable — pan/stack — so only a mild penalty).
  const aspect = width / height;
  const vertical = aspect <= 0.9 ? 1 : aspect <= 1.4 ? 0.85 : aspect <= 2 ? 0.7 : 0.55;

  const contrastQuality = clamp01(1 - Math.abs(stats.contrast - 0.19) * 2.2);

  return clamp01(
    0.3 * sharp + 0.22 * exposure + 0.28 * subject + 0.12 * vertical + 0.08 * contrastQuality,
  );
}

/**
 * Pick the recommended subset: strongest photos, spread across the set,
 * skipping near-duplicates of already-picked images.
 */
export function recommendSubset<T extends { id: string; score: number; phash: string }>(
  photos: T[],
  needed: number,
  phashDistance: (a: string, b: string) => number,
  duplicateThreshold = 10,
): Set<string> {
  const sorted = [...photos].sort((a, b) => b.score - a.score);
  const picked: T[] = [];
  for (const candidate of sorted) {
    if (picked.length >= needed) break;
    const dupe = picked.some(
      (p) => phashDistance(p.phash, candidate.phash) <= duplicateThreshold,
    );
    if (!dupe) picked.push(candidate);
  }
  // If duplicates were all we had, fill remaining slots anyway.
  for (const candidate of sorted) {
    if (picked.length >= needed) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return new Set(picked.map((p) => p.id));
}
