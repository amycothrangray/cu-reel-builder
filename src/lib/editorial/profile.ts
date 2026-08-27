// Editorial profile: what each photograph IS, editorially — beyond
// attractiveness and crop safety. Pure and deterministic.

import type { SequencePhoto } from '../engine/sequence';
import type { IdentityIndex } from './identity';
import { clamp01 } from '../imaging/pixels';

export type ShotScale = 'wide' | 'medium' | 'close' | 'detail';
export type Grouping = 'none' | 'individual' | 'pair' | 'small-group' | 'large-group';

export interface EditorialProfile {
  photoId: string;
  peopleCount: number;
  grouping: Grouping;
  shotScale: ShotScale;
  orientation: 'portrait' | 'landscape' | 'square';
  brightness: number; // 0..1 mean luma
  energy: number; // 0..1
  /** Pure image quality (sharpness/exposure/composition proxy). */
  visual: number;
  /** Purpose-weighted editorial value — what actually ranks photos. */
  hero: number;
  identities: string[];
  /** Environmental / scene-setting image (no clear people). */
  isContext: boolean;
  required: boolean;
}

const biggestFace = (p: SequencePhoto): number =>
  p.faces.length > 0 ? Math.max(...p.faces.map((f) => f.w * f.h)) : 0;

export function shotScaleOf(p: SequencePhoto): ShotScale {
  const face = biggestFace(p);
  if (p.faces.length === 0) {
    return p.width > p.height ? 'wide' : 'detail';
  }
  if (face > 0.045) return 'close';
  if (face > 0.012) return 'medium';
  return 'wide';
}

export function groupingOf(p: SequencePhoto): Grouping {
  const n = p.faces.length;
  if (n === 0) return 'none';
  if (n === 1) return 'individual';
  if (n === 2) return 'pair';
  if (n <= 5) return 'small-group';
  return 'large-group';
}

export function energyOf(p: SequencePhoto): number {
  let energy = 0.35;
  if (p.ai?.storyRole === 'movement') energy += 0.4;
  if (p.ai?.storyRole === 'interaction') energy += 0.15;
  if (p.faces.length >= 2) energy += 0.1;
  if (p.faces.length >= 4) energy += 0.1;
  // Punchy tonality reads as energy; flat low-contrast reads as calm.
  energy += (p.stats.contrast - 0.18) * 0.8;
  energy += (p.stats.saturation - 0.3) * 0.4;
  return clamp01(energy);
}

/**
 * Purpose-weighted hero score.
 *
 * Photography: the photograph's own excellence leads — the reel exists to
 * make the work look exceptional and desirable.
 *
 * School/community: the MOMENT leads. Recognizable faces, energy and
 * authenticity outrank technical quality; a slightly soft photo of a great
 * student moment is valuable. Technical quality must not dominate.
 */
export function heroScoreOf(
  p: SequencePhoto,
  purpose: 'photography' | 'school',
): number {
  const visual = p.score;
  const appeal = p.ai?.appeal ?? visual;
  const face = biggestFace(p);
  const facePresence = clamp01(face * 12 + (p.faces.length > 0 ? 0.25 : 0));
  const emotional =
    p.ai?.storyRole === 'emotional' || p.ai?.storyRole === 'closing' ? 0.2 : 0;

  if (purpose === 'photography') {
    return clamp01(0.5 * visual + 0.3 * appeal + 0.12 * facePresence + emotional);
  }
  // school
  const energy = energyOf(p);
  return clamp01(
    0.3 * energy + 0.3 * facePresence + 0.2 * appeal + 0.12 * visual + emotional,
  );
}

export function buildProfiles(
  photos: SequencePhoto[],
  identities: IdentityIndex,
  purpose: 'photography' | 'school',
): Map<string, EditorialProfile> {
  const map = new Map<string, EditorialProfile>();
  for (const p of photos) {
    map.set(p.id, {
      photoId: p.id,
      peopleCount: p.faces.length,
      grouping: groupingOf(p),
      shotScale: shotScaleOf(p),
      orientation:
        p.width > p.height * 1.05 ? 'landscape' : p.height > p.width * 1.05 ? 'portrait' : 'square',
      brightness: p.stats.meanLuma,
      energy: energyOf(p),
      visual: p.score,
      hero: heroScoreOf(p, purpose),
      identities: identities.byPhoto.get(p.id) ?? [],
      isContext: p.faces.length === 0 && p.width > p.height,
      required: p.required ?? false,
    });
  }
  return map;
}

/**
 * Infer the likely purpose of an uploaded set. Professional sessions are
 * dominated by pro-camera images of a small recurring cast; school sets mix
 * devices and show many different people.
 */
export function inferPurpose(
  _photos: SequencePhoto[],
  identities: IdentityIndex,
  proFraction: number,
): 'photography' | 'school' {
  if (identities.identityCount >= 8) return 'school';
  if (proFraction >= 0.6) return 'photography';
  if (identities.identityCount >= 5 && proFraction < 0.5) return 'school';
  return 'photography';
}
