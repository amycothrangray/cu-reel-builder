// Text-safe zone selection: place overlays where they won't cover faces
// during the clips they appear over. Pure — testable in Node.

import type { FaceBox, NRect } from '../types';
import { overlapFraction } from './layout';

export interface CandidateZone {
  /** Anchor point (normalized frame coords) for the text block. */
  pos: { x: number; y: number };
  /** Approximate area the text will occupy, for face-collision checks. */
  area: NRect;
  priority: number; // lower = preferred when equally safe
}

/** Candidate placements for mid-reel titles/captions, in preference order. */
export const TITLE_ZONES: CandidateZone[] = [
  { pos: { x: 0.5, y: 0.72 }, area: { x: 0.08, y: 0.66, w: 0.84, h: 0.14 }, priority: 0 },
  { pos: { x: 0.5, y: 0.2 }, area: { x: 0.08, y: 0.14, w: 0.84, h: 0.14 }, priority: 1 },
  { pos: { x: 0.5, y: 0.84 }, area: { x: 0.08, y: 0.79, w: 0.84, h: 0.12 }, priority: 2 },
  { pos: { x: 0.5, y: 0.1 }, area: { x: 0.08, y: 0.05, w: 0.84, h: 0.12 }, priority: 3 },
];

/**
 * Faces that will be visible in the frame while the overlay shows,
 * expressed in *frame* coordinates (caller maps from source-crop space).
 */
export function pickTextZone(
  frameFaces: NRect[],
  candidates: CandidateZone[] = TITLE_ZONES,
): CandidateZone {
  let best = candidates[0];
  let bestScore = Infinity;
  for (const zone of candidates) {
    let collision = 0;
    for (const face of frameFaces) {
      collision += overlapFraction(face, zone.area);
    }
    const score = collision * 10 + zone.priority;
    if (score < bestScore) {
      bestScore = score;
      best = zone;
    }
  }
  return best;
}

/**
 * Map a face box from source-image space into frame space given the active
 * crop and destination region.
 */
export function faceInFrame(face: FaceBox, crop: NRect, dest: NRect): NRect | null {
  // Face relative to the crop:
  const rx = (face.x - crop.x) / crop.w;
  const ry = (face.y - crop.y) / crop.h;
  const rw = face.w / crop.w;
  const rh = face.h / crop.h;
  if (rx + rw < 0 || rx > 1 || ry + rh < 0 || ry > 1) return null;
  return {
    x: dest.x + rx * dest.w,
    y: dest.y + ry * dest.h,
    w: rw * dest.w,
    h: rh * dest.h,
  };
}
